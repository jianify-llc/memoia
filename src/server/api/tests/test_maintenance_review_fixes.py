"""Review counterexamples over real SQL/Redis and the actual SDK runner."""
from datetime import datetime, timezone
import ast
import asyncio
import json
from types import SimpleNamespace
from uuid import UUID, uuid4

import numpy as np
import pytest
from sqlalchemy import insert, select, update

from tests.test_search_bundle import search_users, seed_facts, seed_derived
from tests.test_maintenance_agent import transport, completion, tool
from tests.test_temporal_evidence import period
from tests.maintenance_support import maintain, derive, claim_for
from tests.test_maintenance import batch
from memoia_server import maintenance_agent
from memoia_server.connectors import Session
from memoia_server.controllers import event, source, maintenance
from memoia_server.env import CONFIG
from memoia_server.models.database import UserProfile, UserEvent
from memoia_server.models.source import (
    DeleteMessages, memory_facts, memory_blobs, memory_messages, memory_profile_revisions,
    memory_operations,
)
from memoia_server.models.utils import Promise


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["profile", "event"])
@pytest.mark.parametrize("new", [False, True], ids=["existing", "create"])
@pytest.mark.parametrize("repair", [False, True], ids=["ignored", "corrected"])
async def test_unread_support_can_be_corrected_but_never_ignored(search_users, transport, caplog, kind, new, repair):
    uid, other, _, _ = search_users
    old, current = seed_facts(uid, ["Enjoys hiking", "Prefers Sunday hiking"])
    foreign = seed_facts(other, ["Protected foreign fact"])[0]
    eid, pid = seed_derived(uid, [old], content="Original hiking memory")
    with Session.begin() as session:
        session.execute(update(UserProfile).where(UserProfile.id == pid).values(content="Original hiking memory"))
    batch(uid, fact=False, changes=[{"kind": "added", "fact_id": str(current)}])
    operation = maintenance.flush(uid, "__root__", "support-repair")
    target = pid if kind == "profile" else eid
    change = {"action": "upsert", "id": None if new else str(target),
              "content": "protected-staging-content", "fact_ids": [str(old), str(current)]}
    if kind == "profile":
        change.update(topic="interests_preferences", sub_topic="hiking")
    other_kind = "event" if kind == "profile" else "profile"
    other_change = {"action": "upsert", "id": str(eid if kind == "profile" else pid),
                    "content": "Updated hiking memory", "fact_ids": [str(old), str(current)]}
    if other_kind == "profile":
        other_change.update(topic="interests_preferences", sub_topic="hiking")
    corrected = completion(None, calls=[tool("stage_" + kind, {"changes": [change]}, "repair")], response_id="resp-repair")
    transport["responses"] = [
        completion(None, calls=[tool("read_changes", {})], response_id="resp-changes"),
        completion(None, calls=[tool("search_memory", {"query": "hiking"}, "search")], response_id="resp-search"),
        completion(None, calls=[
            tool("stage_" + kind, {"changes": [{**change, "fact_ids": [str(foreign)]}]}, "rejected"),
            tool("stage_" + other_kind, {"changes": [other_change]}, "independent"),
        ], response_id="resp-rejected"),
        *([corrected] if repair else []), completion(),
    ]
    rejection = {}
    def use_returned_identity():
        if len(transport["requests"]) != 4:
            return
        output = next(item["output"] for item in transport["requests"][-1]["input"]
                      if item.get("call_id") == "rejected")
        rejection.update(ast.literal_eval(output))
        if repair:
            args = json.loads(corrected["output"][0]["arguments"])
            args["changes"][0]["id"] = rejection["ids"][0]
            corrected["output"][0]["arguments"] = json.dumps(args)
    transport["after_response"] = use_returned_identity
    assert await maintenance.execute_claim(claim_for(uid)) is repair
    assert rejection["staged"] is False
    assert rejection["error"] == {"code": "maintenance_support_unread", "unread_fact_ids": [str(foreign)]}
    assert str(foreign) in caplog.text and "protected-staging-content" not in caplog.text
    assert "Protected foreign fact" not in caplog.text
    assert len(transport["requests"]) == (5 if repair else 4)
    assert all(request["service_tier"] == "flex" for request in transport["requests"])
    with Session() as session:
        row = session.execute(select(memory_operations).where(memory_operations.c.id == operation.operation_id)).mappings().one()
        assert row["attempts"] == 1
        assert row["status"] == ("completed" if repair else "failed")
        assert row["error"] == (None if repair else {"code": "maintenance_unresolved_staging", "retryable": False})
        assert session.scalar(select(memory_facts.c.id).where(memory_facts.c.id == foreign)) == foreign
        for table, ident in ((UserProfile, pid), (UserEvent, eid)):
            original = session.get(table, (ident, "__root__"))
            content = original.content if table is UserProfile else original.event_data["content"]
            if not repair or (new and ((kind == "profile") == (table is UserProfile))):
                assert content == "Original hiking memory"
        if repair:
            table = UserProfile if kind == "profile" else UserEvent
            changed = session.get(table, (UUID(rejection["ids"][0]), "__root__"))
            data = changed.attributes if kind == "profile" else changed.event_data
            assert set(data["fact_ids"]) == {str(old), str(current)}
            assert session.query(table).filter_by(user_id=uid).count() == (2 if new else 1)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["profile", "event"])
async def test_rejected_batch_stages_nothing_and_each_target_must_be_resolved(search_users, kind):
    uid, _, _, _ = search_users
    fid = seed_facts(uid, ["Enjoys hiking"])[0]
    eid, pid = seed_derived(uid, [fid], content="Original hiking memory")
    batch(uid, fact=False, changes=[{"kind": "added", "fact_id": str(fid)}])
    factory = maintenance_agent.ProfileMutation if kind == "profile" else maintenance_agent.EventMutation
    fields = dict(topic="interests_preferences", sub_topic="hiking") if kind == "profile" else {}
    existing = factory(action="upsert", id=str(pid if kind == "profile" else eid),
                       content="Updated hiking memory", fact_ids=[str(fid)], **fields)
    new = factory(action="upsert", content="A supported new memory", fact_ids=[str(UUID(int=77))], **fields)
    async def runner(context):
        await context.read_changes()
        await context.read("profiles" if kind == "profile" else "events", ids=[existing.id])
        rejected = await context.stage_batch([existing, new], kind)
        assert rejected["staged"] is False
        assert not context._staged["profiles"] and not context._staged["events"]
        assert rejected["ids"][0] == existing.id
        await context.stage_batch([existing], kind)
        with pytest.raises(source.SourceError, match="must be corrected"):
            context.get_plan(maintenance_agent.LoopUsage())
        # A successful, unrelated create must not clear the rejected create.
        unrelated = await context.stage_batch([new.model_copy(update={"fact_ids": [str(fid)]})], kind)
        with pytest.raises(source.SourceError, match="must be corrected"):
            context.get_plan(maintenance_agent.LoopUsage())
        await context.stage_batch([factory(action="remove", id=unrelated["ids"][0])], kind)
        fixed = new.model_copy(update={"id": rejected["ids"][1], "fact_ids": [str(fid)]})
        assert (await context.stage_batch([fixed], kind))["staged"] is True
        return context.get_plan(maintenance_agent.LoopUsage())
    assert await maintain(uid, runner)
    with Session() as session:
        table = UserProfile if kind == "profile" else UserEvent
        assert session.query(table).filter_by(user_id=uid).count() == 2


@pytest.mark.asyncio
async def test_addition_discovery_reuses_unlinked_entries_and_old_support(search_users, transport):
    uid, _, _, _ = search_users
    old, new = seed_facts(uid, ["The user enjoys hiking.", "The user prefers Sunday hiking."])
    eid, pid = seed_derived(uid, [old], content="A hiking plan")
    with Session.begin() as session:
        session.execute(update(UserProfile).where(UserProfile.id == pid, UserProfile.user_id == uid)
                        .values(content="Enjoys hiking"))
    batch(uid, fact=False, changes=[{"kind": "added", "fact_id": str(new)}])
    operation = maintenance.flush(uid, "__root__", "discover-before-create")
    support = [str(old), str(new)]
    transport["responses"] = [
        completion(None, calls=[tool("read_changes", {})], response_id="resp-changes"),
        completion(None, calls=[tool("search_memory", {"query": "hiking", "limit": 20}, "discover")],
                   response_id="resp-discover"),
        completion(None, calls=[
            tool("stage_profile", {"changes": [{"action": "upsert", "id": str(pid),
                "topic": "interests_preferences", "sub_topic": "hiking",
                "content": "Enjoys hiking, preferably on Sundays.", "fact_ids": support}]}, "profile"),
            tool("stage_event", {"changes": [{"action": "upsert", "id": str(eid),
                "content": "The user's hiking plan favors Sundays.", "fact_ids": support}]}, "event"),
        ], response_id="resp-staged"),
        completion(),
    ]
    # The actual SDK executes a scripted plan over real SQL/tools; this is not a
    # claim that a provider will always choose this two-read plan from the Prompt.
    assert await maintenance.execute_claim(claim_for(uid))
    changes = ast.literal_eval(transport["requests"][1]["input"][0]["output"])
    assert [item["current_fact"]["id"] for item in changes["items"]] == [str(new)]
    found = ast.literal_eval(transport["requests"][2]["input"][0]["output"])
    assert [item["id"] for item in found["profiles"]] == [str(pid)]
    assert [item["id"] for item in found["events"]] == [str(eid)]
    assert str(old) in {item["id"] for item in found["facts"]}
    with Session() as session:
        profile = session.query(UserProfile).filter_by(user_id=uid).one()
        event = session.query(UserEvent).filter_by(user_id=uid).one()
        assert profile.id == pid and event.id == eid
        assert set(profile.attributes["fact_ids"]) == set(event.event_data["fact_ids"]) == set(support)
        assert session.scalar(select(memory_operations.c.status).where(
            memory_operations.c.id == operation.operation_id)) == "completed"


@pytest.mark.asyncio
@pytest.mark.parametrize("mixed", [False, True], ids=["deletion", "mixed"])
@pytest.mark.parametrize("skip_last_page", [False, True], ids=["complete", "missing-page"])
@pytest.mark.parametrize("support_error", [False, True], ids=["valid-support", "corrected-support"])
async def test_changed_evidence_requires_all_linked_pages_even_after_discovery(
        search_users, transport, mixed, skip_last_page, support_error):
    uid, _, _, _ = search_users
    withdrawn = seed_facts(uid, ["An old dawn excursion."])[0]
    kept = seed_facts(uid, ["The user enjoys forest trails."])[0]
    targets = [seed_derived(uid, [withdrawn, kept], story_id=UUID(int=100 + index),
                           profile_id=UUID(int=200 + index), content="Old expedition") for index in range(2)]
    with Session.begin() as session:
        sid = session.scalar(select(memory_blobs.c.source_id).join(
            memory_facts, memory_facts.c.blob_id == memory_blobs.c.id).where(memory_facts.c.id == withdrawn))
        session.execute(update(UserProfile).where(UserProfile.user_id == uid,
            UserProfile.id.in_([pid for _, pid in targets])).values(content="Old expedition"))
    result = await source.delete_messages(uid, "__root__", sid,
        DeleteMessages(message_ids=["m1"], idempotency_key="delete-before-maintenance"))
    assert result.status == "completed"
    discovered = []
    if mixed:
        old, new = seed_facts(uid, ["The user enjoys coastal hiking.", "Coastal hiking is preferred on Sundays."],
                              ids=[UUID(int=401, version=4), UUID(int=400, version=4)])
        eid, pid = seed_derived(uid, [old], content="Coastal hiking plan")
        discovered = [(eid, pid)]
        batch(uid, 2, fact=False, changes=[{"kind": "added", "fact_id": str(new)}])
    operation = maintenance.flush(uid, "__root__", "cover-evidence")

    def linked(collection, cursor, call_id):
        return tool("read_memory", {"collection": collection, "ids": None, "query": None,
                                   "cursor": cursor, "limit": 1}, call_id)

    first_reads = [linked("profiles", None, "profiles-first"), linked("events", None, "events-first")]
    if mixed:
        first_reads.append(tool("search_memory", {"query": "coastal", "limit": 20}, "discover"))
    responses = [
        completion(None, calls=[tool("read_changes", {})], response_id="resp-changes"),
        completion(None, calls=first_reads, response_id="resp-first-page"),
    ]
    if not skip_last_page:
        responses.append(completion(None, calls=[
            linked("profiles", str(targets[0][1]), "profiles-last"),
            linked("events", str(targets[0][0]), "events-last"),
        ], response_id="resp-last-page"))
    resolved = targets[:1] if skip_last_page else targets
    profile_changes, event_changes = [], []
    for eid, pid in [*resolved, *discovered]:
        support = [str(old), str(new)] if (eid, pid) in discovered else [str(kept)]
        content = "Coastal hiking on Sundays." if (eid, pid) in discovered else "Enjoys forest trails."
        profile_changes.append({"action": "upsert", "id": str(pid), "topic": "interests_preferences",
                                "sub_topic": "hiking", "content": content, "fact_ids": support})
        event_changes.append({"action": "upsert", "id": str(eid), "content": content, "fact_ids": support})
    if support_error:
        responses.append(completion(None, calls=[
            tool("stage_profile", {"changes": [{**change, "fact_ids": [str(withdrawn)]} for change in profile_changes]}, "profiles-rejected"),
            tool("stage_event", {"changes": [{**change, "fact_ids": [str(withdrawn)]} for change in event_changes]}, "events-rejected"),
        ], response_id="resp-rejected"))
    responses.extend([
        completion(None, calls=[tool("stage_profile", {"changes": profile_changes}, "profiles"),
                                tool("stage_event", {"changes": event_changes}, "events")],
                   response_id="resp-staged"),
        completion(),
    ])
    transport["responses"] = responses
    assert await maintenance.execute_claim(claim_for(uid)) == (not skip_last_page)
    outputs = {item["call_id"]: ast.literal_eval(item["output"])
               for request in transport["requests"][1:] for item in request["input"]}
    if support_error:
        for name in ("profiles-rejected", "events-rejected"):
            assert outputs[name]["staged"] is False
            assert outputs[name]["error"]["unread_fact_ids"] == [str(withdrawn)]
    for collection, index in (("profiles", 1), ("events", 0)):
        first = outputs[collection + "-first"]
        assert first["next_cursor"] == str(targets[0][index])
        assert [item["id"] for item in first["items"]] == [str(targets[0][index])]
        assert first["items"][0]["invalid_fact_ids"] == [str(withdrawn)]
        assert first["items"][0]["fact_ids"] == [str(kept)]
        if not skip_last_page:
            last = outputs[collection + "-last"]
            assert last["next_cursor"] is None
            assert [item["id"] for item in last["items"]] == [str(targets[1][index])]
        if mixed:
            # Discovery sees the unlinked old target, but not the affected entries:
            # completing search is no substitute for following their linked cursor.
            assert [item["id"] for item in outputs["discover"][collection]] == [str(discovered[0][index])]
    with Session() as session:
        error = session.scalar(select(memory_operations.c.error).where(memory_operations.c.id == operation.operation_id))
        if skip_last_page:
            assert error == {"code": "maintenance_unresolved_entries", "retryable": False}
        else:
            assert error is None
        profiles = {row.id: row for row in session.query(UserProfile).filter_by(user_id=uid)}
        events = {row.id: row for row in session.query(UserEvent).filter_by(user_id=uid)}
        assert set(profiles) == {pid for _, pid in [*targets, *discovered]}
        assert set(events) == {eid for eid, _ in [*targets, *discovered]}
        for eid, pid in targets:
            if skip_last_page:
                assert profiles[pid].content == events[eid].event_data["content"] == "Old expedition"
            else:
                assert profiles[pid].content == events[eid].event_data["content"] == "Enjoys forest trails."
                assert profiles[pid].attributes["fact_ids"] == events[eid].event_data["fact_ids"] == [str(kept)]
        if mixed:
            eid, pid = discovered[0]
            expected = [str(old)] if skip_last_page else [str(old), str(new)]
            # Profile canonicalizes ID order; Event may retain the supplied order.
            assert sorted(profiles[pid].attributes["fact_ids"]) == sorted(events[eid].event_data["fact_ids"]) == sorted(expected)


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
        assert all(not entry["evidence"] for name in ("events", "profiles") for entry in found[name])
        assert context.readset["facts"] == {str(fid): 1, str(future): 1}
        assert all("user_id" not in item and "project_id" not in item
                   for entries in found.values() for item in entries)
        return context.get_plan(maintenance_agent.LoopUsage())
    assert await maintain(uid, runner)


@pytest.mark.asyncio
@pytest.mark.parametrize("discovery", ["read_memory", "search_memory"])
async def test_loop_updates_found_entries_with_historical_support_without_rereading(search_users, transport, discovery):
    uid, _, _, _ = search_users
    old, current = seed_facts(uid, ["Enjoys being outdoors", "Sunday hiking plan"])
    eid, pid = seed_derived(uid, [old, current], content="Sunday hiking plan")
    with Session.begin() as session:
        session.execute(update(UserProfile).where(UserProfile.id == pid).values(content="Sunday hiking plan"))
    batch(uid, fact=False, changes=[{"kind": "added", "fact_id": str(current)}])
    reads = ([tool("search_memory", {"query": "Sunday hiking"}, "search")] if discovery == "search_memory" else [
        tool("read_memory", {"collection": collection, "query": "Sunday hiking"}, collection)
        for collection in ("profiles", "events")])
    transport["responses"] = [
        completion(None, calls=[tool("read_changes", {}, "changes"), *reads], response_id="resp-found"),
        completion(None, calls=[
            tool("stage_profile", {"changes": [{"action": "upsert", "id": str(pid),
                "topic": "interests_preferences", "sub_topic": "hiking", "content": "Enjoys outdoor walks on Sundays",
                "fact_ids": [str(old), str(current)]}]}, "profile-write"),
            tool("stage_event", {"changes": [{"action": "upsert", "id": str(eid),
                "content": "Plans a Sunday hike and enjoys being outdoors", "fact_ids": [str(old), str(current)]}]},
                "event-write")], response_id="resp-staged"),
        completion(),
    ]
    assert await maintain(uid, maintenance_agent.run_loop)
    assert len(transport["requests"]) == 3
    if discovery == "search_memory":
        # The historical Fact appears once in shared evidence, not again per linked entry.
        output = next(item["output"] for item in transport["requests"][1]["input"]
                      if item.get("call_id") == "search")
        found = ast.literal_eval(output)
        delivered = [fact["id"] for fact in found["facts"]]
        delivered += [fact["id"] for name in ("profiles", "events") for item in found[name] for fact in item["evidence"]]
        assert sorted(delivered) == sorted([str(old), str(current)])
    with Session() as session:
        profile = session.get(UserProfile, (pid, "__root__"))
        story = session.get(UserEvent, (eid, "__root__"))
        assert profile.content == "Enjoys outdoor walks on Sundays"
        assert story.event_data["content"] == "Plans a Sunday hike and enjoys being outdoors"
        assert set(profile.attributes["fact_ids"]) == set(story.event_data["fact_ids"]) == {str(old), str(current)}


@pytest.mark.asyncio
@pytest.mark.parametrize("fail_read", [False, True])
async def test_search_hydration_is_concurrent_and_joins_failures(search_users, monkeypatch, fail_read):
    uid, _, _, _ = search_users
    fid = seed_facts(uid, ["Concurrency fixture"])[0]
    eid, pid = seed_derived(uid, [fid])
    batch(uid, fact=False, changes=[{"kind": "added", "fact_id": str(fid)}])
    maintenance.flush(uid, "__root__", "parallel-hydration")
    claim = claim_for(uid)
    async def search(*args, **kwargs):
        return Promise.resolve(SimpleNamespace(**{name: [SimpleNamespace(id=ident, score=0.75)]
            for name, ident in (("facts", fid), ("profiles", pid), ("events", eid))}))
    monkeypatch.setattr(event, "hybrid_search_user_events", search)
    async with maintenance.TaskLease(claim) as lease:
        context = maintenance.DBMaintenanceContext(claim, lease)
        original = context.read
        started, finished, ready = set(), set(), asyncio.Event()
        async def read(collection, **kwargs):
            started.add(collection)
            if len(started) == 3:
                ready.set()
            try:
                await asyncio.wait_for(ready.wait(), 5)
                if fail_read and collection == "profiles":
                    raise maintenance.SourceError("maintenance_read_conflict", "Concurrent change", 409, True)
                return await original(collection, **kwargs)
            finally:
                finished.add(collection)
        monkeypatch.setattr(context, "read", read)
        if fail_read:
            with pytest.raises(maintenance.SourceError, match="Concurrent change"):
                await context.search("fixture")
        else:
            found = await context.search("fixture")
            assert {name: entries[0]["score"] for name, entries in found.items()} == dict.fromkeys(started, 0.75)
            assert context.readset["facts"][str(fid)] == 1
        assert finished == started == {"facts", "profiles", "events"}


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
        assert fact["event_time"] is None
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


@pytest.mark.asyncio
async def test_unfinished_migration_flush_keeps_legacy_changes_out_of_new_history(search_users):
    uid, _, _, _ = search_users
    sid, _, _ = timed_profile(uid, "Sakura Hotel")
    _, legacy_fact, legacy_profile = timed_profile(uid, "Bluebird Cafe")
    legacy_operation = uuid4()
    with Session.begin() as session:
        session.execute(update(memory_facts).where(memory_facts.c.id == legacy_fact).values(event_time=None, revision=2))
        session.execute(memory_operations.insert().values(id=legacy_operation, user_id=uid, project_id="__root__",
            kind="flush", idempotency_key="legacy-migration", request_hash="fixture", status="failed",
            request={"blob_ids": [], "legacy_changes": [{"kind": "evidence", "fact_id": str(legacy_fact)}]},
            error={"code": "model_unavailable", "retryable": True}, generation=0, attempts=4))
    await source.delete_messages(uid, "__root__", sid,
        DeleteMessages(message_ids=["m2"], idempotency_key="other-time"))
    assert await maintain(uid, derive())
    with Session() as session:
        snapshots = session.scalars(select(memory_profile_revisions.c.profiles).where(
            memory_profile_revisions.c.user_id == uid,
            memory_profile_revisions.c.operation_id.is_not(None))).all()
        assert snapshots
        assert all(str(legacy_profile) not in {profile["id"] for profile in snapshot} for snapshot in snapshots)
        # The permitted delayed current view is untouched by another batch.
        assert "April 2025" in session.scalar(select(UserProfile.content).where(UserProfile.id == legacy_profile))
