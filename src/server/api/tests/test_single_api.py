"""Actual HTTP and SQL checks for one unversioned contract."""
import os
from datetime import datetime, timezone
from uuid import uuid4
from unittest.mock import AsyncMock, Mock, patch
import pytest
import pytest_asyncio
import httpx
from memoia_server.models.source import SearchResult
from memoia_server.models.utils import Promise
from memoia_server.controllers import event

@pytest_asyncio.fixture
async def client(db_env):
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=__import__("api").app), base_url="http://test", headers={"Authorization": "Bearer " + os.environ["ACCESS_TOKEN"]})
    yield client
    (await client.aclose())


@pytest.mark.asyncio
async def test_only_one_contract_is_mounted(client):
    assert (await client.get("/api/healthcheck")).json() == {"status": "ok"}
    for prefix in ("/api/v1", "/api/v2"):
        assert (await client.get(prefix + "/healthcheck")).status_code == 404
        assert (await client.post(prefix + "/users", json={})).status_code == 404
    schema = (await client.get("/openapi.json")).json()
    assert not any(path.startswith(("/api/v1", "/api/v2")) for path in schema["paths"])


@pytest.mark.asyncio
async def test_empty_flush_uses_original_operation_contract_and_write_scope(client):
    uid = (await client.post("/api/users", json={})).json()["id"]
    try:
        payload = {"idempotency_key": "empty-flush"}
        receipt = (await client.post(f"/api/users/{uid}/flush", json=payload))
        assert receipt.status_code == 200
        data = receipt.json()
        assert data["kind"] == "flush" and data["status"] == "completed"
        assert data["source_id"] is data["blob_id"] is None
        assert data["result"]["blob_ids"] == []
        assert (await client.post(f"/api/users/{uid}/flush", json=payload)).json() == data
        assert (await client.get(f"/api/users/{uid}/operations/by-key/empty-flush")).json() == data
        assert (await client.post(f"/api/users/{uid}/operations/{data['operation_id']}/retry")).json() == data
        assert (await client.post(f"/api/users/{uid}/flush", json={**payload, "source_id": "spoof"})).status_code == 422
        assert (await client.post(f"/api/users/{uid}/maintenance/retry", json={"task_id": data["operation_id"]})).status_code == 404
        assert (await client.post(f"/api/users/{uuid4()}/flush", json=payload)).status_code == 404
    finally:
        (await client.delete(f"/api/users/{uid}"))


@pytest.mark.asyncio
async def test_user_and_manual_profile_management_use_one_contract(client):
    uid = (await client.post("/api/users", json={"data": {"label": "fixture"}})).json()["id"]
    try:
        assert (await client.get(f"/api/users/{uid}")).json()["data"] == {"label": "fixture"}
        assert (await client.get("/api/users", params={"search": uid})).json()["count"] == 1
        body = {"content": "Sakura Hotel", "topic": "travel", "sub_topic": "hotel"}
        result = (await client.post(f"/api/users/{uid}/profiles", json=body))
        assert result.status_code == 201
        pid = result.json()["id"]
        assert (await client.get(f"/api/users/{uid}/profiles")).json()["profiles"][0]["content"] == body["content"]
        assert (await client.patch(f"/api/users/{uid}/profiles/{pid}", json={**body, "content": "Corrected hotel"})).status_code == 204
        assert (await client.get(f"/api/users/{uid}/profiles")).json()["profiles"][0]["content"] == "Corrected hotel"
        assert (await client.delete(f"/api/users/{uuid4()}/profiles/{pid}")).status_code == 404
        assert (await client.delete(f"/api/users/{uid}/profiles/{pid}")).status_code == 204
    finally:
        result = (await client.delete(f"/api/users/{uid}"))
        assert result.json() == {"user_id": uid, "forgotten": True}
        assert (await client.post("/api/users", json={"id": uid})).status_code == 403


@pytest.mark.asyncio
async def test_private_query_is_post_body_and_errors_never_echo_it(client, monkeypatch):
    secret = "PRIVATE_QUERY_MUST_NOT_LEAK"
    search = AsyncMock(return_value=Promise.resolve(SearchResult(events=[], facts=[], profiles=[])))
    monkeypatch.setattr(event, "hybrid_search_user_events", search)
    uid = str(uuid4())
    result = (await client.post(f"/api/users/{uid}/search", json={"query": secret}))
    assert result.json() == {"facts": [], "events": [], "profiles": []}
    assert secret not in str(result.request.url)
    assert search.await_args.args[2] == secret
    assert (await client.get(f"/api/users/{uid}/search", params={"query": secret})).status_code == 405
    malformed = (await client.post(f"/api/users/{uid}/search", json={"query": secret, "limit": secret}))
    assert malformed.status_code == 422 and secret not in malformed.text
    monkeypatch.setattr(event, "retrieve_user_facts", AsyncMock(side_effect=RuntimeError(secret)))
    with patch("memoia_server.api_layer.middleware.LOG.error") as log:
        failed = (await client.post(f"/api/users/{uid}/context", json={"query": secret}))
        assert failed.status_code == 500
        assert secret not in failed.text and secret not in str(log.call_args_list)


@pytest.mark.asyncio
async def test_read_only_posts_obey_read_scope(client, monkeypatch):
    project = "single-api-" + uuid4().hex
    assert (await client.post("/api/projects", json={"project_id": project})).status_code == 201
    token = (await client.post(f"/api/projects/{project}/keys", json={"name": "reader", "scopes": ["read"]})).json()["token"]
    reader = httpx.AsyncClient(transport=httpx.ASGITransport(app=__import__("api").app), base_url="http://test", headers={"Authorization": "Bearer " + token})
    try:
        monkeypatch.setattr(event, "hybrid_search_user_events", AsyncMock(return_value=Promise.resolve(SearchResult(events=[], facts=[], profiles=[]))))
        monkeypatch.setattr(event, "retrieve_user_facts", AsyncMock(return_value=Promise.resolve([])))
        uid = str(uuid4())
        assert (await reader.post(f"/api/users/{uid}/search", json={"query": "Kyoto"})).status_code == 200
        assert (await reader.post(f"/api/users/{uid}/context", json={"query": "Kyoto"})).json() == {"context": "", "entries": []}
        assert (await reader.post("/api/users", json={})).status_code == 403
        assert (await reader.post(f"/api/users/{uid}/flush", json={"idempotency_key": "read-only"})).status_code == 403
        assert (await reader.patch("/api/project/config", json={"profile_config": ""})).status_code == 403
    finally:
        (await reader.aclose())
        from memoia_server.connectors import Session
        from memoia_server.models.database import Project
        with Session.begin() as session:
            from sqlalchemy import delete
            session.execute(delete(Project).where(Project.project_id == project))


@pytest.mark.asyncio
async def test_context_counts_complete_fact_evidence_and_preserves_rank(client, monkeypatch):
    from memoia_server.models.source import SearchEvent, Evidence, EventTime
    from memoia_server.models.response import EventGistData
    from memoia_server.temporal import render_gist
    from memoia_server.utils import get_encoded_tokens
    uid, fid, blob = str(uuid4()), uuid4(), uuid4()
    fact = Evidence(fact_id=fid, blob_id=blob, content="Kyoto hotel", topic="life_event", sub_topic="travel",
        support_groups=[["1"]], event_time=EventTime(start="2026-04-01", end="2026-04-30", precision="month",
        evidence=[{"message_id": "1", "expression": "April 2026"}]), source_messages=[])
    rendered = render_gist(EventGistData(content=fact.content, event_time=fact.event_time, source_id="dialog", blob_id=blob, fact_id=fid))
    budget = len(get_encoded_tokens(rendered))
    gist = EventGistData(content=fact.content, event_time=fact.event_time, source_id="dialog", blob_id=blob, fact_id=fid)
    result = [event.RetrievedFact(uuid4(), datetime(2026, 10, 6, tzinfo=timezone.utc), .1,
        gist.model_copy(update={"content": "oversized " * 1000})),
        event.RetrievedFact(uuid4(), datetime(2026, 10, 6, tzinfo=timezone.utc), .09, gist),
        event.RetrievedFact(uuid4(), datetime(2026, 10, 6, tzinfo=timezone.utc), .08, EventGistData(content="legacy hotel"))]
    search = AsyncMock(return_value=Promise.resolve(result))
    monkeypatch.setattr(event, "retrieve_user_facts", search)
    response = (await client.post(f"/api/users/{uid}/context", json={"query": "Kyoto April 2026", "max_token_size": budget}))
    assert response.json() == {"context": rendered, "entries": [rendered]}
    assert "April 2026" in rendered and '"precision":"month"' in rendered
    assert len(get_encoded_tokens(response.json()["context"])) <= budget
    assert search.await_count == 1


@pytest.mark.asyncio
async def test_context_recent_records_keep_evidence_and_query_none_avoids_embedding(client, monkeypatch):
    from memoia_server.models.response import EventGistData
    from memoia_server.temporal import render_gist
    search = AsyncMock()
    embedding = AsyncMock()
    gist = EventGistData(content="Sakura fact", fact_id=uuid4(), blob_id=uuid4(), source_id="dialog",
        source_messages=[{"message_id": "1", "recorded_at": "2026-10-06T00:00:00Z", "time_zone": "Asia/Shanghai"}])
    recent = Mock(return_value=[gist])
    monkeypatch.setattr(event, "retrieve_user_facts", search)
    monkeypatch.setattr(event, "recent_user_facts", recent)
    monkeypatch.setattr(event, "get_embedding", embedding)
    uid = str(uuid4())
    response = (await client.post(f"/api/users/{uid}/context", json={"query": None}))
    rendered = render_gist(gist)
    assert response.json() == {"context": rendered, "entries": [rendered]}
    assert "recorded_at" in rendered and "Asia/Shanghai" in rendered
    recent.assert_called_once_with(uid, "__root__")
    search.assert_not_called()
    embedding.assert_not_called()
