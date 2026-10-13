"""Real SQL write-to-query regression, with deterministic embedding transport."""
from datetime import datetime, timezone
from unittest.mock import AsyncMock
from uuid import uuid4

import numpy as np
import pytest
from sqlalchemy import select, update, delete, event as sql_event
from memoia_server.connectors import Session, DB_ENGINE
from memoia_server.controllers import maintenance, query, event
from memoia_server.env import CONFIG
from memoia_server.models.database import UserEvent, UserProfile
from memoia_server.models.query import EventQuery, ProfileQuery
from memoia_server.models.response import EventData
from memoia_server.models.source import memory_facts
from memoia_server.models.utils import Promise
from memoia_server.llms import embeddings
from memoia_server.utils import event_embedding_str
from memoia_server.event_index_backfill import backfill
from tests.test_maintenance import source_user, batch, row, ready
from tests.maintenance_support import claim_for, derive
from tests.test_search_bundle import search_users, seed_facts, seed_derived


async def generated(uid):
    _, fid = batch(uid)
    with Session.begin() as session:
        session.execute(update(memory_facts).where(memory_facts.c.id == fid).values(
            occurred_at=datetime(2024, 1, 1, tzinfo=timezone.utc)))
    receipt = maintenance.flush(uid, "__root__", uuid4().hex)
    assert await maintenance.execute_claim(claim_for(uid), runner=derive())
    return fid, receipt


@pytest.mark.asyncio
async def test_loop_writes_searchable_event_and_real_creation_times(source_user, monkeypatch):
    before = datetime.now(timezone.utc)
    fid, receipt = await generated(source_user)
    monkeypatch.setattr(query, "get_embedding", AsyncMock(return_value=Promise.resolve(
        np.full((1, CONFIG.embedding_dim), .1))))
    result = await query.query_events(source_user, "__root__", EventQuery(
        query="different vocabulary", created_after=before, fact_ids=[fid]))
    assert len(result.events) == 1
    eid = result.events[0].id
    with Session() as session:
        story = session.scalar(select(UserEvent).where(UserEvent.id == eid))
        profile = session.scalar(select(UserProfile).where(UserProfile.user_id == source_user))
        assert story.created_at >= before and profile.created_at >= before
        assert story.event_data["time"].startswith("2024")
        assert story.embedding is not None
        created_at = story.created_at
    assert row(receipt.operation_id)["status"] == "completed"

    # Re-examining unchanged text (e.g. support changes) reuses the vector.
    embed = AsyncMock(side_effect=AssertionError("unchanged story must reuse its vector"))
    monkeypatch.setattr(embeddings, "get_embedding", embed)
    batch(source_user, fact=False, changes=[{"kind": "evidence", "fact_id": str(fid)}])
    maintenance.flush(source_user, "__root__", uuid4().hex)
    assert await maintenance.execute_claim(claim_for(source_user), runner=derive())
    with Session() as session:
        assert session.scalar(select(UserEvent.created_at).where(UserEvent.id == eid)) == created_at
    embed.assert_not_awaited()


@pytest.mark.asyncio
async def test_embedding_failure_preserves_atomicity_and_original_flush_recovery(source_user, monkeypatch):
    batch(source_user)
    receipt = maintenance.flush(source_user, "__root__", uuid4().hex)
    original = embeddings.get_embedding
    monkeypatch.setattr(embeddings, "get_embedding", AsyncMock(return_value=Promise.reject(503, "fixture")))
    assert not await maintenance.execute_claim(claim_for(source_user), runner=derive())
    failed = row(receipt.operation_id)
    assert failed["status"] == "processing" and failed["error"]["code"] == "maintenance_embedding_failed"
    with Session() as session:
        assert not session.scalars(select(UserEvent).where(UserEvent.user_id == source_user)).all()
        assert not session.scalars(select(UserProfile).where(UserProfile.user_id == source_user)).all()
    monkeypatch.setattr(embeddings, "get_embedding", original)
    ready(source_user)
    assert await maintenance.execute_claim(claim_for(source_user), runner=derive())
    assert row(receipt.operation_id)["status"] == "completed"


@pytest.mark.asyncio
async def test_fact_change_during_event_embedding_rejects_both_derived_writes(source_user, monkeypatch):
    _, fid = batch(source_user)
    receipt = maintenance.flush(source_user, "__root__", uuid4().hex)
    original = embeddings.get_embedding
    async def race(*args, **kwargs):
        with Session.begin() as session:
            from sqlalchemy import delete
            session.execute(delete(memory_facts).where(memory_facts.c.id == fid))
        return await original(*args, **kwargs)
    monkeypatch.setattr(embeddings, "get_embedding", race)
    assert not await maintenance.execute_claim(claim_for(source_user), runner=derive())
    assert row(receipt.operation_id)["error"]["code"] == "maintenance_read_conflict"
    with Session() as session:
        assert not session.scalars(select(UserEvent).where(UserEvent.user_id == source_user)).all()
        assert not session.scalars(select(UserProfile).where(UserProfile.user_id == source_user)).all()


def test_event_index_text_has_one_factual_body_and_no_interpretation():
    text = event_embedding_str(EventData(title="Trip", content="Supported story", event_tip="Supported story",
        location="Kyoto", interpretation="Maybe they reconciled"))
    assert text == "Trip\nKyoto\nSupported story"
    assert event_embedding_str(EventData(event_tip="Legacy story")).strip() == "Legacy story"


@pytest.mark.asyncio
async def test_explicit_embedding_disable_keeps_loop_lexical_only(source_user, monkeypatch):
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
    mock = AsyncMock(side_effect=AssertionError("embedding explicitly disabled"))
    monkeypatch.setattr(embeddings, "get_embedding", mock)
    await generated(source_user)
    result = await query.query_events(source_user, "__root__", EventQuery(query="Supported fact"))
    assert len(result.events) == 1
    mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_query_batching_bounds_sql_roundtrips(search_users):
    uid, _, _, _ = search_users
    ids = seed_facts(uid, ["Supported memory"])
    for _ in range(50):
        seed_derived(uid, ids)
    statements = []
    def count(*args):
        statements.append(args[2])
    sql_event.listen(DB_ENGINE, "before_cursor_execute", count)
    try:
        events = await query.query_events(uid, "__root__", EventQuery(limit=1))
        event_count = len(statements)
        statements.clear()
        profiles = await query.query_profiles(uid, "__root__", ProfileQuery(limit=1))
        profile_count = len(statements)
    finally:
        sql_event.remove(DB_ENGINE, "before_cursor_execute", count)
    assert len(events.events) == len(profiles.profiles) == 1
    assert event_count <= 6 and profile_count <= 5


@pytest.mark.asyncio
async def test_budget_skips_whole_oversized_page_then_reads_next(search_users):
    uid, _, _, _ = search_users
    ids = seed_facts(uid, ["Supported memory"])
    for _ in range(20):
        seed_derived(uid, ids, content="large " * 5000)
    eid, _ = seed_derived(uid, ids, content="Small complete story")
    with Session.begin() as session:
        session.execute(update(UserEvent).where(UserEvent.id == eid).values(
            created_at=datetime(2020, 1, 1, tzinfo=timezone.utc)))
    result = await query.query_events(uid, "__root__", EventQuery(limit=1, max_token_size=1000))
    assert [entry.id for entry in result.events] == [eid]
    assert result.events[0].event_data.content == "Small complete story"
    assert result.events[0].event_data.evidence[0].fact_id == ids[0]


@pytest.mark.asyncio
async def test_missing_vector_backfill_is_scoped_bounded_and_does_not_overwrite_races(search_users, monkeypatch):
    uid, other, pid, _ = search_users
    facts = seed_facts(uid, ["A fact"])
    e1, _ = seed_derived(uid, facts)
    e2, _ = seed_derived(uid, facts)
    foreign, _ = seed_derived(other, seed_facts(other, ["Other user"]))
    foreign_project, _ = seed_derived(uid, seed_facts(uid, ["Other project"], pid=pid), pid=pid)
    monkeypatch.setattr(CONFIG, "enable_event_embedding", True)
    async def embedding(*args, **kwargs):
        with Session.begin() as session:
            session.execute(delete(UserEvent).where(UserEvent.id == e1))
            session.execute(update(UserEvent).where(UserEvent.id == e2).values(revision=2))
        return Promise.resolve(np.full((2, CONFIG.embedding_dim), .1))
    mock = AsyncMock(side_effect=embedding)
    monkeypatch.setattr(embeddings, "get_embedding", mock)
    assert (await backfill("__root__", uid, limit=1))["scanned"] == 1
    mock.assert_not_awaited()
    result = await backfill("__root__", uid, apply=True)
    assert result["scanned"] == result["skipped"] == 2 and result["updated"] == 0
    mock.side_effect = lambda _, texts, **kwargs: Promise.resolve(np.full((len(texts), CONFIG.embedding_dim), .1))
    with Session() as session:
        before = session.execute(select(UserEvent.created_at, UserEvent.updated_at, UserEvent.revision).where(UserEvent.id == e2)).one()
    assert (await backfill("__root__", uid, apply=True))["updated"] == 1
    with Session() as session:
        after = session.execute(select(UserEvent.created_at, UserEvent.updated_at, UserEvent.revision).where(UserEvent.id == e2)).one()
        assert before == after
        assert all(value is None for value in session.scalars(select(UserEvent.embedding).where(UserEvent.id.in_([foreign, foreign_project]))))
