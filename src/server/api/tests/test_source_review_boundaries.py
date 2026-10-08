"""Regression boundaries: invalidated derivations, durable v1 cleanup, legacy receipts."""
import asyncio
import json
from uuid import uuid4

import pytest
from sqlalchemy import event as sql_event, insert, select, text, update
from sqlalchemy.exc import IntegrityError

from tests.test_source_groups import uid, models, body
from tests.test_schema_adoption import legacy_schema, install_legacy, migrate
from memoia_server.connectors import DB_ENGINE, Session
from memoia_server.controllers import source, profile, maintenance
from memoia_server.env import CONFIG
from tests.maintenance_support import derive, maintain, status
from tests.test_maintenance import ready
from memoia_server.controllers.buffer import flush_buffer_by_ids
from memoia_server.models.database import GeneralBlob, BufferZone, UserProfile
from memoia_server.models.blob import BlobType
from memoia_server.models.source import DeleteMessages, memory_operations, memory_facts


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["provider", "capacity", "cancel"])
async def test_partial_support_change_commits_fact_and_preserves_pending_derived_scope(uid, models, monkeypatch, failure):
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
    async def extract(request, **kwargs):
        return source.ExtractedSource([
            dict(id=uuid4(), content="Lives in Beijing", topic="work", sub_topic="city",
                 support_groups=[["1"], ["3"]], occurred_at=request.messages[2].occurred_at),
            dict(id=uuid4(), content="Lives in Shanghai", topic="work", sub_topic="city",
                 support_groups=[["2"]], occurred_at=request.messages[1].occurred_at),
            dict(id=uuid4(), content="Likes chess", topic="interest", sub_topic="hobby",
                 support_groups=[["2"]], occurred_at=request.messages[1].occurred_at),
        ])

    monkeypatch.setattr(source, "extract_source", extract)
    await source.import_source(uid, "__root__", body("batch", "1", "2", "3"))
    runner = derive(latest=True, queries=("Lives in",))
    assert await maintain(uid, runner)
    with Session() as session:
        unrelated = session.query(UserProfile).filter_by(user_id=uid, content="Likes chess").one()
        unchanged = (unrelated.id, unrelated.updated_at)

    async def fail(*args, **kwargs):
        if failure == "cancel":
            raise asyncio.CancelledError()
        raise source.SourceError("reconciliation_too_large" if failure == "capacity" else "model_unavailable",
                                 "fixture failure", 413 if failure == "capacity" else 503, failure != "capacity")
    operation = await source.delete_messages(uid, "__root__", "dialog-1",
        DeleteMessages(idempotency_key="delete-3", message_ids=["3"]))
    assert operation.status == "completed"
    if failure == "cancel":
        with pytest.raises(asyncio.CancelledError):
            await maintain(uid, fail)
    else:
        assert not await maintain(uid, fail)
    # Failure does not roll back the synchronous Fact receipt, and stale text is
    # explicitly permitted while the independent maintenance status is pending.
    assert {p.content for p in (await profile.get_user_profiles(uid, "__root__")).data().profiles} == {
        "Lives in Beijing", "Likes chess"}
    assert source.get_operation(uid, "__root__", key="delete-3") == operation
    with Session() as session:
        fact = session.execute(select(memory_facts).where(memory_facts.c.user_id == uid,
            memory_facts.c.content == "Lives in Beijing")).mappings().one()
        assert fact["support_groups"] == [["1"]] and fact["occurred_at"].day == 1
        unrelated = session.get(UserProfile, (unchanged[0], "__root__"))
        assert (unrelated.id, unrelated.updated_at) == unchanged
    state = status(uid, "__root__")
    assert state["error"]["code"] == ("maintenance_cancelled" if failure == "cancel" else
        "reconciliation_too_large" if failure == "capacity" else "model_unavailable")
    maintenance.retry_flush(uid, "__root__", state["operation_id"])
    ready(uid)
    assert await maintain(uid, runner)
    assert {p.content for p in (await profile.get_user_profiles(uid, "__root__")).data().profiles} == {
        "Lives in Shanghai", "Likes chess"}


@pytest.mark.asyncio
@pytest.mark.parametrize("old_receipt", [False, True])
async def test_v1_operation_recovery_atomically_scrubs_original_blob(uid, models, monkeypatch, old_receipt):
    raw, buffer = uuid4(), uuid4()
    with Session.begin() as session:
        session.execute(insert(GeneralBlob.__table__).values(id=raw, user_id=uid, project_id="__root__",
            blob_type="chat", blob_data={"messages": [{"role": "user", "content": "private raw fixture"}]}))
        session.execute(insert(BufferZone.__table__).values(id=buffer, user_id=uid, project_id="__root__",
            blob_type="chat", blob_id=raw, token_size=10, status="idle"))
    original = source.extract_source
    async def fail(*args, **kwargs):
        raise source.SourceError("model_unavailable", "fixture failure", 503, True)
    monkeypatch.setattr(source, "extract_source", fail)
    assert not (await flush_buffer_by_ids(uid, "__root__", BlobType.chat, [buffer])).ok()
    with Session.begin() as session:
        operation = session.execute(select(memory_operations).where(memory_operations.c.user_id == uid)).mappings().one()
        assert operation["request"]["legacy_buffers"] == {"buffer_ids": [str(buffer)], "blob_ids": [str(raw)]}
        if old_receipt:
            # Before durable cleanup metadata existed, recovery still has the exact
            # server-generated v1 message IDs. Do not invent a different input identity.
            session.execute(update(memory_operations).where(memory_operations.c.id == operation["id"])
                .values(request={key: value for key, value in operation["request"].items() if key != "legacy_buffers"}))
            # The legacy conversion path is separately exercised by the migration test;
            # this test keeps a native pending receipt and supplies server-owned identities.
    monkeypatch.setattr(source, "extract_source", original)
    if old_receipt:
        recovered = await source.import_source(uid, "__root__",
            source.ImportSource.model_validate({key: value for key, value in operation["request"].items()
                                               if key != "legacy_buffers"}), legacy_buffers=([buffer], [raw]))
    else:
        recovered = await source.retry_operation(uid, "__root__", operation["id"])
    assert recovered.status == "completed"
    with Session() as session:
        assert session.get(GeneralBlob, (raw, "__root__")) is None
        assert session.get(BufferZone, (buffer, "__root__")) is None
        request = session.scalar(select(memory_operations.c.request).where(memory_operations.c.id == operation["id"]))
        assert set(request) == {"source_id", "idempotency_key"}


@pytest.mark.asyncio
async def test_v1_cleanup_failure_rolls_back_memory_and_receipt_then_recovers(uid, models):
    raw, buffer = uuid4(), uuid4()
    with Session.begin() as session:
        session.execute(insert(GeneralBlob.__table__).values(id=raw, user_id=uid, project_id="__root__",
            blob_type="chat", blob_data={"messages": [{"role": "user", "content": "private raw fixture"}]}))
        session.execute(insert(BufferZone.__table__).values(id=buffer, user_id=uid, project_id="__root__",
            blob_type="chat", blob_id=raw, token_size=10, status="idle"))

    def fail_cleanup(connection, cursor, statement, parameters, context, executemany):
        if statement.startswith("DELETE FROM general_blobs"):
            raise source.SourceError("cleanup_failure", "fixture failure", 503, True)

    sql_event.listen(DB_ENGINE, "before_cursor_execute", fail_cleanup)
    try:
        assert not (await flush_buffer_by_ids(uid, "__root__", BlobType.chat, [buffer])).ok()
    finally:
        sql_event.remove(DB_ENGINE, "before_cursor_execute", fail_cleanup)
    with Session() as session:
        operation = session.execute(select(memory_operations).where(memory_operations.c.user_id == uid)).mappings().one()
        assert operation["status"] == "failed" and operation["result"] is None
        assert session.get(GeneralBlob, (raw, "__root__")) is not None
        assert not session.execute(select(memory_facts).where(memory_facts.c.user_id == uid)).first()
        assert not session.query(UserProfile).filter_by(user_id=uid).first()
    recovered = await source.retry_operation(uid, "__root__", operation["id"])
    assert recovered.status == "completed"
    with Session() as session:
        assert session.get(GeneralBlob, (raw, "__root__")) is None
        assert "messages" not in session.scalar(select(memory_operations.c.request)
            .where(memory_operations.c.id == operation["id"]))


@pytest.mark.parametrize("unconfirmed", [False, True])
def test_old_alias_receipts_upgrade_without_duplicate_executor(legacy_schema, unconfirmed):
    engine, url = legacy_schema
    install_legacy(engine)
    assert migrate(url, "0005_user_tombstones").returncode == 0
    user, blob = uuid4(), uuid4()
    payload = {"external_id": "old-batch", "messages": [{"message_id": "1", "role": "user",
        "content": "fixture", "occurred_at": "2026-01-01T00:00:00Z"}], "metadata": {}}
    receipts = [uuid4(), uuid4()]
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO projects(id,project_id,project_secret,status) VALUES(:id,'alias-upgrade','fixture','active')"), {"id": uuid4()})
        connection.execute(text("INSERT INTO users(id,project_id) VALUES(:id,'alias-upgrade')"), {"id": user})
        connection.execute(text("""INSERT INTO memory_sources(id,user_id,project_id,external_id,payload,request_hash,status)
            VALUES(:id,:uid,'alias-upgrade','old-batch',CAST(:body AS jsonb),'fixture','active')"""),
            {"id": blob, "uid": user, "body": json.dumps(payload)})
        for operation, key in zip(receipts, ["original", "alias"]):
            connection.execute(text("""INSERT INTO memory_operations(id,user_id,project_id,idempotency_key,kind,
                request_hash,request,external_id,source_id,status,result)
                VALUES(:id,:uid,'alias-upgrade',:key,'import','fixture',CAST(:body AS jsonb),'old-batch',:blob,
                'completed','{"event_ids":[],"profile_ids":[]}')"""),
                {"id": operation, "uid": user, "key": key, "body": json.dumps({**payload, "idempotency_key": key}), "blob": blob})
        if unconfirmed:
            connection.execute(text("UPDATE memory_operations SET status='processing',result=NULL WHERE id=:id"),
                               {"id": receipts[0]})
    upgraded = migrate(url)
    if unconfirmed:
        assert upgraded.returncode != 0
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0005_user_tombstones"
            assert connection.scalar(text("SELECT count(*) FROM memory_operations WHERE kind='import'")) == 2
        return
    assert upgraded.returncode == 0, upgraded.stderr
    with engine.connect() as connection:
        rows = connection.execute(text("SELECT * FROM memory_operations ORDER BY id")).mappings().all()
        assert {row["id"] for row in rows} == set(receipts)
        assert {row["kind"] for row in rows} == {"import", "legacy_import"}
        assert {row["idempotency_key"] for row in rows} == {"original", "alias"}
        assert all(row["blob_id"] == blob and row["source_id"] == "legacy:" + str(blob)
                   and row["status"] == "completed" and "messages" not in row["request"] for row in rows)
    with pytest.raises(IntegrityError), engine.begin() as connection:
        connection.execute(text("UPDATE memory_operations SET status='processing' WHERE kind='legacy_import'"))
