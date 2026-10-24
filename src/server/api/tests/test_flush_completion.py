"""Completion, capacity and crash counterexamples using isolated SQL/Redis."""
import ast
import json
from uuid import uuid4
from datetime import timedelta
from xml.etree import ElementTree

import pytest
from sqlalchemy import delete, select, update, func

from tests.test_maintenance import source_user, batch, row
from tests.test_search_bundle import search_users, seed_facts, seed_derived
from tests.test_maintenance_agent import transport, completion, tool
from tests.maintenance_support import claim_for, maintain
from memoia_server import maintenance_agent
from memoia_server.connectors import Session
from memoia_server.controllers import maintenance, source
from memoia_server.models.database import UserProfile, UserEvent
from memoia_server.models.source import DeleteMessages, memory_facts, memory_blobs, memory_operations


def initial_batch(transport):
    text = transport["requests"][0]["input"][1]["content"][0]["text"]
    return json.loads(ElementTree.fromstring(text).text)


def test_flush_reads_candidate_facts_once_not_once_per_blob(source_user):
    from sqlalchemy import event
    from memoia_server.connectors import DB_ENGINE
    for version in range(30):
        batch(source_user, version + 1)
    reads = []
    def record(conn, cursor, statement, parameters, context, many):
        if statement.lstrip().startswith("SELECT") and "FROM memory_facts" in statement:
            reads.append(statement)
    event.listen(DB_ENGINE, "before_cursor_execute", record)
    try:
        sealed = maintenance.flush(source_user, "__root__", "batch-read")
    finally:
        event.remove(DB_ENGINE, "before_cursor_execute", record)
    assert len(sealed.flush.blob_ids) == 30
    assert len(reads) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("large", [False, True], ids=["complete-first-page", "missing-byte-tail"])
async def test_model_final_can_acknowledge_only_changes_in_the_initial_page(source_user, transport, large):
    for version in range(25):
        _, fid = batch(source_user, version + 1)
        if large:
            with Session.begin() as session:
                session.execute(update(memory_facts).where(memory_facts.c.id == fid).values(content="K" * 4096))
    operation = maintenance.flush(source_user, "__root__", "no-read")
    transport["responses"] = [completion()]
    assert await maintenance.execute_claim(claim_for(source_user), runner=maintenance_agent.run_loop) is not large
    initial = initial_batch(transport)
    assert initial["change_count"] == 25
    assert (initial["next_cursor"] is not None) is large
    assert (len(initial["items"]) == 25) is not large
    saved = source.get_operation(source_user, "__root__", operation_id=operation.operation_id)
    if large:
        assert saved.status == "processing" and saved.flush.status == "pending"
        assert saved.result is None and saved.error.code == "maintenance_incomplete"
    else:
        assert saved.status == saved.flush.status == "completed"
        assert len(saved.result.blob_ids) == 25 and saved.error is None
    assert len(transport["requests"]) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("read_all", [False, True])
async def test_repeated_first_page_does_not_cover_the_missing_tail(source_user, transport, read_all):
    for version in range(25):
        _, fid = batch(source_user, version + 1)
        with Session.begin() as session:
            session.execute(update(memory_facts).where(memory_facts.c.id == fid).values(content="K" * 4096))
    operation = maintenance.flush(source_user, "__root__", "pages")
    continuation = tool("read_changes", {"limit": 200}, "next")
    def choose_page():
        if len(transport["requests"]) != 1:
            return
        initial = initial_batch(transport)
        assert initial["next_cursor"] and len(initial["items"]) < 25
        continuation["arguments"] = json.dumps({"limit": 200,
            "cursor": initial["next_cursor"] if read_all else "0"})
    transport["after_response"] = choose_page
    transport["responses"] = [
        completion(None, calls=[continuation]),
        completion(),
    ]
    assert await maintenance.execute_claim(claim_for(source_user), runner=maintenance_agent.run_loop) is read_all
    initial = initial_batch(transport)
    page = ast.literal_eval(transport["requests"][1]["input"][0]["output"])
    initial_refs = {item["fact_id"] for item in initial["items"]}
    continued_refs = {item["fact_id"] for item in page["items"]}
    if read_all:
        assert page["next_cursor"] is None
        assert initial_refs.isdisjoint(continued_refs)
        assert len(initial_refs | continued_refs) == 25
    else:
        assert initial_refs == continued_refs and page["next_cursor"] == initial["next_cursor"]
    saved = row(operation.operation_id)
    assert (saved["status"] == "completed") is read_all
    if read_all:
        assert len(saved["result"]["blob_ids"]) == 25
        assert saved["result"]["profile_ids"] == saved["result"]["event_ids"] == []
    else:
        assert saved["result"] is None and saved["error"]["code"] == "maintenance_incomplete"
    assert len(transport["requests"]) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("changed", [False, True], ids=["current-fact", "changed-after-preload"])
async def test_initial_fact_support_is_staged_then_checked_at_final_commit(source_user, transport, changed):
    _, fid = batch(source_user)
    operation = maintenance.flush(source_user, "__root__", "preloaded-support")
    transport["responses"] = [completion(None, calls=[tool("stage_profile", {"changes": [{
        "action": "upsert", "content": "Supported fact 1", "topic": "interests_preferences",
        "sub_topic": "fixture", "fact_ids": ["f1"]}]}, "stage")]), completion()]
    def before_commit():
        assert row(operation.operation_id)["status"] == "processing"
        with Session() as session:
            assert session.query(UserProfile).filter_by(user_id=source_user).count() == 0
        if changed and len(transport["requests"]) == 2:
            with Session.begin() as session:
                session.execute(update(memory_facts).where(memory_facts.c.id == fid)
                                .values(content="Changed after preload", revision=2))
    transport["after_response"] = before_commit
    assert await maintenance.execute_claim(claim_for(source_user), runner=maintenance_agent.run_loop) is not changed
    initial = initial_batch(transport)
    assert initial["next_cursor"] is None and len(initial["items"]) == 1
    assert initial["items"][0]["fact_id"] == initial["items"][0]["current_fact"]["id"] == "f1"
    staged = ast.literal_eval(transport["requests"][1]["input"][0]["output"])
    assert staged["staged"] is True
    saved = row(operation.operation_id)
    with Session() as session:
        profiles = session.query(UserProfile).filter_by(user_id=source_user).all()
        if changed:
            assert profiles == [] and saved["result"] is None
            assert saved["error"]["code"] == "maintenance_read_conflict"
        else:
            assert len(profiles) == 1 and profiles[0].content == "Supported fact 1"
            assert profiles[0].attributes["fact_ids"] == [str(fid)]
            assert saved["status"] == "completed" and len(saved["result"]["profile_ids"]) == 1
    assert len(transport["requests"]) == 2


@pytest.mark.asyncio
async def test_byte_sized_pages_never_acknowledge_unreturned_facts(source_user):
    for version in range(25):
        _, fid = batch(source_user, version + 1)
        with Session.begin() as session:
            session.execute(update(memory_facts).where(memory_facts.c.id == fid).values(content="K" * 4096))
    maintenance.flush(source_user, "__root__", "byte-pages")
    async def runner(context):
        page = await context.read("facts", limit=200)
        assert page["next_cursor"] and len(page["items"]) < 25
        assert set(context.readset["facts"]) == {item["id"] for item in page["items"]}
        cursor, seen = None, []
        while True:
            page = await context.read_changes(cursor=cursor, limit=200)
            assert maintenance.payload_size(page) <= maintenance_agent.MAX_TOOL_BYTES
            seen.extend(item["fact_id"] for item in page["items"])
            assert all(item["current_fact"]["content"] == "K" * 4096 for item in page["items"])
            cursor = page["next_cursor"]
            if cursor is None:
                break
        assert len(seen) == len(set(seen)) == 25
        return context.get_plan(maintenance_agent.LoopUsage())
    assert await maintenance.execute_claim(claim_for(source_user), runner=runner)


@pytest.mark.asyncio
async def test_byte_pagination_includes_staged_entries_once_without_cursor_loop(source_user):
    _, fid = batch(source_user)
    maintenance.flush(source_user, "__root__", "staged-pages")
    async def runner(context):
        await context.read_changes()
        for index in range(25):
            await context.stage_profile(maintenance_agent.ProfileMutation(action="upsert",
                content="K" * 4096, topic="interests_preferences", sub_topic=f"entry-{index}", fact_ids=[str(fid)]))
        cursor, seen, pages = None, [], 0
        while True:
            page = await context.read("profiles", cursor=cursor, limit=200)
            pages += 1
            assert maintenance.payload_size(page) <= maintenance_agent.MAX_TOOL_BYTES
            assert all(item["content"] == "K" * 4096 and "content_preview" not in item for item in page["items"])
            seen.extend(item["id"] for item in page["items"])
            if page["next_cursor"] is None:
                break
            assert page["next_cursor"] != cursor
            cursor = page["next_cursor"]
        assert len(seen) == len(set(seen)) == 25
        assert pages > 1
        return context.get_plan(maintenance_agent.LoopUsage())
    assert await maintenance.execute_claim(claim_for(source_user), runner=runner)


@pytest.mark.asyncio
async def test_flush_seals_bounded_complete_blobs_and_leaves_the_tail(source_user, monkeypatch):
    monkeypatch.setattr(maintenance, "MAX_FLUSH_BYTES", 700)
    batches = [batch(source_user, version + 1) for version in range(3)]
    ids = [bid for bid, _ in batches]
    with Session.begin() as session:
        session.execute(update(memory_facts).where(memory_facts.c.id.in_([fid for _, fid in batches]))
                        .values(content="K" * 200))
    first = maintenance.flush(source_user, "__root__", "bounded-first")
    assert first.status == "processing" and len(first.flush.blob_ids) == 1
    assert maintenance.get_status(source_user, "__root__")["pending_blob_count"] == 2
    assert maintenance.flush(source_user, "__root__", "bounded-first") == first
    second = maintenance.flush(source_user, "__root__", "bounded-second")
    third = maintenance.flush(source_user, "__root__", "bounded-third")
    selected = [*first.flush.blob_ids, *second.flush.blob_ids, *third.flush.blob_ids]
    assert set(selected) == set(ids) and len(selected) == 3
    assert maintenance.get_status(source_user, "__root__")["pending_blob_count"] == 0


@pytest.mark.asyncio
async def test_indivisible_oversized_blob_fails_explicitly_and_next_blob_can_proceed(source_user, monkeypatch):
    monkeypatch.setattr(maintenance, "MAX_FLUSH_BYTES", 700)
    large, fid = batch(source_user)
    with Session.begin() as session:
        session.execute(update(memory_facts).where(memory_facts.c.id == fid).values(content="K" * 4096))
    small, _ = batch(source_user, 2)
    failed = maintenance.flush(source_user, "__root__", "oversized")
    assert failed.status == failed.flush.status == "failed"
    assert failed.flush.blob_ids == [large] and failed.error.code == "maintenance_capacity"
    assert failed.flush.attempts == 0 and row(failed.operation_id)["lease_owner"] is None
    assert maintenance.flush(source_user, "__root__", "next").flush.blob_ids == [small]


@pytest.mark.asyncio
async def test_explicit_recovery_cannot_bypass_the_fixed_batch_capacity(source_user, monkeypatch):
    monkeypatch.setattr(maintenance, "MAX_FLUSH_BYTES", 700)
    _, fid = batch(source_user)
    with Session.begin() as session:
        session.execute(update(memory_facts).where(memory_facts.c.id == fid).values(content="K" * 4096))
    operation = maintenance.flush(source_user, "__root__", "oversized-recovery")
    maintenance.retry_flush(source_user, "__root__", operation.operation_id)
    called = False
    async def runner(context):
        nonlocal called
        called = True
        return context.get_plan(maintenance_agent.LoopUsage())
    assert not await maintenance.execute_claim(claim_for(source_user), runner=runner)
    assert not called
    saved = source.get_operation(source_user, "__root__", operation_id=operation.operation_id)
    assert saved.status == saved.flush.status == "failed" and saved.error.code == "maintenance_capacity"


@pytest.mark.asyncio
async def test_fourth_attempt_crash_finishes_without_other_eligible_work(source_user):
    batch(source_user)
    operation = maintenance.flush(source_user, "__root__", "last-crash")
    with Session.begin() as session:
        session.execute(update(memory_operations).where(memory_operations.c.id == operation.operation_id).values(attempts=3))
    claim = claim_for(source_user)
    assert claim.attempts == 4
    with Session.begin() as session:
        session.execute(update(memory_operations).where(memory_operations.c.id == operation.operation_id)
                        .values(lease_until=func.now() - timedelta(seconds=1)))
    assert maintenance.reap_expired() == 1
    assert maintenance.reap_expired() == 0 and claim_for(source_user) is None
    saved = source.get_operation(source_user, "__root__", operation_id=operation.operation_id)
    assert saved.status == saved.flush.status == "failed"
    assert saved.error.code == "maintenance_lease_expired" and saved.flush.attempts == 4
    assert row(operation.operation_id)["lease_owner"] is None and not maintenance.renew_claim(claim)


@pytest.mark.asyncio
async def test_backoff_keeps_original_operation_pending_without_resetting_attempts(source_user):
    batch(source_user)
    operation = maintenance.flush(source_user, "__root__", "backoff")
    claim = claim_for(source_user)
    maintenance.fail_claim(claim, source.SourceError("model_unavailable", "safe", 503, True))
    saved = source.get_operation(source_user, "__root__", operation_id=operation.operation_id)
    assert saved.status == "processing" and saved.flush.status == "pending"
    assert saved.error.code == "model_unavailable" and saved.flush.attempts == 1
    assert maintenance.retry_flush(source_user, "__root__", operation.operation_id) == saved
    assert claim_for(source_user) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("fail_commit", [False, True])
async def test_one_fact_can_clean_102_derived_entries_atomically(search_users, transport, monkeypatch, fail_commit):
    uid, _, _, _ = search_users
    fid = seed_facts(uid, ["A supported conclusion"])[0]
    for _ in range(51):
        seed_derived(uid, [fid])
    manual_profile, manual_event = uuid4(), uuid4()
    with Session.begin() as session:
        sid = session.scalar(select(memory_blobs.c.source_id).where(memory_blobs.c.user_id == uid))
        # Standalone manual entries explicitly have no Fact ancestry.
        session.execute(UserProfile.__table__.insert().values(id=manual_profile, user_id=uid, project_id="__root__",
            content="Manual profile", attributes={"topic": "interest", "sub_topic": "manual", "_impact_fact_ids": []}))
        session.execute(UserEvent.__table__.insert().values(id=manual_event, user_id=uid, project_id="__root__",
            event_data={"content": "Manual event", "event_tip": "Manual event", "_impact_fact_ids": []}))
    await source.delete_messages(uid, "__root__", sid,
        DeleteMessages(message_ids=["m1"], idempotency_key="delete-support"))
    transport["responses"] = [completion(None, calls=[tool("read_changes", {})]), completion()]
    if fail_commit:
        apply = maintenance._apply_plan
        def reject_events(session, claim, plan, kind, event_embeddings, impact):
            if kind == "event":
                raise source.SourceError("model_unavailable", "safe", 503, True)
            return apply(session, claim, plan, kind, event_embeddings, impact)
        monkeypatch.setattr(maintenance, "_apply_plan", reject_events)
    assert await maintain(uid, maintenance_agent.run_loop) is not fail_commit
    with Session() as session:
        if fail_commit:
            failed = session.execute(select(memory_operations.c.error).where(
                memory_operations.c.user_id == uid,
                memory_operations.c.kind == "flush",
            )).scalar_one()
            assert failed["code"] == "model_unavailable"
        assert session.query(UserProfile).filter_by(user_id=uid).count() == (52 if fail_commit else 1)
        assert session.query(UserEvent).filter_by(user_id=uid).count() == (52 if fail_commit else 1)
        assert session.get(UserProfile, (manual_profile, "__root__")) is not None
        assert session.get(UserEvent, (manual_event, "__root__")) is not None
    assert len(transport["requests"]) == 2


@pytest.mark.asyncio
async def test_affected_entry_can_be_rebuilt_from_surviving_support(search_users):
    uid, _, _, _ = search_users
    deleted, surviving = seed_facts(uid, ["First evidence", "Independent evidence"])
    eid, pid = seed_derived(uid, [deleted, surviving])
    with Session.begin() as session:
        bid = session.scalar(select(memory_facts.c.blob_id).where(memory_facts.c.id == deleted))
        session.execute(delete(memory_facts).where(memory_facts.c.id == deleted))
        maintenance.record_changes(session, uid, "__root__", bid, 2, [{"kind": "deleted", "fact_id": str(deleted)}])
    async def runner(context):
        await context.read_changes()
        assert not context._staged["profiles"] and not context._staged["events"]
        await context.read("facts", ids=[str(surviving)])
        await context.read("profiles", ids=[str(pid)])
        await context.read("events", ids=[str(eid)])
        await context.stage_profile(maintenance_agent.ProfileMutation(action="upsert", id=str(pid),
            content="Independent evidence", topic="interests_preferences", sub_topic="travel", fact_ids=[str(surviving)]))
        await context.stage_event(maintenance_agent.EventMutation(action="upsert", id=str(eid),
            content="Independent evidence", fact_ids=[str(surviving)]))
        return context.get_plan(maintenance_agent.LoopUsage())
    assert await maintain(uid, runner)
    with Session() as session:
        assert session.scalar(select(UserProfile.content).where(UserProfile.id == pid)) == "Independent evidence"
        assert session.scalar(select(UserEvent.event_data).where(UserEvent.id == eid))["fact_ids"] == [str(surviving)]
        assert session.scalar(select(memory_facts.c.id).where(memory_facts.c.id == surviving)) == surviving
