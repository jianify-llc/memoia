"""Fact relevance and complete context boundaries through real isolated SQL/API."""
import os
from datetime import datetime, timezone
from uuid import uuid4
from unittest.mock import AsyncMock

import numpy as np
import pytest
import pytest_asyncio
import httpx
from sqlalchemy import delete, insert, select, update

from memoia_server.connectors import Session
from memoia_server.controllers import event
from memoia_server.env import CONFIG
from memoia_server.models.database import User, UserEvent, UserEventGist
from memoia_server.models.source import memory_sources, memory_messages, memory_blobs, memory_facts, memory_event_facts
from memoia_server.models.utils import Promise


@pytest_asyncio.fixture
async def fact_user(db_env):
    uid = uuid4()
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=__import__("api").app), base_url="http://test", headers={"Authorization": "Bearer " + os.environ["ACCESS_TOKEN"]})
    with Session.begin() as session:
        user = User(project_id="__root__")
        user.id = uid
        session.add(user)
    try:
        yield uid, client
    finally:
        (await client.aclose())
        with Session.begin() as session:
            session.execute(delete(User).where(User.id == uid, User.project_id == "__root__"))


def store_facts(uid, contents, *, with_event=True, recorded_at=None, time_zone="Asia/Shanghai", source_id="dialog"):
    blob, fact_ids = uuid4(), [uuid4() for _ in contents]
    identity = {"user_id": uid, "project_id": "__root__"}
    recorded_at = recorded_at or datetime(2026, 4, 3, tzinfo=timezone.utc)
    with Session.begin() as session:
        session.execute(insert(memory_sources).values(**identity, source_id=source_id))
        session.execute(insert(memory_messages).values(**identity, source_id=source_id, message_id="1",
            content_hash="fixture", role="user", occurred_at=recorded_at, time_zone=time_zone, processed=True))
        session.execute(insert(memory_blobs).values(**identity, id=blob, source_id=source_id,
            message_ids=["1"], status="active"))
        for fact_id, content in zip(fact_ids, contents):
            session.execute(insert(memory_facts).values(**identity, id=fact_id, blob_id=blob,
                content=content, search_text=content, topic="life_event", sub_topic="travel",
                support_groups=[["1"]], occurred_at=recorded_at))
        if not with_event:
            return None, fact_ids
        row = UserEvent(**identity, event_data={"memoia_v2": True,
            "event_tip": "\n".join(contents), "fact_ids": [str(ident) for ident in fact_ids]})
        session.add(row)
        session.flush()
        session.execute(insert(memory_event_facts), [dict(identity, event_id=row.id, fact_id=ident) for ident in fact_ids])
        return row.id, fact_ids


@pytest.mark.asyncio
async def test_matching_fact_survives_budget_in_large_event(fact_user, monkeypatch):
    uid, client = fact_user
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
    eid, fact_ids = store_facts(uid, [f"Alice enjoys guitar and gardening, unrelated note {i}." for i in range(12)]
        + ["Alice stayed at Sakura Hotel in Kyoto."])
    result = (await client.post(f"/api/users/{uid}/context", json={"query": "Sakura", "max_token_size": 500}))
    assert result.status_code == 200
    data = result.json()
    assert "Sakura" in data["context"] and "guitar" not in data["context"]
    assert data["context"] == "\n\n".join(data["entries"])
    assert "recorded_at" in data["entries"][0] and "Asia/Shanghai" in data["entries"][0]
    search = (await client.post(f"/api/users/{uid}/search", json={"query": "Sakura", "include_events": False})).json()
    assert search["events"] == []
    assert [fact["id"] for fact in search["facts"]] == [str(fact_ids[-1])]
    assert search["facts"][0]["evidence"]["content"] == "Alice stayed at Sakura Hotel in Kyoto."
    expanded = (await client.post(f"/api/users/{uid}/search", json={"query": "Sakura", "include_events": True,
        "event_max_tokens": 8000, "max_token_size": 10000})).json()
    assert expanded["events"][0]["id"] == str(eid)
    bounded = (await client.post(f"/api/users/{uid}/search", json={"query": "Sakura", "include_events": True,
        "event_max_tokens": 1})).json()
    assert bounded["events"] == [] and len(bounded["facts"]) == 1
    with Session() as session:
        assert session.scalar(select(memory_facts.c.content).where(memory_facts.c.id == fact_ids[-1])) == "Alice stayed at Sakura Hotel in Kyoto."


@pytest.mark.asyncio
async def test_embedding_outage_keeps_available_lexical_evidence(fact_user, monkeypatch):
    uid, client = fact_user
    store_facts(uid, ["Alice stayed at Sakura Hotel in Kyoto."])
    monkeypatch.setattr(CONFIG, "enable_event_embedding", True)
    monkeypatch.setattr(event, "get_embedding", AsyncMock(return_value=Promise.reject(503, "Controlled outage")))
    result = (await client.post(f"/api/users/{uid}/context", json={"query": "Sakura"}))
    assert result.status_code == 200 and "Sakura" in result.json()["context"]


@pytest.mark.parametrize("status", [400, 422])
@pytest.mark.asyncio
async def test_embedding_input_or_configuration_rejection_is_not_silently_degraded(fact_user, monkeypatch, status):
    uid, client = fact_user
    store_facts(uid, ["Sakura Hotel"])
    monkeypatch.setattr(CONFIG, "enable_event_embedding", True)
    monkeypatch.setattr(event, "get_embedding", AsyncMock(return_value=Promise.reject(status, "Controlled rejection")))
    assert (await client.post(f"/api/users/{uid}/context", json={"query": "Sakura"})).status_code != 200


@pytest.mark.asyncio
async def test_deleting_event_preserves_fact_index_and_message_delete_removes_it(fact_user, monkeypatch):
    uid, client = fact_user
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
    eid, fact_ids = store_facts(uid, ["Sakura Hotel"])
    assert (await client.delete(f"/api/users/{uid}/events/{eid}")).status_code == 204
    result = (await client.post(f"/api/users/{uid}/search", json={"query": "Sakura", "include_events": True})).json()
    assert [fact["id"] for fact in result["facts"]] == [str(fact_ids[0])]
    assert result["events"] == []
    deleted = await client.request("DELETE", f"/api/users/{uid}/sources/dialog/messages",
        json={"idempotency_key": "delete-message-1", "message_ids": ["1"]})
    assert deleted.status_code == 200 and deleted.json()["status"] == "completed"
    assert (await client.post(f"/api/users/{uid}/context", json={"query": "Sakura"})).json() == {"context": "", "entries": []}


@pytest.mark.asyncio
async def test_unindexed_old_event_remains_searchable_without_new_dates(fact_user, monkeypatch):
    uid, client = fact_user
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
    with Session.begin() as session:
        session.add(UserEvent(user_id=uid, project_id="__root__", event_data={"event_tip": "Sakura legacy hotel"}))
    result = (await client.post(f"/api/users/{uid}/context", json={"query": "Sakura"})).json()
    assert result == {"context": "Sakura legacy hotel", "entries": ["Sakura legacy hotel"]}


@pytest.mark.asyncio
async def test_non_source_legacy_gist_remains_searchable(fact_user, monkeypatch):
    uid, client = fact_user
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
    with Session.begin() as session:
        legacy = UserEvent(user_id=uid, project_id="__root__", event_data={"event_tip": "Legacy narrative"})
        session.add(legacy)
        session.flush()
        session.add(UserEventGist(user_id=uid, project_id="__root__", event_id=legacy.id,
            gist_data={"content": "Sakura legacy hotel"}))
        eid = legacy.id
    result = (await client.post(f"/api/users/{uid}/search", json={"query": "Sakura"})).json()
    assert result["facts"] == []
    assert [row["id"] for row in result["events"]] == [str(eid)]
    assert result["events"][0]["content"] == "Sakura legacy hotel"
    assert result["events"][0]["evidence"] == []
    assert (await client.post(f"/api/users/{uid}/context", json={"query": "Sakura"})).json() == {
        "context": "Sakura legacy hotel", "entries": ["Sakura legacy hotel"]}


@pytest.mark.asyncio
async def test_recent_context_combines_independent_fact_and_real_legacy_event(fact_user, monkeypatch):
    uid, client = fact_user
    monkeypatch.setattr(event, "get_embedding", AsyncMock(side_effect=AssertionError("Recent reads need no model")))
    _, fact_ids = store_facts(uid, ["Sakura current fact"], with_event=False)
    with Session.begin() as session:
        session.add(UserEvent(user_id=uid, project_id="__root__", event_data={"event_tip": "Legacy undated event"}))
    result = (await client.post(f"/api/users/{uid}/context", json={"query": None})).json()
    assert len(result["entries"]) == 2
    assert result["entries"][0] == "Legacy undated event"
    assert "Sakura current fact" in result["entries"][1] and str(fact_ids[0]) in result["entries"][1]
    assert "Asia/Shanghai" in result["entries"][1]


@pytest.mark.asyncio
@pytest.mark.parametrize("ranked", [False, True])
async def test_fact_evidence_query_count_does_not_grow_with_result_count(fact_user, monkeypatch, ranked):
    from sqlalchemy import event as sql_event
    from memoia_server.connectors import DB_ENGINE
    uid, _ = fact_user
    store_facts(uid, [f"Sakura hotel note {index}" for index in range(12)], with_event=False)
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
    statements = []

    def capture(_connection, _cursor, statement, *_):
        if statement.lstrip().startswith("SELECT"):
            statements.append(statement)

    sql_event.listen(DB_ENGINE, "before_cursor_execute", capture)
    try:
        counts = []
        for limit in (1, 12):
            statements.clear()
            if ranked:
                response = await event.retrieve_user_facts(uid, "__root__", "Sakura", limit)
                assert response.ok()
                entries = response.data()
                assert all(entry.evidence.source_messages for entry in entries)
            else:
                entries = event.recent_user_facts(uid, "__root__", limit)
                assert all(entry.source_messages for entry in entries)
            assert len(entries) == limit
            assert sum("FROM memory_messages" in sql for sql in statements) == 1
            counts.append(len(statements))
        assert counts[0] == counts[1]
    finally:
        sql_event.remove(DB_ENGINE, "before_cursor_execute", capture)


def test_bulk_evidence_keeps_same_message_id_isolated_across_users(fact_user):
    uid, _ = fact_user
    other = uuid4()
    with Session.begin() as session:
        user = User(project_id="__root__")
        user.id = other
        session.add(user)
    try:
        _, own_ids = store_facts(uid, ["Own fact"], with_event=False)
        other_time = datetime(2026, 5, 3, tzinfo=timezone.utc)
        _, foreign_ids = store_facts(other, ["Foreign fact"], with_event=False, recorded_at=other_time, time_zone="UTC")
        _, second_source_ids = store_facts(uid, ["Another source fact"], with_event=False,
            source_id="another-dialog", recorded_at=other_time, time_zone="Europe/London")
        with Session() as session:
            rows = session.execute(select(memory_facts, memory_blobs.c.source_id).join(memory_blobs,
                memory_facts.c.blob_id == memory_blobs.c.id).where(
                memory_facts.c.id.in_(own_ids + foreign_ids + second_source_ids))).mappings().all()
            evidence = event.facts_evidence(session, rows)
        assert evidence[own_ids[0]].source_messages[0].time_zone == "Asia/Shanghai"
        assert evidence[foreign_ids[0]].source_messages[0].time_zone == "UTC"
        assert evidence[foreign_ids[0]].source_messages[0].recorded_at == other_time
        assert evidence[second_source_ids[0]].source_messages[0].time_zone == "Europe/London"
        assert len(evidence[own_ids[0]].source_messages) == len(evidence[foreign_ids[0]].source_messages) == 1
    finally:
        with Session.begin() as session:
            session.execute(delete(User).where(User.id == other, User.project_id == "__root__"))


@pytest.mark.asyncio
async def test_fact_vectors_drive_fusion_and_cross_user_facts_are_excluded(fact_user, monkeypatch):
    uid, client = fact_user
    other = uuid4()
    with Session.begin() as session:
        user = User(project_id="__root__")
        user.id = other
        session.add(user)
    query_vector = np.zeros(CONFIG.embedding_dim)
    query_vector[0] = 1
    unrelated_vector = np.zeros(CONFIG.embedding_dim)
    unrelated_vector[1] = 1
    try:
        eid, fact_ids = store_facts(uid, ["Sakura hotel", "hotel advice", "guitar unrelated"])
        store_facts(other, ["hotel private foreign user"])
        with Session.begin() as session:
            # 整体事件向量故意不相关，事实向量才是本次相关性的真相源。
            parent = session.get(UserEvent, (eid, "__root__"))
            parent.embedding = unrelated_vector
            for row in session.execute(select(memory_facts).where(memory_facts.c.project_id == "__root__",
                memory_facts.c.user_id.in_([uid, other]))).mappings():
                vector = query_vector if "Sakura" in row["content"] or row["user_id"] == other else unrelated_vector
                session.execute(update(memory_facts).where(memory_facts.c.id == row["id"]).values(embedding=vector))
        monkeypatch.setattr(CONFIG, "enable_event_embedding", True)
        monkeypatch.setattr(event, "get_embedding", AsyncMock(return_value=Promise.resolve(np.array([query_vector]))))
        result = (await client.post(f"/api/users/{uid}/search", json={"query": "hotel", "include_events": False})).json()
        assert result["events"] == []
        assert [fact["id"] for fact in result["facts"]] == [str(ident) for ident in fact_ids[:2]]
        assert result["facts"][0]["score"] > .03
        assert [fact["content"] for fact in result["facts"]] == ["Sakura hotel", "hotel advice"]
        context = (await client.post(f"/api/users/{uid}/context", json={"query": "hotel"})).json()
        assert context["entries"][0].startswith("Sakura hotel")
        assert "private foreign" not in context["context"] and "guitar" not in context["context"]
    finally:
        with Session.begin() as session:
            session.execute(delete(User).where(User.id == other, User.project_id == "__root__"))


@pytest.mark.asyncio
async def test_lexical_finishes_while_query_embedding_waits_and_timeout_cancels_vector(fact_user, monkeypatch):
    import asyncio
    import threading
    from sqlalchemy import event as sql_event
    from memoia_server.connectors import DB_ENGINE
    uid, client = fact_user
    store_facts(uid, ["Alice stayed at Sakura Hotel in Kyoto."])
    monkeypatch.setattr(CONFIG, "enable_event_embedding", True)
    monkeypatch.setattr(event, "QUERY_EMBEDDING_TIMEOUT_SECONDS", .1)
    lexical_finished = threading.Event()
    vector_cancelled = threading.Event()
    vector_saw_lexical = threading.Event()

    def observed(connection, cursor, statement, parameters, context, many):
        if "ts_rank_cd" in statement:
            lexical_finished.set()

    async def blocked_vector(*args, **kwargs):
        try:
            if await asyncio.to_thread(lexical_finished.wait, .08):
                vector_saw_lexical.set()
            await asyncio.Future()
        finally:
            vector_cancelled.set()

    sql_event.listen(DB_ENGINE, "after_cursor_execute", observed)
    monkeypatch.setattr(event, "get_embedding", blocked_vector)
    try:
        result = (await client.post(f"/api/users/{uid}/context", json={"query": "Sakura"}))
        assert result.status_code == 200 and "Sakura" in result.json()["context"]
        assert vector_saw_lexical.is_set() and vector_cancelled.is_set()
    finally:
        sql_event.remove(DB_ENGINE, "after_cursor_execute", observed)
