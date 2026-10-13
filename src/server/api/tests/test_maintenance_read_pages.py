"""Mutable tool pages preserve identities, evidence scope and bounded SQL work."""
from uuid import UUID

import pytest
from sqlalchemy import delete, event as sql_events, update

from memoia_server import connectors, maintenance_agent
from memoia_server.connectors import Session
from memoia_server.controllers import maintenance
from memoia_server.models.database import UserProfile, UserEvent
from memoia_server.models.source import memory_facts
from tests.maintenance_support import claim_for
from tests.test_maintenance import source_user, batch
from tests.test_search_bundle import search_users, seed_facts, seed_derived


def profiles(uid, fid, values):
    with Session.begin() as session:
        session.execute(UserProfile.__table__.insert(), [dict(
            id=UUID(int=ident), user_id=uid, project_id="__root__", content=content,
            attributes={"topic": "interests_preferences", "sub_topic": "fixture", "fact_ids": [str(fid)]},
        ) for ident, content in values])


@pytest.mark.asyncio
async def test_keyset_pages_merge_staged_add_update_and_delete_without_skipping(source_user, monkeypatch):
    _, fid = batch(source_user)
    profiles(source_user, fid, [(10, "needle first"), (30, "old text")])
    maintenance.flush(source_user, "__root__", "overlay-pages")
    claim = claim_for(source_user)
    async with maintenance.TaskLease(claim) as lease:
        context = maintenance.DBMaintenanceContext(claim, lease)
        await context.read_changes()
        await context.read("profiles", ids=[str(UUID(int=30))])
        await context.stage_profile(maintenance_agent.ProfileMutation(action="upsert", id=str(UUID(int=30)),
            content="needle updated", topic="interests_preferences", sub_topic="fixture", fact_ids=[str(fid)]))
        monkeypatch.setattr(maintenance, "uuid4", lambda: UUID(int=20))
        await context.stage_profile(maintenance_agent.ProfileMutation(action="upsert", content="needle new",
            topic="interests_preferences", sub_topic="fixture", fact_ids=[str(fid)]))
        first = await context.read("profiles", query="needle", limit=1)
        assert first["items"][0]["id"] == str(UUID(int=10))
        await context.stage_profile(maintenance_agent.ProfileMutation(action="remove", id=first["items"][0]["id"]))
        second = await context.read("profiles", query="needle", cursor=first["next_cursor"], limit=1)
        third = await context.read("profiles", query="needle", cursor=second["next_cursor"], limit=1)
        assert [second["items"][0]["id"], third["items"][0]["id"]] == [str(UUID(int=20)), str(UUID(int=30))]
        assert third["next_cursor"] is None
        assert (await context.read("profiles", query="old text"))["items"] == []
        pending = (await context.read("profiles", ids=[str(UUID(int=10))]))["items"][0]
        assert pending["pending_delete"] and pending["content"] == "needle first"


@pytest.mark.asyncio
async def test_query_update_of_previous_page_cannot_shift_the_next_page(source_user):
    _, fid = batch(source_user)
    profiles(source_user, fid, [(10, "needle first"), (20, "needle second")])
    maintenance.flush(source_user, "__root__", "changed-filter")
    claim = claim_for(source_user)
    async with maintenance.TaskLease(claim) as lease:
        context = maintenance.DBMaintenanceContext(claim, lease)
        await context.read_changes()
        first = await context.read("profiles", query="needle", limit=1)
        await context.stage_profile(maintenance_agent.ProfileMutation(action="upsert", id=first["items"][0]["id"],
            content="different words", topic="interests_preferences", sub_topic="fixture", fact_ids=[str(fid)]))
        following = await context.read("profiles", query="needle", cursor=first["next_cursor"], limit=1)
        assert [item["id"] for item in following["items"]] == [str(UUID(int=20))]
        assert following["next_cursor"] is None


@pytest.mark.asyncio
async def test_unsupported_entries_remain_navigation_without_deleted_evidence(search_users):
    uid, _, _, _ = search_users
    fid = seed_facts(uid, ["Original support"])[0]
    eid, pid = seed_derived(uid, [fid])
    with Session.begin() as session:
        session.execute(delete(memory_facts).where(memory_facts.c.id == fid))
    batch(uid, fact=False, changes=[{"kind": "deleted", "fact_id": str(fid)}])
    maintenance.flush(uid, "__root__", "pending-navigation")
    claim = claim_for(uid)
    async with maintenance.TaskLease(claim) as lease:
        context = maintenance.DBMaintenanceContext(claim, lease)
        for collection, ident in (("profiles", pid), ("events", eid)):
            item = (await context.read(collection, ids=[str(ident)]))["items"][0]
            assert item["pending_delete"]
            assert item["fact_ids"] == [] and item["invalid_fact_ids"] == [str(fid)]
            assert item.get("evidence", []) == []
            assert context._staged[collection][str(ident)].action == "remove"


@pytest.mark.asyncio
async def test_staged_event_uses_only_replacement_text_and_fact_links(search_users):
    uid, _, _, _ = search_users
    old, current = seed_facts(uid, ["Old evidence", "Current evidence"])
    eid, _ = seed_derived(uid, [old], content="Old story")
    batch(uid, fact=False, changes=[{"kind": "added", "fact_id": str(current)}])
    maintenance.flush(uid, "__root__", "event-overlay")
    claim = claim_for(uid)
    async with maintenance.TaskLease(claim) as lease:
        context = maintenance.DBMaintenanceContext(claim, lease)
        await context.read_changes()
        await context.read("events", ids=[str(eid)])
        await context.stage_event(maintenance_agent.EventMutation(action="upsert", id=str(eid),
            content="Replacement story", fact_ids=[str(current)]))
        assert (await context.read("events", query="Old story"))["items"] == []
        matching = (await context.read("events", query="Replacement"))["items"]
        assert [item["id"] for item in matching] == [str(eid)]
        assert matching[0]["content"] == matching[0]["event_tip"] == "Replacement story"
        item = (await context.read("events", ids=[str(eid)]))["items"][0]
        assert item["event_tip"] == item["content"] == "Replacement story"
        assert item["fact_ids"] == [str(current)]
        assert [fact["id"] for fact in item["evidence"]] == [str(current)]


@pytest.mark.asyncio
@pytest.mark.parametrize("collection", ["profiles", "events"])
async def test_derived_pages_preserve_complete_text_and_reject_oversized_entries(search_users, monkeypatch, collection):
    uid, _, _, _ = search_users
    fid = seed_facts(uid, ["Supported page fixture"])[0]
    text = "needle " + "K" * 2048
    pairs = [seed_derived(uid, [fid], content=text) for _ in range(2)]
    with Session.begin() as session:
        session.execute(update(UserProfile).where(UserProfile.user_id == uid).values(content=text))
        for eid, _ in pairs:
            row = session.get(UserEvent, (eid, "__root__"))
            row.event_data = {**row.event_data, "interpretation": "Explicitly uncertain interpretation"}
    batch(uid, fact=False, changes=[{"kind": "added", "fact_id": str(fid)}])
    maintenance.flush(uid, "__root__", "complete-pages")
    claim = claim_for(uid)
    monkeypatch.setattr(maintenance_agent, "MAX_TOOL_BYTES", 3000 if collection == "profiles" else 6000)
    async with maintenance.TaskLease(claim) as lease:
        context = maintenance.DBMaintenanceContext(claim, lease)
        first = await context.read(collection, query="needle")
        assert first["next_cursor"] and len(first["items"]) == 1
        second = await context.read(collection, query="needle", cursor=first["next_cursor"])
        assert second["next_cursor"] is None and len(second["items"]) == 1
        items = first["items"] + second["items"]
        assert len({item["id"] for item in items}) == 2
        assert all(item["content"] == text and "content_preview" not in item for item in items)
        if collection == "events":
            assert all(item["event_tip"] == text for item in items)
            assert all(item["interpretation"] == "Explicitly uncertain interpretation" for item in items)
        monkeypatch.setattr(maintenance_agent, "MAX_TOOL_BYTES", 1000)
        with pytest.raises(maintenance.SourceError) as error:
            await context.read(collection, query="needle")
        assert error.value.code == "maintenance_capacity"


@pytest.mark.asyncio
async def test_event_page_hydration_and_readset_validation_use_set_queries(search_users):
    uid, _, _, _ = search_users
    fid = seed_facts(uid, ["Shared support"])[0]
    pairs = [seed_derived(uid, [fid]) for _ in range(25)]
    batch(uid, fact=False, changes=[{"kind": "added", "fact_id": str(fid)}])
    maintenance.flush(uid, "__root__", "bounded-queries")
    claim = claim_for(uid)
    async with maintenance.TaskLease(claim) as lease:
        context = maintenance.DBMaintenanceContext(claim, lease)
        counts = []
        def record(_conn, _cursor, statement, *_):
            if statement.lstrip().upper().startswith("SELECT"):
                counts.append(statement)
        sql_events.listen(connectors.DB_ENGINE, "before_cursor_execute", record)
        try:
            await context.read("events", ids=[str(pairs[0][0])])
            one_count = len(counts)
            counts.clear()
            page = await context.read("events", ids=[str(eid) for eid, _ in pairs])
            assert len(page["items"]) == 25
            assert len(counts) == one_count <= 6
            assert all(item["evidence"][0]["id"] == str(fid) for item in page["items"])
            counts.clear()
            with Session.begin() as session:
                maintenance._verify_readset(session, claim, context.readset)
            assert len(counts) == 2  # One Fact set and one Event set, regardless of entry count.
        finally:
            sql_events.remove(connectors.DB_ENGINE, "before_cursor_execute", record)


@pytest.mark.asyncio
@pytest.mark.parametrize("entry_count", [1, 25])
async def test_apply_plan_reads_targets_support_and_tombstones_in_batches(search_users, monkeypatch, entry_count):
    uid, _, _, _ = search_users
    fid = seed_facts(uid, ["Shared support"])[0]
    pairs = [seed_derived(uid, [fid]) for _ in range(entry_count)]
    batch(uid, fact=False, changes=[{"kind": "added", "fact_id": str(fid)}])
    maintenance.flush(uid, "__root__", "apply-batches")
    counts = {}
    original_apply = maintenance._apply_plan
    def apply(session, claim, plan, kind, embeddings):
        queries = []
        def record(_conn, _cursor, statement, *_):
            if statement.lstrip().upper().startswith("SELECT"):
                queries.append(statement)
        sql_events.listen(connectors.DB_ENGINE, "before_cursor_execute", record)
        try:
            result = original_apply(session, claim, plan, kind, embeddings)
            counts[kind] = len(queries)
            return result
        finally:
            sql_events.remove(connectors.DB_ENGINE, "before_cursor_execute", record)
    monkeypatch.setattr(maintenance, "_apply_plan", apply)
    async def runner(context):
        await context.read_changes()
        await context.read("profiles", ids=[str(pid) for _, pid in pairs])
        await context.read("events", ids=[str(eid) for eid, _ in pairs])
        for eid, pid in pairs:
            await context.stage_profile(maintenance_agent.ProfileMutation(action="upsert", id=str(pid),
                content="Updated profile", topic="interests_preferences", sub_topic="fixture", fact_ids=[str(fid)]))
            await context.stage_event(maintenance_agent.EventMutation(action="upsert", id=str(eid),
                content="Updated story", fact_ids=[str(fid)]))
        return context.get_plan(maintenance_agent.LoopUsage())
    assert await maintenance.execute_claim(claim_for(uid), runner=runner)
    assert counts == {"profile": 7, "event": 4}
