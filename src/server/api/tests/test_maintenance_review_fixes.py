"""Review counterexamples over real SQL/Redis and the actual SDK runner."""
from datetime import datetime, timezone
from uuid import uuid4

import numpy as np
import pytest
from sqlalchemy import insert, select, update

from tests.test_search_bundle import search_users, seed_facts, seed_derived
from tests.test_maintenance_agent import transport, completion, tool
from tests.test_temporal_evidence import period
from tests.maintenance_support import maintain, derive
from memoia_server import maintenance_agent
from memoia_server.connectors import Session
from memoia_server.controllers import event, source, maintenance
from memoia_server.env import CONFIG
from memoia_server.models.database import UserProfile, UserEvent
from memoia_server.models.source import (
    DeleteMessages, memory_facts, memory_blobs, memory_messages, memory_profile_revisions,
)
from memoia_server.models.utils import Promise


@pytest.mark.asyncio
async def test_worker_batch_removes_seven_profiles_and_stories_after_support_deletion(search_users, transport):
    uid, _, _, _ = search_users
    fid = seed_facts(uid, ["Sakura history"])[0]
    for _ in range(7):
        seed_derived(uid, [fid])
    with Session() as session:
        sid = session.scalar(select(memory_blobs.c.source_id).where(memory_blobs.c.user_id == uid))
    await source.delete_messages(uid, "__root__", sid,
        DeleteMessages(message_ids=["m1"], idempotency_key="delete-all-support"))
    transport["responses"] = [completion(None, calls=[tool("read_changes", {})]), completion()]
    assert await maintain(uid, maintenance_agent.run_loop)
    assert all(f["status"] == "completed" for f in maintenance.get_status(uid, "__root__")["flushes"])
    with Session() as session:
        assert session.query(UserProfile).filter_by(user_id=uid).count() == 0
        assert session.query(UserEvent).filter_by(user_id=uid).count() == 0
    assert len(transport["requests"]) == 2


@pytest.mark.asyncio
async def test_loop_hybrid_search_is_semantic_scoped_and_reads_current_facts(search_users, monkeypatch):
    uid, other, pid, _ = search_users
    fid = seed_facts(uid, ["The colleague could not join the mountain walk because of overtime"])[0]
    future = seed_facts(uid, ["Hiking invitation"])[0]
    foreign = [seed_facts(other, ["Hiking invitation"])[0],
               seed_facts(uid, ["Hiking invitation"], pid=pid)[0]]
    vector = np.ones(CONFIG.embedding_dim)
    with Session.begin() as session:
        session.execute(update(memory_facts).where(memory_facts.c.id == fid).values(embedding=vector, created_version=1))
        session.execute(update(memory_facts).where(memory_facts.c.id == future).values(embedding=vector, created_version=2))
        session.execute(update(memory_facts).where(memory_facts.c.id.in_(foreign)).values(embedding=vector))
        bid = session.scalar(select(memory_facts.c.blob_id).where(memory_facts.c.id == fid))
        maintenance.record_changes(session, uid, "__root__", bid, 1, [{"kind": "added", "fact_id": str(fid)}])
    eid, profile = seed_derived(uid, [fid])
    monkeypatch.setattr(CONFIG, "enable_event_embedding", True)
    async def embed(*args, **kwargs):
        return Promise.resolve([vector])
    monkeypatch.setattr(event, "get_embedding", embed)
    async def runner(context):
        await context.read_changes()
        found = await context.search("Hiking invitation", limit=20)
        assert set(fact["id"] for fact in found["facts"]) == {str(fid), str(future)}
        assert [entry["id"] for entry in found["events"]] == [str(eid)]
        assert [entry["id"] for entry in found["profiles"]] == [str(profile)]
        assert context.readset["facts"] == {str(fid): 1, str(future): 1}
        assert all("user_id" not in item and "project_id" not in item
                   for entries in found.values() for item in entries)
        return context.get_plan(maintenance_agent.LoopUsage())
    assert await maintain(uid, runner)


def timed_profile(uid, label):
    fid = seed_facts(uid, [f"Visited {label}"])[0]
    scope = dict(user_id=uid, project_id="__root__")
    profile_id = uuid4()
    with Session.begin() as session:
        blob = session.execute(select(memory_blobs).where(memory_blobs.c.id ==
            select(memory_facts.c.blob_id).where(memory_facts.c.id == fid).scalar_subquery())).mappings().one()
        sid = blob["source_id"]
        session.execute(insert(memory_messages).values(**scope, source_id=sid, message_id="m2", role="user",
            content_hash="no-body", processed=True, occurred_at=datetime(2026, 9, 4, tzinfo=timezone.utc)))
        session.execute(update(memory_blobs).where(memory_blobs.c.id == blob["id"]).values(message_ids=["m1", "m2"]))
        session.execute(update(memory_facts).where(memory_facts.c.id == fid).values(
            support_groups=[["m1"], ["m2"]], event_time=period(mid="m2")))
        old = dict(id=str(profile_id), content=f"Visited {label} in April 2025", topic="life_event",
                   sub_topic="visit", fact_ids=[str(fid)], source_ids=[sid])
        session.execute(UserProfile.__table__.insert().values(**scope, id=profile_id, content=old["content"],
            attributes={"memoia_v2": True, "topic": old["topic"], "sub_topic": old["sub_topic"],
                        "fact_ids": [str(fid)], "source_ids": [sid]}))
        session.execute(memory_profile_revisions.insert().values(**scope, id=uuid4(),
            profiles=[old], added=[old], removed=[]))
    return sid, fid, profile_id


def history_text(uid):
    return [entry.content for row in source.get_history(uid, "__root__")
            for entry in [*row.profiles, *row.added, *row.removed]]


@pytest.mark.asyncio
async def test_surviving_fact_loses_time_in_history_before_and_after_maintenance(search_users):
    uid, _, _, _ = search_users
    sid, fid, _ = timed_profile(uid, "Sakura Hotel")
    await source.delete_messages(uid, "__root__", sid,
        DeleteMessages(message_ids=["m2"], idempotency_key="delete-time"))
    with Session() as session:
        assert "April 2025" in session.scalar(select(UserProfile.content).where(UserProfile.user_id == uid))
    assert not any("April 2025" in text for text in history_text(uid))
    assert await maintain(uid, derive())
    with Session() as session:
        fact = session.execute(select(memory_facts).where(memory_facts.c.id == fid)).mappings().one()
        assert fact["active"] and fact["event_time"] is None
    assert history_text(uid) and not any("April 2025" in text for text in history_text(uid))


@pytest.mark.asyncio
async def test_new_evidence_deletion_during_loop_cannot_reintroduce_stale_history(search_users):
    uid, _, _, _ = search_users
    sid, _, _ = timed_profile(uid, "Sakura Hotel")
    other_sid, _, other_profile = timed_profile(uid, "Bluebird Cafe")
    await source.delete_messages(uid, "__root__", sid,
        DeleteMessages(message_ids=["m2"], idempotency_key="first-time"))
    original = derive()
    async def runner(context):
        await source.delete_messages(uid, "__root__", other_sid,
            DeleteMessages(message_ids=["m2"], idempotency_key="later-time"))
        return await original(context)
    assert await maintain(uid, runner)
    with Session() as session:
        assert "April 2025" in session.scalar(select(UserProfile.content).where(UserProfile.id == other_profile))
    assert not any("April 2025" in text for text in history_text(uid))
    assert maintenance.get_status(uid, "__root__")["pending_blob_count"] == 1
    assert await maintain(uid, derive())
    assert not any("April 2025" in text for text in history_text(uid))
