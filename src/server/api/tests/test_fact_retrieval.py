"""Fact relevance and complete context boundaries through real isolated SQL/API."""
import os
from datetime import datetime, timezone
from uuid import uuid4
from unittest.mock import AsyncMock

import numpy as np
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from memoia_server.connectors import Session
from memoia_server.controllers import event
from memoia_server.env import CONFIG
from memoia_server.models.database import User, UserEvent, UserEventGist
from memoia_server.models.utils import Promise


@pytest.fixture
def fact_user(db_env):
    uid = uuid4()
    client = TestClient(__import__("api").app, headers={"Authorization": "Bearer " + os.environ["ACCESS_TOKEN"]})
    with Session.begin() as session:
        user = User(project_id="__root__")
        user.id = uid
        session.add(user)
    try:
        yield uid, client
    finally:
        client.close()
        with Session.begin() as session:
            session.execute(delete(User).where(User.id == uid, User.project_id == "__root__"))


def store_facts(uid, contents):
    blob = uuid4()
    evidence = [{"fact_id": str(uuid4()), "blob_id": str(blob), "content": content,
        "topic": "life_event", "sub_topic": "travel", "support_groups": [["1"]], "event_time": None,
        "source_messages": [{"message_id": "1", "recorded_at": "2026-04-03T00:00:00Z", "time_zone": "Asia/Shanghai"}]}
        for content in contents]
    with Session.begin() as session:
        row = UserEvent(user_id=uid, project_id="__root__", event_data={
            "event_tip": "\n".join(contents), "source_id": "dialog", "blob_id": str(blob), "evidence": evidence})
        session.add(row)
        session.flush()
        for fact in evidence:
            session.add(UserEventGist(user_id=uid, project_id="__root__", event_id=row.id,
                gist_data={key: fact[key] for key in ("content", "fact_id", "blob_id", "event_time", "source_messages")} | {"source_id": "dialog"}))
        return row.id


def test_matching_fact_survives_budget_in_large_event(fact_user, monkeypatch):
    uid, client = fact_user
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
    eid = store_facts(uid, [f"Alice enjoys guitar and gardening, unrelated note {i}." for i in range(12)]
        + ["Alice stayed at Sakura Hotel in Kyoto."])
    result = client.post(f"/api/users/{uid}/context", json={"query": "Sakura", "max_token_size": 500})
    assert result.status_code == 200
    data = result.json()
    assert "Sakura" in data["context"] and "guitar" not in data["context"]
    assert data["context"] == "\n\n".join(data["entries"])
    assert "recorded_at" in data["entries"][0] and "Asia/Shanghai" in data["entries"][0]
    search = client.post(f"/api/users/{uid}/search", json={"query": "Sakura"}).json()
    assert search["events"][0]["id"] == str(eid)
    assert [fact["content"] for fact in search["events"][0]["evidence"]] == ["Alice stayed at Sakura Hotel in Kyoto."]
    with Session() as session:
        assert session.scalar(select(UserEventGist.gist_data).where(UserEventGist.event_id == eid,
            UserEventGist.gist_data["content"].astext.contains("Sakura")))["content"] == "Alice stayed at Sakura Hotel in Kyoto."


def test_embedding_outage_keeps_available_lexical_evidence(fact_user, monkeypatch):
    uid, client = fact_user
    store_facts(uid, ["Alice stayed at Sakura Hotel in Kyoto."])
    monkeypatch.setattr(CONFIG, "enable_event_embedding", True)
    monkeypatch.setattr(event, "get_embedding", AsyncMock(return_value=Promise.reject(503, "Controlled outage")))
    result = client.post(f"/api/users/{uid}/context", json={"query": "Sakura"})
    assert result.status_code == 200 and "Sakura" in result.json()["context"]


@pytest.mark.parametrize("status", [400, 422])
def test_embedding_input_or_configuration_rejection_is_not_silently_degraded(fact_user, monkeypatch, status):
    uid, client = fact_user
    store_facts(uid, ["Sakura Hotel"])
    monkeypatch.setattr(CONFIG, "enable_event_embedding", True)
    monkeypatch.setattr(event, "get_embedding", AsyncMock(return_value=Promise.reject(status, "Controlled rejection")))
    assert client.post(f"/api/users/{uid}/context", json={"query": "Sakura"}).status_code != 200


def test_deleted_event_cannot_return_its_fact_index(fact_user, monkeypatch):
    uid, client = fact_user
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
    eid = store_facts(uid, ["Sakura Hotel"])
    assert client.delete(f"/api/users/{uid}/events/{eid}").status_code == 204
    assert client.post(f"/api/users/{uid}/context", json={"query": "Sakura"}).json() == {"context": "", "entries": []}


def test_unindexed_old_event_remains_searchable_without_new_dates(fact_user, monkeypatch):
    uid, client = fact_user
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
    with Session.begin() as session:
        session.add(UserEvent(user_id=uid, project_id="__root__", event_data={"event_tip": "Sakura legacy hotel"}))
    result = client.post(f"/api/users/{uid}/context", json={"query": "Sakura"}).json()
    assert result == {"context": "Sakura legacy hotel", "entries": ["Sakura legacy hotel"]}


def test_fact_vectors_drive_fusion_and_cross_user_facts_are_excluded(fact_user, monkeypatch):
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
        eid = store_facts(uid, ["Sakura hotel", "hotel advice", "guitar unrelated"])
        store_facts(other, ["hotel private foreign user"])
        with Session.begin() as session:
            # 整体事件向量故意不相关，事实向量才是本次相关性的真相源。
            parent = session.get(UserEvent, (eid, "__root__"))
            parent.embedding = unrelated_vector
            for row in session.scalars(select(UserEventGist).where(UserEventGist.project_id == "__root__",
                UserEventGist.user_id.in_([uid, other]))):
                row.embedding = query_vector if "Sakura" in row.gist_data["content"] or row.user_id == other else unrelated_vector
        monkeypatch.setattr(CONFIG, "enable_event_embedding", True)
        monkeypatch.setattr(event, "get_embedding", AsyncMock(return_value=Promise.resolve(np.array([query_vector]))))
        result = client.post(f"/api/users/{uid}/search", json={"query": "hotel"}).json()
        assert len(result["events"]) == 1
        row = result["events"][0]
        assert row["id"] == str(eid) and row["score"] > .03
        assert [fact["content"] for fact in row["evidence"]] == ["Sakura hotel", "hotel advice"]
        context = client.post(f"/api/users/{uid}/context", json={"query": "hotel"}).json()
        assert context["entries"][0].startswith("Sakura hotel")
        assert "private foreign" not in context["context"] and "guitar" not in context["context"]
    finally:
        with Session.begin() as session:
            session.execute(delete(User).where(User.id == other, User.project_id == "__root__"))


def test_lexical_finishes_while_query_embedding_waits_and_timeout_cancels_vector(fact_user, monkeypatch):
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
        result = client.post(f"/api/users/{uid}/context", json={"query": "Sakura"})
        assert result.status_code == 200 and "Sakura" in result.json()["context"]
        assert vector_saw_lexical.is_set() and vector_cancelled.is_set()
    finally:
        sql_event.remove(DB_ENGINE, "after_cursor_execute", observed)
