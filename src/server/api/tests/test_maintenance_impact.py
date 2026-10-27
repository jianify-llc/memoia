"""Read influence locates derived text without turning background into evidence."""
import asyncio
import threading
from datetime import timedelta
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import delete, event as sql_events, func, select, text, update

from memoia_server.connectors import DB_ENGINE, Session
from memoia_server.controllers import event, maintenance, profile, source, user
from memoia_server.maintenance_agent import EventMutation, LoopUsage, ProfileMutation
from memoia_server.models.database import User, UserEvent, UserProfile
from memoia_server.models.response import UserData
from memoia_server.models.source import (
    DeleteFact, DeleteMessages, UpdateFact, memory_blobs, memory_event_facts, memory_facts,
    memory_messages, memory_profile_revisions,
)
from tests.maintenance_support import claim_for
from tests.test_maintenance import batch, row, source_user


async def read_changes_only(context):
    await context.read_changes()
    return context.get_plan(LoopUsage())


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["updated", "deleted", "evidence"])
async def test_required_progress_covers_indirect_scope_not_optional_reads(background_memory, kind, monkeypatch):
    uid, main, background, pid, eid = background_memory
    manual = str((await profile.add_user_profiles(uid, "__root__", ["Independent manual profile"],
        [{"topic": "interests_preferences", "sub_topic": "manual"}])).data().ids[0])
    await change_background(uid, background, kind)
    batch(uid, 3)  # Mixed addition must not turn optional entries into obligations.
    expected = {"profiles": {"count": 1, "ids": [pid]}, "events": {"count": 1, "ids": [eid]}}

    async def runner(context):
        assert (await context.read_changes())["remaining_review"] == expected
        # Progress exposes identity, not the original text or permission to mutate it.
        for action in ("keep", "remove", "upsert"):
            proposal = {"action": action, "id": pid}
            if action == "upsert":
                proposal.update(content="Unseen replacement", topic=context.allowed_topics[0],
                                sub_topic="concert", fact_ids=[str(main)])
            with pytest.raises(source.SourceError, match="Read the complete target"):
                await context.stage_batch([ProfileMutation(**proposal)], "profile")
        optional = await context.read("profiles", ids=[manual])
        assert optional["items"][0]["review_required"] is False
        assert optional["remaining_review"] == expected
        for collection, ident in (("profiles", pid), ("events", eid)):
            page = await context.read(collection)
            assert page["items"][0]["review_required"] is True
            assert page["items"][0]["fact_ids"] == [str(main)]
            assert set(page["items"][0]) <= {"id", "revision", "topic", "fact_ids", "evidence",
                                               "invalid_fact_ids", "support_unknown", "review_required"}
            assert page["remaining_review"] == expected
        from types import SimpleNamespace
        from memoia_server.models.utils import Promise
        async def search(*args, **kwargs):
            return Promise.resolve(SimpleNamespace(facts=[], events=[SimpleNamespace(id=eid, score=1)],
                profiles=[SimpleNamespace(id=pid, score=1), SimpleNamespace(id=manual, score=.5)]))
        monkeypatch.setattr(event, "hybrid_search_user_events", search)
        found = await context.search("concert")
        assert [item["review_required"] for item in found["profiles"]] == [True, False]
        assert found["events"][0]["review_required"] is True
        for item in (found["profiles"][0], found["events"][0]):
            assert not {"content", "event_tip", "title", "summary", "keywords", "sub_topic"}.intersection(item)
        for collection, ident, factory in (("profile", pid, ProfileMutation), ("event", eid, EventMutation)):
            with pytest.raises(source.SourceError) as rejected:
                await context.stage_batch([factory(action="keep", id=ident)], collection)
            assert rejected.value.code == "maintenance_rewrite_required"
        current = (await context.read("facts", ids=[str(main)]))["items"][0]
        result = await context.stage_batch([EventMutation(action="upsert", id=eid,
            content=current["content"], fact_ids=[current["id"]])], "event")
        assert result["remaining_review"] == {**expected, "events": {"count": 0, "ids": []}}
        with pytest.raises(source.SourceError) as missing:
            context.get_plan(LoopUsage())
        assert missing.value.code == "maintenance_unresolved_entries"
        result = await context.stage_batch([ProfileMutation(action="upsert", id=pid,
            content=current["content"], topic=context.allowed_topics[0], sub_topic="concert",
            fact_ids=[current["id"]])], "profile")
        assert all(group["count"] == 0 for group in result["remaining_review"].values())
        return context.get_plan(LoopUsage())

    before = derived(uid)
    assert (await run_flush(uid, "explicit-required-scope", runner))[1]
    profiles, events = derived(uid)
    assert profiles[manual] == before[0][manual]
    assert profiles[pid]["fact_ids"] == events[eid]["fact_ids"] == [str(main)]
    with Session() as session:
        assert session.get(UserProfile, (pid, "__root__")).content == "Supported fact 2"
    assert events[eid]["content"] == "Supported fact 2"


@pytest.mark.asyncio
async def test_remaining_preview_advances_after_decisions_not_reads(background_memory):
    uid, main, background, pid, eid = background_memory
    with Session.begin() as session:
        original = session.get(UserProfile, (pid, "__root__"))
        session.execute(UserProfile.__table__.insert(), [dict(id=uuid4(), user_id=uid, project_id="__root__",
            content=original.content, attributes=dict(original.attributes)) for _ in range(21)])
    await change_background(uid, background, "updated")

    async def runner(context):
        progress = (await context.read_changes())["remaining_review"]
        assert progress["profiles"]["count"] == 22 and len(progress["profiles"]["ids"]) == 20
        ids = progress["profiles"]["ids"]
        page = await context.read("profiles", ids=ids)
        assert page["remaining_review"] == progress
        current = (await context.read("facts", ids=[str(main)]))["items"][0]
        result = await context.stage_batch([ProfileMutation(action="upsert", id=ident,
            content=current["content"], topic=context.allowed_topics[0], sub_topic="concert",
            fact_ids=[current["id"]]) for ident in ids], "profile")
        tail = result["remaining_review"]["profiles"]
        assert tail["count"] == len(tail["ids"]) == 2 and not set(tail["ids"]).intersection(ids)
        await context.read("profiles", ids=tail["ids"])
        await context.stage_batch([ProfileMutation(action="upsert", id=ident,
            content=current["content"], topic=context.allowed_topics[0], sub_topic="concert",
            fact_ids=[current["id"]]) for ident in tail["ids"]], "profile")
        await context.read("events", ids=[eid])
        result = await context.stage_batch([EventMutation(action="upsert", id=eid,
            content=current["content"], fact_ids=[current["id"]])], "event")
        assert all(group["count"] == 0 for group in result["remaining_review"].values())
        return context.get_plan(LoopUsage())

    assert (await run_flush(uid, "bounded-required-preview", runner))[1]


@pytest.mark.asyncio
async def test_candidate_disappearance_during_preparation_is_a_read_conflict(background_memory, monkeypatch):
    uid, _, background, pid, _ = background_memory
    await change_background(uid, background, "updated")
    operation = maintenance.flush(uid, "__root__", "candidate-disappeared")
    original = maintenance._entry_support
    def remove_before_support(session, table, collection, claim, ids):
        if collection == "profiles":
            with Session.begin() as writer:
                writer.execute(delete(UserProfile).where(UserProfile.id == pid, UserProfile.user_id == uid))
        return original(session, table, collection, claim, ids)
    monkeypatch.setattr(maintenance, "_entry_support", remove_before_support)
    claim = claim_for(uid)
    async with maintenance.TaskLease(claim) as lease:
        with pytest.raises(source.SourceError) as conflict:
            maintenance.DBMaintenanceContext(claim, lease)
        assert conflict.value.code == "maintenance_read_conflict" and conflict.value.retryable
    assert row(operation.operation_id)["status"] == "processing"


async def run_flush(uid, key, runner):
    operation = maintenance.flush(uid, "__root__", key)
    claim = claim_for(uid)
    assert claim is not None and claim.operation_id == operation.operation_id
    return operation, await maintenance.execute_claim(claim, runner=runner)


async def change_background(uid, fid, kind):
    with Session() as session:
        fact = session.execute(select(memory_facts).where(memory_facts.c.id == fid)).mappings().one()
    common = dict(idempotency_key="background-" + kind, expected_revision=fact["revision"],
                  reason="Correct the background voice part")
    if kind == "deleted":
        result = await source.delete_fact(uid, "__root__", fid, DeleteFact(**common))
    elif kind == "evidence":
        with Session() as session:
            sid = session.scalar(select(memory_blobs.c.source_id).where(memory_blobs.c.id == fact["blob_id"]))
        result = await source.delete_messages(uid, "__root__", sid,
            DeleteMessages(idempotency_key=common["idempotency_key"], message_ids=["m2"]))
    else:
        result = await source.update_fact(uid, "__root__", fid, UpdateFact(**common,
            content="The user sings soprano.",
            subject=fact["subject"] or "The user", reporter=fact["reporter"] or "The user",
            certainty="asserted" if fact["certainty"] == "legacy" else fact["certainty"],
            support_groups=fact["support_groups"],
            fact_time=fact["fact_time"]))
    assert result.status == "completed"
    with Session() as session:
        changes = session.scalar(select(memory_blobs.c.fact_changes).where(memory_blobs.c.id == result.blob_id))
        assert [change["kind"] for change in changes] == [kind]
    return result


def derived(uid):
    with Session() as session:
        profiles = {str(item.id): dict(item.attributes) for item in
                    session.query(UserProfile).filter_by(user_id=uid, project_id="__root__")}
        events = {str(item.id): dict(item.event_data) for item in
                  session.query(UserEvent).filter_by(user_id=uid, project_id="__root__")}
    return profiles, events


@pytest_asyncio.fixture
async def background_memory(source_user):
    uid = source_user
    bid, background = batch(uid)
    with Session.begin() as session:
        sid = session.scalar(select(memory_blobs.c.source_id).where(memory_blobs.c.id == bid))
        session.execute(memory_messages.insert().values(user_id=uid, project_id="__root__", source_id=sid,
            message_id="m2", role="user", content_hash="no-body", processed=True,
            occurred_at=func.now() + timedelta(seconds=1)))
        session.execute(update(memory_blobs).where(memory_blobs.c.id == bid).values(message_ids=["m1", "m2"]))
        session.execute(update(memory_facts).where(memory_facts.c.id == background).values(
            content="The user sings alto.", subject="The user", reporter="The user", certainty="asserted",
            support_groups=[["m1"], ["m2"]]))
    assert (await run_flush(uid, "background-before-concert", read_changes_only))[1]
    _, main = batch(uid, 2)

    async def create(context):
        await context.read_changes()
        await context.stage_profile(ProfileMutation(action="upsert", content="An alto singer performed.",
            topic=context.allowed_topics[0], sub_topic="concert", fact_ids=[str(main)]))
        await context.stage_event(EventMutation(action="upsert", content="The user performed at a concert.",
            summary="The alto singer performed.", keywords="concert, alto", fact_ids=[str(main)]))
        # The final read set owns influence, including background read after staging.
        await context.read("facts", ids=[str(background)])
        return context.get_plan(LoopUsage())

    assert (await run_flush(uid, "concert-with-background", create))[1]
    profiles, events = derived(uid)
    return uid, main, background, next(iter(profiles)), next(iter(events))


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["updated", "deleted"])
async def test_background_scope_is_private_and_failed_flush_recovers_atomically(background_memory, kind, monkeypatch):
    uid, main, background, pid, eid = background_memory
    profiles, events = derived(uid)
    for data in (profiles[pid], events[eid]):
        assert data["fact_ids"] == [str(main)]
        assert set(data["_impact_fact_ids"]) == {str(main), str(background)}
    with Session() as session:
        assert list(session.scalars(select(memory_event_facts.c.fact_id).where(
            memory_event_facts.c.event_id == eid))) == [main]
        public_event = event.event_view(session, session.get(UserEvent, (eid, "__root__")))
    public_profiles = (await profile.get_user_profiles(uid, "__root__")).data().model_dump(mode="json")
    assert public_event["fact_ids"] == [str(main)]
    assert [proof["fact_id"] for proof in public_event["evidence"]] == [str(main)]
    assert "_impact_fact_ids" not in str(public_event) + str(public_profiles)

    # Exercise every historical field with the actual saved influence metadata.
    with Session.begin() as session:
        saved = session.scalar(select(memory_profile_revisions.c.profiles).where(
            memory_profile_revisions.c.user_id == uid))[0]
        session.execute(memory_profile_revisions.insert().values(id=uuid4(), user_id=uid,
            project_id="__root__", profiles=[saved], added=[saved], removed=[saved]))
    await change_background(uid, background, kind)
    history = source.get_history(uid, "__root__")
    assert history and not any([*item.profiles, *item.added, *item.removed] for item in history)

    async def fail_after_staging(context):
        await context.read_changes()
        for collection, ident in (("profiles", pid), ("events", eid)):
            page = await context.read(collection)
            assert [item["id"] for item in page["items"]] == [ident]
            assert page["items"][0]["fact_ids"] == [str(main)]
            assert page["items"][0]["invalid_fact_ids"] == []
            assert page["items"][0].get("pending_delete", False) is False
            assert "_impact_fact_ids" not in str(page)
        await context.stage_profile(ProfileMutation(action="upsert", id=pid,
            content="This staged rewrite must roll back with the staged event removal.",
            topic=context.allowed_topics[0], sub_topic="concert", fact_ids=[str(main)]))
        raise source.SourceError("model_unavailable", "Controlled one-time runner failure", 503, True)

    monkeypatch.setattr(maintenance, "RETRY_SECONDS", (0, 0, 0))
    operation, completed = await run_flush(uid, "failed-background-rewrite", fail_after_staging)
    assert not completed
    assert row(operation.operation_id)["error"] == {"code": "model_unavailable", "retryable": True}
    assert derived(uid) == (profiles, events)

    async def rewrite(context):
        remaining = (await context.read_changes())["remaining_review"]
        assert remaining == {"profiles": {"count": 1, "ids": [pid]}, "events": {"count": 1, "ids": [eid]}}
        for collection, ident in (("profiles", pid), ("events", eid)):
            assert [item["id"] for item in (await context.read(collection))["items"]] == [ident]
        await context.stage_profile(ProfileMutation(action="upsert", id=pid,
            content="The user performed at a concert.", topic=context.allowed_topics[0],
            sub_topic="concert", fact_ids=[str(main)]))
        await context.stage_event(EventMutation(action="upsert", id=eid,
            content="The user performed at a concert.",
            summary="The soprano singer performed." if kind == "updated" else "The user performed.",
            keywords="concert, soprano" if kind == "updated" else "concert", fact_ids=[str(main)]))
        return context.get_plan(LoopUsage())

    maintenance.retry_flush(uid, "__root__", operation.operation_id)
    recovered = claim_for(uid)
    assert recovered.operation_id == operation.operation_id
    assert await maintenance.execute_claim(recovered, runner=rewrite)
    assert row(operation.operation_id)["status"] == "completed"
    profiles, events = derived(uid)
    assert profiles[pid]["fact_ids"] == events[eid]["fact_ids"] == [str(main)]
    assert "alto" not in events[eid]["summary"] + events[eid]["keywords"]
    for data in (profiles[pid], events[eid]):
        assert set(data["_impact_fact_ids"]) == ({str(main)} if kind == "deleted" else {str(main), str(background)})
    current_history = next(item for item in source.get_history(uid, "__root__")
                           if item.operation_id == operation.operation_id)
    assert [item.content for item in current_history.profiles] == ["The user performed at a concert."]
    assert [item.content for item in current_history.added] == ["The user performed at a concert."]
    assert "_impact_fact_ids" not in str(current_history.model_dump())


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["updated", "deleted"])
async def test_unhandled_background_impact_rejects_commit_and_preserves_valid_memory(background_memory, kind):
    uid, main, background, _, _ = background_memory
    await change_background(uid, background, kind)
    original = derived(uid)
    columns = (memory_facts.c.id, memory_facts.c.blob_id, memory_facts.c.content,
               memory_facts.c.support_groups, memory_facts.c.revision)
    with Session() as session:
        before = list(session.execute(select(*columns).where(memory_facts.c.user_id == uid)
                                      .order_by(memory_facts.c.id)).mappings())
    # The Loop reads changes but never stages either affected entry.
    operation, completed = await run_flush(uid, "forget-unhandled-background", read_changes_only)
    assert not completed
    assert row(operation.operation_id)["error"] == {"code": "maintenance_unresolved_entries", "retryable": False}
    assert derived(uid) == original
    with Session() as session:
        after = list(session.execute(select(*columns).where(memory_facts.c.user_id == uid)
                                     .order_by(memory_facts.c.id)).mappings())
        assert after == before
        assert next(fact for fact in after if fact["id"] == main)["support_groups"] == [["m1"]]
        assert list(session.scalars(select(memory_event_facts.c.fact_id).where(
            memory_event_facts.c.user_id == uid))) == [main]


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["updated", "evidence", "deleted"])
@pytest.mark.parametrize("action", ["upsert", "keep"])
async def test_reading_derived_inherits_scope_and_background_change_fences_old_loop(background_memory, kind, action):
    uid, main, background, old_pid, old_eid = background_memory
    _, current = batch(uid, 3)

    async def inherit(context):
        await context.read_changes()
        await context.read("profiles", ids=[old_pid])
        await context.read("events", ids=[old_eid])
        assert str(background) not in context.readset["facts"]
        await context.stage_profile(ProfileMutation(action="upsert", content="The alto singer gave an encore.",
            topic=context.allowed_topics[0], sub_topic="encore", fact_ids=[str(current)]))
        await context.stage_event(EventMutation(action="upsert", content="The user gave an encore.",
            summary="The alto singer returned.", fact_ids=[str(current)]))
        return context.get_plan(LoopUsage())

    assert (await run_flush(uid, "inherited-background", inherit))[1]
    profiles, events = derived(uid)
    pid, eid = next(ident for ident in profiles if ident != old_pid), next(ident for ident in events if ident != old_eid)
    for data in (profiles[pid], events[eid]):
        assert data["fact_ids"] == [str(current)]
        assert set(data["_impact_fact_ids"]) == {str(main), str(background), str(current)}

    batch(uid, 4, fact=False, changes=[{"kind": "added", "fact_id": str(current)}])

    async def stale(context):
        await context.read_changes()
        for collection, ident in (("profiles", pid), ("events", eid)):
            assert [item["id"] for item in (await context.read(collection))["items"]] == [ident]
        assert str(background) not in context.readset["facts"]
        if action == "keep":
            await context.stage_profile(ProfileMutation(action="keep", id=pid))
            await context.stage_event(EventMutation(action="keep", id=eid))
        else:
            await context.stage_profile(ProfileMutation(action="upsert", id=pid, content="Stale alto encore",
                topic=context.allowed_topics[0], sub_topic="encore", fact_ids=[str(current)]))
            await context.stage_event(EventMutation(action="upsert", id=eid, content="Stale alto encore",
                fact_ids=[str(current)]))
        plan = context.get_plan(LoopUsage())
        await change_background(uid, background, kind)
        return plan

    operation, completed = await run_flush(uid, "old-loop-before-background-change", stale)
    assert not completed
    assert row(operation.operation_id)["error"] == {"code": "maintenance_read_conflict", "retryable": True}
    assert derived(uid) == (profiles, events)


@pytest.mark.asyncio
@pytest.mark.parametrize("unknown", ["missing", "null"])
async def test_unknown_legacy_scope_is_conservative_but_manual_and_foreign_entries_are_isolated(source_user, unknown):
    uid = source_user
    foreign = str((await user.create_user(UserData(), "__root__")).data().id)
    try:
        _, main = batch(uid)
        _, background = batch(uid, 2)
        assert (await run_flush(uid, "legacy-facts-ready", read_changes_only))[1]
        pid, eid, foreign_pid, foreign_eid = (uuid4() for _ in range(4))
        base = {"memoia_v2": True, "fact_ids": [str(main)]}
        if unknown == "null":
            base["_impact_fact_ids"] = None
        attrs = {**base, "topic": "interests_preferences", "sub_topic": "legacy"}
        story = {**base, "content": "Legacy alto concert", "event_tip": "Legacy alto concert"}
        manual = (await profile.add_user_profiles(uid, "__root__", ["An independent manual profile"],
            [{"topic": "interests_preferences", "sub_topic": "manual", "_impact_fact_ids": [str(background)]}])).data().ids[0]
        with Session.begin() as session:
            session.execute(UserProfile.__table__.insert(), [dict(id=ident, user_id=owner, project_id="__root__",
                content="Legacy alto profile", attributes=attrs) for ident, owner in ((pid, uid), (foreign_pid, foreign))])
            session.execute(UserEvent.__table__.insert(), [dict(id=ident, user_id=owner, project_id="__root__",
                event_data=story) for ident, owner in ((eid, uid), (foreign_eid, foreign))])
            assert session.scalar(select(UserProfile.attributes).where(UserProfile.id == manual))["_impact_fact_ids"] == []
            manual_revision = session.scalar(select(UserProfile.revision).where(UserProfile.id == manual))
            revisions = {owner: (session.scalar(select(UserProfile.revision).where(UserProfile.id == profile_id)),
                                 session.scalar(select(UserEvent.revision).where(UserEvent.id == event_id)))
                         for owner, profile_id, event_id in ((uid, pid, eid), (foreign, foreign_pid, foreign_eid))}
            old = dict(id=str(pid), content="Legacy alto profile", topic=attrs["topic"], sub_topic="legacy",
                       fact_ids=[str(main)], source_ids=[], **({"_impact_fact_ids": None} if unknown == "null" else {}))
            independent = dict(id=str(manual), content="An independent manual profile", topic=attrs["topic"],
                               sub_topic="manual", fact_ids=[], source_ids=[], _impact_fact_ids=[])
            for owner in (uid, foreign):
                session.execute(memory_profile_revisions.insert().values(id=uuid4(), user_id=owner,
                    project_id="__root__", profiles=[old, independent], added=[old, independent], removed=[old, independent]))
        foreign_before = derived(foreign)

        # Unknown legacy entries are conservative only for non-additions.
        batch(uid, 3)
        async def addition(context):
            await context.read_changes()
            assert (await context.read("profiles"))["items"] == []
            assert (await context.read("events"))["items"] == []
            return context.get_plan(LoopUsage())
        assert (await run_flush(uid, "addition-does-not-expand-unknown", addition))[1]
        await change_background(uid, background, "updated")
        with Session() as session:
            for owner, profile_id, event_id in ((uid, pid, eid), (foreign, foreign_pid, foreign_eid)):
                actual = (session.scalar(select(UserProfile.revision).where(UserProfile.id == profile_id)),
                          session.scalar(select(UserEvent.revision).where(UserEvent.id == event_id)))
                assert actual == tuple(value + (owner == uid) for value in revisions[owner])
            foreign_history = session.execute(select(memory_profile_revisions).where(
                memory_profile_revisions.c.user_id == foreign)).mappings().one()
            assert all(len(foreign_history[field]) == 2 for field in ("profiles", "added", "removed"))
        history = source.get_history(uid, "__root__")
        assert all([entry.content for entry in getattr(item, field)] == ["An independent manual profile"]
                   for item in history for field in ("profiles", "added", "removed"))
        assert "_impact_fact_ids" not in str([item.model_dump() for item in history])

        original = derived(uid)
        async def leave_unhandled(context):
            remaining = (await context.read_changes())["remaining_review"]
            assert remaining == {"profiles": {"count": 1, "ids": [str(pid)]},
                                 "events": {"count": 1, "ids": [str(eid)]}}
            for collection, ident in (("profiles", pid), ("events", eid)):
                page = await context.read(collection)
                assert [item["id"] for item in page["items"]] == [str(ident)]
                assert page["items"][0]["review_required"] is True
                assert page["items"][0].get("pending_delete", False) is False
            return context.get_plan(LoopUsage())
        operation, completed = await run_flush(uid, "forget-unhandled-legacy", leave_unhandled)
        assert not completed
        assert row(operation.operation_id)["error"] == {"code": "maintenance_unresolved_entries", "retryable": False}
        profiles, events = derived(uid)
        assert (profiles, events) == original
        assert set(profiles) == {str(manual), str(pid)} and set(events) == {str(eid)}
        assert profiles[str(manual)]["_impact_fact_ids"] == []
        assert derived(foreign) == foreign_before
        with Session() as session:
            assert session.scalar(select(UserProfile.revision).where(UserProfile.id == manual)) == manual_revision
            assert session.scalar(select(memory_facts.c.support_groups).where(memory_facts.c.id == main)) == [["m1"]]
            assert session.scalar(select(memory_facts.c.content).where(memory_facts.c.id == background)) == "The user sings soprano."
    finally:
        with Session.begin() as session:
            session.execute(delete(User).where(User.id == foreign, User.project_id == "__root__"))


@pytest.mark.asyncio
@pytest.mark.parametrize("unknown", ["missing", "null"])
async def test_reading_legacy_entries_cannot_wash_unknown_scope_or_restore_history(source_user, unknown):
    uid = source_user
    _, original = batch(uid)
    assert (await run_flush(uid, "legacy-original-ready", read_changes_only))[1]
    pid, eid, revision_id = uuid4(), uuid4(), uuid4()
    base = {"memoia_v2": True, "fact_ids": [str(original)]}
    if unknown == "null":
        base["_impact_fact_ids"] = None
    snapshot = dict(id=str(pid), content="Legacy alto profile", topic="interests_preferences",
                    sub_topic="legacy", fact_ids=[str(original)], source_ids=[],
                    **({"_impact_fact_ids": None} if unknown == "null" else {}))
    with Session.begin() as session:
        session.execute(UserProfile.__table__.insert().values(id=pid, user_id=uid, project_id="__root__",
            content=snapshot["content"], attributes={**base, "topic": snapshot["topic"], "sub_topic": "legacy"}))
        session.execute(UserEvent.__table__.insert().values(id=eid, user_id=uid, project_id="__root__",
            event_data={**base, "content": "Legacy alto concert", "event_tip": "Legacy alto concert"}))
        session.execute(memory_profile_revisions.insert().values(id=revision_id, user_id=uid,
            project_id="__root__", profiles=[snapshot], added=[snapshot], removed=[snapshot]))
    edited = await profile.update_user_profiles(uid, "__root__", [str(pid)], [snapshot["content"]],
        [{"topic": snapshot["topic"], "sub_topic": "legacy", "_impact_fact_ids": [str(original)]}])
    assert edited.ok()
    updated = derived(uid)[0][str(pid)]
    assert updated.get("_impact_fact_ids") is None
    assert ("_impact_fact_ids" in updated) == (unknown == "null")
    _, added = batch(uid, 2)

    async def inherit(context):
        changes = await context.read_changes()
        assert [item["kind"] for item in changes["items"]] == ["added"]
        await context.read("profiles", ids=[str(pid)])
        await context.read("events", ids=[str(eid)])
        await context.stage_profile(ProfileMutation(action="upsert", content="The alto singer gave an encore.",
            topic=context.allowed_topics[0], sub_topic="encore", fact_ids=[str(added)]))
        await context.stage_event(EventMutation(action="upsert", content="The user gave an encore.",
            summary="The alto singer returned.", fact_ids=[str(added)]))
        return context.get_plan(LoopUsage())

    operation, completed = await run_flush(uid, "added-with-unknown-background", inherit)
    assert completed
    profiles, events = derived(uid)
    new_pid = next(ident for ident in profiles if ident != str(pid))
    new_eid = next(ident for ident in events if ident != str(eid))
    for data in (profiles[new_pid], events[new_eid]):
        assert data["fact_ids"] == [str(added)]
        assert data["_impact_fact_ids"] is None
    with Session() as session:
        old = session.execute(select(memory_profile_revisions).where(
            memory_profile_revisions.c.id == revision_id)).mappings().one()
        assert all(old[field] == [snapshot] for field in ("profiles", "added", "removed"))
        saved = session.scalar(select(memory_profile_revisions.c.profiles).where(
            memory_profile_revisions.c.operation_id == operation.operation_id))
        assert next(item for item in saved if item["id"] == new_pid)["_impact_fact_ids"] is None
    history = source.get_history(uid, "__root__")
    assert len(history) == 2
    assert not any([*item.profiles, *item.added, *item.removed] for item in history)


@pytest.mark.asyncio
async def test_explicit_legacy_removals_do_not_make_new_derived_scope_unknown(source_user):
    uid = source_user
    _, fid = batch(uid)
    assert (await run_flush(uid, "legacy-auto-remove-original-ready", read_changes_only))[1]
    pid, eid = uuid4(), uuid4()
    with Session.begin() as session:
        session.execute(UserProfile.__table__.insert().values(id=pid, user_id=uid, project_id="__root__",
            content="Unread legacy profile", attributes={"memoia_v2": True, "topic": "interests_preferences",
                "sub_topic": "legacy", "fact_ids": [str(fid)]}))
        session.execute(UserEvent.__table__.insert().values(id=eid, user_id=uid, project_id="__root__",
            event_data={"memoia_v2": True, "content": "Unread legacy event", "event_tip": "Unread legacy event",
                        "fact_ids": [str(fid)], "_impact_fact_ids": None}))
    await change_background(uid, fid, "updated")

    async def rebuild_from_fact(context):
        await context.read_changes()
        facts = await context.read("facts", ids=[str(fid)])
        assert [item["content"] for item in facts["items"]] == ["The user sings soprano."]
        assert not context._staged["profiles"] and not context._staged["events"]
        # Resolve legacy entries explicitly before deriving replacements.
        await context.read("profiles", ids=[str(pid)])
        await context.read("events", ids=[str(eid)])
        await context.stage_profile(ProfileMutation(action="remove", id=str(pid)))
        await context.stage_event(EventMutation(action="remove", id=str(eid)))
        await context.stage_profile(ProfileMutation(action="upsert", content="The user sings soprano.",
            topic=context.allowed_topics[0], sub_topic="voice", fact_ids=[str(fid)]))
        await context.stage_event(EventMutation(action="upsert", content="The user sings soprano.",
            fact_ids=[str(fid)]))
        return context.get_plan(LoopUsage())

    operation, completed = await run_flush(uid, "rebuild-without-reading-legacy", rebuild_from_fact)
    assert completed
    profiles, events = derived(uid)
    assert len(profiles) == len(events) == 1
    assert str(pid) not in profiles and str(eid) not in events
    for data in [*profiles.values(), *events.values()]:
        assert data["fact_ids"] == [str(fid)]
        assert data["_impact_fact_ids"] is None
    history = next(item for item in source.get_history(uid, "__root__")
                   if item.operation_id == operation.operation_id)
    assert history.profiles == []


@pytest.mark.asyncio
async def test_manual_edits_preserve_private_scope_and_serialize_background_revision(background_memory, monkeypatch):
    uid, main, background, pid, _ = background_memory
    original = derived(uid)[0][pid]
    with Session() as session:
        initial_revision = session.scalar(select(UserProfile.revision).where(UserProfile.id == pid))
    attempts = [{}, {"_impact_fact_ids": []}, {"_impact_fact_ids": None},
                {"_impact_fact_ids": [str(uuid4())]}]
    for attempt in attempts:
        response = await profile.update_user_profiles(uid, "__root__", [pid], ["Edited concert profile"],
            [{"topic": original["topic"], "sub_topic": "concert", "memoia_v2": False,
              "fact_ids": [str(background)], "source_ids": ["forged-source"], **attempt}])
        assert response.ok()
        stored = derived(uid)[0][pid]
        assert all(stored[key] == original[key] for key in ("memoia_v2", "fact_ids", "source_ids", "_impact_fact_ids"))
    public = (await profile.get_user_profiles(uid, "__root__")).data().profiles[0]
    assert public.attributes["fact_ids"] == [str(main)]
    assert "_impact_fact_ids" not in public.attributes

    null_profile = uuid4()
    with Session.begin() as session:
        session.execute(UserProfile.__table__.insert().values(id=null_profile, user_id=uid, project_id="__root__",
            content="Legacy profile with null attributes", attributes=None))
        assert session.scalar(select(UserProfile.attributes).where(UserProfile.id == null_profile)) is None
    edited = await profile.update_user_profiles(uid, "__root__", [str(null_profile)], ["Edited legacy profile"],
        [{"topic": original["topic"], "sub_topic": "legacy-null", "_impact_fact_ids": [str(background)]}])
    assert edited.ok()
    legacy = derived(uid)[0][str(null_profile)]
    assert "_impact_fact_ids" not in legacy and "fact_ids" not in legacy

    checked, release, background_attempted = threading.Event(), threading.Event(), threading.Event()
    original_attributes = profile._profile_attributes
    background_pid = []

    def pause_manual(supplied, previous=None):
        checked.set()
        assert release.wait(10), "Manual profile update was not released"
        return original_attributes(supplied, previous)

    def capture_background(connection, cursor, statement, parameters, context, executemany):
        if statement.lstrip().startswith("UPDATE user_profiles SET revision="):
            background_pid.append(connection.scalar(text("SELECT pg_backend_pid()")))
            background_attempted.set()

    def background_is_blocked():
        with Session() as session:
            return session.scalar(text("SELECT cardinality(pg_blocking_pids(:pid)) > 0"), {"pid": background_pid[0]})

    monkeypatch.setattr(profile, "_profile_attributes", pause_manual)
    sql_events.listen(DB_ENGINE, "before_cursor_execute", capture_background)
    manual_task = asyncio.create_task(profile.update_user_profiles(uid, "__root__", [pid], ["Final concert profile"],
        [{"topic": original["topic"], "sub_topic": "concert", "_impact_fact_ids": []}]))
    background_task = None
    try:
        assert await asyncio.to_thread(checked.wait, 3)
        background_task = asyncio.create_task(change_background(uid, background, "updated"))
        assert await asyncio.to_thread(background_attempted.wait, 3)
        async with asyncio.timeout(3):
            while not await source.run_sql(background_is_blocked):
                assert not background_task.done(), "Background invalidation bypassed the manual profile row lock"
                await asyncio.sleep(.01)
    finally:
        release.set()
        await asyncio.gather(manual_task, *([background_task] if background_task else []), return_exceptions=True)
        sql_events.remove(DB_ENGINE, "before_cursor_execute", capture_background)
    assert manual_task.result().ok()
    assert background_task is not None and background_task.result().status == "completed"
    with Session() as session:
        stored = session.get(UserProfile, (pid, "__root__"))
        assert stored.content == "Final concert profile"
        assert stored.revision == initial_revision + len(attempts) + 2
        assert stored.attributes["fact_ids"] == [str(main)]
        assert stored.attributes["_impact_fact_ids"] == original["_impact_fact_ids"]

    async def forget_affected(context):
        await context.read_changes()
        current = (await context.read("facts", ids=[str(main)]))["items"][0]
        for collection, factory in (("profiles", ProfileMutation), ("events", EventMutation)):
            page = await context.read(collection)
            for entry in page["items"]:
                if entry["id"] == str(null_profile):
                    assert entry["review_required"] is True
                    assert entry["support_unknown"] is True
                    assert entry["fact_ids"] == entry["invalid_fact_ids"] == entry["evidence"] == []
                    assert "content" not in entry and "sub_topic" not in entry
                    assert entry.get("pending_delete", False) is False
                    await context.stage_profile(factory(action="remove", id=entry["id"]))
                elif collection == "profiles":
                    await context.stage_profile(factory(action="upsert", id=entry["id"],
                        content=current["content"], topic=context.allowed_topics[0], sub_topic="concert",
                        fact_ids=[current["id"]]))
                else:
                    await context.stage_event(factory(action="upsert", id=entry["id"],
                        content=current["content"], fact_ids=[current["id"]]))
        plan = context.get_plan(LoopUsage())
        assert any(change.id == str(null_profile) and change.action == "remove" for change in plan.profiles)
        return plan

    assert (await run_flush(uid, "forget-edited-null-legacy-profile", forget_affected))[1]
    with Session() as session:
        assert session.get(UserProfile, (null_profile, "__root__")) is None
        assert session.scalar(select(memory_facts.c.support_groups).where(memory_facts.c.id == main)) == [["m1"]]
