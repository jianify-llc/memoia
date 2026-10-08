"""Source/blob/message contracts against isolated PostgreSQL and Redis."""
import asyncio
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from sqlalchemy import select, update, insert, delete, func
from sqlalchemy.exc import IntegrityError

from memoia_server.controllers import source
from memoia_server.connectors import Session
from memoia_server.env import CONFIG
from memoia_server.connectors import get_redis_client
from memoia_server.controllers.user_lease import UserLease
from memoia_server.models.database import User, UserEvent
from memoia_server.models.source import (
    ImportSource, DeleteMessages, memory_sources, memory_blobs, memory_messages,
    memory_operations, memory_facts,
    memory_fact_corrections,
)


def body(key, *ids, source_id="dialog-1"):
    return ImportSource(source_id=source_id, idempotency_key=key, messages=[{
        "message_id": mid, "role": "user", "content": "input " + mid,
        "occurred_at": datetime(2026, 1, int(mid), tzinfo=timezone.utc),
    } for mid in ids])


@pytest.fixture
def uid(db_env):
    uid = uuid4()
    with Session.begin() as session:
        session.execute(insert(User.__table__).values(id=uid, project_id="__root__", additional_fields={}))
    yield uid
    with Session.begin() as session:
        session.execute(delete(User).where(User.id == uid, User.project_id == "__root__"))


@pytest.fixture
def models(monkeypatch):
    async def extract(request, **kwargs):
        return source.ExtractedSource([dict(id=uuid4(), content="Likes chess", topic="interest", sub_topic="hobby",
            support_groups=[[m.message_id]], occurred_at=m.occurred_at) for m in request.messages])
    monkeypatch.setattr(source, "extract_source", extract)
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)


@pytest.mark.asyncio
async def test_group_appends_blobs_and_overlap_is_not_independent_evidence(uid, models):
    first = await source.import_source(uid, "__root__", body("batch1", "1"))
    second = await source.import_source(uid, "__root__", body("batch2", "1", "2"))
    replay = await source.import_source(uid, "__root__", body("batch2", "1", "2"))
    assert first.source_id == second.source_id == "dialog-1"
    assert first.blob_id != second.blob_id and second == replay
    group = source.get_source(uid, "__root__", source_id="dialog-1")
    assert len(group.blobs) == 2 and len(group.evidence) == 2
    assert [f.support_groups for f in group.evidence] == [[["1"]], [["2"]]]
    with Session() as session:
        assert session.scalar(select(func.count()).select_from(memory_sources).where(memory_sources.c.user_id == uid)) == 1
        for row in session.execute(select(memory_operations).where(memory_operations.c.user_id == uid)).mappings():
            assert "messages" not in row["request"] and row["input_expires_at"] is None
        assert "payload" not in memory_sources.c and "payload" not in memory_blobs.c


@pytest.mark.asyncio
async def test_message_conflict_and_source_isolation(uid, models):
    await source.import_source(uid, "__root__", body("a", "1"))
    changed = body("b", "1")
    changed.messages[0].content = "different body"
    with pytest.raises(source.SourceError) as caught:
        await source.import_source(uid, "__root__", changed)
    assert caught.value.code == "message_conflict"
    changed.source_id = "dialog-2"
    changed.idempotency_key = "c"
    assert (await source.import_source(uid, "__root__", changed)).status == "completed"


@pytest.mark.asyncio
@pytest.mark.parametrize("field,value", [("role", "assistant"),
    ("occurred_at", datetime(2026, 1, 2, tzinfo=timezone.utc))])
async def test_message_metadata_conflict(uid, models, field, value):
    await source.import_source(uid, "__root__", body("a", "1"))
    changed = body("b", "1")
    setattr(changed.messages[0], field, value)
    with pytest.raises(source.SourceError) as error:
        await source.import_source(uid, "__root__", changed)
    assert error.value.code == "message_conflict"


@pytest.mark.asyncio
async def test_deleting_message_rebuilds_all_blobs_without_original_text(uid, models):
    first = await source.import_source(uid, "__root__", body("a", "1"))
    await source.import_source(uid, "__root__", body("b", "1", "2"))
    operation = await source.delete_messages(uid, "__root__", "dialog-1",
        DeleteMessages(idempotency_key="delete-1", message_ids=["1"]))
    assert operation.status == "completed" and operation.blob_id is not None
    assert source.get_blob(uid, "__root__", operation.blob_id).kind == "retract"
    group = source.get_source(uid, "__root__", source_id="dialog-1")
    assert group.deleted_message_ids == ["1"]
    assert [f.support_groups for f in group.evidence] == [[["2"]]]
    assert source.get_blob(uid, "__root__", first.blob_id).status == "retracted"
    late = await source.import_source(uid, "__root__", body("late", "1"))
    assert late.status == "completed" and not late.result.event_ids
    assert len(source.get_source(uid, "__root__", source_id="dialog-1").evidence) == 1


@pytest.mark.asyncio
async def test_correction_has_its_own_evidence_and_deleted_proof_restores_old_fact(uid, models, monkeypatch):
    async def extract(request, **kwargs):
        related = kwargs["rules"].get("related_facts", [])
        if request.idempotency_key == "old":
            return source.ExtractedSource([dict(id=uuid4(), content="User lives in Beijing", subject="user",
                reporter="user", certainty="asserted", corrects=[], support_groups=[["1"]])])
        return source.ExtractedSource([dict(id=uuid4(), content="User lives in Shanghai", subject="user",
            reporter="user", certainty="asserted", support_groups=[["2"], ["4"]],
            corrects=[{"fact_id": related[0]["id"], "support_groups": [["2"]]}])])
    monkeypatch.setattr(source, "extract_source", extract)
    old = await source.import_source(uid, "__root__", body("old", "1"))
    newer = await source.import_source(uid, "__root__", body("correction", "2", "4"))
    with Session() as session:
        old_id, new_id = old.result.fact_ids[0], newer.result.fact_ids[0]
        assert not session.scalar(select(memory_facts.c.active).where(memory_facts.c.id == old_id))
        assert session.scalar(select(memory_facts.c.active).where(memory_facts.c.id == new_id))
    await source.delete_messages(uid, "__root__", "dialog-1",
        DeleteMessages(idempotency_key="remove-correction", message_ids=["2"]))
    with Session() as session:
        assert session.scalar(select(memory_facts.c.active).where(memory_facts.c.id == old_id))
        assert session.scalar(select(memory_facts.c.support_groups).where(memory_facts.c.id == new_id)) == [["4"]]
        assert session.scalar(select(func.count()).select_from(memory_fact_corrections).where(
            memory_fact_corrections.c.user_id == uid)) == 0
        changed = [c for batch in session.scalars(select(memory_blobs.c.fact_changes).where(memory_blobs.c.user_id == uid)) for c in batch]
        assert any(c["fact_id"] == str(old_id) and c["kind"] == "updated" for c in changed)
        assert all("messages" not in request for request in session.scalars(select(memory_operations.c.request).where(
            memory_operations.c.user_id == uid)))


@pytest.mark.asyncio
async def test_normal_time_change_is_not_an_explicit_correction(uid, models):
    await source.import_source(uid, "__root__", body("earlier", "1"))
    await source.import_source(uid, "__root__", body("later", "2"))
    with Session() as session:
        assert session.scalar(select(func.count()).select_from(memory_facts).where(memory_facts.c.user_id == uid,
            memory_facts.c.active)) == 2
        assert session.scalar(select(func.count()).select_from(memory_fact_corrections).where(
            memory_fact_corrections.c.user_id == uid)) == 0


@pytest.mark.asyncio
async def test_cross_source_correction_reads_related_old_assertion_not_full_sentence_and(uid, models, monkeypatch):
    old = await source.import_source(uid, "__root__", body("old", "1", source_id="earlier"))
    with Session.begin() as session:
        session.execute(update(memory_facts).where(memory_facts.c.id == old.result.fact_ids[0])
                        .values(content="User lives in Beijing"))
    async def extract(request, **kwargs):
        related = kwargs["rules"]["related_facts"]
        assert [f["id"] for f in related] == [str(old.result.fact_ids[0])]
        return source.ExtractedSource([dict(id=uuid4(), content="User lives in Shanghai", subject="user",
            reporter="user", certainty="asserted", support_groups=[["2"]],
            corrects=[{"fact_id": related[0]["id"], "support_groups": [["2"]]}])])
    monkeypatch.setattr(source, "extract_source", extract)
    corrected = body("correct", "2", source_id="new-dialog")
    corrected.messages[0].content = "Correction: I misspoke about Beijing; actually I live in Shanghai."
    await source.import_source(uid, "__root__", corrected)
    with Session() as session:
        assert not session.scalar(select(memory_facts.c.active).where(memory_facts.c.id == old.result.fact_ids[0]))


@pytest.mark.asyncio
async def test_capacity_repair_explicitly_resumes_original_import_receipt(uid, models, monkeypatch):
    original = source._related_facts
    def too_large(*args):
        raise source.SourceError("related_facts_too_large", "fixture capacity", 413)
    monkeypatch.setattr(source, "_related_facts", too_large)
    with pytest.raises(source.SourceError):
        await source.import_source(uid, "__root__", body("capacity", "1"))
    failed = source.get_operation(uid, "__root__", key="capacity")
    assert failed.status == "failed" and not failed.error.retryable
    monkeypatch.setattr(source, "_related_facts", original)
    done = await source.retry_operation(uid, "__root__", failed.operation_id)
    assert done.operation_id == failed.operation_id and done.status == "completed"


@pytest.mark.asyncio
async def test_empty_fact_and_repeated_batch_have_completable_maintenance_watermark(uid, models, monkeypatch):
    from tests.maintenance_support import maintain
    from memoia_server.controllers import maintenance
    async def empty(*args, **kwargs):
        return source.ExtractedSource([])
    monkeypatch.setattr(source, "extract_source", empty)
    first = await source.import_source(uid, "__root__", body("empty", "1"))
    assert first.result.fact_ids == [] and first.result.memory_version > 0
    assert await maintain(uid)
    again = await source.import_source(uid, "__root__", body("repeated", "1"))
    assert await maintain(uid)
    state = maintenance.get_status(uid, "__root__")
    assert state["pending_blob_count"] == 0
    assert all(row["status"] == "completed" for row in state["flushes"])
    assert source.get_operation(uid, "__root__", operation_id=first.operation_id) == first
    # An empty extraction still has input identities, all of which can be deleted.
    await source.delete_messages(uid, "__root__", "dialog-1",
        DeleteMessages(idempotency_key="delete-empty", message_ids=["1"]))
    assert source.get_blob(uid, "__root__", first.blob_id).status == "retracted"


@pytest.mark.asyncio
async def test_fact_search_does_not_require_event_and_deletion_is_immediate(uid, models, monkeypatch):
    from memoia_server.controllers import event
    from memoia_server.models.utils import Promise
    async def unavailable(*args, **kwargs):
        return Promise.reject("fixture lexical-only")
    monkeypatch.setattr(event, "get_embedding", unavailable)
    imported = await source.import_source(uid, "__root__", body("indexed", "1"))
    found = (await event.hybrid_search_user_events(uid, "__root__", "chess")).data()
    assert [f.id for f in found.facts] == imported.result.fact_ids
    assert not found.events
    with Session.begin() as session:
        # Legacy inclusion only governs old Profile selection, not factual validity.
        session.execute(update(memory_facts).where(memory_facts.c.id == imported.result.fact_ids[0]).values(included=False))
    assert (await event.hybrid_search_user_events(uid, "__root__", "chess")).data().facts
    await source.delete_messages(uid, "__root__", "dialog-1",
        DeleteMessages(idempotency_key="removed", message_ids=["1"]))
    assert not (await event.hybrid_search_user_events(uid, "__root__", "chess")).data().facts


@pytest.mark.asyncio
async def test_tombstone_before_first_batch_and_repeat_delete(uid, models):
    request = DeleteMessages(idempotency_key="early", message_ids=["1"])
    first = await source.delete_messages(uid, "__root__", "dialog-1", request)
    assert first == await source.delete_messages(uid, "__root__", "dialog-1", request)
    assert not (await source.import_source(uid, "__root__", body("late", "1"))).result.event_ids


@pytest.mark.asyncio
async def test_delete_fences_inflight_batch_and_resume_cannot_restore_contribution(uid, models, monkeypatch):
    entered, release = asyncio.Event(), asyncio.Event()
    extract = source.extract_source
    async def paused(request, **kwargs):
        entered.set()
        await release.wait()
        return await extract(request, **kwargs)
    monkeypatch.setattr(source, "extract_source", paused)
    execution = asyncio.create_task(source.import_source(uid, "__root__", body("a", "1")))
    try:
        await asyncio.wait_for(entered.wait(), timeout=5)
        # Simulate ownership loss while the supplier still holds the old input.
        async with get_redis_client() as redis:
            await redis.delete(UserLease(str(uid), "__root__").key)
        deleted = await source.delete_messages(uid, "__root__", "dialog-1",
            DeleteMessages(idempotency_key="d", message_ids=["1"]))
        assert deleted.status == "completed"
        release.set()
        with pytest.raises(source.SourceError):
            await execution
        monkeypatch.setattr(source, "extract_source", extract)
        receipt = source.get_operation(uid, "__root__", key="a")
        resumed = await source.retry_operation(uid, "__root__", receipt.operation_id)
        assert resumed.status == "completed" and not resumed.result.event_ids
        assert not source.get_source(uid, "__root__", source_id="dialog-1").evidence
        with Session() as session:
            assert "messages" not in session.scalar(select(memory_operations.c.request)
                .where(memory_operations.c.id == receipt.operation_id))
    finally:
        release.set()
        if not execution.done():
            execution.cancel()
            await asyncio.gather(execution, return_exceptions=True)


@pytest.mark.asyncio
async def test_joint_support_failure_and_independent_surviving_group(uid, models, monkeypatch):
    async def extract(request, **kwargs):
        return source.ExtractedSource([dict(id=uuid4(), content="Likes chess", topic="interest", sub_topic="hobby",
            support_groups=[["1", "2"], ["3"]], occurred_at=request.messages[-1].occurred_at)])
    monkeypatch.setattr(source, "extract_source", extract)
    imported = await source.import_source(uid, "__root__", body("a", "1", "2", "3"))
    await source.delete_messages(uid, "__root__", "dialog-1", DeleteMessages(idempotency_key="d2", message_ids=["2"]))
    fact = source.get_source(uid, "__root__", source_id="dialog-1").evidence[0]
    assert fact.support_groups == [["3"]]
    await source.delete_messages(uid, "__root__", "dialog-1", DeleteMessages(idempotency_key="d3", message_ids=["3"]))
    assert not source.get_source(uid, "__root__", source_id="dialog-1").evidence
    assert not source.get_blob(uid, "__root__", imported.blob_id).event_ids


@pytest.mark.asyncio
async def test_failed_input_expires_then_same_key_can_resupply(uid, models, monkeypatch):
    original = source.extract_source
    async def fail(*args, **kwargs):
        raise source.SourceError("provider_unavailable", "test failure", 503, True)
    monkeypatch.setattr(source, "extract_source", fail)
    request = body("a", "1")
    with pytest.raises(source.SourceError):
        await source.import_source(uid, "__root__", request)
    operation = source.get_operation(uid, "__root__", key="a")
    with Session.begin() as session:
        session.execute(update(memory_operations).where(memory_operations.c.id == operation.operation_id)
            .values(input_expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
    source.purge_expired_inputs()
    with pytest.raises(source.SourceError) as error:
        await source.retry_operation(uid, "__root__", operation.operation_id)
    assert error.value.code == "input_required"
    monkeypatch.setattr(source, "extract_source", original)
    recovered = await source.import_source(uid, "__root__", request)
    assert recovered.operation_id == operation.operation_id and recovered.status == "completed"


@pytest.mark.asyncio
async def test_retry_preserves_retention_deadline(uid, models, monkeypatch):
    async def fail(*args, **kwargs):
        raise source.SourceError("provider_unavailable", "test failure", 503, True)
    monkeypatch.setattr(source, "extract_source", fail)
    request = body("a", "1")
    with pytest.raises(source.SourceError):
        await source.import_source(uid, "__root__", request)
    operation = source.get_operation(uid, "__root__", key="a")
    with Session() as session:
        before = session.scalar(select(memory_operations.c.input_expires_at).where(memory_operations.c.id == operation.operation_id))
    with pytest.raises(source.SourceError):
        await source.retry_operation(uid, "__root__", operation.operation_id)
    with Session() as session:
        after = session.scalar(select(memory_operations.c.input_expires_at).where(memory_operations.c.id == operation.operation_id))
    assert before == after
    assert timedelta(days=6, hours=23) < before - datetime.now(timezone.utc) <= timedelta(days=7)


@pytest.mark.asyncio
async def test_database_rejects_foreign_owner_and_nonexistent_evidence(uid, models):
    imported = await source.import_source(uid, "__root__", body("a", "1"))
    with pytest.raises(IntegrityError), Session.begin() as session:
        session.execute(insert(memory_facts).values(id=uuid4(), user_id=uuid4(), project_id="__root__",
            blob_id=imported.blob_id, content="invalid", topic="interest", sub_topic="hobby",
            support_groups=[["1"]], occurred_at=datetime.now(timezone.utc)))
    with pytest.raises(IntegrityError), Session.begin() as session:
        session.execute(insert(memory_facts).values(id=uuid4(), user_id=uid, project_id="__root__",
            blob_id=imported.blob_id, content="invalid", topic="interest", sub_topic="hobby",
            support_groups=[["foreign-message"]], occurred_at=datetime.now(timezone.utc)))
    await source.import_source(uid, "__root__", body("b", "2", source_id="dialog-2"))
    with pytest.raises(IntegrityError), Session.begin() as session:
        session.execute(update(memory_operations).where(memory_operations.c.id == imported.operation_id)
            .values(source_id="dialog-2"))


@pytest.mark.asyncio
async def test_database_rejects_tombstone_resurrection(uid, models):
    await source.import_source(uid, "__root__", body("a", "1"))
    await source.delete_messages(uid, "__root__", "dialog-1", DeleteMessages(idempotency_key="d", message_ids=["1"]))
    with pytest.raises(IntegrityError), Session.begin() as session:
        session.execute(update(memory_messages).where(memory_messages.c.user_id == uid,
            memory_messages.c.project_id == "__root__", memory_messages.c.source_id == "dialog-1",
            memory_messages.c.message_id == "1").values(deleted=False))


@pytest.mark.asyncio
async def test_database_rejects_duplicate_support_groups_and_batch_receipts(uid, models):
    imported = await source.import_source(uid, "__root__", body("a", "1", "2"))
    with pytest.raises(IntegrityError), Session.begin() as session:
        session.execute(insert(memory_facts).values(id=uuid4(), user_id=uid, project_id="__root__",
            blob_id=imported.blob_id, content="invalid", topic="interest", sub_topic="hobby",
            support_groups=[["1", "2"], ["2", "1"]], occurred_at=datetime.now(timezone.utc)))
    with pytest.raises(IntegrityError), Session.begin() as session:
        session.execute(insert(memory_operations).values(id=uuid4(), user_id=uid, project_id="__root__",
            source_id="dialog-1", blob_id=imported.blob_id, idempotency_key="b", kind="import",
            request_hash="x", request={}, status="processing"))
