"""Bounded source access and off-event-loop SQL; models stay deterministic."""
import asyncio
import json
import threading
from datetime import datetime, timezone
from uuid import uuid4
from unittest.mock import AsyncMock

import numpy as np
import pytest
from sqlalchemy import event as sql_event, select

from memoia_server.connectors import DB_ENGINE, Session, get_redis_client
from memoia_server.controllers import source
from memoia_server.controllers.user_lease import UserLease
from memoia_server.models.source import DeleteMessages, memory_facts, memory_blobs, memory_messages, memory_sources
from tests.test_sources import source_user, models, request


@pytest.mark.asyncio
async def test_noop_batch_reads_only_input_identities_and_never_reads_facts_or_calls_models(source_user, models, monkeypatch):
    body = request()
    await source.import_source(source_user, "__root__", body)
    statements, message_reads = [], []
    original = source._message_rows
    def tracked_messages(session, uid, pid, sid, ids):
        message_reads.append(set(ids))
        return original(session, uid, pid, sid, ids)
    def capture(connection, cursor, statement, parameters, context, executemany):
        statements.append(statement)
    monkeypatch.setattr(source, "_message_rows", tracked_messages)
    model, embedding = AsyncMock(side_effect=AssertionError("noop extraction")), AsyncMock(side_effect=AssertionError("noop embedding"))
    monkeypatch.setattr(source, "extract_source", model)
    monkeypatch.setattr(source, "get_embedding", embedding)
    sql_event.listen(DB_ENGINE, "before_cursor_execute", capture)
    try:
        done = await source.import_source(source_user, "__root__", body.model_copy(update={"idempotency_key": "overlap"}))
    finally:
        sql_event.remove(DB_ENGINE, "before_cursor_execute", capture)
    assert done.status == "completed" and done.result.fact_ids == []
    assert message_reads and all(ids == {"1", "2"} for ids in message_reads)
    assert not any("memory_facts" in statement for statement in statements)
    model.assert_not_awaited()
    embedding.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_reads_related_inputs_only_and_reuses_unchanged_fact_embedding(source_user, models, monkeypatch):
    now = datetime.now(timezone.utc)
    async def extract(body, **kwargs):
        return source.ExtractedSource([dict(id=uuid4(), content="The user likes chess",
            support_groups=[[m.message_id] for m in body.messages], occurred_at=now)])
    monkeypatch.setattr(source, "extract_source", extract)
    def batch(key, *ids):
        return request(key, messages=[{"message_id": mid, "role": "user", "content": "I like chess",
            "occurred_at": now} for mid in ids])
    first = await source.import_source(source_user, "__root__", batch("first", "a", "b"))
    unrelated = await source.import_source(source_user, "__root__", batch("other", "c", "d"))
    with Session() as session:
        vector = session.scalar(select(memory_facts.c.embedding).where(memory_facts.c.id == first.result.fact_ids[0]))
    reads = []
    original = source._message_rows
    def tracked_messages(session, uid, pid, sid, ids):
        reads.append(set(ids))
        return original(session, uid, pid, sid, ids)
    monkeypatch.setattr(source, "_message_rows", tracked_messages)
    embedding = AsyncMock(side_effect=AssertionError("unchanged indexed text must reuse its embedding"))
    monkeypatch.setattr(source, "get_embedding", embedding)
    done = await source.delete_messages(source_user, "__root__", first.source_id,
        DeleteMessages(idempotency_key="delete-a", message_ids=["a"]))
    assert done.status == "completed" and done.result.fact_ids == first.result.fact_ids
    assert reads == [{"a", "b"}]
    embedding.assert_not_awaited()
    with Session() as session:
        after = session.execute(select(memory_facts).where(memory_facts.c.id == first.result.fact_ids[0])).mappings().one()
        assert after["support_groups"] == [["b"]] and np.array_equal(after["embedding"], vector)
        assert session.scalar(select(memory_facts.c.support_groups).where(memory_facts.c.id == unrelated.result.fact_ids[0])) == [["c"], ["d"]]


@pytest.mark.asyncio
async def test_import_delete_and_recovery_run_complete_sql_units_off_event_loop(source_user, models):
    loop_thread, observed = threading.get_ident(), []
    entered, release = threading.Event(), threading.Event()
    def capture(connection, cursor, statement, parameters, context, executemany):
        observed.append(threading.get_ident())
        if statement.startswith("UPDATE memory_user_states") and not entered.is_set():
            entered.set()
            assert release.wait(5), "event loop did not advance while the SQL unit was blocked"
    sql_event.listen(DB_ENGINE, "before_cursor_execute", capture)
    execution = asyncio.create_task(source.import_source(source_user, "__root__", request()))
    try:
        async with asyncio.timeout(5):
            while not entered.is_set():
                await asyncio.sleep(.01)
        assert not execution.done()
        release.set()
        imported = await execution
        assert await source.retry_operation(source_user, "__root__", imported.operation_id) == imported
        removed = await source.delete_messages(source_user, "__root__", imported.source_id,
            DeleteMessages(idempotency_key="offloop-delete", message_ids=["1"]))
        assert removed.status == "completed"
    finally:
        release.set()
        await asyncio.gather(execution, return_exceptions=True)
        sql_event.remove(DB_ENGINE, "before_cursor_execute", capture)
    assert observed and all(ident != loop_thread for ident in observed)


@pytest.mark.asyncio
async def test_cancelled_sql_commit_finishes_before_releasing_user_lease(source_user, models, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    def capture(connection, cursor, statement, parameters, context, executemany):
        if statement.startswith("INSERT INTO memory_facts") and not entered.is_set():
            entered.set()
            assert release.wait(5), "cancelled SQL was not allowed to finish"
    monkeypatch.setattr(source, "UserLease", lambda uid, pid: UserLease(uid, pid, ttl=.15))
    body = request()
    key = UserLease(source_user, "__root__").key
    sql_event.listen(DB_ENGINE, "before_cursor_execute", capture)
    execution = asyncio.create_task(source.import_source(source_user, "__root__", body))
    try:
        async with asyncio.timeout(5):
            while not entered.is_set():
                await asyncio.sleep(.01)
        execution.cancel()
        # The SQL unit is still running. More than two lease TTLs prove the event
        # loop and heartbeat stay live while cancellation waits for its outcome.
        await asyncio.sleep(.35)
        assert not execution.done()
        assert await get_redis_client().get(key) is not None
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await execution
    finally:
        release.set()
        await asyncio.gather(execution, return_exceptions=True)
        sql_event.remove(DB_ENGINE, "before_cursor_execute", capture)
    receipt = source.get_operation(source_user, "__root__", key=body.idempotency_key)
    assert receipt.status == "completed" and await get_redis_client().get(key) is None
    assert await source.import_source(source_user, "__root__", body) == receipt
    assert models.await_count == 1


@pytest.mark.asyncio
async def test_delete_one_message_in_large_source_fetches_only_affected_rows(source_user, models):
    now, sid = datetime.now(timezone.utc), "large-source"
    batches = [(str(index), uuid4(), uuid4()) for index in range(10_000)]
    with Session.begin() as session:
        session.execute(memory_sources.insert().values(user_id=source_user, project_id="__root__", source_id=sid))
        session.execute(memory_messages.insert(), [dict(user_id=source_user, project_id="__root__", source_id=sid,
            message_id=mid, content_hash="0" * 64, role="user", occurred_at=now, processed=True) for mid, _, _ in batches])
        session.execute(memory_blobs.insert(), [dict(id=bid, user_id=source_user, project_id="__root__", source_id=sid,
            message_ids=[mid], status="active") for mid, bid, _ in batches])
        session.execute(memory_facts.insert(), [dict(id=fid, user_id=source_user, project_id="__root__", blob_id=bid,
            content="Historical statement " + mid, support_groups=[[mid]], occurred_at=now) for mid, bid, fid in batches])
    plans = {}
    def capture(connection, cursor, statement, parameters, context, executemany):
        if not statement.startswith("SELECT"):
            return
        kind = "facts" if "FROM memory_facts" in statement else "blobs" if "FROM memory_blobs" in statement else None
        if kind is not None:
            plan = connection.exec_driver_sql("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + statement, parameters).scalar_one()[0]
            plans[kind] = plan
    sql_event.listen(DB_ENGINE, "before_cursor_execute", capture)
    try:
        done = await source.delete_messages(source_user, "__root__", sid,
            DeleteMessages(idempotency_key="delete-one-large-source", message_ids=["5000"]))
    finally:
        sql_event.remove(DB_ENGINE, "before_cursor_execute", capture)
    assert done.status == "completed" and done.result.fact_ids == [batches[5000][2]]
    assert plans["facts"]["Plan"]["Actual Rows"] == 1
    assert plans["blobs"]["Plan"]["Actual Rows"] == 2  # Original input plus this deletion Blob.
    print("source-delete-explain " + json.dumps(plans))
