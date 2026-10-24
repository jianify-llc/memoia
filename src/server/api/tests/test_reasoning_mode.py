"""Standard-only execution through real SQL/Redis and deterministic provider transport."""
from datetime import datetime, timedelta, timezone
from uuid import uuid4
import os
from unittest.mock import AsyncMock

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import delete, select, update, func
from memoia_server.connectors import Session
from memoia_server.controllers import maintenance, source, user
from memoia_server.models.database import User
from memoia_server.models.response import UserData
from memoia_server.models.source import ImportSource, memory_operations, memory_facts
from tests.maintenance_support import claim_for, derive
from tests.test_maintenance import batch
from tests.test_source_quality import fact, model_outputs, model_transport

extract_source = source.extract_source


@pytest_asyncio.fixture
async def mode_user(db_env):
    uid = str((await user.create_user(UserData(data={"label": "preserved"}), "__root__")).data().id)
    try:
        yield uid
    finally:
        with Session.begin() as session:
            session.execute(delete(User).where(User.id == uid, User.project_id == "__root__"))


def body(key, *, sid=None):
    return ImportSource(idempotency_key=key, source_id=sid or key, messages=[{
        "message_id": "1", "role": "user", "content": "I live in Tokyo",
        "occurred_at": datetime(2026, 10, 22, tzinfo=timezone.utc)}])


def request(op):
    with Session() as session:
        return session.scalar(select(memory_operations.c.request).where(memory_operations.c.id == op.operation_id))


def user_data(uid):
    with Session() as session:
        return session.get(User, (uid, "__root__")).additional_fields


@pytest.mark.asyncio
async def test_fact_commit_zero_failure_retry_and_noop_are_standard_without_mode_state(
        mode_user, bounded_source_model, monkeypatch):
    # Keep the real extraction entrypoint and Responses SDK; only replace network I/O.
    monkeypatch.setattr(source, "extract_source", extract_source)
    monkeypatch.setattr(source, "record_completion_usage", AsyncMock())
    contents = [*model_outputs([fact("The user lives in Tokyo", [["1"]])]),
                "invalid response", *model_outputs([]), *model_outputs([])]
    client, wires = model_transport(contents)
    monkeypatch.setattr("memoia_server.llms.openai_model_llm.get_openai_async_client_instance", lambda: client)
    try:
        complete = await source.import_source(mode_user, "__root__", body("committed"))
        assert len(complete.result.fact_ids) == 1
        assert await source.import_source(mode_user, "__root__", body("committed")) == complete
        await source.import_source(mode_user, "__root__", body("noop", sid="committed"))
        assert len(wires) == 1
        with pytest.raises(source.SourceError):
            await source.import_source(mode_user, "__root__", body("retry"))
        failed = source.get_operation(mode_user, "__root__", key="retry")
        assert failed.status == "failed" and "reasoning_mode" not in request(failed)
        retried = await source.retry_operation(mode_user, "__root__", failed.operation_id)
        assert retried.status == "completed" and retried.result.fact_ids == []
        empty = await source.import_source(mode_user, "__root__", body("empty"))
        assert empty.result.fact_ids == [] and len(wires) == 4
        assert all(wire["reasoning"]["mode"] == "standard" and wire["service_tier"] == "default" for wire in wires)
        for key in ("committed", "noop", "retry", "empty"):
            assert request(source.get_operation(mode_user, "__root__", key=key)) == {
                "source_id": "committed" if key == "noop" else key, "idempotency_key": key}
        assert user_data(mode_user) == {"label": "preserved"}
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_expired_input_restores_original_request_without_mode(mode_user, bounded_source_model):
    pending = body("expired")
    registered = source._register(mode_user, "__root__", pending.idempotency_key, "import",
        pending.model_dump(mode="json", exclude_none=True), pending.source_id)
    with Session.begin() as session:
        session.execute(update(memory_operations).where(memory_operations.c.id == registered["id"]).values(
            input_expires_at=func.now() - timedelta(seconds=1)))
    source.purge_expired_inputs()
    assert request(source.get_operation(mode_user, "__root__", key="expired")) == {
        "idempotency_key": "expired", "source_id": "expired"}
    assert (await source.import_source(mode_user, "__root__", pending)).status == "completed"
    assert "background_reasoning_mode" not in bounded_source_model.await_args.kwargs["rules"]
    assert user_data(mode_user) == {"label": "preserved"}


@pytest.mark.asyncio
async def test_maintenance_does_not_freeze_user_or_operation_mode_on_retry(mode_user, bounded_source_model):
    # Historical JSON is inert and remains untouched; no cleanup or compatibility writer.
    with Session.begin() as session:
        session.get(User, (mode_user, "__root__")).additional_fields = {
            "label": "preserved", "_last_fact_reasoning_mode": "pro"}
    batch(mode_user)
    maintenance.flush(mode_user, "__root__", "queued")
    seen = []
    async def runner(context):
        assert not hasattr(context, "background_reasoning_mode")
        seen.append(context.operation_id)
        if len(seen) == 1:
            raise source.SourceError("model_unavailable", "fixture", 503, True)
        return await derive()(context)
    first = claim_for(mode_user)
    assert not await maintenance.execute_claim(first, runner=runner)
    assert "reasoning_mode" not in request(source.get_operation(mode_user, "__root__", operation_id=first.operation_id))
    await source.import_source(mode_user, "__root__", body("new-fact"))
    maintenance.retry_flush(mode_user, "__root__", first.operation_id)
    with Session.begin() as session:
        session.execute(update(memory_operations).where(memory_operations.c.id == first.operation_id).values(
            available_at=func.now() - timedelta(seconds=1)))
    assert await maintenance.execute_claim(claim_for(mode_user), runner=runner)
    maintenance.flush(mode_user, "__root__", "new-maintenance")
    assert await maintenance.execute_claim(claim_for(mode_user), runner=runner)
    assert len(seen) == 3 and seen[0] == seen[1] and seen[2] != seen[0]
    assert user_data(mode_user) == {"label": "preserved", "_last_fact_reasoning_mode": "pro"}
    for key in ("queued", "new-maintenance"):
        assert "reasoning_mode" not in request(source.get_operation(mode_user, "__root__", key=key))


@pytest.mark.asyncio
async def test_http_rejects_every_public_mode_value_before_acceptance(db_env):
    uid = str(uuid4())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=__import__("api").app),
        base_url="http://test", headers={"Authorization": "Bearer " + os.environ["ACCESS_TOKEN"]}) as client:
        for value in ("standard", "pro", "plus", True, None, 1):
            payload = body("invalid").model_dump(mode="json") | {"reasoning_mode": value}
            assert (await client.post(f"/api/users/{uid}/blobs", json=payload)).status_code == 422
        assert (await client.get(f"/api/users/{uid}")).status_code == 404
        assert (await client.put(f"/api/users/{uid}/reasoning-policy", json={})).status_code == 404


@pytest.mark.asyncio
async def test_fact_failure_rolls_back_without_updating_user_data(mode_user, bounded_source_model, monkeypatch):
    await source.import_source(mode_user, "__root__", body("initial"))
    with Session() as session:
        before = session.scalar(select(func.count()).select_from(memory_facts).where(memory_facts.c.user_id == mode_user))
    def reject_commit(*args, **kwargs):
        raise source.SourceError("write_conflict", "fixture rollback", 409, True)
    monkeypatch.setattr(maintenance, "record_changes", reject_commit)
    with pytest.raises(source.SourceError):
        await source.import_source(mode_user, "__root__", body("rolled-back"))
    assert user_data(mode_user) == {"label": "preserved"}
    with Session() as session:
        assert session.scalar(select(func.count()).select_from(memory_facts).where(memory_facts.c.user_id == mode_user)) == before
    assert source.get_operation(mode_user, "__root__", key="rolled-back").status == "failed"
