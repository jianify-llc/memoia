"""Real PostgreSQL effects and Redis leases, with deterministic model boundaries."""
import asyncio
from datetime import datetime, timezone
from uuid import uuid4
from unittest.mock import AsyncMock

import numpy as np
import pytest
import pytest_asyncio
from sqlalchemy import select, update, delete, func

from memoia_server.controllers import source, user, profile, event
from memoia_server.controllers.user_lease import UserLease, LeaseUnavailable, CURRENT_LEASE
from memoia_server.connectors import Session, get_redis_client, DB_ENGINE
from memoia_server.models.database import User, UserProfile, UserEvent, UserEventGist, Project, Billing, ProjectBilling
from memoia_server.models.response import UserData
from memoia_server.models.source import ImportSource, RetractMessages, memory_sources, memory_operations, memory_facts, user_memory_states
from memoia_server.env import CONFIG
from memoia_server.models.utils import Promise


def request(key="import-1", external="log-1", messages=None):
    return ImportSource(idempotency_key=key, external_id=external, messages=messages or [
        {"message_id": "1", "role": "user", "content": "I live in Tokyo", "occurred_at": datetime.now(timezone.utc)},
        {"message_id": "2", "role": "user", "content": "I enjoy chess", "occurred_at": datetime.now(timezone.utc)},
    ])


@pytest_asyncio.fixture
async def source_user(db_env):
    created = await user.create_user(UserData(), "__root__")
    uid = str(created.data().id)
    try:
        yield uid
    finally:
        with Session.begin() as session:
            row = session.get(User, (created.data().id, "__root__"))
            if row:
                session.delete(row)


@pytest.fixture
def models(monkeypatch):
    async def extract(body, **kwargs):
        return source.ExtractedSource([{"id": uuid4(), "content": m.content, "topic": "basic", "sub_topic": m.message_id,
                 "support_groups": [[m.message_id]], "occurred_at": m.occurred_at} for m in body.messages if m.role == "user"], [])
    async def reconcile(candidates, **kwargs):
        return source.Reconciliation(
            decisions=[source.FactDecision(fact_id=f["id"], include=True) for f in candidates],
            profiles=[source.DerivedProfile(content=f["content"], topic=f["topic"], sub_topic=f["sub_topic"], fact_ids=[f["id"]]) for f in candidates],
        )
    async def embeddings(_, texts, **kwargs):
        return Promise.resolve(np.ones((len(texts), CONFIG.embedding_dim)))
    monkeypatch.setattr(source, "extract_source", AsyncMock(side_effect=extract))
    monkeypatch.setattr(source, "reconcile_facts", AsyncMock(side_effect=reconcile))
    monkeypatch.setattr(source, "get_embedding", AsyncMock(side_effect=embeddings))
    monkeypatch.setattr(source, "_structured", AsyncMock(return_value=source.EventTagging(event_tags=[])))
    return source.extract_source


@pytest.mark.asyncio
async def test_completed_replay_returns_same_ids_and_effect_once(source_user, models):
    body = request()
    first = await source.import_source(source_user, "__root__", body)
    second = await source.import_source(source_user, "__root__", body)
    assert first == second and first.status == "completed"
    assert models.await_count == 1
    with Session() as session:
        assert session.scalar(select(func.count()).select_from(memory_sources).where(memory_sources.c.user_id == source_user)) == 1
        assert session.scalar(select(func.count()).select_from(UserEvent).where(UserEvent.user_id == source_user)) == 1


@pytest.mark.asyncio
async def test_first_import_creates_fixed_user_once_under_concurrent_replay(db_env, models):
    uid = uuid4()
    body = request()
    try:
        first, second = await asyncio.gather(source.import_source(uid, "__root__", body),
                                            source.import_source(uid, "__root__", body))
        assert first.operation_id == second.operation_id
        assert source.get_operation(uid, "__root__", operation_id=first.operation_id).status == "completed"
        assert models.await_count == 1
        with Session() as session:
            assert session.scalar(select(func.count()).select_from(User).where(User.id == uid, User.project_id == "__root__")) == 1
    finally:
        with Session.begin() as session:
            session.execute(delete(User).where(User.id == uid, User.project_id == "__root__"))


@pytest.mark.asyncio
async def test_fixed_user_import_is_project_scoped_and_deleted_user_is_not_recreated_by_recovery(db_env, models):
    uid, project = uuid4(), "source-" + uuid4().hex
    with Session.begin() as session:
        session.execute(Project.__table__.insert().values(id=uuid4(), project_id=project,
                                                         project_secret="fixture-only", profile_config=None, status="active"))
    try:
        first = await source.import_source(uid, "__root__", request())
        other = await source.import_source(uid, project, request())
        assert first.source_id != other.source_id
        with Session.begin() as session:
            assert session.scalar(select(func.count()).select_from(User).where(User.id == uid)) == 2
            session.execute(delete(User).where(User.id == uid, User.project_id == "__root__"))
        with pytest.raises(source.SourceError, match="not found"):
            await source.retry_operation(uid, "__root__", first.operation_id)
        with pytest.raises(source.SourceError, match="not found"):
            await source.retract_messages(uid, "__root__", first.source_id,
                                         RetractMessages(idempotency_key="forgotten", message_ids=["1"]))
        with Session() as session:
            assert session.get(User, (uid, "__root__")) is None
            assert session.get(User, (uid, project)) is not None
    finally:
        with Session.begin() as session:
            session.execute(delete(User).where(User.id == uid))
            session.execute(delete(Project).where(Project.project_id == project))


@pytest.mark.asyncio
async def test_project_accounting_does_not_touch_user_memory_version_or_require_live_lease(source_user):
    from memoia_server.controllers.billing import project_cost_token_billing
    with Session.begin() as session:
        billing = session.query(Billing).join(ProjectBilling).filter(ProjectBilling.project_id == "__root__").one()
        before, bid = billing.usage_left, billing.id
        billing.usage_left = 1000
    try:
        async with UserLease(source_user, "__root__") as lease:
            with Session.begin() as session:
                source._fence_snapshot(session, source_user, "__root__", lease)
            generation, version = lease.generation, lease.version
            lease.lost.set()
            result = await project_cost_token_billing("__root__", 7, 3)
            assert result.ok()
            with Session() as session:
                row = session.execute(select(user_memory_states).where(user_memory_states.c.user_id == source_user)).mappings().one()
                assert (row["generation"], row["version"]) == (generation, version)
                assert session.get(Billing, bid).usage_left == 990
    finally:
        with Session.begin() as session:
            session.get(Billing, bid).usage_left = before


@pytest.mark.asyncio
async def test_same_key_changed_body_is_conflict(source_user, models):
    body = request()
    await source.import_source(source_user, "__root__", body)
    changed = body.model_copy(deep=True)
    changed.messages[0].content = "different"
    with pytest.raises(source.SourceError, match="different request"):
        await source.import_source(source_user, "__root__", changed)


@pytest.mark.asyncio
async def test_profile_failure_rolls_back_source_events_and_completion(source_user, models, monkeypatch):
    body = request()
    original = source._replace_profiles
    def fail(*args):
        raise source.SourceError("confirmed_failure", "test", 503, True)
    monkeypatch.setattr(source, "_replace_profiles", fail)
    with pytest.raises(source.SourceError):
        await source.import_source(source_user, "__root__", body)
    receipt = source.get_operation(source_user, "__root__", key=body.idempotency_key)
    assert receipt.status == "failed" and receipt.error.retryable
    with Session() as session:
        assert session.scalar(select(func.count()).select_from(memory_sources).where(memory_sources.c.user_id == source_user)) == 0
        assert session.scalar(select(func.count()).select_from(memory_facts).where(memory_facts.c.user_id == source_user)) == 0
        assert session.scalar(select(func.count()).select_from(UserEvent).where(UserEvent.user_id == source_user)) == 0
    monkeypatch.setattr(source, "_replace_profiles", original)
    recovered = await source.retry_operation(source_user, "__root__", receipt.operation_id)
    assert recovered.status == "completed"


@pytest.mark.asyncio
async def test_retract_joint_support_preserves_independent_support(source_user, models, monkeypatch):
    now = datetime.now(timezone.utc)
    async def joint(body, **kwargs):
        return source.ExtractedSource([{"id": uuid4(), "content": "Tokyo", "topic": "basic", "sub_topic": "city",
                 "support_groups": [["1", "2"], ["3"]], "occurred_at": now}], [])
    monkeypatch.setattr(source, "extract_source", joint)
    body = request(messages=[{"message_id": mid, "role": "user", "content": "Tokyo", "occurred_at": now} for mid in ["1", "2", "3"]])
    inserted = await source.import_source(source_user, "__root__", body)
    await source.retract_messages(source_user, "__root__", inserted.source_id, RetractMessages(idempotency_key="remove1", message_ids=["1"]))
    detail = source.get_source(source_user, "__root__", source_id=inserted.source_id)
    assert detail.evidence[0].support_groups == [["3"]]
    assert (await profile.get_user_profiles(source_user, "__root__")).data().profiles[0].content == "Tokyo"
    await source.retract_messages(source_user, "__root__", inserted.source_id, RetractMessages(idempotency_key="remove3", message_ids=["3"]))
    assert not (await profile.get_user_profiles(source_user, "__root__")).data().profiles
    assert all("Tokyo" not in p.content for h in source.get_history(source_user, "__root__") for p in h.profiles)
    assert not (await event.get_user_events(source_user, "__root__")).data().events


@pytest.mark.asyncio
async def test_failed_rebuild_is_hidden_and_recoverable(source_user, models, monkeypatch):
    inserted = await source.import_source(source_user, "__root__", request())
    original = source.reconcile_facts
    monkeypatch.setattr(source, "reconcile_facts", AsyncMock(side_effect=source.SourceError("model_failure", "test", 503, True)))
    with pytest.raises(source.SourceError):
        await source.retract_messages(source_user, "__root__", inserted.source_id, RetractMessages(idempotency_key="remove1", message_ids=["1"]))
    assert not (await event.get_user_events(source_user, "__root__")).data().events
    assert [p.content for p in (await profile.get_user_profiles(source_user, "__root__")).data().profiles] == ["I enjoy chess"]
    assert all("Tokyo" not in p.content for h in source.get_history(source_user, "__root__") for p in h.profiles)
    receipt = source.get_operation(source_user, "__root__", key="remove1")
    monkeypatch.setattr(source, "reconcile_facts", original)
    resumed = await source.retry_operation(source_user, "__root__", receipt.operation_id)
    assert resumed.status == "completed"
    assert [p.content for p in (await profile.get_user_profiles(source_user, "__root__")).data().profiles] == ["I enjoy chess"]


@pytest.mark.asyncio
@pytest.mark.parametrize("fail_first", [False, True])
async def test_event_tags_rebuild_uses_only_configured_remaining_evidence(source_user, models, monkeypatch, fail_first):
    import json
    with Session.begin() as session:
        project = session.query(Project).filter_by(project_id="__root__").one()
        previous_config = project.profile_config
        project.profile_config = """event_tags:
  - name: city
    description: Current city
  - name: hobby
    description: Personal hobby
"""
    original_extract = source.extract_source
    tags = [{"tag": "city", "value": "Tokyo"}, {"tag": "hobby", "value": "chess"}]
    async def extract_with_tags(body, **kwargs):
        assert {item["name"] for item in kwargs["rules"]["event_tag_definitions"]} == {"city", "hobby"}
        extracted = await original_extract(body, **kwargs)
        return source.ExtractedSource(extracted.facts, tags)
    calls = []
    async def regenerate(model, prompt, system, **kwargs):
        assert model is source.EventTagging
        data = json.loads(prompt)
        assert {item["name"] for item in data["configuration"]["event_tag_definitions"]} == {"city", "hobby"}
        assert [fact["content"] for fact in data["facts"]] == ["I enjoy chess"]
        assert "Tokyo" not in prompt
        calls.append(data)
        if fail_first and len(calls) == 1:
            raise source.SourceError("tag_model_failed", "Tag generation failed", 503, True)
        return source.EventTagging(event_tags=[source.SourceEventTag(tag="hobby", value="chess")])
    monkeypatch.setattr(source, "extract_source", extract_with_tags)
    monkeypatch.setattr(source, "_structured", regenerate)
    try:
        imported = await source.import_source(source_user, "__root__", request())
        with Session() as session:
            assert session.get(UserEvent, (imported.result.event_ids[0], "__root__")).event_data["event_tags"] == tags
        withdrawal = RetractMessages(idempotency_key="withdraw-city-tag", message_ids=["1"])
        if fail_first:
            with pytest.raises(source.SourceError, match="Tag generation failed"):
                await source.retract_messages(source_user, "__root__", imported.source_id, withdrawal)
            receipt = source.get_operation(source_user, "__root__", key=withdrawal.idempotency_key)
            assert receipt.status == "failed" and receipt.error.retryable
            assert source.get_source(source_user, "__root__", source_id=imported.source_id).status == "rebuilding"
            assert not (await event.get_user_events(source_user, "__root__")).data().events
            completed = await source.retry_operation(source_user, "__root__", receipt.operation_id)
            assert completed.operation_id == receipt.operation_id
        else:
            completed = await source.retract_messages(source_user, "__root__", imported.source_id, withdrawal)
        assert completed.status == "completed"
        with Session() as session:
            rebuilt = session.get(UserEvent, (completed.result.event_ids[0], "__root__"))
            assert rebuilt.event_data["event_tags"] == [{"tag": "hobby", "value": "chess"}]
            assert "Tokyo" not in json.dumps(rebuilt.event_data)
        await source.retract_messages(source_user, "__root__", imported.source_id,
                                      RetractMessages(idempotency_key="withdraw-hobby-tag", message_ids=["2"]))
        assert len(calls) == (2 if fail_first else 1)
        assert not (await event.get_user_events(source_user, "__root__")).data().events
    finally:
        with Session.begin() as session:
            session.query(Project).filter_by(project_id="__root__").update({"profile_config": previous_config})


@pytest.mark.asyncio
async def test_new_generation_fences_stale_model_result(source_user, models, monkeypatch):
    entered, release = asyncio.Event(), asyncio.Event()
    original = source.extract_source
    async def paused(body, **kwargs):
        entered.set()
        await release.wait()
        return await original(body, **kwargs)
    monkeypatch.setattr(source, "extract_source", paused)
    old = asyncio.create_task(source.import_source(source_user, "__root__", request()))
    await entered.wait()
    key = UserLease(source_user, "__root__").key
    async with get_redis_client() as redis:
        await redis.delete(key)
    monkeypatch.setattr(source, "extract_source", original)
    new = await source.import_source(source_user, "__root__", request("new", "new-source"))
    release.set()
    with pytest.raises(source.SourceError, match="Memory changed"):
        await old
    assert new.status == "completed"
    with Session() as session:
        assert session.scalar(select(func.count()).select_from(memory_sources).where(memory_sources.c.user_id == source_user)) == 1


@pytest.mark.asyncio
async def test_user_lease_renews_over_multiple_ttls(source_user):
    async with UserLease(source_user, "__root__", ttl=.3) as lease:
        await asyncio.sleep(.85)
        async def independent():
            token = CURRENT_LEASE.set(None)
            try:
                with pytest.raises(LeaseUnavailable):
                    async with UserLease(source_user, "__root__", ttl=.3):
                        pass
            finally:
                CURRENT_LEASE.reset(token)
        await independent()
        lease.assert_owned()
    async with get_redis_client() as redis:
        assert await redis.get(lease.key) is None


@pytest.mark.asyncio
async def test_cancelled_model_keeps_processing_receipt_and_can_resume(source_user, models, monkeypatch):
    entered = asyncio.Event()
    original = source.extract_source
    async def paused(body, **kwargs):
        entered.set()
        await asyncio.Event().wait()
    monkeypatch.setattr(source, "extract_source", paused)
    execution = asyncio.create_task(source.import_source(source_user, "__root__", request()))
    await entered.wait()
    assert DB_ENGINE.pool.checkedout() == 0
    execution.cancel()
    with pytest.raises(asyncio.CancelledError):
        await execution
    receipt = source.get_operation(source_user, "__root__", key="import-1")
    assert receipt.status == "processing"
    with Session() as session:
        assert session.scalar(select(func.count()).select_from(memory_sources).where(memory_sources.c.user_id == source_user)) == 0
    async with get_redis_client() as redis:
        assert await redis.get(UserLease(source_user, "__root__").key) is None
    monkeypatch.setattr(source, "extract_source", original)
    resumed = await source.retry_operation(source_user, "__root__", receipt.operation_id)
    assert resumed.status == "completed" and resumed.operation_id == receipt.operation_id


@pytest.mark.asyncio
async def test_event_delete_keeps_source_and_profiles_and_never_resurrects(source_user, models):
    inserted = await source.import_source(source_user, "__root__", request())
    eid = inserted.result.event_ids[0]
    async with UserLease(source_user, "__root__") as lease:
        with Session.begin() as session:
            source._fence_snapshot(session, source_user, "__root__", lease)
        assert (await event.delete_user_event(source_user, "__root__", eid)).ok()
    assert len(source.get_source(source_user, "__root__", source_id=inserted.source_id).evidence) == 2
    assert len((await profile.get_user_profiles(source_user, "__root__")).data().profiles) == 2
    retracted = await source.retract_messages(source_user, "__root__", inserted.source_id,
        RetractMessages(idempotency_key="withdraw-one", message_ids=["1"]))
    assert retracted.result.event_ids == []
    assert not (await event.get_user_events(source_user, "__root__")).data().events
    with Session() as session:
        assert session.scalar(select(func.count()).select_from(UserEventGist).where(UserEventGist.user_id == source_user)) == 0


@pytest.mark.asyncio
async def test_event_edit_replaces_vector_and_gists_atomically(source_user, models, monkeypatch):
    inserted = await source.import_source(source_user, "__root__", request())
    eid = inserted.result.event_ids[0]
    vector = np.full(CONFIG.embedding_dim, .25)
    monkeypatch.setattr(event, "get_embedding", AsyncMock(return_value=Promise.resolve(np.array([vector, vector, vector]))))
    async with UserLease(source_user, "__root__") as lease:
        with Session.begin() as session:
            source._fence_snapshot(session, source_user, "__root__", lease)
        assert (await event.update_user_event(source_user, "__root__", eid, {"event_tip": "- edited one\n- edited two"})).ok()
    with Session() as session:
        row = session.get(UserEvent, (eid, "__root__"))
        assert row.event_data["event_tip"] == "- edited one\n- edited two"
        assert np.allclose(row.embedding, vector)
        gists = session.query(UserEventGist).filter_by(event_id=eid, project_id="__root__").all()
        assert {g.gist_data["content"] for g in gists} == {"edited one", "edited two"}
        assert all(np.allclose(g.embedding, vector) for g in gists)


@pytest.mark.asyncio
async def test_profile_edit_cannot_strip_provenance_then_escape_withdrawal(source_user, models):
    inserted = await source.import_source(source_user, "__root__", request())
    pid = inserted.result.profile_ids[0]
    async with UserLease(source_user, "__root__") as lease:
        with Session.begin() as session:
            source._fence_snapshot(session, source_user, "__root__", lease)
        assert (await profile.update_user_profiles(source_user, "__root__", [pid], ["Edited Tokyo"],
            [{"topic": "basic", "sub_topic": "city", "memoia_v2": False, "fact_ids": []}])).ok()
    with Session() as session:
        attributes = session.get(UserProfile, (pid, "__root__")).attributes
        assert attributes["memoia_v2"] and attributes["fact_ids"]
    await source.retract_messages(source_user, "__root__", inserted.source_id,
        RetractMessages(idempotency_key="withdraw-first", message_ids=["1"]))
    assert all("Tokyo" not in row.content for row in (await profile.get_user_profiles(source_user, "__root__")).data().profiles)


@pytest.mark.asyncio
async def test_project_configuration_reaches_structured_prompts_and_strict_validator(source_user, monkeypatch):
    with Session.begin() as session:
        row = session.query(Project).filter_by(project_id="__root__").one()
        old = row.profile_config
        row.profile_config = """language: zh
profile_strict_mode: true
overwrite_user_profiles:
  - topic: custom
    sub_topics: [city]
event_tags: []
"""
    seen = []
    async def structured(model, prompt, system, **kwargs):
        import json
        data = json.loads(prompt)
        seen.append(data)
        assert data["configuration"]["language"] == "zh"
        assert data["configuration"]["strict_mode"] is True
        if model is source.Extraction:
            return source.Extraction(facts=[source.ExtractedFact(content="Tokyo", topic="custom", sub_topic="city", support_groups=[["1"]])], event_tags=[])
        fid = data["facts"][0]["fact_id"]
        return source.Reconciliation(decisions=[source.FactDecision(fact_id=fid, include=True)],
            profiles=[source.DerivedProfile(content="Tokyo", topic="custom", sub_topic="city", fact_ids=[fid])])
    monkeypatch.setattr(source, "_structured", structured)
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
    try:
        inserted = await source.import_source(source_user, "__root__", request())
        assert inserted.status == "completed" and len(seen) == 2
        with pytest.raises(source.SourceError, match="strict slots"):
            source._validate_profile_slots(source.Reconciliation(decisions=[], profiles=[source.DerivedProfile(
                content="Bad", topic="unconfigured", sub_topic="city", fact_ids=[uuid4()])]), seen[0]["configuration"])
    finally:
        with Session.begin() as session:
            session.query(Project).filter_by(project_id="__root__").update({"profile_config": old})


def test_missing_decision_and_invalid_support_are_errors():
    fid = uuid4()
    with pytest.raises(source.SourceError, match="Every fact"):
        source.validate_reconciliation(source.Reconciliation(decisions=[], profiles=[]), [{"id": fid}])
    assert source.retained_groups([["a", "b"], ["c"]], ["a"]) == [["c"]]


def test_input_never_truncates_and_rejects_oversized(monkeypatch):
    monkeypatch.setattr(CONFIG, "source_max_input_tokens", 2)
    with pytest.raises(source.SourceError, match="Complete source"):
        source.validate_budget("x", "s", source_text="many distinct words that exceed the budget")


def test_event_tag_values_must_match_project_definitions():
    rules = {"event_tag_definitions": [{"name": "hobby", "description": "Personal hobby"}]}
    assert source._validated_event_tags([source.SourceEventTag(tag="hobby", value="chess")], rules) == [
        {"tag": "hobby", "value": "chess"}]
    with pytest.raises(source.SourceError, match="configured definitions"):
        source._validated_event_tags([source.SourceEventTag(tag="city", value="Tokyo")], rules)


@pytest.mark.asyncio
async def test_event_tag_rebuild_skips_model_without_evidence_or_definitions(monkeypatch):
    structured = AsyncMock()
    monkeypatch.setattr(source, "_structured", structured)
    assert await source.rebuild_event_tags([], rules={"event_tag_definitions": [{"name": "hobby"}]},
                                           project_id="__root__") == []
    assert await source.rebuild_event_tags([{"content": "chess"}], rules={"event_tag_definitions": []},
                                           project_id="__root__") == []
    structured.assert_not_awaited()


@pytest.mark.asyncio
async def test_external_identity_reuses_effect_and_never_resurrects(source_user, models):
    body = request()
    first = await source.import_source(source_user, "__root__", body)
    changed_key = body.model_copy(update={"idempotency_key": "another-key"})
    second = await source.import_source(source_user, "__root__", changed_key)
    assert second.source_id == first.source_id and second.result == first.result
    assert models.await_count == 1
    await source.retract_messages(source_user, "__root__", first.source_id,
                                  RetractMessages(idempotency_key="forget", message_ids=["1", "2"]))
    third = await source.import_source(source_user, "__root__", body.model_copy(update={"idempotency_key": "third"}))
    assert third.status == "completed" and third.source_id == first.source_id
    assert not source.get_source(source_user, "__root__", source_id=first.source_id).evidence
    assert not (await profile.get_user_profiles(source_user, "__root__")).data().profiles


@pytest.mark.asyncio
async def test_profile_history_is_atomic_diff_and_redacts_retracted_evidence(source_user, models):
    first = await source.import_source(source_user, "__root__", request())
    history = source.get_history(source_user, "__root__")
    assert len(history) == 1 and len(history[0].profiles) == 2 and len(history[0].added) == 2
    await source.retract_messages(source_user, "__root__", first.source_id,
                                  RetractMessages(idempotency_key="forget", message_ids=["1"]))
    history = source.get_history(source_user, "__root__")
    assert len(history) == 2
    assert all("Tokyo" not in p.content for h in history for field in (h.profiles, h.added, h.removed) for p in field)
    with Session() as session:
        accepted = session.execute(select(memory_operations.c.request).where(memory_operations.c.id == first.operation_id)).scalar_one()
        assert accepted["messages"][0]["content"] == ""


@pytest.mark.asyncio
async def test_retract_completed_replay_does_not_recompute(source_user, models, monkeypatch):
    first = await source.import_source(source_user, "__root__", request())
    body = RetractMessages(idempotency_key="forget", message_ids=["1"])
    done = await source.retract_messages(source_user, "__root__", first.source_id, body)
    monkeypatch.setattr(source, "reconcile_facts", AsyncMock(side_effect=AssertionError("must not recompute")))
    assert await source.retract_messages(source_user, "__root__", first.source_id, body) == done
