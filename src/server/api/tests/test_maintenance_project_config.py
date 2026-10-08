"""Resolved project model choices are scoped and fenced at phase submission."""

import json
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from sqlalchemy import delete, func, select, update

from memoia_server.connectors import Session
from memoia_server.controllers import maintenance
from memoia_server.env import CONFIG
from memoia_server.maintenance_agent import EventMutation, LoopUsage, ProfileMutation
from memoia_server.models.database import Project, User, UserEvent, UserProfile
from memoia_server.models.source import (memory_blobs, memory_facts, memory_messages,
    memory_sources)


@pytest.fixture
def projects(db_env):
    uid = uuid4()
    prefix = "model-config-" + uuid4().hex
    ids = [prefix + "-a", prefix + "-b"]
    with Session.begin() as session:
        for index, pid in enumerate(ids):
            session.execute(Project.__table__.insert().values(id=uuid4(), project_id=pid, project_secret=uuid4().hex,
                profile_config=json.dumps({"llm_model": f"project-model-{index}",
                    "reasoning_effort": "low" if index == 0 else "high"})))
        for pid in ids:
            session.execute(User.__table__.insert().values(id=uid, project_id=pid, additional_fields={}))
            blob, fact = uuid4(), uuid4()
            session.execute(memory_sources.insert().values(user_id=uid, project_id=pid, source_id="dialog"))
            session.execute(memory_messages.insert().values(user_id=uid, project_id=pid, source_id="dialog",
                message_id="1", role="user", content_hash="fixture", processed=True,
                occurred_at=datetime.now(timezone.utc)))
            session.execute(memory_blobs.insert().values(id=blob, user_id=uid, project_id=pid,
                source_id="dialog", message_ids=["1"], status="active"))
            session.execute(memory_facts.insert().values(id=fact, user_id=uid, project_id=pid, blob_id=blob,
                content="The user's name is Gus", subject="The user", reporter="The user", certainty="asserted",
                support_groups=[["1"]], occurred_at=datetime.now(timezone.utc), created_version=1))
            maintenance.record_changes(session, uid, pid, blob, 1, [{"kind": "added", "fact_id": str(fact)}])
    try:
        yield str(uid), ids
    finally:
        with Session.begin() as session:
            session.execute(delete(Project).where(Project.project_id.in_(ids)))


def claim_project(uid, pid):
    from tests.maintenance_support import claim_for
    maintenance.flush(uid, pid, uuid4().hex)
    return claim_for(uid, project_id=pid)


@pytest.mark.asyncio
async def test_two_projects_resolve_model_and_reasoning_without_cross_scope(projects):
    uid, ids = projects
    for index, pid in enumerate(ids):
        claim = claim_project(uid, pid)
        async with maintenance.TaskLease(claim) as lease:
            context = maintenance.DBMaintenanceContext(claim, lease)
            assert context.llm_model == f"project-model-{index}"
            assert context.reasoning_effort == ("low" if index == 0 else "high")
            page = await context.read("facts")
            assert len(page["items"]) == 1
            with Session() as session:
                owner = session.execute(select(memory_facts.c.user_id, memory_facts.c.project_id).where(
                    memory_facts.c.id == page["items"][0]["id"])).one()
            assert str(owner.user_id) == uid and owner.project_id == pid


@pytest.mark.asyncio
async def test_custom_topic_descriptions_survive_project_context(projects):
    uid, ids = projects
    topics = [
        {"topic": "p1", "description": "Own attributes", "sub_topics": []},
        {"topic": "p2", "description": "Friends and relatives", "sub_topics": []},
    ]
    with Session.begin() as session:
        session.execute(update(Project).where(Project.project_id == ids[0]).values(
            profile_config=json.dumps({"overwrite_user_profiles": topics})))
    claim = claim_project(uid, ids[0])
    async with maintenance.TaskLease(claim) as lease:
        context = maintenance.DBMaintenanceContext(claim, lease)
        assert context.profile_topics == topics
        assert context.allowed_topics == ["p1", "p2"]


@pytest.mark.asyncio
async def test_model_and_reasoning_fallbacks_are_resolved_independently(projects, monkeypatch):
    uid, ids = projects
    monkeypatch.setattr(CONFIG, "best_llm_model", "global-model")
    monkeypatch.setattr(CONFIG, "llm_reasoning_effort", "high")
    settings = [{"llm_model": "explicit-model"}, {"reasoning_effort": "low"}]
    with Session.begin() as session:
        for pid, config in zip(ids, settings):
            session.execute(update(Project).where(Project.project_id == pid).values(profile_config=json.dumps(config)))
    for pid, expected in zip(ids, [("explicit-model", "high"), ("global-model", "low")]):
        claim = claim_project(uid, pid)
        async with maintenance.TaskLease(claim) as lease:
            context = maintenance.DBMaintenanceContext(claim, lease)
            assert (context.llm_model, context.reasoning_effort) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("field,value", [("llm_model", "replacement-model"), ("reasoning_effort", "medium")])
@pytest.mark.parametrize("stage_changes", [False, True])
async def test_model_change_during_phase_conflicts_without_ack_or_partial_writes(
        projects, monkeypatch, field, value, stage_changes):
    uid, ids = projects
    pid = ids[0]
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
    observed = []

    async def runner(context):
        observed.append((context.llm_model, context.reasoning_effort))
        await context.read_changes()
        facts = await context.read("facts")
        fact_ids = [fact["id"] for fact in facts["items"]]
        if stage_changes:
            await context.stage_profile(ProfileMutation(action="upsert", content="Gus", topic="basic_info",
                sub_topic="name", fact_ids=fact_ids))
            await context.stage_event(EventMutation(action="upsert", content="The user's name is Gus", fact_ids=fact_ids))
        with Session.begin() as session:
            config = json.loads(session.scalar(select(Project.profile_config).where(Project.project_id == pid)))
            config[field] = value
            session.execute(update(Project).where(Project.project_id == pid).values(profile_config=json.dumps(config)))
        assert (context.llm_model, context.reasoning_effort) == ("project-model-0", "low")
        return context.get_plan(LoopUsage())

    assert not await maintenance.execute_claim(claim_project(uid, pid), runner=runner)
    status = maintenance.get_status(uid, pid)["flushes"][0]
    assert status["status"] == "pending"
    assert status["error"] == {"code": "maintenance_read_conflict", "retryable": True}
    assert all(model == "project-model-0" and effort == "low" for model, effort in observed)
    with Session() as session:
        profile_count = session.scalar(select(func.count()).select_from(UserProfile).where(
            UserProfile.user_id == uid, UserProfile.project_id == pid))
        assert profile_count == 0
        assert session.scalar(select(func.count()).select_from(UserEvent).where(
            UserEvent.user_id == uid, UserEvent.project_id == pid)) == 0
        assert json.loads(session.scalar(select(Project.profile_config).where(
            Project.project_id == ids[1]))) == {"llm_model": "project-model-1", "reasoning_effort": "high"}
