"""Actual SQL/HTTP scope isolation, immediate revocation and independent search ranks."""
import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from unittest.mock import AsyncMock

import numpy as np
import pytest
import pytest_asyncio
import httpx
from sqlalchemy import delete, select, update

from api import app
from memoia_server.connectors import Session
from memoia_server.models.database import Project, UserEvent, User
from memoia_server.models.projects import project_api_keys
from memoia_server.models.utils import Promise
from memoia_server.controllers import event
from memoia_server.env import CONFIG


@pytest_asyncio.fixture
async def managed_project(db_env):
    project = "scope-test-" + uuid4().hex
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers={"Authorization": f"Bearer {os.environ['ACCESS_TOKEN']}"})
    created = (await client.post("/api/projects", json={"project_id": project}))
    assert created.status_code == 201, created.text
    try:
        yield project, client
    finally:
        with Session.begin() as session:
            session.execute(delete(Project.__table__).where(Project.project_id == project))
        (await client.aclose())


async def issue(project, client, scopes, **extra):
    response = (await client.post(f"/api/projects/{project}/keys", json={"name": "integration test", "scopes": scopes, **extra}))
    assert response.status_code == 201, response.text
    return response.json()


@pytest.mark.asyncio
async def test_scoped_key_read_write_and_admin_are_distinct(managed_project):
    project, root = managed_project
    write_key = await issue(project, root, ["read", "write"])
    writer = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers={"Authorization": "Bearer " + write_key["token"]})
    created = (await writer.post("/api/users", json={}))
    assert created.status_code == 201
    uid = created.json()["id"]
    read_key = await issue(project, root, ["read"])
    reader = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers={"Authorization": "Bearer " + read_key["token"]})
    assert (await reader.get(f"/api/users/{uid}/profiles")).status_code == 200
    assert (await reader.delete(f"/api/users/{uid}")).status_code == 403
    assert (await writer.get(f"/api/projects/{project}/keys")).status_code == 403
    assert (await writer.patch("/api/project/config", json={"profile_config": "language: zh"})).status_code == 403
    assert (await writer.post("/api/projects", json={"project_id": "forbidden"})).status_code == 403
    with Session() as session:
        stored = session.execute(select(project_api_keys.c.token_hash).where(project_api_keys.c.id == write_key["key_id"])).scalar_one()
        assert write_key["token"] not in stored
    (await reader.aclose())
    (await writer.aclose())


@pytest.mark.asyncio
async def test_revocation_expiry_and_project_suspension_take_effect_next_request(managed_project):
    project, root = managed_project
    key = await issue(project, root, ["admin"])
    headers = {"Authorization": "Bearer " + key["token"]}
    assert (await root.get("/api/projects", headers=headers)).status_code == 200
    assert (await root.delete(f"/api/projects/{project}/keys/{key['key_id']}")).status_code == 204
    assert (await root.get("/api/projects", headers=headers)).status_code == 401
    expiring = await issue(project, root, ["admin"], expires_at=(datetime.now(timezone.utc) + timedelta(hours=1)).isoformat())
    with Session.begin() as session:
        session.execute(update(project_api_keys).where(project_api_keys.c.id == expiring["key_id"])
                        .values(expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
    assert (await root.get("/api/projects", headers={"Authorization": "Bearer " + expiring["token"]})).status_code == 401
    active = await issue(project, root, ["admin"])
    assert (await root.patch(f"/api/projects/{project}", json={"status": "suspended"})).status_code == 200
    assert (await root.get("/api/projects", headers={"Authorization": "Bearer " + active["token"]})).status_code == 401


@pytest.mark.asyncio
async def test_project_admin_cannot_enumerate_or_modify_other_project(managed_project):
    project, root = managed_project
    key = await issue(project, root, ["admin"])
    headers = {"Authorization": "Bearer " + key["token"]}
    listed = (await root.get("/api/projects", headers=headers)).json()["projects"]
    assert [p["project_id"] for p in listed] == [project]
    assert (await root.get("/api/projects/__root__/keys", headers=headers)).status_code == 403
    assert (await root.post("/api/projects/__root__/legacy-token/rotate", headers=headers)).status_code == 403


@pytest.mark.asyncio
async def test_legacy_rotation_immediately_rejects_old_token(managed_project):
    project, root = managed_project
    old = (await root.post(f"/api/projects/{project}/legacy-token/rotate")).json()["token"]
    assert (await root.get("/api/projects", headers={"Authorization": "Bearer " + old})).status_code == 200
    new = (await root.post(f"/api/projects/{project}/legacy-token/rotate")).json()["token"]
    assert new != old
    assert (await root.get("/api/projects", headers={"Authorization": "Bearer " + old})).status_code == 401
    assert (await root.get("/api/projects", headers={"Authorization": "Bearer " + new})).status_code == 200


def test_missing_root_credential_never_authorizes(monkeypatch):
    from memoia_server.api_layer.middleware import AuthMiddleware
    middleware = AuthMiddleware(app)
    for value in (None, "", "  "):
        if value is None:
            monkeypatch.delenv("ACCESS_TOKEN", raising=False)
        else:
            monkeypatch.setenv("ACCESS_TOKEN", value)
        assert not middleware.is_valid_root("")
        assert not middleware.is_valid_root("arbitrary")


@pytest.mark.asyncio
async def test_rejected_input_is_not_echoed_in_validation_response(managed_project):
    _, client = managed_project
    secret_text = "private-body-not-for-error-output"
    response = (await client.post(f"/api/users/{uuid4()}/blobs", json={"idempotency_key": "invalid",
        "source_id": "invalid", "messages": [{"message_id": "1", "role": "wrong-role", "content": secret_text}]}))
    assert response.status_code == 422
    assert secret_text not in response.text
    assert all("input" not in item for item in response.json()["detail"])


@pytest.mark.asyncio
async def test_hybrid_search_fuses_lexical_and_semantic_without_cross_user_leak(db_env, monkeypatch):
    uid, other = uuid4(), uuid4()
    lexical_vector = np.zeros(CONFIG.embedding_dim)
    lexical_vector[0] = 1
    semantic_vector = np.zeros(CONFIG.embedding_dim)
    semantic_vector[1] = 1
    with Session.begin() as session:
        for user_id in (uid, other):
            row = User(project_id="__root__")
            row.id = user_id
            session.add(row)
        session.flush()
        exact = UserEvent(user_id=uid, project_id="__root__", event_data={"event_tip": "rareword ZX-42"}, embedding=lexical_vector)
        semantic = UserEvent(user_id=uid, project_id="__root__", event_data={"event_tip": "different semantic wording"}, embedding=semantic_vector)
        secret = UserEvent(user_id=other, project_id="__root__", event_data={"event_tip": "rareword private"}, embedding=semantic_vector)
        session.add_all([exact, semantic, secret])
        ids = exact.id, semantic.id, secret.id
    monkeypatch.setattr(event, "get_embedding", AsyncMock(return_value=Promise.resolve(np.array([semantic_vector]))))
    try:
        result = (await event.hybrid_search_user_events(uid, "__root__", "rareword", 10)).data()
        assert {row.id for row in result.events} == set(ids[:2])
        assert all(0 < row.score < .1 for row in result.events)
        monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
        lexical_only = (await event.hybrid_search_user_events(uid, "__root__", "rareword", 10)).data()
        assert [row.id for row in lexical_only.events] == [ids[0]]
    finally:
        with Session.begin() as session:
            session.execute(delete(User).where(User.id.in_([uid, other]), User.project_id == "__root__"))
