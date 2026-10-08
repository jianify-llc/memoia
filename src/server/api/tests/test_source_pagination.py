"""Bounded provenance reads; independent pages are never claimed to be complete."""
import pytest
from sqlalchemy import event, delete, update

from memoia_server.connectors import DB_ENGINE, Session
from memoia_server.controllers import source, blob
from memoia_server.models.blob import BlobData
from memoia_server.models.source import DeleteMessages, memory_blobs
from memoia_server.models.database import UserEvent
from tests.test_source_groups import uid, models, body


@pytest.mark.asyncio
async def test_legacy_blob_validation_never_echoes_private_input():
    invalid = BlobData(blob_type="chat", blob_data={"messages": [{"content": "PRIVATE_MARKER"}]})
    result = await blob.insert_blob("unused", "unused", invalid)
    assert not result.ok() and result.msg() == "CODE 400; ERROR Invalid blob data"
    assert "PRIVATE_MARKER" not in result.msg()


@pytest.mark.asyncio
async def test_summary_and_independent_pages_have_constant_query_count(uid, models):
    for index in range(1, 7):
        await source.import_source(uid, "__root__", body(f"batch-{index}", str(index)))
    await source.delete_messages(uid, "__root__", "dialog-1",
        DeleteMessages(idempotency_key="delete-1", message_ids=["1"]))
    statements = []
    def capture(_connection, _cursor, statement, *_):
        if statement.lstrip().startswith("SELECT"):
            statements.append(statement)
    event.listen(DB_ENGINE, "before_cursor_execute", capture)
    try:
        summary = source.list_sources(uid, "__root__")
        assert len(statements) == 1
        assert set(summary[0].model_dump()) == {"source_id", "legacy", "created_at"}
        statements.clear()
        first = source.get_source(uid, "__root__", source_id="dialog-1", limit=2)
        assert len(statements) == 6
        assert first.message_ids == ["1", "2"] and first.deleted_message_ids == ["1"]
        assert (first.next_message_offset, first.next_blob_offset, first.next_evidence_offset) == (2, 2, 2)
        statements.clear()
        second = source.get_source(uid, "__root__", source_id="dialog-1", limit=2,
                                   message_offset=2, blob_offset=2, evidence_offset=2)
        assert len(statements) == 6
        assert second.message_ids == ["3", "4"] and second.deleted_message_ids == []
        assert not {b.blob_id for b in first.blobs}.intersection(b.blob_id for b in second.blobs)
        # Evidence observations survive when their IDs are outside this message page.
        independent = source.get_source(uid, "__root__", source_id="dialog-1", limit=2,
                                        message_offset=6)
        assert independent.message_ids == [] and independent.next_message_offset is None
        assert all(f.source_messages for f in independent.evidence)
        last = source.get_source(uid, "__root__", source_id="dialog-1", limit=2,
                                 message_offset=4, blob_offset=4, evidence_offset=4)
        assert last.message_ids == ["5", "6"]
        assert last.next_message_offset is last.next_evidence_offset is None
        assert last.next_blob_offset == 6
        deletion_page = source.get_source(uid, "__root__", source_id="dialog-1", blob_offset=6, limit=2)
        assert len(deletion_page.blobs) == 1 and deletion_page.blobs[0].kind == "retract"
        assert deletion_page.next_blob_offset is None
        assert len(first.blobs) == len(second.blobs) == len(last.blobs) == 2
        assert len(first.evidence) + len(second.evidence) + len(last.evidence) == 5
        statements.clear()
        whole_page = source.get_source(uid, "__root__", source_id="dialog-1", limit=6)
        assert len(statements) == 6
        assert len(whole_page.blobs) == 6 and len(whole_page.evidence) == 5
        assert whole_page.next_blob_offset == 6
    finally:
        event.remove(DB_ENGINE, "before_cursor_execute", capture)


@pytest.mark.asyncio
async def test_legacy_blob_parent_deleted_without_flag_never_returns_dangling_id(uid, models):
    receipt = await source.import_source(uid, "__root__", body("legacy-parent", "1"))
    with Session.begin() as session:
        parent = UserEvent(user_id=uid, project_id="__root__", event_data={"event_tip": "Legacy event"})
        session.add(parent)
        session.flush()
        event_id = parent.id
        session.execute(update(memory_blobs).where(memory_blobs.c.id == receipt.blob_id).values(event_id=event_id))
    assert source.get_blob(uid, "__root__", receipt.blob_id).event_ids == [event_id]
    assert source.get_source(uid, "__root__", source_id="dialog-1").blobs[0].event_ids == [event_id]
    with Session.begin() as session:
        session.execute(delete(UserEvent).where(UserEvent.id == event_id, UserEvent.user_id == uid,
            UserEvent.project_id == "__root__"))
    assert source.get_blob(uid, "__root__", receipt.blob_id).event_ids == []
    group = source.get_source(uid, "__root__", source_id="dialog-1")
    assert group.blobs[0].event_ids == [] and len(group.evidence) == 1


@pytest.mark.parametrize("page", [{"limit": 0}, {"limit": 101}, {"message_offset": -1},
                                  {"blob_offset": -1}, {"evidence_offset": -1}])
def test_bad_page_rejected_before_database(page):
    with pytest.raises(source.SourceError, match="Invalid source page"):
        source.get_source("unused", "unused", source_id="unused", **page)
