"""Idempotent v1 deletion without weakening authentication or SQL fencing."""
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from api import app
from memoia_server.connectors import Session
from memoia_server.controllers import source, user
from memoia_server.models.database import User, UserEvent, UserEventGist, UserProfile
from memoia_server.models.response import UserData
from memoia_server.models.source import ImportSource, SOURCE_TABLES, memory_profile_revisions


def user_row_counts(uid):
    tables = [User.__table__, UserProfile.__table__, UserEvent.__table__,
              UserEventGist.__table__, *SOURCE_TABLES, memory_profile_revisions]
    with Session() as session:
        return {table.name: session.scalar(select(func.count()).select_from(table).where(
            (table.c.id == uid if table.name == "users" else table.c.user_id == uid),
            table.c.project_id == "__root__")) for table in tables}


@pytest.mark.asyncio
async def test_controller_delete_missing_and_repeated_user_succeeds(db_env):
    uid = uuid4()
    result = await user.delete_user(uid, "__root__")
    assert result.ok() and result.data() is None
    created = await user.create_user(UserData(id=uid), "__root__")
    assert created.ok()
    assert (await user.delete_user(uid, "__root__")).ok()
    assert (await user.delete_user(uid, "__root__")).ok()
    assert all(count == 0 for count in user_row_counts(uid).values())


def test_http_delete_never_imported_user_is_idempotent(db_env, monkeypatch):
    token, uid = "user-delete-test-root", uuid4()
    monkeypatch.setenv("ACCESS_TOKEN", token)
    client = TestClient(app, headers={"Authorization": f"Bearer {token}"})
    try:
        for _ in range(2):
            response = client.delete(f"/api/v1/users/{uid}")
            assert response.status_code == 200
            assert response.json() == {"data": None, "errno": 0, "errmsg": ""}
        assert all(count == 0 for count in user_row_counts(uid).values())
    finally:
        client.close()


@pytest.mark.asyncio
async def test_http_delete_cascades_and_repeat_does_not_create_state(db_env, bounded_source_model, monkeypatch):
    token, uid = "user-delete-test-root", uuid4()
    monkeypatch.setenv("ACCESS_TOKEN", token)
    operation = await source.import_source(uid, "__root__", ImportSource(
        idempotency_key="delete-test", source_id="delete-test", messages=[{
            "message_id": "1", "role": "user", "content": "My name is Gus",
            "occurred_at": datetime.now(timezone.utc),
        }]))
    assert operation.status == "completed"
    assert all(count > 0 for count in user_row_counts(uid).values())
    original_fence, fenced = source.fence_commit, []

    def record_fence(session, user_id, project_id, lease):
        assert session.get(User, (uid, project_id)) is not None
        fenced.append((lease.generation, lease.version))
        return original_fence(session, user_id, project_id, lease)

    monkeypatch.setattr(source, "fence_commit", record_fence)
    client = TestClient(app, headers={"Authorization": f"Bearer {token}"})
    try:
        first = client.delete(f"/api/v1/users/{uid}")
        assert first.status_code == 200 and first.json()["errno"] == 0
        assert fenced and all(generation is not None and version is not None for generation, version in fenced)
        assert all(count == 0 for count in user_row_counts(uid).values())
        fence_count = len(fenced)
        second = client.delete(f"/api/v1/users/{uid}")
        assert second.status_code == 200 and second.json() == first.json()
        assert len(fenced) == fence_count
        assert all(count == 0 for count in user_row_counts(uid).values())
        assert client.get(f"/api/v2/users/{uid}/sources").json() == {"sources": []}
        assert client.get(f"/api/v2/users/{uid}/profiles").json() == {"profiles": []}
        assert client.get(f"/api/v2/users/{uid}/history").json() == {"entries": []}
        assert client.get(f"/api/v1/users/event/{uid}").json()["data"]["events"] == []
    finally:
        client.close()
        await user.delete_user(uid, "__root__")


@pytest.mark.asyncio
@pytest.mark.parametrize("exists", [False, True])
async def test_http_delete_wrong_token_does_not_succeed_or_modify_user(db_env, bounded_source_model, monkeypatch, exists):
    uid = uuid4()
    monkeypatch.setenv("ACCESS_TOKEN", "user-delete-test-root")
    if exists:
        await source.import_source(uid, "__root__", ImportSource(
            idempotency_key="auth-delete-test", source_id="auth-delete-test", messages=[{
                "message_id": "1", "role": "user", "content": "My name is Gus",
                "occurred_at": datetime.now(timezone.utc),
            }]))
    before = user_row_counts(uid)
    client = TestClient(app, headers={"Authorization": "Bearer deliberately-invalid"})
    try:
        response = client.delete(f"/api/v1/users/{uid}")
        assert response.status_code == 401 and response.json()["errno"] == 401
        assert user_row_counts(uid) == before
    finally:
        client.close()
        await user.delete_user(uid, "__root__")
