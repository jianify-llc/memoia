"""Independent candidate pools and filters, tested against the real isolated DB."""
from uuid import uuid4
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import update, select
from tests.test_search_bundle import search_users, seed_facts, seed_derived
from memoia_server.connectors import Session
from memoia_server.models.database import UserEvent, UserProfile
from memoia_server.models.source import memory_facts, memory_blobs
from memoia_server.models.utils import Promise
from memoia_server.env import CONFIG
from memoia_server.controllers import query


@pytest.mark.asyncio
async def test_independent_fact_filters_precede_limit_and_ignore_other_memory_pools(search_users):
    uid, other, pid, client = search_users
    ids = seed_facts(uid, ["Sakura " + str(i) for i in range(60)])
    seed_facts(other, ["Sakura other user"])
    seed_facts(uid, ["Sakura other project"], pid=pid)
    with Session.begin() as session:
        blob = session.execute(select(memory_facts.c.blob_id).where(memory_facts.c.id == ids[-1])).scalar_one()
        sid = session.execute(select(memory_blobs.c.source_id).where(memory_blobs.c.id == blob)).scalar_one()
    response = await client.post(f"/api/users/{uid}/facts/query", json={"query": "Sakura", "ids": [str(ids[-1])],
        "source_ids": [sid], "limit": 1, "recorded_after": "2026-09-01T00:00:00Z"})
    assert response.status_code == 200
    assert [row["id"] for row in response.json()["facts"]] == [str(ids[-1])]
    assert response.json()["facts"][0]["evidence"]["event_time"] is None
    all_found = await client.post(f"/api/users/{uid}/facts/query", json={"query": "Sakura", "limit": 100})
    # Full proof counts toward the response budget: never require all 60 to fit.
    selected = {row["id"] for row in all_found.json()["facts"]}
    assert selected and selected <= set(map(str, ids))
    excluded = await client.post(f"/api/users/{uid}/facts/query", json={"ids": [str(ids[-1])], "exclude_ids": [str(ids[-1])]})
    assert excluded.json()["facts"] == []
    denied = await client.post(f"/api/users/{uid}/facts/query", json={"recorded_after": "2026-10-01T00:00:00Z"})
    assert denied.json()["facts"] == []


@pytest.mark.asyncio
async def test_event_query_has_its_own_keywords_links_and_calendar_time(search_users):
    uid, _, _, client = search_users
    ids = seed_facts(uid, ["Unrelated factual vocabulary"])
    event, _ = seed_derived(uid, ids, content="An independent story about Sakura")
    with Session.begin() as session:
        session.execute(update(memory_facts).where(memory_facts.c.id == ids[0]).values(event_time={
            "start": "2024-04-01", "end": "2024-04-30", "precision": "month",
            "evidence": [{"message_id": "m1", "expression": "April 2024"}]}))
    found = await client.post(f"/api/users/{uid}/events/query", json={"query": "Sakura", "fact_ids": [str(ids[0])],
        "event_after": "2024-04-01", "event_before": "2024-04-30", "max_token_size": 4000})
    assert found.status_code == 200
    assert [row["id"] for row in found.json()["events"]] == [str(event)]
    assert found.json()["events"][0]["created_at"].startswith("2026-")
    assert found.json()["events"][0]["event_data"]["fact_ids"] == [str(ids[0])]
    assert found.json()["events"][0]["event_data"]["evidence"][0]["event_time"]["start"] == "2024-04-01"
    with Session.begin() as session:
        session.execute(update(UserEvent).where(UserEvent.id == event).values(event_data={"event_tip": "Legacy Sakura story"}))
    legacy = await client.post(f"/api/users/{uid}/events/query", json={"ids": [str(event)]})
    assert legacy.json()["events"][0]["event_data"]["fact_ids"] == [str(ids[0])]
    no_time = await client.post(f"/api/users/{uid}/events/query", json={"event_after": "2025-01-01"})
    assert no_time.json()["events"] == []
    no_link = await client.post(f"/api/users/{uid}/events/query", json={"fact_ids": [str(uuid4())]})
    assert no_link.json()["events"] == []


@pytest.mark.asyncio
async def test_profile_query_is_independent_and_filters_scope_before_budget(search_users):
    uid, other, pid, client = search_users
    ids = seed_facts(uid, ["No Sakura fact keyword"])
    _, target = seed_derived(uid, ids)
    with Session.begin() as session:
        session.execute(update(UserProfile).where(UserProfile.id == target).values(content="Sakura preference"))
        for who, project in [(other, "__root__"), (uid, pid)]:
            session.execute(UserProfile.__table__.insert().values(id=uuid4(), user_id=who, project_id=project,
                content="Sakura secret", attributes={"topic": "interest", "sub_topic": "travel"}))
    found = await client.post(f"/api/users/{uid}/profiles/query", json={"query": "Sakura", "topic": "interest", "sub_topic": "travel"})
    assert found.status_code == 200
    assert [row["id"] for row in found.json()["profiles"]] == [str(target)]
    filtered = await client.post(f"/api/users/{uid}/profiles/query", json={"topic": "basic_info"})
    assert filtered.json()["profiles"] == []
    tiny = await client.post(f"/api/users/{uid}/profiles/query", json={"max_token_size": 20})
    assert tiny.json()["profiles"] == []


@pytest.mark.asyncio
async def test_read_query_contract_rejects_forged_scope_unknown_filters_and_bad_time(search_users):
    uid, _, _, client = search_users
    for suffix, body in [("facts", {"project_id": "forged"}), ("events", {"event_after": "2026-10-12", "event_before": "2020-01-01"}),
                         ("profiles", {"source_ids": ["unsupported"]}), ("facts", {"recorded_after": "2026-01-01T00:00:00"})]:
        response = await client.post(f"/api/users/{uid}/{suffix}/query", json=body)
        assert response.status_code == 422
    identity = await client.get("/api/project/identity")
    assert identity.status_code == 200 and identity.json() == {"project_id": "__root__"}


@pytest.mark.asyncio
async def test_query_read_scope_and_identity_are_live_and_project_isolated(search_users):
    uid, _, pid, client = search_users
    seed_facts(uid, ["Private root memory"])
    project_facts = seed_facts(uid, ["Reader project memory"], pid=pid)
    issued = (await client.post(f"/api/projects/{pid}/keys", json={"name": "query-reader", "scopes": ["read"]})).json()
    headers = {"Authorization": "Bearer " + issued["token"]}
    identity = await client.get("/api/project/identity", headers=headers)
    assert identity.json() == {"project_id": pid}
    facts = await client.post(f"/api/users/{uid}/facts/query", headers=headers, json={})
    assert [row["id"] for row in facts.json()["facts"]] == list(map(str, project_facts))
    for kind in ("events", "profiles"):
        assert (await client.post(f"/api/users/{uid}/{kind}/query", headers=headers, json={})).status_code == 200
    assert (await client.post(f"/api/users/{uid}/flush", headers=headers, json={"idempotency_key": "forbidden"})).status_code == 403
    assert (await client.delete(f"/api/projects/{pid}/keys/{issued['key_id']}")).status_code == 204
    assert (await client.get("/api/project/identity", headers=headers)).status_code == 401
    assert (await client.post(f"/api/users/{uid}/facts/query", headers=headers, json={})).status_code == 401


@pytest.mark.asyncio
async def test_query_provider_transient_fallback_and_configuration_errors(search_users, monkeypatch):
    uid, _, _, client = search_users
    ids = seed_facts(uid, ["Sakura surviving lexical fact"])
    monkeypatch.setattr(CONFIG, "enable_event_embedding", True)
    provider = AsyncMock(return_value=Promise.reject(503, "unavailable"))
    monkeypatch.setattr(query, "get_embedding", provider)
    reply = await client.post(f"/api/users/{uid}/facts/query", json={"query": "Sakura"})
    assert [row["id"] for row in reply.json()["facts"]] == list(map(str, ids))
    provider.return_value = Promise.reject(401, "private provider detail")
    failed = await client.post(f"/api/users/{uid}/events/query", json={"query": "Sakura"})
    assert failed.status_code == 422 and failed.json()["detail"]["code"] == "query_configuration"
    assert "private provider detail" not in failed.text
    provider.reset_mock()
    assert (await client.post(f"/api/users/{uid}/facts/query", json={})).status_code == 200
    provider.assert_not_awaited()
