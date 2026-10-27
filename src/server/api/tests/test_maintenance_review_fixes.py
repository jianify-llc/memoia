"""Review counterexamples over real SQL/Redis and the actual SDK runner."""
from datetime import datetime, timedelta, timezone
import ast
import asyncio
import json
from types import SimpleNamespace
from uuid import UUID, uuid4

import numpy as np
import pytest
from pydantic import ValidationError
from sqlalchemy import insert, select, update, event as sql_event

from tests.test_search_bundle import search_users, seed_facts, seed_derived
from tests.test_maintenance_agent import transport, completion, tool
from tests.test_temporal_evidence import period
from tests.maintenance_support import maintain, derive, claim_for
from tests.test_maintenance import batch
from memoia_server import maintenance_agent
from memoia_server.connectors import Session, DB_ENGINE
from memoia_server.controllers import event, profile, source, maintenance
from memoia_server.env import CONFIG
from memoia_server.models.database import UserProfile, UserEvent
from memoia_server.models.source import (
    DeleteFact, DeleteMessages, UpdateFact, memory_facts, memory_blobs, memory_messages, memory_profile_revisions,
    memory_operations, memory_event_facts,
)
from memoia_server.models.utils import Promise


@pytest.fixture
def script_refs(monkeypatch, transport):
    """Scripted provider uses only addresses actually issued by the real tools."""
    issued = {}
    encode = maintenance_agent._LoopReferences.encode
    def observe(self, kind, ident):
        ref = encode(self, kind, ident)
        issued[str(ident)] = ref
        return ref
    monkeypatch.setattr(maintenance_agent._LoopReferences, "encode", observe)
    def bind(responses):
        transport["responses"] = list(responses)
        def replace(value):
            if isinstance(value, str):
                return issued.get(value, value)
            if isinstance(value, list):
                return [replace(item) for item in value]
            if isinstance(value, dict):
                return {key: replace(item) for key, item in value.items()}
            return value
        def prepare():
            for response in responses:
                for call in response.get("output", []):
                    if call.get("type") == "function_call":
                        call["arguments"] = json.dumps(replace(json.loads(call["arguments"])))
        transport["after_response"] = prepare
        return issued
    return bind


@pytest.mark.parametrize("factory", [maintenance_agent.ProfileMutation, maintenance_agent.EventMutation])
def test_keep_mutation_requires_only_an_existing_id(factory):
    ident = str(uuid4())
    assert factory(action="keep", id=ident).id == ident
    for fields in ({}, {"id": None}, {"id": ident, "content": "Replacement prose"},
                   {"id": ident, "fact_ids": [str(uuid4())]}):
        with pytest.raises(ValidationError):
            factory(action="keep", **fields)


@pytest.mark.asyncio
@pytest.mark.parametrize("omit_last", [False, True], ids=["rebuilt", "unresolved"])
async def test_one_correction_rebuilds_all_entries_in_a_broad_impact_set(
        search_users, transport, script_refs, omit_last):
    uid, _, _, _ = search_users
    fact_contents = ["The user sings alto.", "The user hikes on Sundays.",
                     "The user paints with oils.", "The user plays chess."]
    facts = seed_facts(uid, fact_contents)
    targets = [seed_derived(uid, [fid], content=content)
               for fid, content in zip(facts, fact_contents, strict=True)]
    with Session.begin() as session:
        for index, (eid, pid) in enumerate(targets):
            entry = session.get(UserProfile, (pid, "__root__"))
            entry.content = f"Original profile {index}"
            entry.attributes = {**entry.attributes, "memoia_v2": True,
                                "_impact_fact_ids": list(map(str, facts))}
            story = session.get(UserEvent, (eid, "__root__"))
            story.event_data = {**story.event_data, "_impact_fact_ids": list(map(str, facts))}
            story.embedding = np.full(CONFIG.embedding_dim, index / 10, dtype=np.float32)
    corrected = await source.update_fact(uid, "__root__", facts[0], UpdateFact(
        idempotency_key="correct-one-of-four", expected_revision=1, reason="Wrong voice part",
        content="The user sings soprano.", subject="The user", reporter="The user",
        certainty="asserted", support_groups=[["m1"]], fact_time=None))
    assert corrected.status == "completed"
    fact_contents[0] = "The user sings soprano."

    def snapshot():
        with Session() as session:
            profiles = {str(row["id"]): dict(row) for row in session.execute(
                select(UserProfile.__table__).where(UserProfile.user_id == uid)).mappings()}
            events = {str(row["id"]): {**dict(row), "embedding": (
                          tuple(row["embedding"]) if row["embedding"] is not None else None)}
                      for row in session.execute(select(UserEvent.__table__).where(
                          UserEvent.user_id == uid)).mappings()}
            return profiles, events

    before = snapshot()
    operation = maintenance.flush(uid, "__root__", "review-four-impact-candidates")
    profile_changes, event_changes = [], []
    for index, (eid, pid) in enumerate(targets[:3 if omit_last else 4]):
        profile_changes.append({"action": "upsert", "id": str(pid),
            "content": fact_contents[index], "topic": "interests_preferences", "sub_topic": "activity",
            "fact_ids": [str(facts[index])]})
        event_changes.append({"action": "upsert", "id": str(eid),
            "content": fact_contents[index], "fact_ids": [str(facts[index])]})
    refs = script_refs([
        completion(None, calls=[tool("read_changes", {})], response_id="resp-changes"),
        completion(None, calls=[
            tool("read_memory", {"collection": "profiles", "limit": 100}, "profiles-read"),
            tool("read_memory", {"collection": "events", "limit": 100}, "events-read"),
        ], response_id="resp-candidates"),
        completion(None, calls=[
            tool("stage_profile", {"changes": profile_changes}, "profiles-stage"),
            tool("stage_event", {"changes": event_changes}, "events-stage"),
        ], response_id="resp-resolutions"),
        completion(),
    ])
    assert await maintenance.execute_claim(claim_for(uid)) is (not omit_last)
    from xml.etree import ElementTree
    initial = json.loads(ElementTree.fromstring(transport["requests"][0]["input"][1]["content"][0]["text"]).text)
    assert all(group["count"] == 4 for group in initial["remaining_review"].values())
    reads = {item["call_id"]: ast.literal_eval(item["output"]) for item in transport["requests"][2]["input"]}
    assert all(item["review_required"] for page in reads.values() for item in page["items"])
    assert all(not ({"content", "title", "summary", "sub_topic"} & item.keys())
               for page in reads.values() for item in page["items"])
    evidence = {item["id"]: item["content"] for page in reads.values()
                for entry in page["items"] for item in entry["evidence"]}
    assert evidence == {refs[str(fid)]: content for fid, content in zip(facts, fact_contents, strict=True)}
    staged = {item["call_id"]: ast.literal_eval(item["output"]) for item in transport["requests"][3]["input"]}
    for collection, call_id, target_index in (("profiles", "profiles-stage", 1), ("events", "events-stage", 0)):
        pending = staged[call_id]["remaining_review"][collection]
        assert pending == {"count": int(omit_last), "ids": [refs[str(targets[-1][target_index])]] if omit_last else []}
    after = snapshot()
    with Session() as session:
        saved = session.execute(select(memory_operations).where(
            memory_operations.c.id == operation.operation_id)).mappings().one()
        assert saved["error"] == ({"code": "maintenance_unresolved_entries", "retryable": False}
                                  if omit_last else None)
        assert set(session.scalars(select(memory_facts.c.id).where(memory_facts.c.user_id == uid))) == set(facts)
    if omit_last:
        assert after == before
        return
    assert after[0].keys() == before[0].keys() and after[1].keys() == before[1].keys()
    for index, (eid, pid) in enumerate(targets):
        assert after[0][str(pid)]["content"] == after[1][str(eid)]["event_data"]["content"] == fact_contents[index]
        assert after[0][str(pid)]["attributes"]["fact_ids"] == [str(facts[index])]
        assert after[1][str(eid)]["event_data"]["fact_ids"] == [str(facts[index])]
        assert after[0][str(pid)]["revision"] == before[0][str(pid)]["revision"] + 1
        assert after[1][str(eid)]["revision"] == before[1][str(eid)]["revision"] + 1


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["profile", "event"])
@pytest.mark.parametrize("reason", ["target-unread", "staged-replacement", "support-unread", "support-missing", "support-empty"])
async def test_keep_cannot_bypass_actual_target_and_complete_original_support_reads(
        search_users, monkeypatch, kind, reason):
    uid, _, _, _ = search_users
    changed, support = seed_facts(uid, ["Changed background", "Supporting fact " + "x" * 2000])
    eid, pid = seed_derived(uid, [support, changed], content="Original supported entry")
    with Session.begin() as session:
        if reason == "support-missing":
            # Exercise ordinary keep validation without creating a required-rewrite change.
            session.execute(memory_facts.delete().where(memory_facts.c.id == support))
        for table, ident, column in ((UserProfile, pid, "attributes"), (UserEvent, eid, "event_data")):
            entry = session.get(table, (ident, "__root__"))
            data = {**getattr(entry, column), "_impact_fact_ids": [str(changed), str(support)]}
            if reason == "support-empty":
                data["fact_ids"] = []
            setattr(entry, column, data)
        if reason == "support-empty":
            session.execute(memory_event_facts.delete().where(memory_event_facts.c.event_id == eid))
    batch(uid, fact=False, changes=[{"kind": "added", "fact_id": str(changed)}])
    operation = maintenance.flush(uid, "__root__", "keep-requires-real-reads")
    target = str(pid if kind == "profile" else eid)
    collection = "profiles" if kind == "profile" else "events"
    factory = maintenance_agent.ProfileMutation if kind == "profile" else maintenance_agent.EventMutation

    async def runner(context):
        await context.read_changes()
        assert all(group["count"] == 0 for group in context._remaining_review().values())
        if reason == "staged-replacement":
            await context.read("facts", ids=[str(support)])
            fields = {"topic": context.allowed_topics[0], "sub_topic": "replacement"} if kind == "profile" else {}
            await (context.stage_profile if kind == "profile" else context.stage_event)(factory(
                action="upsert", id=target, content="Staged replacement, never the saved text",
                fact_ids=[str(support), str(changed)], **fields))
            page = await context.read(collection, ids=[target])
            assert page["items"][0]["content"] == "Staged replacement, never the saved text"
            assert target not in context._derived_reads[collection]
        elif reason != "target-unread":
            if reason == "support-unread":
                monkeypatch.setattr(maintenance_agent, "MAX_TOOL_BYTES", 1600)
            page = await context.read(collection, ids=[target])
            assert [entry["id"] for entry in page["items"]] == [target]
            if reason == "support-unread":
                assert str(support) not in context.readset["facts"]
            if reason == "support-missing":
                assert page["items"][0]["invalid_fact_ids"] == [str(support)]
        await (context.stage_profile if kind == "profile" else context.stage_event)(factory(action="keep", id=target))
        other = "events" if kind == "profile" else "profiles"
        other_id = str(eid if kind == "profile" else pid)
        await context.read(other, ids=[other_id])
        await (context.stage_event if kind == "profile" else context.stage_profile)(
            (maintenance_agent.EventMutation if kind == "profile" else maintenance_agent.ProfileMutation)(
                action="remove", id=other_id))
        return context.get_plan(maintenance_agent.LoopUsage())

    assert not await maintenance.execute_claim(claim_for(uid), runner=runner)
    with Session() as session:
        saved = session.execute(select(memory_operations).where(
            memory_operations.c.id == operation.operation_id)).mappings().one()
        assert saved["error"]["code"] == (
            "maintenance_target_unread" if reason in ("target-unread", "staged-replacement")
            else "maintenance_support_unread")
        assert session.get(UserProfile, (pid, "__root__")).content == "Enjoys Kyoto hotels"
        assert session.get(UserEvent, (eid, "__root__")).event_data["content"] == "Original supported entry"


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["profile", "event"])
async def test_keep_batch_can_read_omitted_support_and_correct_it_in_the_same_loop(search_users, monkeypatch, kind):
    uid, _, _, _ = search_users
    changed, support = seed_facts(uid, ["Changed background", "Supporting fact " + "x" * 2000])
    eid, pid = seed_derived(uid, [support], content="Original supported entry")
    batch(uid, fact=False, changes=[{"kind": "added", "fact_id": str(changed)}])
    collection, target, factory = (("profiles", str(pid), maintenance_agent.ProfileMutation)
        if kind == "profile" else ("events", str(eid), maintenance_agent.EventMutation))

    async def runner(context):
        await context.read_changes()
        with monkeypatch.context() as limited:
            limited.setattr(maintenance_agent, "MAX_TOOL_BYTES", 1600)
            await context.read(collection, ids=[target])
        assert str(support) not in context.readset["facts"]
        change = factory(action="keep", id=target)
        rejected = await context.stage_batch([change], kind)
        assert rejected == {"staged": False, "ids": [target], "remaining_review": {
            "profiles": {"count": 0, "ids": []}, "events": {"count": 0, "ids": []}}, "error": {
            "code": "maintenance_support_unread", "unread_fact_ids": [str(support)], "invalid_fact_ids": []}}
        with pytest.raises(source.SourceError, match="must be corrected"):
            context.get_plan(maintenance_agent.LoopUsage())
        await context.read("facts", ids=[str(support)])
        accepted = await context.stage_batch([change], kind)
        assert accepted["staged"] is True and accepted["ids"] == [target]
        assert accepted["remaining_review"][collection] == {"count": 0, "ids": []}
        proposal = dict(action="upsert", id=target, content="Rejected replacement", fact_ids=[str(uuid4())])
        if kind == "profile":
            proposal.update(topic=context.allowed_topics[0], sub_topic="fixture")
        rejected_again = await context.stage_batch([factory(**proposal)], kind)
        assert rejected_again["staged"] is False
        assert rejected_again["remaining_review"][collection] == {"count": 0, "ids": []}
        with pytest.raises(source.SourceError, match="must be corrected"):
            context.get_plan(maintenance_agent.LoopUsage())
        assert (await context.stage_batch([change], kind))["remaining_review"][collection]["count"] == 0
        other, other_id, other_factory = (("events", str(eid), maintenance_agent.EventMutation)
            if kind == "profile" else ("profiles", str(pid), maintenance_agent.ProfileMutation))
        await context.read(other, ids=[other_id])
        assert (await context.stage_batch([other_factory(action="keep", id=other_id)],
                                          "event" if kind == "profile" else "profile"))["staged"] is True
        return context.get_plan(maintenance_agent.LoopUsage())

    assert await maintain(uid, runner)
    with Session() as session:
        assert session.get(UserProfile, (pid, "__root__")).content == "Enjoys Kyoto hotels"
        assert session.get(UserEvent, (eid, "__root__")).event_data["content"] == "Original supported entry"


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["profile", "event"])
@pytest.mark.parametrize("new", [False, True], ids=["existing", "create"])
async def test_invalid_support_cannot_be_dropped_to_report_success(search_users, transport, script_refs, kind, new):
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
    script_refs([
        completion(None, calls=[tool("read_changes", {})], response_id="resp-changes"),
        completion(None, calls=[tool("search_memory", {"query": "hiking"}, "search")], response_id="resp-search"),
        completion(None, calls=[
            tool("stage_" + kind, {"changes": [{**change, "fact_ids": ["f999"]}]}, "rejected"),
            tool("stage_" + other_kind, {"changes": [other_change]}, "independent"),
        ], response_id="resp-rejected"),
        # Even a subsequent well-formed subset must not turn this failed run green.
        completion(None, calls=[tool("stage_" + kind, {"changes": [{**change, "fact_ids": [str(current)]}]}, "omit")]),
        completion(),
    ])
    assert await maintenance.execute_claim(claim_for(uid)) is False
    assert len(transport["requests"]) == 3
    assert all(request["service_tier"] == "flex" for request in transport["requests"])
    with Session() as session:
        row = session.execute(select(memory_operations).where(memory_operations.c.id == operation.operation_id)).mappings().one()
        assert row["attempts"] == 1
        assert row["status"] == "failed"
        assert row["error"] == {"code": "MAINTENANCE_REFERENCE_INVALID", "retryable": False}
        assert session.scalar(select(memory_facts.c.id).where(memory_facts.c.id == foreign)) == foreign
        for table, ident in ((UserProfile, pid), (UserEvent, eid)):
            original = session.get(table, (ident, "__root__"))
            content = original.content if table is UserProfile else original.event_data["content"]
            assert content == "Original hiking memory"
            assert session.query(table).filter_by(user_id=uid).count() == 1


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
async def test_addition_discovery_reuses_unlinked_entries_and_old_support(search_users, transport, script_refs):
    uid, _, _, _ = search_users
    old, new = seed_facts(uid, ["The user enjoys hiking.", "The user prefers Sunday hiking."])
    eid, pid = seed_derived(uid, [old], content="A hiking plan")
    with Session.begin() as session:
        session.execute(update(UserProfile).where(UserProfile.id == pid, UserProfile.user_id == uid)
                        .values(content="Enjoys hiking"))
    batch(uid, fact=False, changes=[{"kind": "added", "fact_id": str(new)}])
    operation = maintenance.flush(uid, "__root__", "discover-before-create")
    support = [str(old), str(new)]
    refs = script_refs([
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
    ])
    # The actual SDK executes a scripted plan over real SQL/tools; this is not a
    # claim that a provider will always choose this two-read plan from the Prompt.
    assert await maintenance.execute_claim(claim_for(uid))
    changes = ast.literal_eval(transport["requests"][1]["input"][0]["output"])
    assert [item["current_fact"]["id"] for item in changes["items"]] == [refs[str(new)]]
    found = ast.literal_eval(transport["requests"][2]["input"][0]["output"])
    assert [item["id"] for item in found["profiles"]] == [refs[str(pid)]]
    assert [item["id"] for item in found["events"]] == [refs[str(eid)]]
    assert refs[str(old)] in {item["id"] for item in found["facts"]}
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
@pytest.mark.parametrize("change_kind", ["deleted", "updated"])
async def test_changed_evidence_requires_every_page_before_committing_rebuilt_entries(
        search_users, transport, script_refs, mixed, skip_last_page, change_kind):
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
    if change_kind == "deleted":
        result = await source.delete_messages(uid, "__root__", sid,
            DeleteMessages(message_ids=["m1"], idempotency_key="delete-before-maintenance"))
    else:
        result = await source.update_fact(uid, "__root__", withdrawn, UpdateFact(
            idempotency_key="edit-before-maintenance", expected_revision=1, reason="Incorrect activity",
            content="The user enjoys forest trails.", subject="The user", reporter="The user",
            certainty="asserted", support_groups=[["m1"]], fact_time=None))
    assert result.status == "completed"
    discovered = []
    if mixed:
        old, new = seed_facts(uid, ["The user enjoys coastal hiking.", "Coastal hiking is preferred on Sundays."],
                              ids=[UUID(int=401, version=4), UUID(int=400, version=4)])
        eid, pid = seed_derived(uid, [old], content="Coastal hiking plan")
        with Session.begin() as session:
            # This discovery is known to be independent of the withdrawn excursion.
            stored_profile = session.get(UserProfile, (pid, "__root__"))
            stored_profile.attributes = {**stored_profile.attributes, "_impact_fact_ids": [str(old)]}
            stored_event = session.get(UserEvent, (eid, "__root__"))
            stored_event.event_data = {**stored_event.event_data, "_impact_fact_ids": [str(old)]}
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
    responses.extend([
        completion(None, calls=[tool("stage_profile", {"changes": profile_changes}, "profiles"),
                                tool("stage_event", {"changes": event_changes}, "events")],
                   response_id="resp-staged"),
        completion(),
    ])
    refs = script_refs(responses)
    assert await maintenance.execute_claim(claim_for(uid)) is (not skip_last_page)
    outputs = {item["call_id"]: ast.literal_eval(item["output"])
               for request in transport["requests"][1:] for item in request["input"]}
    for collection, index in (("profiles", 1), ("events", 0)):
        first = outputs[collection + "-first"]
        assert first["next_cursor"] == refs[str(targets[0][index])]
        assert [item["id"] for item in first["items"]] == [refs[str(targets[0][index])]]
        assert first["items"][0].get("pending_delete", False) is False
        assert first["items"][0]["invalid_fact_ids"] == ([refs[str(withdrawn)]] if change_kind == "deleted" else [])
        assert set(first["items"][0]["fact_ids"]) == {refs[str(fid)] for fid in
            ([kept] if change_kind == "deleted" else [withdrawn, kept])}
        if not skip_last_page:
            last = outputs[collection + "-last"]
            assert last["next_cursor"] is None
            assert [item["id"] for item in last["items"]] == [refs[str(targets[1][index])]]
        if mixed:
            # Independent discovery cannot resolve an unread affected page.
            assert [item["id"] for item in outputs["discover"][collection]] == [refs[str(discovered[0][index])]]
    with Session() as session:
        error = session.scalar(select(memory_operations.c.error).where(memory_operations.c.id == operation.operation_id))
        assert error == ({"code": "maintenance_unresolved_entries", "retryable": False}
                         if skip_last_page else None)
        assert session.scalar(select(memory_operations.c.status).where(
            memory_operations.c.id == operation.operation_id)) == ("failed" if skip_last_page else "completed")
        profiles = {row.id: row for row in session.query(UserProfile).filter_by(user_id=uid)}
        events = {row.id: row for row in session.query(UserEvent).filter_by(user_id=uid)}
        assert set(profiles) == {pid for _, pid in [*targets, *discovered]}
        assert set(events) == {eid for eid, _ in [*targets, *discovered]}
        for eid, pid in targets:
            if skip_last_page:
                assert profiles[pid].content == events[eid].event_data["content"] == "Old expedition"
                assert set(profiles[pid].attributes["fact_ids"]) == set(events[eid].event_data["fact_ids"]) == {
                    str(withdrawn), str(kept)}
                continue
            assert profiles[pid].content == events[eid].event_data["content"] == "Enjoys forest trails."
            assert profiles[pid].attributes["fact_ids"] == events[eid].event_data["fact_ids"] == [str(kept)]
        expected_facts = {kept} | ({withdrawn} if change_kind == "updated" else set())
        if mixed:
            eid, pid = discovered[0]
            expected = [str(old), str(new)]
            # Profile canonicalizes ID order; Event may retain the supplied order.
            if skip_last_page:
                assert profiles[pid].content == "Enjoys Kyoto hotels"
                assert events[eid].event_data["content"] == "Coastal hiking plan"
                expected = [str(old)]
            assert sorted(profiles[pid].attributes["fact_ids"]) == sorted(events[eid].event_data["fact_ids"]) == sorted(expected)
            expected_facts.update((old, new))
        assert set(session.scalars(select(memory_facts.c.id).where(memory_facts.c.user_id == uid))) == expected_facts


@pytest.mark.asyncio
@pytest.mark.parametrize("late_collection", ["profiles", "events"])
async def test_new_affected_entry_after_preparation_rejects_all_staged_changes(search_users, late_collection):
    uid, _, _, _ = search_users
    changed, kept = seed_facts(uid, ["An old dawn excursion.", "The user enjoys forest trails."])
    eid, pid = seed_derived(uid, [changed, kept], content="Original excursion")
    batch(uid, fact=False, changes=[{"kind": "updated", "fact_id": str(changed)}])
    operation = maintenance.flush(uid, "__root__", "late-affected-entry")
    late_id, created = uuid4(), {}

    async def runner(context):
        await context.read_changes()
        current = (await context.read("facts", ids=[str(kept)]))["items"][0]
        assert not context._staged["profiles"] and not context._staged["events"]
        await context.read("profiles", ids=[str(pid)])
        await context.read("events", ids=[str(eid)])
        await context.stage_profile(maintenance_agent.ProfileMutation(action="upsert", id=str(pid),
            content=current["content"], topic=context.allowed_topics[0], sub_topic="trails", fact_ids=[str(kept)]))
        await context.stage_event(maintenance_agent.EventMutation(action="upsert", id=str(eid),
            content=current["content"], fact_ids=[str(kept)]))
        created["profile"] = await context.stage_profile(maintenance_agent.ProfileMutation(action="upsert",
            content="A newly staged profile must not commit.", topic=context.allowed_topics[0],
            sub_topic="late-write", fact_ids=[str(kept)]))
        data = {"fact_ids": [str(kept)], "_impact_fact_ids": [str(changed), str(kept)]}
        with Session.begin() as session:
            values = {"id": late_id, "user_id": uid, "project_id": "__root__"}
            if late_collection == "profiles":
                session.execute(UserProfile.__table__.insert().values(**values,
                    content="Late affected profile", attributes=data))
            else:
                session.execute(UserEvent.__table__.insert().values(**values,
                    event_data={**data, "content": "Late affected event", "event_tip": "Late affected event"}))
        return context.get_plan(maintenance_agent.LoopUsage())

    assert not await maintenance.execute_claim(claim_for(uid), runner=runner)
    with Session() as session:
        saved = session.execute(select(memory_operations).where(
            memory_operations.c.id == operation.operation_id)).mappings().one()
        assert saved["error"] == {"code": "maintenance_unresolved_entries", "retryable": False}
        assert saved["result"] is None
        assert session.get(UserProfile, (pid, "__root__")) is not None
        assert session.get(UserEvent, (eid, "__root__")) is not None
        assert session.get(UserProfile, (UUID(created["profile"]), "__root__")) is None
        table = UserProfile if late_collection == "profiles" else UserEvent
        assert session.get(table, (late_id, "__root__")) is not None
        assert set(session.scalars(select(memory_facts.c.id).where(memory_facts.c.user_id == uid))) == {changed, kept}


@pytest.mark.asyncio
async def test_added_claim_inherits_pending_deletion_until_its_own_flush_cleans_descendants(search_users):
    uid, _, _, _ = search_users
    background = seed_facts(uid, ["The user sings alto."])[0]
    main = seed_facts(uid, ["The user performed at a concert."])[0]
    old_event, old_profile = seed_derived(uid, [main], content="The alto singer performed at a concert.")
    with Session.begin() as session:
        stored_profile = session.get(UserProfile, (old_profile, "__root__"))
        stored_profile.content = "The alto singer performed at a concert."
        stored_profile.attributes = {**stored_profile.attributes, "memoia_v2": True,
            "_impact_fact_ids": [str(background), str(main)]}
        stored_event = session.get(UserEvent, (old_event, "__root__"))
        stored_event.event_data = {**stored_event.event_data, "_impact_fact_ids": [str(background), str(main)]}
    batch(uid, fact=False, changes=[{"kind": "added", "fact_id": str(main)}])
    addition = maintenance.flush(uid, "__root__", "addition-before-background-deletion")
    addition_claim = claim_for(uid)
    assert addition_claim.operation_id == addition.operation_id
    assert all(change["kind"] == "added" for change in addition_claim.changes)

    deletion = await source.delete_fact(uid, "__root__", background, DeleteFact(
        idempotency_key="delete-before-reading-pending-derived", expected_revision=1,
        reason="Remove the voice information"))
    assert deletion.status == "completed"
    created = {}

    async def derive_from_pending_text(context):
        await context.read_changes()
        for collection, ident in (("profiles", old_profile), ("events", old_event)):
            page = await context.read(collection, ids=[str(ident)])
            assert page["items"][0]["fact_ids"] == [str(main)]
            assert "alto" in page["items"][0]["content"]
        # The deletion already committed before these derived revisions were read,
        # so its bump cannot reject this otherwise valid, earlier sealed claim.
        assert str(background) not in context.readset["facts"]
        created["profile"] = await context.stage_profile(maintenance_agent.ProfileMutation(action="upsert",
            content="The alto singer performed.", topic=context.allowed_topics[0],
            sub_topic="copied-background", fact_ids=[str(main)]))
        created["event"] = await context.stage_event(maintenance_agent.EventMutation(action="upsert",
            content="The alto singer performed.", fact_ids=[str(main)]))
        return context.get_plan(maintenance_agent.LoopUsage())

    assert await maintenance.execute_claim(addition_claim, runner=derive_from_pending_text)
    with Session() as session:
        for table, ident, field in ((UserProfile, created["profile"], "attributes"),
                                    (UserEvent, created["event"], "event_data")):
            data = getattr(session.get(table, (UUID(ident), "__root__")), field)
            assert data["fact_ids"] == [str(main)]
            assert set(data["_impact_fact_ids"]) == {str(background), str(main)}
        assert session.scalar(select(memory_facts.c.id).where(memory_facts.c.id == background)) is None
        snapshots = session.scalars(select(memory_profile_revisions.c.profiles).where(
            memory_profile_revisions.c.operation_id == addition.operation_id)).all()
        assert snapshots and all(created["profile"] not in {item["id"] for item in snapshot}
                                 for snapshot in snapshots)
    assert not any(item.id == UUID(created["profile"]) for entry in source.get_history(uid, "__root__")
                   for item in [*entry.profiles, *entry.added, *entry.removed])

    cleanup = maintenance.flush(uid, "__root__", "clean-pending-background-descendants")
    cleanup_claim = claim_for(uid)
    assert cleanup_claim.operation_id == cleanup.operation_id
    assert any(change.get("fact_id") == str(background) and change["kind"] == "deleted"
               for change in cleanup_claim.changes)

    async def clear_affected(context):
        await context.read_changes()
        assert not context._staged["profiles"] and not context._staged["events"]
        for collection, factory, stage in (
            ("profiles", maintenance_agent.ProfileMutation, context.stage_profile),
            ("events", maintenance_agent.EventMutation, context.stage_event),
        ):
            page = await context.read(collection)
            assert {entry["id"] for entry in page["items"]} == (
                {str(old_profile), created["profile"]} if collection == "profiles" else
                {str(old_event), created["event"]})
            for entry in page["items"]:
                await stage(factory(action="remove", id=entry["id"]))
        return context.get_plan(maintenance_agent.LoopUsage())

    assert await maintenance.execute_claim(cleanup_claim, runner=clear_affected)
    with Session() as session:
        assert session.query(UserProfile).filter_by(user_id=uid, project_id="__root__").count() == 0
        assert session.query(UserEvent).filter_by(user_id=uid, project_id="__root__").count() == 0
        assert set(session.scalars(select(memory_facts.c.id).where(memory_facts.c.user_id == uid))) == {main}


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
async def test_loop_updates_found_entries_with_historical_support_without_rereading(search_users, transport, script_refs, discovery):
    uid, _, _, _ = search_users
    old, current = seed_facts(uid, ["Enjoys being outdoors", "Sunday hiking plan"])
    eid, pid = seed_derived(uid, [old, current], content="Sunday hiking plan")
    with Session.begin() as session:
        session.execute(update(UserProfile).where(UserProfile.id == pid).values(content="Sunday hiking plan"))
    batch(uid, fact=False, changes=[{"kind": "added", "fact_id": str(current)}])
    reads = ([tool("search_memory", {"query": "Sunday hiking"}, "search")] if discovery == "search_memory" else [
        tool("read_memory", {"collection": collection, "query": "Sunday hiking"}, collection)
        for collection in ("profiles", "events")])
    refs = script_refs([
        completion(None, calls=[tool("read_changes", {}, "changes"), *reads], response_id="resp-found"),
        completion(None, calls=[
            tool("stage_profile", {"changes": [{"action": "upsert", "id": str(pid),
                "topic": "interests_preferences", "sub_topic": "hiking", "content": "Enjoys outdoor walks on Sundays",
                "fact_ids": [str(old), str(current)]}]}, "profile-write"),
            tool("stage_event", {"changes": [{"action": "upsert", "id": str(eid),
                "content": "Plans a Sunday hike and enjoys being outdoors", "fact_ids": [str(old), str(current)]}]},
                "event-write")], response_id="resp-staged"),
        completion(),
    ])
    assert await maintain(uid, maintenance_agent.run_loop)
    assert len(transport["requests"]) == 3
    if discovery == "search_memory":
        # The historical Fact appears once in shared evidence, not again per linked entry.
        output = next(item["output"] for item in transport["requests"][1]["input"]
                      if item.get("call_id") == "search")
        found = ast.literal_eval(output)
        delivered = [fact["id"] for fact in found["facts"]]
        delivered += [fact["id"] for name in ("profiles", "events") for item in found[name] for fact in item["evidence"]]
        assert sorted(delivered) == sorted([refs[str(old)], refs[str(current)]])
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
            support_groups=[["m1"], ["m2"]], fact_time=period(mid="m2")))
        old = dict(id=str(profile_id), content=f"Visited {label} in April 2025", topic="life_event",
                   sub_topic="visit", fact_ids=[str(fid)], source_ids=[sid], _impact_fact_ids=[str(fid)])
        session.execute(UserProfile.__table__.insert().values(**scope, id=profile_id, content=old["content"],
            attributes={"memoia_v2": True, "topic": old["topic"], "sub_topic": old["sub_topic"],
                        "fact_ids": [str(fid)], "source_ids": [sid], "_impact_fact_ids": [str(fid)]}))
        session.execute(memory_profile_revisions.insert().values(**scope, id=uuid4(),
            profiles=[old], added=[old], removed=[]))
    return sid, fid, profile_id


def history_text(uid):
    return [entry.content for row in source.get_history(uid, "__root__")
            for entry in [*row.profiles, *row.added, *row.removed]]


@pytest.mark.asyncio
async def test_manual_edit_rejects_already_computed_loop_plan_without_hiding_current_derivatives(search_users):
    uid, _, _, _ = search_users
    fid = seed_facts(uid, ["Old Sakura fact"])[0]
    eid, pid = seed_derived(uid, [fid], content="Old Sakura story")
    batch(uid, fact=False, changes=[{"kind": "added", "fact_id": str(fid)}])
    operation = maintenance.flush(uid, "__root__", "edit-after-loop-read")
    build = derive()
    async def runner(context):
        plan = await build(context)
        await source.update_fact(uid, "__root__", fid, UpdateFact(
            idempotency_key="during-loop", expected_revision=1, reason="Wrong hotel",
            content="Current Bluebird fact", subject="The user", reporter="The user",
            certainty="asserted", support_groups=[["m1"]], fact_time=None))
        return plan
    assert not await maintenance.execute_claim(claim_for(uid), runner=runner)
    with Session() as session:
        error = session.scalar(select(memory_operations.c.error).where(memory_operations.c.id == operation.operation_id))
        assert error == {"code": "maintenance_read_conflict", "retryable": True}
        assert session.scalar(select(memory_facts.c.content).where(memory_facts.c.id == fid)) == "Current Bluebird fact"
        assert session.scalar(select(UserProfile.content).where(UserProfile.id == pid)) == "Enjoys Kyoto hotels"
        story = session.get(UserEvent, (eid, "__root__"))
        assert story.event_data["content"] == "Old Sakura story"
        view = event.event_view(session, story)
        assert view["evidence"] == [] and view["fact_ids"] == []

    # Let the original flush's backoff elapse. Its successful recovery must not
    # declare the later correction Blob maintained as a side effect.
    with Session.begin() as session:
        session.execute(update(memory_operations).where(memory_operations.c.id == operation.operation_id).values(
            available_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
    recovered = claim_for(uid)
    assert recovered.operation_id == operation.operation_id

    async def recover_old(context):
        await context.read_changes()
        found = await context.search("Current Bluebird")
        assert [row["id"] for row in found["events"]] == [str(eid)]
        assert [row["id"] for row in found["profiles"]] == [str(pid)]
        assert found["facts"][0]["content"] == "Current Bluebird fact"
        await context.stage_profile(maintenance_agent.ProfileMutation(action="upsert", id=str(pid),
            content="Current Bluebird fact", topic=context.allowed_topics[0], sub_topic="legacy::value",
            fact_ids=[str(fid)]))
        await context.stage_event(maintenance_agent.EventMutation(action="upsert", id=str(eid),
            content="Current Bluebird fact", fact_ids=[str(fid)]))
        return context.get_plan(maintenance_agent.LoopUsage())

    assert await maintenance.execute_claim(recovered, runner=recover_old)
    assert maintenance.get_status(uid, "__root__")["pending_blob_count"] == 1
    with Session() as session:
        story = session.get(UserEvent, (eid, "__root__"))
        assert story.event_data["content"] == "Current Bluebird fact"
        assert event.event_view(session, story)["evidence"] == []
    profiles = (await profile.get_user_profiles(uid, "__root__")).data().profiles
    assert profiles[0].attributes["fact_ids"] == []
    assert await maintain(uid, derive())
    with Session() as session:
        story = session.get(UserEvent, (eid, "__root__"))
        assert event.event_view(session, story)["evidence"][0]["content"] == "Current Bluebird fact"


@pytest.mark.asyncio
async def test_public_proof_waits_for_successful_auto_flush_but_loop_keeps_navigation(search_users):
    uid, _, _, client = search_users
    changed = seed_facts(uid, ["The user visited Tokyo"])[0]
    kept = seed_facts(uid, ["The user enjoys travel"])[0]
    eid, pid = seed_derived(uid, [changed, kept], content="Old Tokyo story")
    solo_event, solo_profile = seed_derived(uid, [changed], content="Old Tokyo visit")
    corrected = await source.update_fact(uid, "__root__", changed, UpdateFact(
        idempotency_key="correct-city", expected_revision=1, reason="Incorrect city",
        content="The user visited Kyoto", subject="The user", reporter="The user",
        certainty="asserted", support_groups=[["m1"]], fact_time=None))
    assert corrected.status == "completed"

    async def assert_pending_proof():
        response = await client.get(f"/api/users/{uid}/events")
        assert response.status_code == 200
        rows = {row["id"]: row["event_data"] for row in response.json()["events"]}
        assert rows[str(eid)]["content"] == "Old Tokyo story"
        assert [proof["fact_id"] for proof in rows[str(eid)]["evidence"]] == [str(kept)]
        assert rows[str(solo_event)]["evidence"] == []
        profiles = {row.id: row for row in (await profile.get_user_profiles(uid, "__root__")).data().profiles}
        assert profiles[pid].attributes["fact_ids"] == [str(kept)]
        assert profiles[solo_profile].attributes["fact_ids"] == []
        listed = await client.get(f"/api/users/{uid}/profiles")
        source_ids = {row["id"]: row["source_ids"] for row in listed.json()["profiles"]}
        assert source_ids[str(pid)] and source_ids[str(solo_profile)] == []
        found = await client.post(f"/api/users/{uid}/search", json={"query": "user", "max_token_size": 10000})
        assert found.status_code == 200
        bundle = found.json()
        assert {row["id"]: row["content"] for row in bundle["facts"]}[str(changed)] == "The user visited Kyoto"
        assert [row["id"] for row in bundle["events"]] == [str(eid)]
        assert bundle["events"][0]["fact_ids"] == [str(kept)]
        assert [proof["fact_id"] for proof in bundle["events"][0]["evidence"]] == [str(kept)]
        assert [row["id"] for row in bundle["profiles"]] == [str(pid)]
        assert bundle["profiles"][0]["fact_ids"] == [str(kept)]
        for query in (None, "user"):
            context = await client.post(f"/api/users/{uid}/context", json={"query": query})
            assert context.status_code == 200
            entries = [entry for entry in context.json()["entries"] if str(changed) in entry]
            assert len(entries) == 1 and "Kyoto" in entries[0] and "Tokyo" not in entries[0]

    await assert_pending_proof()
    # Exercise the worker's normal quiet-window sealer, not an extra import.
    with Session.begin() as session:
        session.execute(update(memory_blobs).where(memory_blobs.c.id == corrected.blob_id).values(
            fact_completed_at=datetime.now(timezone.utc) - timedelta(seconds=31)))
    maintenance.seal_due()
    failed_claim = claim_for(uid)
    assert failed_claim is not None
    assert maintenance.fail_claim(failed_claim, source.SourceError("model_configuration", "fixture", 422, False))
    await assert_pending_proof()
    maintenance.retry_flush(uid, "__root__", failed_claim.operation_id)
    recovered = claim_for(uid)
    assert recovered.operation_id == failed_claim.operation_id

    async def rebuild(context):
        await assert_pending_proof()
        changes = await context.read_changes()
        assert changes["items"][0]["current_fact"]["content"] == "The user visited Kyoto"
        found = await context.search("user")
        # Public proof filtering must not hide the Loop's repair targets.
        assert {row["id"] for row in found["events"]} == {str(eid), str(solo_event)}
        assert {row["id"] for row in found["profiles"]} == {str(pid), str(solo_profile)}
        for collection in ("events", "profiles"):
            assert all(str(changed) in row["fact_ids"] for row in found[collection])
        for event_id, profile_id, ids in [(eid, pid, [changed, kept]), (solo_event, solo_profile, [changed])]:
            await context.stage_profile(maintenance_agent.ProfileMutation(action="upsert", id=str(profile_id),
                content="The user visited Kyoto", topic=context.allowed_topics[0], sub_topic="travel",
                fact_ids=list(map(str, ids))))
            await context.stage_event(maintenance_agent.EventMutation(action="upsert", id=str(event_id),
                content="The user visited Kyoto", fact_ids=list(map(str, ids))))
        return context.get_plan(maintenance_agent.LoopUsage())

    assert await maintenance.execute_claim(recovered, runner=rebuild)
    events = await client.get(f"/api/users/{uid}/events")
    events = {row["id"]: row["event_data"] for row in events.json()["events"]}
    assert {proof["fact_id"] for proof in events[str(eid)]["evidence"]} == {str(changed), str(kept)}
    assert [proof["fact_id"] for proof in events[str(solo_event)]["evidence"]] == [str(changed)]
    assert events[str(solo_event)]["evidence"][0]["content"] == "The user visited Kyoto"
    profiles = {row.id: row for row in (await profile.get_user_profiles(uid, "__root__")).data().profiles}
    assert set(profiles[pid].attributes["fact_ids"]) == {str(changed), str(kept)}
    assert profiles[solo_profile].attributes["fact_ids"] == [str(changed)]


@pytest.mark.asyncio
@pytest.mark.parametrize("reader", ["event-list", "profile-list", "event-query", "profile-query", "search"])
async def test_flush_completion_cannot_attach_new_proof_to_a_previously_read_derivative(search_users, reader):
    uid, _, _, client = search_users
    fid = seed_facts(uid, ["The user visited Kyoto"])[0]
    eid, pid = seed_derived(uid, [fid], content="Old Tokyo story")
    with Session.begin() as session:
        session.execute(update(UserProfile).where(UserProfile.id == pid).values(content="Old Tokyo profile"))
    batch(uid, fact=False, changes=[{"kind": "updated", "fact_id": str(fid)}])
    operation = maintenance.flush(uid, "__root__", "concurrent-completion")
    fired = False
    marker = "user_events.event_data" if reader.startswith("event") else "user_profiles.content"

    def complete_after_text_read(connection, cursor, statement, parameters, context, executemany):
        nonlocal fired
        if fired or not statement.lstrip().startswith("SELECT") or marker not in statement:
            return
        fired = True
        # Another committed writer updates both derived text and the receipt
        # after the reader's old-text SELECT, before its evidence SELECT.
        with Session.begin() as writer:
            story = dict(writer.scalar(select(UserEvent.event_data).where(UserEvent.id == eid)))
            story.update(content="The user visited Kyoto", event_tip="The user visited Kyoto")
            writer.execute(update(UserEvent).where(UserEvent.id == eid).values(
                event_data=story, revision=UserEvent.revision + 1))
            writer.execute(update(UserProfile).where(UserProfile.id == pid).values(
                content="The user visited Kyoto", revision=UserProfile.revision + 1))
            writer.execute(update(memory_operations).where(memory_operations.c.id == operation.operation_id).values(
                status="completed", result={"blob_ids": [], "profile_ids": [str(pid)], "event_ids": [str(eid)]}))

    async def read():
        if reader.endswith("list"):
            return await client.get(f"/api/users/{uid}/{'events' if reader.startswith('event') else 'profiles'}")
        if reader.endswith("query"):
            collection, ident = ("events", eid) if reader.startswith("event") else ("profiles", pid)
            return await client.post(f"/api/users/{uid}/{collection}/query", json={"ids": [str(ident)]})
        return await client.post(f"/api/users/{uid}/search", json={"query": "user"})

    sql_event.listen(DB_ENGINE, "after_cursor_execute", complete_after_text_read)
    try:
        response = await read()
    finally:
        sql_event.remove(DB_ENGINE, "after_cursor_execute", complete_after_text_read)
    assert fired and response.status_code == 200
    data = response.json()
    if reader.startswith("event"):
        old = data["events"][0]["event_data"]
        assert old["content"] == "Old Tokyo story" and old["evidence"] == []
        if reader.endswith("query"):
            assert old["fact_ids"] == []
    elif reader.startswith("profile"):
        old = data["profiles"][0]
        assert old["content"] == "Old Tokyo profile" and old["source_ids"] == []
        if reader.endswith("query"):
            assert old["fact_ids"] == []
    else:
        assert data["facts"][0]["content"] == "The user visited Kyoto"
        assert data["events"] == data["profiles"] == []
    # A new read observes the completed tuple, including its restored proof.
    current = (await read()).json()
    if reader.startswith("event"):
        assert current["events"][0]["event_data"]["content"] == "The user visited Kyoto"
        assert [proof["fact_id"] for proof in current["events"][0]["event_data"]["evidence"]] == [str(fid)]
        if reader.endswith("query"):
            assert current["events"][0]["event_data"]["fact_ids"] == [str(fid)]
    elif reader.startswith("profile"):
        assert current["profiles"][0]["content"] == "The user visited Kyoto"
        assert current["profiles"][0]["source_ids"]
    else:
        assert current["events"][0]["fact_ids"] == current["profiles"][0]["fact_ids"] == [str(fid)]


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
        assert fact["fact_time"] is None
    assert history_text(uid) and not any("April 2025" in text for text in history_text(uid))


@pytest.mark.asyncio
@pytest.mark.parametrize("change_kind", ["evidence", "updated"])
async def test_new_evidence_deletion_during_loop_cannot_reintroduce_stale_history(search_users, change_kind):
    uid, _, _, _ = search_users
    sid, _, _ = timed_profile(uid, "Sakura Hotel")
    other_sid, other_fact, other_profile = timed_profile(uid, "Bluebird Cafe")
    await source.delete_messages(uid, "__root__", sid,
        DeleteMessages(message_ids=["m2"], idempotency_key="first-time"))
    original = derive()
    async def runner(context):
        if change_kind == "evidence":
            await source.delete_messages(uid, "__root__", other_sid,
                DeleteMessages(message_ids=["m2"], idempotency_key="later-time"))
        else:
            await source.update_fact(uid, "__root__", other_fact, UpdateFact(
                idempotency_key="later-edit", expected_revision=1, reason="Incorrect cafe",
                content="Visited Bluebird Restaurant", subject="The user", reporter="The user",
                certainty="asserted", support_groups=[["m1"], ["m2"]], fact_time=None))
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
        session.execute(update(memory_facts).where(memory_facts.c.id == legacy_fact).values(fact_time=None, revision=2))
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
