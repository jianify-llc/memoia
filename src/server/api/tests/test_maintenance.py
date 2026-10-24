"""Fixed Blob sealing, per-user operation leases and atomic unified maintenance."""
import asyncio
import ast
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import delete, func, select, update, text
from sqlalchemy.exc import IntegrityError
from memoia_server.connectors import Session
from memoia_server.controllers import maintenance, source
from memoia_server.controllers.source import SourceError
from memoia_server.models.database import User, UserProfile, UserEvent
from memoia_server.models.source import (memory_operations as operations, memory_blobs as blobs,
    memory_sources, memory_messages, memory_facts, FlushInput, DeleteMessages, UpdateFact)
from memoia_server.maintenance_agent import ProfileMutation, EventMutation, LoopUsage, MaintenanceRunError, run_loop
from tests.maintenance_support import derive, claim_for
from tests.test_maintenance_agent import transport, completion, tool, http_failure


@pytest_asyncio.fixture
async def source_user(db_env, bounded_source_model):
    from memoia_server.controllers import user
    from memoia_server.models.response import UserData
    uid = str((await user.create_user(UserData(), "__root__")).data().id)
    try:
        yield uid
    finally:
        with Session.begin() as session:
            session.execute(delete(User).where(User.id == uid, User.project_id == "__root__"))


def batch(uid, version=1, *, sid=None, changes=None, age=0, fact=True):
    sid, bid, fid = sid or uuid4().hex, uuid4(), uuid4()
    with Session.begin() as session:
        session.execute(memory_sources.insert().values(user_id=uid, project_id="__root__", source_id=sid))
        session.execute(memory_messages.insert().values(user_id=uid, project_id="__root__", source_id=sid,
            message_id="m1", role="user", content_hash="no-body", processed=True, occurred_at=func.now()))
        session.execute(blobs.insert().values(id=bid, user_id=uid, project_id="__root__", source_id=sid,
            message_ids=["m1"], status="active"))
        if fact:
            session.execute(memory_facts.insert().values(id=fid, user_id=uid, project_id="__root__", blob_id=bid,
                content=f"Supported fact {version}", support_groups=[["m1"]], occurred_at=func.now(), created_version=version))
        maintenance.record_changes(session, uid, "__root__", bid, version,
            changes if changes is not None else [{"kind": "added", "fact_id": str(fid)}])
        if age:
            session.execute(update(blobs).where(blobs.c.id == bid).values(
                fact_completed_at=func.now() - timedelta(seconds=age)))
    return bid, fid


def ready(uid):
    maintenance.flush(uid, "__root__", f"ready:{uuid4()}")
    with Session.begin() as session:
        session.execute(update(operations).where(operations.c.user_id == uid, operations.c.kind == "flush",
            operations.c.status != "completed").values(available_at=func.now() - timedelta(seconds=1)))


def row(op_id):
    with Session() as session:
        return dict(session.execute(select(operations).where(operations.c.id == op_id)).mappings().one())


@pytest.mark.asyncio
async def test_failed_flush_records_precise_guard_code_without_tool_content(source_user, caplog):
    batch(source_user)
    maintenance.flush(source_user, "__root__", "diagnostic")
    claim = claim_for(source_user)
    async with maintenance.TaskLease(claim) as lease:
        context = maintenance.DBMaintenanceContext(claim, lease)
        change = ProfileMutation(action="upsert", id=str(uuid4()), content="protected-tool-content",
            topic=context.allowed_topics[0], sub_topic="fixture", fact_ids=[str(uuid4())])
        with pytest.raises(SourceError) as rejected:
            await context.stage_profile(change)
        assert rejected.value.code == "maintenance_target_unread"
    assert maintenance.fail_claim(claim, rejected.value)
    assert row(claim.operation_id)["error"] == {"code": "maintenance_target_unread", "retryable": False}
    assert "maintenance_target_unread" in caplog.text
    assert "protected-tool-content" not in caplog.text
    assert not maintenance.fail_claim(claim, SourceError("maintenance_target_unread", "private-error-text", 502))
    assert "private-error-text" not in caplog.text


@pytest.mark.asyncio
async def test_fact_rollback_cannot_leave_flush_intent(source_user):
    with pytest.raises(RuntimeError):
        with Session.begin() as session:
            bid = uuid4()
            sid = uuid4().hex
            session.execute(memory_sources.insert().values(user_id=source_user, project_id="__root__", source_id=sid))
            session.execute(blobs.insert().values(id=bid, user_id=source_user, project_id="__root__",
                source_id=sid, message_ids=[], status="active"))
            maintenance.record_changes(session, source_user, "__root__", bid, 1, [])
            raise RuntimeError("rollback")
    assert maintenance.get_status(source_user, "__root__")["pending_blob_count"] == 0


@pytest.mark.asyncio
async def test_explicit_flush_is_fixed_cross_source_and_idempotent(source_user):
    a, _ = batch(source_user)
    b, _ = batch(source_user, 2)
    first = maintenance.flush(source_user, "__root__", "same-flush")
    assert first.source_id is None and first.blob_id is None and first.kind == "flush"
    assert set(map(str, first.flush.blob_ids)) == {str(a), str(b)}
    c, _ = batch(source_user, 3)
    assert maintenance.flush(source_user, "__root__", "same-flush") == first
    next_op = maintenance.flush(source_user, "__root__", "next-flush")
    assert next_op.flush.blob_ids == [c]
    with Session() as session:
        assert session.scalar(select(blobs.c.flush_operation_id).where(blobs.c.id == a)) == first.operation_id
    empty = maintenance.flush(source_user, "__root__", "empty-flush")
    assert empty.status == "completed" and empty.result.blob_ids == []


@pytest.mark.asyncio
async def test_auto_flush_quiet_max_wait_and_queries_do_not_reset_clock(source_user):
    a, _ = batch(source_user, age=110)
    b, _ = batch(source_user, 2)
    maintenance.seal_due()
    assert maintenance.get_status(source_user, "__root__")["pending_blob_count"] == 2
    with Session.begin() as session:
        session.execute(update(blobs).where(blobs.c.id == a).values(
            fact_completed_at=func.now() - timedelta(seconds=121)))
    maintenance.seal_due()
    state = maintenance.get_status(source_user, "__root__")
    assert state["pending_blob_count"] == 0 and len(state["flushes"]) == 1
    assert set(map(str, state["flushes"][0]["blob_ids"])) == {str(a), str(b)}


@pytest.mark.asyncio
async def test_inflight_input_not_sealed_until_fact_commits(source_user):
    a, _ = batch(source_user)
    with Session.begin() as session:
        session.execute(update(blobs).where(blobs.c.id == a).values(fact_completed_at=None, fact_changes=[]))
    empty = maintenance.flush(source_user, "__root__", "while-processing")
    assert empty.status == "completed"
    with Session.begin() as session:
        maintenance.record_changes(session, source_user, "__root__", a, 1, [])
    following = maintenance.flush(source_user, "__root__", "after-fact")
    assert following.flush.blob_ids == [a]


@pytest.mark.asyncio
async def test_only_one_effective_loop_even_for_multiple_sealed_operations(source_user):
    batch(source_user)
    maintenance.flush(source_user, "__root__", "first")
    batch(source_user, 2)
    maintenance.flush(source_user, "__root__", "second")
    claims = await asyncio.gather(asyncio.to_thread(claim_for, source_user),
                                  asyncio.to_thread(claim_for, source_user))
    assert sum(claim is not None for claim in claims) == 1
    original = next(c for c in claims if c)
    assert maintenance.renew_claim(original)
    assert claim_for(source_user) is None


@pytest.mark.asyncio
async def test_new_input_during_run_is_not_acknowledged(source_user):
    first, _ = batch(source_user)
    maintenance.flush(source_user, "__root__", "first")
    claim = claim_for(source_user)
    newer, _ = batch(source_user, 2)
    assert await maintenance.execute_claim(claim, runner=derive())
    assert row(claim.operation_id)["result"]["blob_ids"] == [str(first)]
    with Session() as session:
        assert session.scalar(select(blobs.c.flush_operation_id).where(blobs.c.id == newer)) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("removed", [False, True], ids=["current-support", "deleted-support"])
@pytest.mark.parametrize("support_error", [False, True], ids=["valid-support", "corrected-support"])
@pytest.mark.parametrize("change_kind", ["evidence", "updated"])
async def test_old_failed_new_completed_then_old_recovery_reads_current_facts(source_user, removed, support_error, change_kind):
    bid, fid = batch(source_user)
    old = maintenance.flush(source_user, "__root__", "old")
    claim = claim_for(source_user)
    maintenance.fail_claim(claim, SourceError("invalid_model_output", "safe", 502, False))
    assert row(old.operation_id)["attempts"] == 1
    # Recovery reads today's Fact even when the old sealed batch still says added.
    current_time = datetime(2026, 1, 1, tzinfo=timezone.utc)
    current_content = "Supported fact corrected" if change_kind == "updated" else "Supported fact 1"
    with Session.begin() as session:
        session.execute(update(memory_facts).where(memory_facts.c.id == fid).values(
            content=current_content, occurred_at=current_time, revision=2))
    newer, _ = batch(source_user, 2, fact=False, changes=[{"kind": change_kind, "fact_id": str(fid)}])
    new = maintenance.flush(source_user, "__root__", "new")
    assert await maintenance.execute_claim(claim_for(source_user), runner=derive())
    assert row(new.operation_id)["status"] == "completed"
    assert row(old.operation_id)["status"] == "failed"
    with Session() as session:
        profile_id = session.scalar(select(UserProfile.id).where(UserProfile.user_id == source_user))
        event_id = session.scalar(select(UserEvent.id).where(UserEvent.user_id == source_user))
        sid = session.scalar(select(blobs.c.source_id).where(blobs.c.id == bid))
    if removed:
        await source.delete_messages(source_user, "__root__", sid,
            DeleteMessages(idempotency_key="delete-before-old-recovery", message_ids=["m1"]))

    async def discover_current(context):
        page = await context.read_changes()
        assert page["items"][0]["kind"] == "added"  # The original change kind did not become "evidence".
        if removed:
            assert page["items"][0]["current_fact"] is None
            for collection, ident in (("profiles", profile_id), ("events", event_id)):
                linked = await context.read(collection)
                assert [item["id"] for item in linked["items"]] == [str(ident)]
                assert linked["items"][0]["fact_ids"] == []
                assert linked["items"][0]["invalid_fact_ids"] == [str(fid)]
            if support_error:
                for kind, ident, factory in (("profile", profile_id, ProfileMutation), ("event", event_id, EventMutation)):
                    fields = dict(topic=context.allowed_topics[0], sub_topic="fixture") if kind == "profile" else {}
                    rejected = await context.stage_batch([factory(action="upsert", id=str(ident),
                        content="Must not restore deleted evidence", fact_ids=[str(fid)], **fields)], kind)
                    assert rejected["staged"] is False
            await context.stage_profile(ProfileMutation(action="remove", id=str(profile_id)))
            await context.stage_event(EventMutation(action="remove", id=str(event_id)))
            return context.get_plan(LoopUsage())
        assert datetime.fromisoformat(page["items"][0]["current_fact"]["occurred_at"]) == current_time
        assert page["items"][0]["current_fact"]["content"] == current_content
        found = await context.search("Supported fact")
        assert [item["id"] for item in found["profiles"]] == [str(profile_id)]
        assert [item["id"] for item in found["events"]] == [str(event_id)]
        if support_error:
            for kind, ident, factory in (("profile", profile_id, ProfileMutation), ("event", event_id, EventMutation)):
                fields = dict(topic=context.allowed_topics[0], sub_topic="fixture") if kind == "profile" else {}
                rejected = await context.stage_batch([factory(action="upsert", id=str(ident),
                    content="Must correct the support ID", fact_ids=[str(uuid4())], **fields)], kind)
                assert rejected["staged"] is False
        await context.stage_profile(ProfileMutation(action="upsert", id=str(profile_id),
            content=found["profiles"][0]["content"], topic=context.allowed_topics[0],
            sub_topic="fixture", fact_ids=[str(fid)]))
        await context.stage_event(EventMutation(action="upsert", id=str(event_id),
            content=found["events"][0]["content"], event_time=found["events"][0]["event_time"], fact_ids=[str(fid)]))
        return context.get_plan(LoopUsage())

    maintenance.retry_flush(source_user, "__root__", old.operation_id)
    recovered = claim_for(source_user)
    assert recovered.operation_id == old.operation_id
    assert await maintenance.execute_claim(recovered, runner=discover_current)
    with Session() as session:
        if removed:
            assert session.query(UserProfile).filter_by(user_id=source_user).count() == 0
            assert session.query(UserEvent).filter_by(user_id=source_user).count() == 0
            assert session.scalar(select(memory_facts.c.id).where(memory_facts.c.id == fid)) is None
            return
        assert list(session.scalars(select(UserProfile.content).where(UserProfile.user_id == source_user))) == [current_content]
        assert session.scalar(select(UserProfile.id).where(UserProfile.user_id == source_user)) == profile_id
        assert session.query(UserEvent).filter_by(user_id=source_user).count() == 1
        assert session.scalar(select(UserEvent.id).where(UserEvent.user_id == source_user)) == event_id
        assert session.scalar(select(UserEvent.event_data).where(UserEvent.user_id == source_user))["event_time"] == current_time.isoformat()


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["profile", "event"])
async def test_deleted_support_rejects_whole_batch_and_cannot_commit_unresolved_plan(source_user, kind):
    _, valid = batch(source_user)
    deleted = uuid4()
    batch(source_user, 2, fact=False, changes=[{"kind": "deleted", "fact_id": str(deleted)}])
    operation = maintenance.flush(source_user, "__root__", "deleted-support-unresolved")
    factory = ProfileMutation if kind == "profile" else EventMutation
    async def runner(context):
        await context.read_changes()
        fields = dict(topic=context.allowed_topics[0], sub_topic="fixture") if kind == "profile" else {}
        good = factory(action="upsert", content="Supported memory", fact_ids=[str(valid)], **fields)
        bad = factory(action="upsert", content="Unsupported memory", fact_ids=[str(deleted)], **fields)
        rejected = await context.stage_batch([good, bad], kind)
        assert rejected["staged"] is False
        assert rejected["error"] == {"code": "maintenance_support_invalid",
                                     "unread_fact_ids": [], "invalid_fact_ids": [str(deleted)]}
        assert context._staged == {"profiles": {}, "events": {}}
        return context.get_plan(LoopUsage())
    assert not await maintenance.execute_claim(claim_for(source_user), runner=runner)
    assert row(operation.operation_id)["error"]["code"] == "maintenance_unresolved_staging"
    with Session() as session:
        assert session.query(UserProfile).filter_by(user_id=source_user).count() == 0
        assert session.query(UserEvent).filter_by(user_id=source_user).count() == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("deleted", [False, True], ids=["edit-background", "delete-background"])
async def test_event_background_support_locates_rewrite_and_fences_old_loop(source_user, deleted):
    _, main_fact = batch(source_user)
    background_blob, background_fact = batch(source_user, 2)
    with Session.begin() as session:
        session.execute(update(memory_facts).where(memory_facts.c.id == main_fact)
                        .values(content="The user performed at a charity concert."))
        session.execute(update(memory_facts).where(memory_facts.c.id == background_fact)
                        .values(content="The user sings alto."))
    maintenance.flush(source_user, "__root__", "with-background")
    async def create(context):
        await context.read_changes()
        await context.stage_event(EventMutation(action="upsert",
            content="The user performed at a charity concert.", summary="The alto singer performed.",
            keywords="charity concert, alto", fact_ids=[str(main_fact), str(background_fact)]))
        return context.get_plan(LoopUsage())
    assert await maintenance.execute_claim(claim_for(source_user), runner=create)
    with Session() as session:
        event = session.query(UserEvent).filter_by(user_id=source_user).one()
        event_id, original_data = str(event.id), dict(event.event_data)
        sid = session.scalar(select(blobs.c.source_id).where(blobs.c.id == background_blob))
        revision = session.scalar(select(memory_facts.c.revision).where(memory_facts.c.id == background_fact))

    batch(source_user, 3, fact=False, changes=[{"kind": "evidence", "fact_id": str(main_fact)}])
    old = maintenance.flush(source_user, "__root__", "before-background-change")
    async def stale(context):
        await context.read_changes()
        entry = (await context.read("events"))["items"][0]
        await context.stage_event(EventMutation(action="upsert", id=event_id,
            content=entry["content"], summary="Old background must not be committed.",
            keywords=entry["keywords"], fact_ids=entry["fact_ids"]))
        if deleted:
            await source.delete_messages(source_user, "__root__", sid,
                DeleteMessages(idempotency_key="remove-background", message_ids=["m1"]))
        else:
            await source.update_fact(source_user, "__root__", background_fact,
                UpdateFact(idempotency_key="edit-background", expected_revision=revision,
                    reason="Correct the voice part", content="The user sings soprano.",
                    subject="the user", reporter="the user", certainty="asserted",
                    support_groups=[["m1"]], fact_time=None))
        return context.get_plan(LoopUsage())
    assert not await maintenance.execute_claim(claim_for(source_user), runner=stale)
    assert row(old.operation_id)["error"]["code"] == "maintenance_read_conflict"
    with Session() as session:
        assert session.scalar(select(UserEvent.event_data).where(UserEvent.id == event_id)) == original_data

    updated = maintenance.flush(source_user, "__root__", "after-background-change")
    async def rewrite(context):
        await context.read_changes()
        # The changed Fact only appeared in summary/keywords, never in content.
        linked = await context.read("events")
        assert [entry["id"] for entry in linked["items"]] == [event_id]
        entry = linked["items"][0]
        assert entry.get("pending_delete", False) is False
        assert entry["invalid_fact_ids"] == ([str(background_fact)] if deleted else [])
        await context.stage_event(EventMutation(action="upsert", id=event_id,
            content=entry["content"], summary="The user performed." if deleted else "The soprano singer performed.",
            keywords="charity concert" if deleted else "charity concert, soprano",
            fact_ids=entry["fact_ids"]))
        return context.get_plan(LoopUsage())
    claim = claim_for(source_user)
    assert claim.operation_id == updated.operation_id
    assert await maintenance.execute_claim(claim, runner=rewrite)
    with Session() as session:
        data = session.scalar(select(UserEvent.event_data).where(UserEvent.id == event_id))
        assert data["content"] == original_data["content"]
        assert set(data["fact_ids"]) == ({str(main_fact)} if deleted else {str(main_fact), str(background_fact)})
        assert "alto" not in data["summary"] + data["keywords"]
        assert ("soprano" in data["keywords"]) is not deleted
        assert session.scalar(select(memory_facts.c.id).where(memory_facts.c.id == main_fact)) == main_fact


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [SourceError("model_unavailable", "safe", 503, True),
    MaintenanceRunError("MAINTENANCE_PARENT_UNAVAILABLE", retryable=True),
    MaintenanceRunError("MAINTENANCE_CONVERSATION_LOCKED", retryable=True)])
async def test_four_attempts_backoff_and_new_batch_cannot_reset_old_budget(source_user, error):
    batch(source_user)
    op = maintenance.flush(source_user, "__root__", "exhaust")
    for attempt in range(1, 5):
        ready(source_user)
        claim = claim_for(source_user)
        assert claim.attempts == attempt
        maintenance.fail_claim(claim, error)
        failed = row(op.operation_id)
        assert failed["lease_owner"] is None
        assert failed["status"] == ("processing" if attempt < 4 else "failed")
        if attempt < 4:
            # Scheduling uses PostgreSQL time; a Docker host can have clock skew.
            with Session() as session:
                now = session.scalar(select(func.clock_timestamp()))
            remaining = (failed["available_at"] - now).total_seconds()
            assert maintenance.RETRY_SECONDS[attempt - 1] - 5 <= remaining <= maintenance.RETRY_SECONDS[attempt - 1]
    batch(source_user, 2)
    new = maintenance.flush(source_user, "__root__", "after-exhaust")
    assert claim_for(source_user).operation_id == new.operation_id
    assert row(op.operation_id)["attempts"] == 4
    recovered = maintenance.retry_flush(source_user, "__root__", op.operation_id)
    assert recovered.operation_id == op.operation_id and recovered.flush.attempts == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("deleted", [False, True])
async def test_parent_loss_recovers_original_operation_without_stale_staged_writes(source_user, transport, deleted):
    from memoia_server.models.source import DeleteMessages
    sid = uuid4().hex
    bid, fid = batch(source_user, sid=sid)
    op = maintenance.flush(source_user, "__root__", "lost-parent")
    original = claim_for(source_user)

    async def fail_after_staging(context):
        transport["outcomes"] = [
            completion(None, calls=[tool("read_changes", {})], response_id="resp-read"),
            completion(None, calls=[tool("stage_profile", {"changes": [{
                "action": "upsert", "id": None, "topic": context.allowed_topics[0],
                "sub_topic": "fixture", "content": "Never commit this failed draft",
                "fact_ids": ["f1"]}]}, "stage-1")], response_id="resp-stage"),
            http_failure(400, code="previous_response_not_found", param="previous_response_id"),
        ]
        return await run_loop(context)

    assert not await maintenance.execute_claim(original, runner=fail_after_staging)
    failed = row(op.operation_id)
    assert failed["status"] == "processing" and failed["attempts"] == 1
    assert failed["error"] == {"code": "MAINTENANCE_PARENT_UNAVAILABLE", "retryable": True}
    assert failed["lease_owner"] is None and failed["result"] is None
    assert claim_for(source_user) is None  # The original backoff is enforced.
    with Session() as session:
        assert session.query(UserProfile).filter_by(user_id=source_user).count() == 0
        assert session.query(UserEvent).filter_by(user_id=source_user).count() == 0
        assert session.scalar(select(blobs.c.flush_operation_id).where(blobs.c.id == bid)) == op.operation_id

    if deleted:
        result = await source.delete_messages(source_user, "__root__", sid,
            DeleteMessages(idempotency_key="delete-during-backoff", message_ids=["m1"]))
        assert result.status == "completed"
    # Advance only this fixture's clock, not the retry count or identity.
    with Session.begin() as session:
        session.execute(update(operations).where(operations.c.id == op.operation_id)
                        .values(available_at=func.now() - timedelta(seconds=1)))
    recovered = claim_for(source_user)
    assert recovered.operation_id == original.operation_id and recovered.blob_ids == original.blob_ids
    assert recovered.attempts == 2 and recovered.generation > original.generation
    assert not maintenance.fail_claim(original, MaintenanceRunError("stale", retryable=True))
    with Session.begin() as session, pytest.raises(SourceError, match="ownership was lost"):
        maintenance.assert_claim(session, original)

    restart_index = len(transport["requests"])
    transport["responses"] = [
        completion(None, calls=[tool("read_changes", {})], response_id="resp-new"), completion(),
    ]
    assert await maintenance.execute_claim(recovered)
    restarted, continued = transport["requests"][restart_index:]
    assert "previous_response_id" not in restarted
    assert all("prompt_cache_key" not in body for body in transport["requests"])
    assert continued["previous_response_id"] == "resp-new"
    # The pinned Agents SDK serializes dict tool results with str(), not JSON.
    changes = ast.literal_eval(continued["input"][0]["output"])["items"]
    assert (changes[0]["current_fact"] is None) == deleted
    assert row(op.operation_id)["status"] == "completed"
    with Session() as session:
        assert session.query(UserProfile).filter_by(user_id=source_user).count() == 0
        assert session.query(UserEvent).filter_by(user_id=source_user).count() == 0
        assert bool(session.scalar(select(memory_facts.c.id).where(memory_facts.c.id == fid))) != deleted


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [400, 404])
async def test_unclassified_parent_error_stops_operation_without_automatic_replay(source_user, transport, status):
    batch(source_user)
    op = maintenance.flush(source_user, "__root__", "unknown-provider-error")
    transport["responses"] = []
    transport["outcomes"] = [completion(None, calls=[tool("read_changes", {})]),
        http_failure(status, param="previous_response_id", message="previous_response_not_found")]
    assert not await maintenance.execute_claim(claim_for(source_user))
    assert row(op.operation_id)["status"] == "failed"
    assert row(op.operation_id)["error"] == {"code": "model_configuration_rejected", "retryable": False}
    assert claim_for(source_user) is None


@pytest.mark.asyncio
async def test_model_wait_renews_short_operation_lease_without_holding_write_lock(source_user):
    batch(source_user)
    op = maintenance.flush(source_user, "__root__", "slow-model")
    claim = claim_for(source_user)
    async with maintenance.TaskLease(claim, ttl=.6) as lease:
        initial_expiry = row(op.operation_id)["lease_until"]
        await asyncio.sleep(.9)
        await lease.assert_active()
        assert row(op.operation_id)["lease_until"] > initial_expiry
        assert claim_for(source_user) is None
        # A new Fact batch can still arrive while this model execution waits.
        batch(source_user, 2)
        assert maintenance.get_status(source_user, "__root__")["pending_blob_count"] == 1


@pytest.mark.asyncio
async def test_expired_lease_is_fenced_and_other_batch_can_proceed(source_user):
    batch(source_user)
    old = maintenance.flush(source_user, "__root__", "killed")
    claim = maintenance.claim_next(lease_seconds=.05)
    await asyncio.sleep(.06)
    batch(source_user, 2)
    new = maintenance.flush(source_user, "__root__", "following")
    next_claim = claim_for(source_user)
    assert next_claim.operation_id == new.operation_id
    assert not maintenance.renew_claim(claim)
    assert row(old.operation_id)["error"]["code"] == "maintenance_lease_expired"
    with Session.begin() as session, pytest.raises(SourceError):
        maintenance.assert_claim(session, claim)


@pytest.mark.asyncio
async def test_unified_atomic_commit_rolls_back_profile_if_event_apply_fails(source_user, monkeypatch):
    batch(source_user)
    maintenance.flush(source_user, "__root__", "atomic")
    claim = claim_for(source_user)
    apply = maintenance._apply_plan
    def fail_event(session, claim, plan, kind, event_embeddings, impact):
        if kind == "event":
            raise SourceError("test_event_failure", "safe", 502, True)
        apply(session, claim, plan, kind, event_embeddings, impact)
    monkeypatch.setattr(maintenance, "_apply_plan", fail_event)
    assert not await maintenance.execute_claim(claim, runner=derive())
    with Session() as session:
        assert session.query(UserProfile).filter_by(user_id=source_user).count() == 0
        assert session.query(UserEvent).filter_by(user_id=source_user).count() == 0
    assert row(claim.operation_id)["status"] == "processing"
    assert row(claim.operation_id)["error"] == {"code": "test_event_failure", "retryable": True}


@pytest.mark.asyncio
async def test_database_rejects_cross_user_flush_assignment(source_user):
    bid, _ = batch(source_user)
    other = uuid4()
    with Session.begin() as session:
        session.execute(User.__table__.insert().values(id=other, project_id="__root__", additional_fields={}))
    try:
        op = maintenance.flush(other, "__root__", "other")
        with pytest.raises(IntegrityError), Session.begin() as session:
            session.execute(update(blobs).where(blobs.c.id == bid).values(flush_operation_id=op.operation_id))
    finally:
        with Session.begin() as session:
            session.execute(delete(User).where(User.id == other))


@pytest.mark.asyncio
async def test_sealed_batch_cannot_be_reassigned_or_rewritten(source_user):
    bid, _ = batch(source_user)
    operation = maintenance.flush(source_user, "__root__", "sealed")
    for changes in ({"flush_operation_id": None}, {"fact_changes": []},
                    {"message_ids": ["different"]}, {"fact_completed_at": None}):
        with pytest.raises(IntegrityError), Session.begin() as session:
            session.execute(update(blobs).where(blobs.c.id == bid).values(**changes))
    assert row(operation.operation_id)["request"]["blob_ids"] == [str(bid)]
    with pytest.raises(IntegrityError), Session.begin() as session:
        session.execute(update(operations).where(operations.c.id == operation.operation_id).values(request={"blob_ids": []}))


@pytest.mark.asyncio
async def test_background_claim_skips_busy_identity_without_waiting(source_user):
    batch(source_user, age=121)
    with Session.begin() as holder:
        source.lock_user_identity(holder, source_user, "__root__")
        await asyncio.wait_for(asyncio.to_thread(maintenance.seal_due), timeout=2)
    assert maintenance.get_status(source_user, "__root__")["pending_blob_count"] == 1
    operation = maintenance.flush(source_user, "__root__", "after-busy")
    with Session.begin() as holder:
        source.lock_user_identity(holder, source_user, "__root__")
        assert await asyncio.wait_for(asyncio.to_thread(claim_for, source_user), timeout=2) is None
    assert claim_for(source_user).operation_id == operation.operation_id


@pytest.mark.asyncio
async def test_forgetting_user_preempts_staged_loop(source_user):
    batch(source_user)
    maintenance.flush(source_user, "__root__", "forget")
    async def runner(context):
        plan = await derive()(context)
        source.forget_user(source_user, "__root__")
        return plan
    assert not await maintenance.execute_claim(claim_for(source_user), runner=runner)
    with Session() as session:
        assert session.query(UserProfile).filter_by(user_id=source_user).count() == 0
        assert session.query(UserEvent).filter_by(user_id=source_user).count() == 0
