"""Fixed Blob sealing, per-user operation leases and atomic unified maintenance."""
import asyncio
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
    memory_sources, memory_messages, memory_facts, FlushInput)
from memoia_server.maintenance_agent import ProfileMutation, EventMutation, LoopUsage
from tests.maintenance_support import derive, claim_for


@pytest_asyncio.fixture
async def source_user(db_env):
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
async def test_old_failed_new_completed_then_old_recovery_reads_current_facts(source_user):
    bid, fid = batch(source_user)
    old = maintenance.flush(source_user, "__root__", "old")
    claim = claim_for(source_user)
    maintenance.fail_claim(claim, SourceError("invalid_model_output", "safe", 502, False))
    assert row(old.operation_id)["attempts"] == 1
    # A newer operation changes the same Fact; old recovery must not resurrect v1.
    with Session.begin() as session:
        session.execute(update(memory_facts).where(memory_facts.c.id == fid).values(
            content="Current corrected conclusion", revision=2))
    newer, _ = batch(source_user, 2, fact=False, changes=[{"kind": "corrected", "fact_id": str(fid)}])
    new = maintenance.flush(source_user, "__root__", "new")
    assert await maintenance.execute_claim(claim_for(source_user), runner=derive())
    assert row(new.operation_id)["status"] == "completed"
    assert row(old.operation_id)["status"] == "failed"
    maintenance.retry_flush(source_user, "__root__", old.operation_id)
    recovered = claim_for(source_user)
    assert recovered.operation_id == old.operation_id
    assert await maintenance.execute_claim(recovered, runner=derive())
    with Session() as session:
        assert list(session.scalars(select(UserProfile.content).where(UserProfile.user_id == source_user))) == ["Current corrected conclusion"]
        assert session.query(UserEvent).filter_by(user_id=source_user).count() == 1


@pytest.mark.asyncio
async def test_four_attempts_backoff_and_new_batch_cannot_reset_old_budget(source_user):
    batch(source_user)
    op = maintenance.flush(source_user, "__root__", "exhaust")
    for attempt in range(1, 5):
        ready(source_user)
        claim = claim_for(source_user)
        assert claim.attempts == attempt
        maintenance.fail_claim(claim, SourceError("model_unavailable", "safe", 503, True))
        assert row(op.operation_id)["lease_owner"] is None
    batch(source_user, 2)
    new = maintenance.flush(source_user, "__root__", "after-exhaust")
    assert claim_for(source_user).operation_id == new.operation_id
    assert row(op.operation_id)["attempts"] == 4
    recovered = maintenance.retry_flush(source_user, "__root__", op.operation_id)
    assert recovered.operation_id == op.operation_id and recovered.flush.attempts == 0


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
    def fail_event(session, claim, plan, kind):
        if kind == "event":
            raise SourceError("test_event_failure", "safe", 502, True)
        apply(session, claim, plan, kind)
    monkeypatch.setattr(maintenance, "_apply_plan", fail_event)
    assert not await maintenance.execute_claim(claim, runner=derive())
    with Session() as session:
        assert session.query(UserProfile).filter_by(user_id=source_user).count() == 0
        assert session.query(UserEvent).filter_by(user_id=source_user).count() == 0
    assert row(claim.operation_id)["status"] == "processing"


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
