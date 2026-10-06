"""Incremental effects use real isolated SQL/Redis; model output is deterministic."""
import asyncio
from datetime import datetime, timezone
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import select

from tests.test_sources import source_user, models, request
from memoia_server.controllers import source, profile
from memoia_server.connectors import Session
from memoia_server.env import CONFIG
from memoia_server.models.database import UserProfile, UserEvent
from memoia_server.models.source import memory_facts, DeleteMessages


def day(number):
    return datetime(2026, 1, number, tzinfo=timezone.utc)


def fact(topic, content="fact"):
    return {"id": uuid4(), "topic": topic, "sub_topic": "value", "content": content,
            "occurred_at": day(1), "support_groups": [["m"]]}


def test_scope_expands_transitive_cross_topic_dependencies_and_keeps_excluded_facts():
    a, b, c, other = [fact(topic) for topic in ("work", "health", "habits", "interest")]
    b["included"] = False
    profiles = [
        {"id": "p1", "topic": "work", "fact_ids": [str(a["id"]), str(b["id"])]},
        {"id": "p2", "topic": "health", "fact_ids": [str(b["id"]), str(c["id"])]},
        {"id": "p3", "topic": "interest", "fact_ids": [str(other["id"])]},
    ]
    scope = source.reconciliation_scope([a, b, c, other], profiles, [a])
    assert scope.topics == frozenset({"work", "health", "habits"})
    assert {f["id"] for f in scope.facts} == {a["id"], b["id"], c["id"]}


@pytest.mark.asyncio
async def test_withdrawal_recomputes_time_from_remaining_independent_support(source_user, models, monkeypatch):
    async def extract(body, **kwargs):
        return source.ExtractedSource([{**fact("basic", "Beijing"), "sub_topic": "city",
            "support_groups": [["old"], ["new"]], "occurred_at": day(3)}], [])
    monkeypatch.setattr(source, "extract_source", extract)
    imported = await source.import_source(source_user, "__root__", request(messages=[
        {"message_id": mid, "role": "user", "content": "Beijing", "occurred_at": when}
        for mid, when in (("old", day(1)), ("new", day(3)))
    ]))
    await source.delete_messages(source_user, "__root__", imported.source_id,
        DeleteMessages(idempotency_key="withdraw-new", message_ids=["new"]))
    with Session() as session:
        row = session.execute(select(memory_facts).where(memory_facts.c.blob_id == imported.blob_id)).mappings().one()
        assert row["support_groups"] == [["old"]]
        assert row["occurred_at"] == day(1)
        event = session.query(UserEvent).filter_by(user_id=source_user, project_id="__root__").one()
        assert event.created_at == day(1)


@pytest.mark.asyncio
async def test_new_topic_leaves_unrelated_profile_id_content_and_update_time_unchanged(source_user, models, monkeypatch):
    async def extract(body, **kwargs):
        return source.ExtractedSource([{**fact(m.content, m.content), "support_groups": [[m.message_id]],
                                       "occurred_at": m.occurred_at} for m in body.messages], [])
    monkeypatch.setattr(source, "extract_source", extract)
    first = await source.import_source(source_user, "__root__", request("first", "first", messages=[
        {"message_id": "m1", "role": "user", "content": "work", "occurred_at": day(1)}]))
    with Session() as session:
        row = session.get(UserProfile, (first.result.profile_ids[0], "__root__"))
        before = (row.id, row.content, row.updated_at)
    reconcile = source.reconcile_facts
    recorder = AsyncMock(side_effect=reconcile)
    monkeypatch.setattr(source, "reconcile_facts", recorder)
    await source.import_source(source_user, "__root__", request("second", "second", messages=[
        {"message_id": "m2", "role": "user", "content": "interest", "occurred_at": day(2)}]))
    assert [f["topic"] for f in recorder.call_args.args[0]] == ["interest"]
    with Session() as session:
        row = session.get(UserProfile, (before[0], "__root__"))
        assert (row.id, row.content, row.updated_at) == before


@pytest.mark.asyncio
async def test_withdraw_correction_restores_previously_excluded_fact(source_user, models, monkeypatch):
    async def latest(candidates, **kwargs):
        winner = max(candidates, key=lambda f: f["occurred_at"]) if candidates else None
        return source.Reconciliation(
            decisions=[source.FactDecision(fact_id=f["id"], include=f is winner) for f in candidates],
            profiles=[] if winner is None else [source.DerivedProfile(content=winner["content"],
                topic=winner["topic"], sub_topic=winner["sub_topic"], fact_ids=[winner["id"]])])
    monkeypatch.setattr(source, "reconcile_facts", latest)
    await source.import_source(source_user, "__root__", request("old", "old", messages=[
        {"message_id": "city", "role": "user", "content": "Beijing", "occurred_at": day(1)}]))
    newer = await source.import_source(source_user, "__root__", request("new", "new", messages=[
        {"message_id": "city", "role": "user", "content": "Shanghai", "occurred_at": day(2)}]))
    with Session() as session:
        assert session.execute(select(memory_facts.c.included).where(memory_facts.c.content == "Beijing",
            memory_facts.c.user_id == source_user)).scalar_one() is False
    await source.delete_messages(source_user, "__root__", newer.source_id,
        DeleteMessages(idempotency_key="withdraw-correction", message_ids=["city"]))
    assert [p.content for p in (await profile.get_user_profiles(source_user, "__root__")).data().profiles] == ["Beijing"]


@pytest.mark.asyncio
async def test_withdraw_latest_support_restores_correct_order_against_other_source(source_user, models, monkeypatch):
    async def extract(body, **kwargs):
        return source.ExtractedSource([{**fact("basic", body.messages[0].content),
            "support_groups": [[m.message_id] for m in body.messages],
            "occurred_at": max(m.occurred_at for m in body.messages)}], [])
    async def latest(candidates, **kwargs):
        winner = max(candidates, key=lambda f: f["occurred_at"])
        return source.Reconciliation(
            decisions=[source.FactDecision(fact_id=f["id"], include=f is winner) for f in candidates],
            profiles=[source.DerivedProfile(content=winner["content"], topic="basic", sub_topic="city", fact_ids=[winner["id"]])])
    monkeypatch.setattr(source, "extract_source", extract)
    monkeypatch.setattr(source, "reconcile_facts", latest)
    beijing = await source.import_source(source_user, "__root__", request("beijing", "beijing", messages=[
        {"message_id": mid, "role": "user", "content": "Beijing", "occurred_at": when}
        for mid, when in (("old", day(1)), ("latest", day(3)))]))
    await source.import_source(source_user, "__root__", request("shanghai", "shanghai", messages=[
        {"message_id": "city", "role": "user", "content": "Shanghai", "occurred_at": day(2)}]))
    assert [p.content for p in (await profile.get_user_profiles(source_user, "__root__")).data().profiles] == ["Beijing"]
    await source.delete_messages(source_user, "__root__", beijing.source_id,
        DeleteMessages(idempotency_key="withdraw-latest-support", message_ids=["latest"]))
    assert [p.content for p in (await profile.get_user_profiles(source_user, "__root__")).data().profiles] == ["Shanghai"]


@pytest.mark.asyncio
async def test_failed_empty_topic_rebuild_retains_scope_for_retry(source_user, models, monkeypatch):
    imported = await source.import_source(source_user, "__root__", request())
    original = source.reconcile_facts
    recorder = AsyncMock(side_effect=source.SourceError("model_failure", "test", 503, True))
    monkeypatch.setattr(source, "reconcile_facts", recorder)
    body = DeleteMessages(idempotency_key="remove-all", message_ids=["1", "2"])
    with pytest.raises(source.SourceError):
        await source.delete_messages(source_user, "__root__", imported.source_id, body)
    monkeypatch.setattr(source, "reconcile_facts", original)
    receipt = source.get_operation(source_user, "__root__", key=body.idempotency_key)
    resumed = await source.retry_operation(source_user, "__root__", receipt.operation_id)
    assert resumed.status == "completed"
    assert source.get_blob(source_user, "__root__", imported.blob_id).status == "retracted"
    assert not (await profile.get_user_profiles(source_user, "__root__")).data().profiles


@pytest.mark.asyncio
async def test_cancelled_withdrawal_retains_topic_scope_after_evidence_disappears(source_user, models, monkeypatch):
    imported = await source.import_source(source_user, "__root__", request())
    original = source.reconcile_facts
    started = asyncio.Event()
    async def blocked(candidates, **kwargs):
        started.set()
        await asyncio.Event().wait()
    monkeypatch.setattr(source, "reconcile_facts", blocked)
    body = DeleteMessages(idempotency_key="cancel-withdrawal", message_ids=["1", "2"])
    execution = asyncio.create_task(source.delete_messages(source_user, "__root__", imported.source_id, body))
    await asyncio.wait_for(started.wait(), timeout=5)
    execution.cancel()
    with pytest.raises(asyncio.CancelledError):
        await execution
    receipt = source.get_operation(source_user, "__root__", key=body.idempotency_key)
    assert receipt.status == "processing"
    assert source.get_source(source_user, "__root__", source_id=imported.source_id).evidence == []
    recorder = AsyncMock(side_effect=original)
    monkeypatch.setattr(source, "reconcile_facts", recorder)
    resumed = await source.retry_operation(source_user, "__root__", receipt.operation_id)
    assert resumed.status == "completed"
    assert recorder.call_args.kwargs["affected_topics"] == frozenset({"basic"})


@pytest.mark.asyncio
async def test_out_of_scope_model_profile_cannot_commit_new_evidence(source_user, models, monkeypatch):
    async def invalid(candidates, **kwargs):
        return source.Reconciliation(
            decisions=[source.FactDecision(fact_id=f["id"], include=True) for f in candidates],
            profiles=[source.DerivedProfile(content="unrelated", topic="unrelated", sub_topic="value",
                                           fact_ids=[f["id"] for f in candidates])])
    monkeypatch.setattr(source, "reconcile_facts", invalid)
    with pytest.raises(source.SourceError) as error:
        await source.import_source(source_user, "__root__", request())
    assert error.value.code == "invalid_model_output"
    groups = source.list_sources(source_user, "__root__")
    assert len(groups) == 1
    detail = source.get_source(source_user, "__root__", source_id=groups[0].source_id)
    assert not detail.evidence and detail.blobs[0].status == "failed"
    assert not (await profile.get_user_profiles(source_user, "__root__")).data().profiles


@pytest.mark.asyncio
async def test_reconciliation_budget_error_is_distinct_and_does_not_call_model(monkeypatch):
    monkeypatch.setattr(CONFIG, "source_context_window_tokens", 1)
    model = AsyncMock()
    monkeypatch.setattr(source, "_structured", model)
    with pytest.raises(source.SourceError) as error:
        await source.reconcile_facts([fact("work")])
    assert error.value.code == "reconciliation_too_large" and not error.value.retryable
    model.assert_not_awaited()


@pytest.mark.asyncio
async def test_capacity_withdrawal_stays_hidden_and_only_explicit_retry_resumes(source_user, models, monkeypatch):
    imported = await source.import_source(source_user, "__root__", request())
    original = source.reconcile_facts
    failed = AsyncMock(side_effect=source.SourceError("reconciliation_too_large", "test", 413))
    monkeypatch.setattr(source, "reconcile_facts", failed)
    body = DeleteMessages(idempotency_key="capacity-withdraw", message_ids=["1"])
    with pytest.raises(source.SourceError):
        await source.delete_messages(source_user, "__root__", imported.source_id, body)
    receipt = source.get_operation(source_user, "__root__", key=body.idempotency_key)
    assert receipt.status == "failed" and not receipt.error.retryable
    assert source.get_blob(source_user, "__root__", imported.blob_id).status == "rebuilding"
    assert all("Tokyo" not in p.content for p in (await profile.get_user_profiles(source_user, "__root__")).data().profiles)
    assert await source.delete_messages(source_user, "__root__", imported.source_id, body) == receipt
    assert failed.await_count == 1
    monkeypatch.setattr(source, "reconcile_facts", original)
    resumed = await source.retry_operation(source_user, "__root__", receipt.operation_id)
    assert resumed.status == "completed" and resumed.operation_id == receipt.operation_id
    assert [p.content for p in (await profile.get_user_profiles(source_user, "__root__")).data().profiles] == ["I enjoy chess"]


@pytest.mark.asyncio
async def test_oversized_unrelated_history_is_not_sent_to_model(source_user, models, monkeypatch):
    async def extract(body, **kwargs):
        topic = "work" if body.source_id == "log-1" else "interest"
        return source.ExtractedSource([{**fact(topic, "chess"), "support_groups": [["1"]]}], [])
    monkeypatch.setattr(source, "extract_source", extract)
    old = await source.import_source(source_user, "__root__", request())
    # Use actual SQL history, not a fixture list hidden from the scope selector.
    with Session.begin() as session:
        session.execute(memory_facts.insert(), [{**fact("work", "historical evidence " * 120),
            "support_groups": [["1"]],
            "blob_id": old.blob_id, "user_id": source_user, "project_id": "__root__"} for _ in range(80)])
    monkeypatch.setattr(CONFIG, "source_context_window_tokens", 12000)
    monkeypatch.setattr(CONFIG, "source_output_reserve_tokens", 64)
    with Session() as session:
        history = source._read_facts(session, source_user, "__root__")
    with pytest.raises(source.SourceError):
        source.validate_budget(" ".join(f["content"] for f in history), source.RECONCILE_SYSTEM)
    async def structured(model, prompt, system, **kwargs):
        import json
        data = json.loads(prompt)
        assert model is source.Reconciliation
        assert data["affected_topics"] == ["interest"]
        assert [f["content"] for f in data["facts"]] == ["chess"]
        fid = data["facts"][0]["fact_id"]
        return source.Reconciliation(decisions=[source.FactDecision(fact_id=fid, include=True)],
            profiles=[source.DerivedProfile(content="chess", topic="interest", sub_topic="value", fact_ids=[fid])])
    monkeypatch.setattr(source, "reconcile_facts", ORIGINAL_RECONCILE)
    monkeypatch.setattr(source, "_structured", structured)
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
    result = await source.import_source(source_user, "__root__", request("small", "small"))
    assert result.status == "completed"


ORIGINAL_RECONCILE = source.reconcile_facts
