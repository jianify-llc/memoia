"""Targeted correction boundaries against isolated PostgreSQL and Redis."""
import asyncio
import os
import threading
from datetime import datetime, timezone, timedelta
from uuid import uuid4
from unittest.mock import AsyncMock

import numpy as np
import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select, update, delete, event as sql_event, text

from memoia_server.connectors import Session, DB_ENGINE
from memoia_server.controllers import source
from memoia_server.controllers.user_lease import CURRENT_LEASE
from memoia_server.env import CONFIG
from memoia_server.models.database import User, Project
from memoia_server.models.projects import project_api_keys
from memoia_server.models.source import (ImportSource, UpdateFact, DeleteFact, DeleteMessages,
    memory_facts as facts, memory_operations as operations, memory_blobs as blobs,
    memory_messages as messages, memory_profile_revisions as history)
from memoia_server.models.utils import Promise


def stored(table, ident):
    with Session() as session:
        return dict(session.execute(select(table).where(table.c.id == ident)).mappings().one())


@pytest_asyncio.fixture
async def correction(db_env, monkeypatch):
    uid = uuid4()
    async def extract(body, **kwargs):
        return source.ExtractedSource([dict(id=uuid4(), content="User lives in Tokyo", subject="user",
            reporter="user", certainty="asserted", support_groups=[["m1"], ["m2"]],
            fact_time=None, occurred_at=body.messages[1].occurred_at)])
    async def embed(_, texts, **kwargs):
        return Promise.resolve(np.ones((len(texts), CONFIG.embedding_dim)))
    monkeypatch.setattr(source, "extract_source", AsyncMock(side_effect=extract))
    monkeypatch.setattr(source, "get_embedding", AsyncMock(side_effect=embed))
    now = datetime.now(timezone.utc)
    body = ImportSource(idempotency_key="initial", source_id="dialog", messages=[
        dict(message_id="m1", role="user", content="Tokyo", occurred_at=now - timedelta(days=1)),
        dict(message_id="m2", role="user", content="Tokyo again", occurred_at=now),
        dict(message_id="assistant", role="assistant", content="Understood", occurred_at=now)])
    result = await source.import_source(uid, "__root__", body)
    fid = result.result.fact_ids[0]
    source.get_embedding.reset_mock()
    try:
        yield uid, fid, result.blob_id, now
    finally:
        with Session.begin() as session:
            session.execute(delete(User).where(User.id == uid, User.project_id == "__root__"))


def edit(key="edit", revision=1, **values):
    return UpdateFact(idempotency_key=key, expected_revision=revision, reason="Fix extraction",
        **{**dict(content="User lives in Tokyo", subject="user", reporter="user", certainty="asserted",
                   support_groups=[["m1"], ["m2"]], fact_time=None), **values})


def test_fact_metrics_normalize_target_id_and_preserve_query_route():
    from memoia_server.api_layer.middleware import AuthMiddleware
    middleware = AuthMiddleware(None)
    assert middleware.normalize_path(f"/api/users/{uuid4()}/facts/{uuid4()}") == "/api/users/{id}/facts/{id}"
    assert middleware.normalize_path(f"/api/users/{uuid4()}/facts/query") == "/api/users/{id}/facts/query"


@pytest.mark.asyncio
@pytest.mark.parametrize("method,handler", [("PUT", "update_fact"), ("DELETE", "delete_fact")])
@pytest.mark.parametrize("status,http_status", [("completed", 200), ("processing", 202)])
async def test_correction_http_status_matches_openapi(monkeypatch, method, handler, status, http_status):
    from fastapi import FastAPI
    from memoia_server.api_layer.source import router
    from memoia_server.models.source import Operation

    uid, fid = uuid4(), uuid4()
    receipt = Operation(operation_id=uuid4(), kind="correct", status=status, source_id="dialog",
        blob_id=uuid4(), result=dict(fact_ids=[fid], event_ids=[], profile_ids=[]) if status == "completed" else None,
        error=None)
    controller = AsyncMock(return_value=receipt)
    monkeypatch.setattr(source, handler, controller)
    app = FastAPI()
    app.include_router(router)

    @app.middleware("http")
    async def authenticated_project(request, call_next):
        request.state.memobase_project_id = "scoped-project"
        return await call_next(request)

    body = edit() if method == "PUT" else DeleteFact(idempotency_key="delete", expected_revision=1, reason="Incorrect extraction")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.request(method, f"/api/users/{uid}/facts/{fid}", json=body.model_dump(mode="json"))
    assert response.status_code == http_status
    assert response.json() == receipt.model_dump(mode="json")
    controller.assert_awaited_once_with(uid, "scoped-project", fid, body)
    responses = app.openapi()["paths"]["/api/users/{user_id}/facts/{fact_id}"][method.lower()]["responses"]
    assert responses[str(http_status)]["content"]["application/json"]["schema"] == {"$ref": "#/components/schemas/Operation"}


@pytest.mark.asyncio
async def test_concurrent_same_key_registration_has_one_receipt_and_effect(correction):
    uid, fid, _, _ = correction
    body = edit(content="User lives in Kyoto")
    first, second = await asyncio.gather(source.update_fact(uid, "__root__", fid, body),
                                         source.update_fact(uid, "__root__", fid, body))
    assert first.operation_id == second.operation_id
    assert source.get_operation(uid, "__root__", operation_id=first.operation_id).status == "completed"
    assert stored(facts, fid)["revision"] == 2 and source.get_embedding.await_count == 1


@pytest.mark.asyncio
async def test_update_preserves_fact_identity_scrubs_history_and_erases_payload(correction):
    uid, fid, original_blob, _ = correction
    before = stored(facts, fid)
    with Session.begin() as session:
        snapshot = [dict(id=str(uuid4()), content="Old profile", topic="work", sub_topic="city",
                         fact_ids=[str(fid)], source_ids=["dialog"])]
        session.execute(history.insert().values(id=uuid4(), user_id=uid, project_id="__root__",
                                               profiles=snapshot, added=snapshot, removed=snapshot))
    body = edit(content="User lives in Kyoto")
    result = await source.update_fact(uid, "__root__", fid, body)
    assert result.status == "completed" and result.kind == "correct" and result.result.fact_ids == [fid]
    assert await source.update_fact(uid, "__root__", fid, body) == result
    after = stored(facts, fid)
    assert after["blob_id"] == original_blob and after["content"] == body.content and after["revision"] == 2
    assert after["created_at"] == before["created_at"] and after["updated_at"] >= before["updated_at"]
    assert source.get_embedding.await_count == 1
    audit = stored(operations, result.operation_id)
    historical_payload = {"fact_id": str(fid), "action": "update", **body.model_dump(mode="json")}
    historical_payload["event_time"] = historical_payload.pop("fact_time")
    assert audit["request_hash"] == source._hash({"kind": "correct", "request": historical_payload})
    with pytest.raises(source.SourceError) as conflict:
        await source.update_fact(uid, "__root__", fid, edit(content="Different proposal"))
    assert conflict.value.code == "idempotency_conflict"
    assert set(audit["request"]) == {"source_id", "idempotency_key", "fact_id", "action", "reason", "before_revision", "after_revision"}
    assert audit["request"]["before_revision"] == 1 and audit["request"]["after_revision"] == 2
    assert audit["input_expires_at"] is None
    blob = source.get_blob(uid, "__root__", result.blob_id)
    assert blob.kind == "correct" and blob.message_ids == ["m1", "m2", "assistant"]
    assert stored(blobs, result.blob_id)["fact_changes"][0]["kind"] == "updated"
    assert not any(h.profiles or h.added or h.removed for h in source.get_history(uid, "__root__"))


@pytest.mark.asyncio
async def test_noop_and_evidence_only_update_reuse_index(correction):
    uid, fid, _, _ = correction
    before = stored(facts, fid)
    noop = await source.update_fact(uid, "__root__", fid, edit())
    assert noop.result.memory_version == before["created_version"]
    assert stored(facts, fid)["revision"] == 1
    assert stored(facts, fid)["updated_at"] == before["updated_at"]
    assert stored(blobs, noop.blob_id)["fact_changes"] == [{"kind": "noop", "version": before["created_version"]}]
    updated = await source.update_fact(uid, "__root__", fid, edit("evidence", support_groups=[["m1"]]))
    after = stored(facts, fid)
    assert updated.status == "completed" and after["revision"] == 2
    assert after["occurred_at"] < before["occurred_at"] and after["created_at"] == before["created_at"]
    assert after["updated_at"] > before["updated_at"]
    assert np.array_equal(after["embedding"], before["embedding"])
    assert source.get_embedding.await_count == 0
    detail = source.get_source(uid, "__root__", source_id="dialog").evidence[0]
    assert detail.created_at == after["created_at"] and detail.updated_at == after["updated_at"]


@pytest.mark.asyncio
async def test_delete_targets_one_fact_and_completed_receipt_precedes_missing_target(correction):
    uid, fid, original_blob, now = correction
    other_id = uuid4()
    with Session.begin() as session:
        session.execute(facts.insert().values(id=other_id, user_id=uid, project_id="__root__", blob_id=original_blob,
            content="Independent Fact", support_groups=[["m1"]], occurred_at=now))
        before_messages = list(session.execute(select(messages).where(messages.c.user_id == uid)).mappings())
    body = DeleteFact(idempotency_key="delete", expected_revision=1, reason="Incorrect extraction")
    result = await source.delete_fact(uid, "__root__", fid, body)
    assert result.kind == "correct" and result.result.fact_ids == [fid]
    assert await source.delete_fact(uid, "__root__", fid, body) == result
    assert await source.retry_operation(uid, "__root__", result.operation_id) == result
    assert stored(facts, other_id)["content"] == "Independent Fact"
    with Session() as session:
        assert session.scalar(select(facts.c.id).where(facts.c.id == fid)) is None
        assert list(session.execute(select(messages).where(messages.c.user_id == uid)).mappings()) == before_messages
    assert source.get_embedding.await_count == 0
    assert stored(operations, result.operation_id)["request"]["after_revision"] is None
    with pytest.raises(source.SourceError) as conflict:
        await source.delete_fact(uid, "__root__", fid, body.model_copy(update={"reason": "Different"}))
    assert conflict.value.code == "idempotency_conflict"


@pytest.mark.asyncio
async def test_stale_revision_and_cross_scope_do_not_call_embedding(correction):
    uid, fid, _, _ = correction
    await source.update_fact(uid, "__root__", fid, edit("first", certainty="reported"))
    with pytest.raises(source.SourceError) as stale:
        await source.update_fact(uid, "__root__", fid, edit("stale", content="Wrong stale overwrite"))
    assert stale.value.code == "fact_revision_conflict" and not stale.value.retryable
    assert source.get_operation(uid, "__root__", key="stale").error.code == "fact_revision_conflict"
    for wrong_uid, wrong_project in ((uuid4(), "__root__"), (uid, "other-project")):
        with pytest.raises(source.SourceError) as missing:
            await source.update_fact(wrong_uid, wrong_project, fid, edit("cross-scope"))
        assert missing.value.code == "fact_not_found"
    assert stored(facts, fid)["certainty"] == "reported" and source.get_embedding.await_count == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("groups", [[["foreign"]], [["assistant"]], [["m1", "foreign"]]])
async def test_evidence_requires_original_blob_and_user_support(correction, groups):
    uid, fid, _, _ = correction
    with pytest.raises(source.SourceError) as invalid:
        await source.update_fact(uid, "__root__", fid, edit(support_groups=groups))
    assert invalid.value.code == "invalid_fact_evidence"
    assert stored(facts, fid)["revision"] == 1 and source.get_embedding.await_count == 0


@pytest.mark.asyncio
async def test_deleted_message_support_is_rejected_and_retraction_advances_timestamp(correction):
    uid, fid, _, _ = correction
    before = stored(facts, fid)
    await source.delete_messages(uid, "__root__", "dialog", DeleteMessages(idempotency_key="withdraw", message_ids=["m2"]))
    after = stored(facts, fid)
    assert after["updated_at"] > before["updated_at"] and after["created_at"] == before["created_at"]
    with pytest.raises(source.SourceError) as invalid:
        await source.update_fact(uid, "__root__", fid, edit(revision=2))
    assert invalid.value.code == "invalid_fact_evidence" and source.get_embedding.await_count == 0


@pytest.mark.asyncio
async def test_time_requires_joint_group_and_only_rendered_date_change_reindexes(correction):
    uid, fid, _, _ = correction
    time = dict(start="2026-01-01", end="2026-01-01", precision="day",
                evidence=[dict(message_id="m1", expression="New Year's Day"), dict(message_id="m2", expression="2026")])
    with pytest.raises(source.SourceError) as invalid:
        await source.update_fact(uid, "__root__", fid, edit(fact_time=time))
    assert invalid.value.code == "invalid_fact_evidence"
    result = await source.update_fact(uid, "__root__", fid, edit("time", fact_time=time, support_groups=[["m1", "m2"]]))
    assert result.status == "completed" and source.get_embedding.await_count == 1
    time["evidence"][0]["expression"] = "January 1"
    await source.update_fact(uid, "__root__", fid, edit("quote", revision=2, fact_time=time, support_groups=[["m1", "m2"]]))
    assert source.get_embedding.await_count == 1 and stored(facts, fid)["revision"] == 3


@pytest.mark.asyncio
async def test_embedding_failure_expiry_original_hash_resupply_and_explicit_recovery(correction):
    uid, fid, _, _ = correction
    body = edit(content="User lives in Kyoto")
    original = source.get_embedding.side_effect
    source.get_embedding.side_effect = None
    source.get_embedding.return_value = Promise.reject(503, "fixture failure")
    with pytest.raises(source.SourceError) as failed:
        await source.update_fact(uid, "__root__", fid, body)
    assert failed.value.code == "embedding_unavailable" and stored(facts, fid)["revision"] == 1
    receipt = source.get_operation(uid, "__root__", key=body.idempotency_key)
    with Session.begin() as session:
        session.execute(update(operations).where(operations.c.id == receipt.operation_id)
                        .values(input_expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
    source.purge_expired_inputs()
    purged = stored(operations, receipt.operation_id)
    assert "content" not in purged["request"] and "support_groups" not in purged["request"]
    with pytest.raises(source.SourceError) as expired:
        await source.retry_operation(uid, "__root__", receipt.operation_id)
    assert expired.value.code == "input_required"
    with pytest.raises(source.SourceError) as conflict:
        await source.update_fact(uid, "__root__", fid, edit(content="Wrong replacement"))
    assert conflict.value.code == "idempotency_conflict"
    source.get_embedding.side_effect = original
    assert await source.update_fact(uid, "__root__", fid, body) == receipt
    assert source.get_embedding.await_count == 1
    expiry = stored(operations, receipt.operation_id)["input_expires_at"]
    assert await source.update_fact(uid, "__root__", fid, body) == receipt
    assert stored(operations, receipt.operation_id)["input_expires_at"] == expiry
    assert source.get_embedding.await_count == 1
    # Only explicit recovery executes a failed correction, including after
    # resupply; repeated delivery never extends the restored input's expiry.
    recovered = await source.retry_operation(uid, "__root__", receipt.operation_id)
    assert recovered.status == "completed" and recovered.operation_id == receipt.operation_id
    assert stored(facts, fid)["revision"] == 2 and source.get_embedding.await_count == 2
    assert expiry > datetime.now(timezone.utc)


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["update", "delete"])
@pytest.mark.parametrize("expiry_state", ["pending_sweep", "swept", "previous_sweep"])
async def test_interrupted_expired_correction_resupply_requires_explicit_retry(correction, action, expiry_state):
    uid, fid, _, _ = correction
    body = edit(content="User lives in Kyoto") if action == "update" else DeleteFact(
        idempotency_key="delete", expected_revision=1, reason="Incorrect extraction")
    # A crash, cancellation or unavailable lease can leave registration processing
    # without any effect. An older sweep could also have erased only its input.
    registered, restored = source._register_correction(uid, "__root__", fid, action, body)
    assert registered["status"] == "processing" and not restored
    with Session.begin() as session:
        session.execute(update(operations).where(operations.c.id == registered["id"]).values(
            input_expires_at=None if expiry_state == "previous_sweep" else
                datetime.now(timezone.utc) - timedelta(seconds=1)))
    if expiry_state == "swept":
        source.purge_expired_inputs()
        expired = stored(operations, registered["id"])
        assert expired["status"] == "failed"
        assert expired["error"] == {"code": "input_required", "retryable": False}
        assert expired["input_expires_at"] is None and "content" not in expired["request"]
    submit = source.update_fact if action == "update" else source.delete_fact
    receipt = await submit(uid, "__root__", fid, body)
    assert receipt.operation_id == registered["id"] and receipt.status == "failed"
    assert receipt.error.code == "input_required" and not receipt.error.retryable
    expiry = stored(operations, receipt.operation_id)["input_expires_at"]
    assert expiry > datetime.now(timezone.utc)
    assert await submit(uid, "__root__", fid, body) == receipt
    assert stored(operations, receipt.operation_id)["input_expires_at"] == expiry
    assert stored(facts, fid)["revision"] == 1 and source.get_embedding.await_count == 0
    recovered = await source.retry_operation(uid, "__root__", receipt.operation_id)
    assert recovered.status == "completed" and recovered.operation_id == receipt.operation_id
    if action == "update":
        assert stored(facts, fid)["revision"] == 2 and source.get_embedding.await_count == 1
    else:
        with Session() as session:
            assert session.scalar(select(facts.c.id).where(facts.c.id == fid)) is None
        assert source.get_embedding.await_count == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["update", "delete"])
async def test_expiry_never_rewrites_completed_correction_receipt(correction, action):
    uid, fid, _, _ = correction
    body = edit(content="User lives in Kyoto") if action == "update" else DeleteFact(
        idempotency_key="delete", expected_revision=1, reason="Incorrect extraction")
    submit = source.update_fact if action == "update" else source.delete_fact
    receipt = await submit(uid, "__root__", fid, body)
    audit = stored(operations, receipt.operation_id)["request"]
    with Session.begin() as session:
        session.execute(update(operations).where(operations.c.id == receipt.operation_id).values(
            input_expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
    source.purge_expired_inputs()
    assert source.get_operation(uid, "__root__", operation_id=receipt.operation_id) == receipt
    assert await submit(uid, "__root__", fid, body) == receipt
    assert stored(operations, receipt.operation_id)["request"] == audit
    assert await source.retry_operation(uid, "__root__", receipt.operation_id) == receipt


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["update", "delete"])
@pytest.mark.parametrize("phase", ["snapshot", "commit"])
async def test_correction_expiry_between_registration_snapshot_and_commit(correction, monkeypatch, action, phase):
    uid, fid, _, _ = correction
    body = edit(content="Must not commit") if action == "update" else DeleteFact(
        idempotency_key="delete", expected_revision=1, reason="Incorrect extraction")
    original = source.run_sql
    async def expire_before_step(function, *args, **kwargs):
        if function.__name__ == phase:
            with Session.begin() as session:
                session.execute(update(operations).where(operations.c.user_id == uid,
                    operations.c.idempotency_key == body.idempotency_key).values(
                        input_expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
        return await original(function, *args, **kwargs)
    monkeypatch.setattr(source, "run_sql", expire_before_step)
    submit = source.update_fact if action == "update" else source.delete_fact
    with pytest.raises(source.SourceError) as expired:
        await submit(uid, "__root__", fid, body)
    assert expired.value.code == "input_required"
    assert stored(facts, fid)["revision"] == 1
    receipt = source.get_operation(uid, "__root__", key=body.idempotency_key)
    assert receipt.status == "failed" and receipt.error.code == "input_required"
    assert source.get_embedding.await_count == int(action == "update" and phase == "commit")


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["commit", "embedding"])
async def test_old_correction_failure_cannot_replace_purged_input_required_receipt(correction, failure):
    uid, fid, _, _ = correction
    original = source.get_embedding.side_effect
    expired_receipts = []
    def expire_and_purge():
        with Session.begin() as session:
            session.info["memoia_fence_done"] = True
            session.execute(update(operations).where(operations.c.user_id == uid,
                operations.c.project_id == "__root__", operations.c.idempotency_key == "edit").values(
                    input_expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
        source.purge_expired_inputs()
        expired_receipts.append(source.get_operation(uid, "__root__", key="edit"))
    async def purge_during_embedding(*args, **kwargs):
        await source.run_sql(expire_and_purge)
        if failure == "embedding":
            return Promise.reject(503, "Controlled embedding outage after expiry")
        return await original(*args, **kwargs)
    source.get_embedding.side_effect = purge_during_embedding
    with pytest.raises(source.SourceError) as failed:
        await source.update_fact(uid, "__root__", fid, edit(content="Must not commit"))
    assert failed.value.code == ("embedding_unavailable" if failure == "embedding" else "write_conflict")
    expired = expired_receipts[0]
    assert expired.status == "failed" and expired.error.code == "input_required" and not expired.error.retryable
    assert source.get_operation(uid, "__root__", operation_id=expired.operation_id) == expired
    assert stored(facts, fid)["revision"] == 1
    assert stored(blobs, expired.blob_id)["fact_completed_at"] is None


@pytest.mark.asyncio
async def test_purge_waits_for_checked_correction_commit_before_publishing_expiry(correction, monkeypatch):
    uid, fid, _, _ = correction
    checked, release, purge_attempted = threading.Event(), threading.Event(), threading.Event()
    original_commit, original_expiry = source.fence_commit, source._expire_correction_inputs
    purge_pid = []
    def pause_commit(*args, **kwargs):
        checked.set()
        assert release.wait(5), "Correction commit was not released"
        return original_commit(*args, **kwargs)
    def expired_at_sweep(now):
        # Advance only the sweep's clock beyond retention after commit has checked
        # its input, so the interleaving does not depend on a wall-clock sleep.
        return original_expiry(datetime.now(timezone.utc) + timedelta(days=8)).execution_options(
            correction_expiry_probe=True)
    def capture_purge(connection, cursor, statement, parameters, context, executemany):
        if context.execution_options.get("correction_expiry_probe"):
            purge_pid.append(connection.scalar(text("SELECT pg_backend_pid()")))
            purge_attempted.set()
    def purge_is_blocked():
        with Session() as session:
            return session.scalar(text("SELECT cardinality(pg_blocking_pids(:pid)) > 0"), {"pid": purge_pid[0]})
    monkeypatch.setattr(source, "fence_commit", pause_commit)
    monkeypatch.setattr(source, "_expire_correction_inputs", expired_at_sweep)
    sql_event.listen(DB_ENGINE, "before_cursor_execute", capture_purge)
    correction_task = asyncio.create_task(source.update_fact(uid, "__root__", fid, edit(content="User lives in Kyoto")))
    purge_task = None
    try:
        assert await asyncio.to_thread(checked.wait, 3)
        purge_task = asyncio.create_task(source.run_sql(source.purge_expired_inputs))
        assert await asyncio.to_thread(purge_attempted.wait, 3)
        async with asyncio.timeout(3):
            while not await source.run_sql(purge_is_blocked):
                assert not purge_task.done(), "Sweep published expiry while the checked commit was still running"
        assert source.get_operation(uid, "__root__", key="edit").status == "processing"
    finally:
        release.set()
        await asyncio.gather(correction_task, *([purge_task] if purge_task else []), return_exceptions=True)
        sql_event.remove(DB_ENGINE, "before_cursor_execute", capture_purge)
    assert purge_task is not None and purge_task.exception() is None
    result = correction_task.result()
    assert result.status == "completed" and stored(facts, fid)["revision"] == 2
    assert source.get_operation(uid, "__root__", key="edit") == result


@pytest.mark.asyncio
async def test_commit_revision_fence_rejects_changes_during_embedding(correction):
    uid, fid, _, _ = correction
    original = source.get_embedding.side_effect
    async def concurrent_change(*args, **kwargs):
        with Session.begin() as session:
            session.info["memoia_fence_done"] = True
            session.execute(update(facts).where(facts.c.id == fid).values(revision=2))
        return await original(*args, **kwargs)
    source.get_embedding.side_effect = concurrent_change
    with pytest.raises(source.SourceError) as stale:
        await source.update_fact(uid, "__root__", fid, edit(content="Cannot overwrite"))
    assert stale.value.code == "fact_revision_conflict"
    assert stored(facts, fid)["content"] == "User lives in Tokyo"
    assert source.get_operation(uid, "__root__", key="edit").status == "failed"


@pytest.mark.asyncio
async def test_lost_lease_cannot_commit_correction(correction):
    uid, fid, _, _ = correction
    original = source.get_embedding.side_effect
    async def lose_lease(*args, **kwargs):
        CURRENT_LEASE.get().lost.set()
        return await original(*args, **kwargs)
    source.get_embedding.side_effect = lose_lease
    with pytest.raises(source.SourceError) as lost:
        await source.update_fact(uid, "__root__", fid, edit(content="Cannot commit"))
    assert lost.value.code == "lease_lost" and stored(facts, fid)["revision"] == 1


@pytest.mark.asyncio
async def test_sql_failure_rolls_back_fact_index_history_and_completion(correction, monkeypatch):
    from memoia_server.controllers import maintenance
    uid, fid, _, _ = correction
    before = stored(facts, fid)
    def fail_recording(*args, **kwargs):
        raise source.SourceError("fixture_sql_failure", "Controlled rollback", 503, True)
    monkeypatch.setattr(maintenance, "record_changes", fail_recording)
    with pytest.raises(source.SourceError) as failed:
        await source.update_fact(uid, "__root__", fid, edit(content="Must roll back"))
    assert failed.value.code == "fixture_sql_failure"
    after = stored(facts, fid)
    assert after["content"] == before["content"] and after["revision"] == before["revision"]
    assert after["updated_at"] == before["updated_at"] and np.array_equal(after["embedding"], before["embedding"])
    receipt = source.get_operation(uid, "__root__", key="edit")
    assert receipt.status == "failed" and receipt.result is None
    assert stored(blobs, receipt.blob_id)["fact_completed_at"] is None


@pytest.mark.asyncio
async def test_lost_completion_acknowledgement_keeps_committed_receipt(correction, monkeypatch):
    uid, fid, _, _ = correction
    original = source.get_operation
    def lose_ack(*args, **kwargs):
        raise source.SourceError("fixture_ack_unknown", "Acknowledgement lost", 503, True)
    monkeypatch.setattr(source, "get_operation", lose_ack)
    with pytest.raises(source.SourceError) as unknown:
        await source.update_fact(uid, "__root__", fid, edit(content="User lives in Kyoto"))
    assert unknown.value.code == "fixture_ack_unknown"
    monkeypatch.setattr(source, "get_operation", original)
    receipt = source.get_operation(uid, "__root__", key="edit")
    assert receipt.status == "completed" and stored(facts, fid)["revision"] == 2
    assert await source.update_fact(uid, "__root__", fid, edit(content="User lives in Kyoto")) == receipt
    assert source.get_embedding.await_count == 1


@pytest.mark.asyncio
async def test_http_correction_authorization_errors_receipts_and_explicit_recovery(correction):
    from api import app
    uid, fid, _, _ = correction
    project = "correction-http-" + uuid4().hex
    key_ids = []
    with Session.begin() as session:
        session.execute(Project.__table__.insert().values(id=uuid4(), project_id=project,
            project_secret="fixture-only", profile_config=None, status="active"))
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test",
                headers={"Authorization": "Bearer " + os.environ["ACCESS_TOKEN"]}) as client:
            route = f"/api/users/{uid}/facts/{fid}"
            body = edit(content="User lives in Kyoto").model_dump(mode="json")
            reader = await client.post("/api/projects/__root__/keys", json={"name": "correction reader", "scopes": ["read"]})
            other = await client.post(f"/api/projects/{project}/keys", json={"name": "foreign writer", "scopes": ["write"]})
            assert reader.status_code == other.status_code == 201
            key_ids.extend([reader.json()["key_id"], other.json()["key_id"]])
            assert (await client.put(route, json=body, headers={"Authorization": ""})).status_code == 401
            denied = await client.put(route, json=body, headers={"Authorization": "Bearer " + reader.json()["token"]})
            assert denied.status_code == 403 and denied.json()["detail"]["code"] == "scope_required"
            foreign = await client.put(route, json=body, headers={"Authorization": "Bearer " + other.json()["token"]})
            assert foreign.status_code == 404 and foreign.json()["detail"]["code"] == "fact_not_found"
            missing = await client.put(f"/api/users/{uuid4()}/facts/{fid}", json=body)
            assert missing.status_code == 404
            success = await client.put(route, json=body)
            assert success.status_code == 200 and success.json()["kind"] == "correct"
            opid = success.json()["operation_id"]
            assert (await client.get(f"/api/users/{uid}/operations/{opid}")).json() == success.json()
            stale = await client.put(route, json=edit("stale-http").model_dump(mode="json"))
            assert stale.status_code == 409 and stale.json()["detail"] == {
                "code": "fact_revision_conflict", "message": "Fact changed; read its current revision before correcting", "retryable": False}
            failed_receipt = await client.get(f"/api/users/{uid}/operations/by-key/stale-http")
            assert failed_receipt.json()["status"] == "failed"
            invalid = await client.put(route, json=edit("bad-evidence-http", revision=2, support_groups=[["assistant"]]).model_dump(mode="json"))
            assert invalid.status_code == 422 and invalid.json()["detail"]["code"] == "invalid_fact_evidence"
            embed = source.get_embedding.side_effect
            source.get_embedding.side_effect = None
            source.get_embedding.return_value = Promise.reject(503, "Controlled outage")
            recover_body = edit("recover-http", revision=2, content="User lives in Osaka").model_dump(mode="json")
            failed = await client.put(route, json=recover_body)
            assert failed.status_code == 503 and failed.json()["detail"]["code"] == "embedding_unavailable"
            receipt = (await client.get(f"/api/users/{uid}/operations/by-key/recover-http")).json()
            assert receipt["status"] == "failed"
            source.get_embedding.side_effect = embed
            duplicate = await client.put(route, json=recover_body)
            assert duplicate.status_code == 200 and duplicate.json() == receipt
            recovered = await client.post(f"/api/users/{uid}/operations/{receipt['operation_id']}/retry")
            assert recovered.status_code == 200 and recovered.json()["status"] == "completed"
            deleted_body = DeleteFact(idempotency_key="http-delete", expected_revision=3, reason="Delete incorrect fact").model_dump(mode="json")
            deleted = await client.request("DELETE", route, json=deleted_body)
            assert deleted.status_code == 200 and deleted.json()["status"] == "completed"
            assert (await client.request("DELETE", route, json=deleted_body)).json() == deleted.json()
    finally:
        with Session.begin() as session:
            session.execute(delete(project_api_keys).where(project_api_keys.c.id.in_(key_ids)))
            session.execute(delete(Project).where(Project.project_id == project))
