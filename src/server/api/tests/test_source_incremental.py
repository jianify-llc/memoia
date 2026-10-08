"""Fact commits are immediate; deterministic maintenance uses real SQL/Redis."""
import asyncio
from datetime import datetime, timezone
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import select

from tests.test_sources import source_user, models, request
from tests.test_maintenance import ready
from tests.maintenance_support import claim_for, derive, maintain, status
from memoia_server.controllers import source, profile, maintenance
from memoia_server.connectors import Session
from memoia_server.env import CONFIG
from memoia_server.models.database import UserProfile, UserEvent
from memoia_server.models.source import memory_facts, DeleteMessages
from memoia_server.maintenance_agent import ProfileMutation, LoopUsage


def day(number):
    return datetime(2026, 1, number, tzinfo=timezone.utc)


def fact(topic, content="fact"):
    return {"id": uuid4(), "topic": topic, "sub_topic": "value", "content": content,
            "occurred_at": day(1), "support_groups": [["m"]]}




@pytest.mark.asyncio
async def test_withdrawal_recomputes_time_from_remaining_independent_support(source_user, models, monkeypatch):
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
    async def extract(body, **kwargs):
        return source.ExtractedSource([{**fact("basic", "Beijing"), "sub_topic": "city",
            "support_groups": [["old"], ["new"]], "occurred_at": day(3)}])
    monkeypatch.setattr(source, "extract_source", extract)
    imported = await source.import_source(source_user, "__root__", request(messages=[
        {"message_id": mid, "role": "user", "content": "Beijing", "occurred_at": when}
        for mid, when in (("old", day(1)), ("new", day(3)))
    ]))
    assert await maintain(source_user)
    deleted = await source.delete_messages(source_user, "__root__", imported.source_id,
        DeleteMessages(idempotency_key="withdraw-new", message_ids=["new"]))
    assert deleted.status == "completed" and deleted.result.memory_version > imported.result.memory_version
    with Session() as session:
        row = session.execute(select(memory_facts).where(memory_facts.c.blob_id == imported.blob_id)).mappings().one()
        assert row["support_groups"] == [["old"]] and row["occurred_at"] == day(1)
        assert session.query(UserEvent).filter_by(user_id=source_user).one().event_data["time"] == day(3).isoformat()
    assert status(source_user, "__root__")["status"] == "pending"
    assert await maintain(source_user)
    with Session() as session:
        assert session.query(UserEvent).filter_by(user_id=source_user).one().event_data["time"] == day(1).isoformat()


@pytest.mark.asyncio
async def test_new_topic_leaves_unrelated_profile_id_content_and_update_time_unchanged(source_user, models, monkeypatch):
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
    async def extract(body, **kwargs):
        return source.ExtractedSource([{**fact(m.content, m.content), "support_groups": [[m.message_id]],
                                       "occurred_at": m.occurred_at} for m in body.messages])
    monkeypatch.setattr(source, "extract_source", extract)
    await source.import_source(source_user, "__root__", request("first", "first", messages=[
        {"message_id": "m1", "role": "user", "content": "work", "occurred_at": day(1)}]))
    assert await maintain(source_user)
    with Session() as session:
        row = session.query(UserProfile).filter_by(user_id=source_user).one()
        before = (row.id, row.content, row.updated_at)
    second = await source.import_source(source_user, "__root__", request("second", "second", messages=[
        {"message_id": "m2", "role": "user", "content": "interest", "occurred_at": day(2)}]))
    recorder = AsyncMock(side_effect=derive())
    assert await maintain(source_user, recorder)
    assert set(recorder.call_args_list[0].args[0].readset["facts"]) == set(map(str, second.result.fact_ids))
    with Session() as session:
        row = session.get(UserProfile, (before[0], "__root__"))
        assert (row.id, row.content, row.updated_at) == before
        assert session.query(UserProfile).filter_by(user_id=source_user).count() == 2


@pytest.mark.asyncio
async def test_withdraw_correction_restores_previously_invalid_fact(source_user, models, monkeypatch):
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
    async def extract(body, *, rules, **kwargs):
        item = {**fact("basic", "Shanghai" if body.idempotency_key == "new" else "Beijing"), "sub_topic": "city",
                "support_groups": [[body.messages[0].message_id]], "occurred_at": body.messages[0].occurred_at}
        if body.idempotency_key == "new":
            assert rules["related_facts"][0]["content"] == "Beijing"
            item["corrects"] = [{"fact_id": rules["related_facts"][0]["id"], "support_groups": [["city"]]}]
        return source.ExtractedSource([item])
    monkeypatch.setattr(source, "extract_source", extract)
    await source.import_source(source_user, "__root__", request("old", "cities", messages=[
        {"message_id": "old-city", "role": "user", "content": "Beijing", "occurred_at": day(1)}]))
    runner = derive(latest=True, queries=("Beijing", "Shanghai"))
    assert await maintain(source_user, runner)
    newer = await source.import_source(source_user, "__root__", request("new", "cities", messages=[
        {"message_id": "city", "role": "user", "content": "Beijing corrected to Shanghai", "occurred_at": day(2)}]))
    with Session() as session:
        assert session.execute(select(memory_facts.c.active).where(memory_facts.c.content == "Beijing",
            memory_facts.c.user_id == source_user)).scalar_one() is False
    assert await maintain(source_user, runner)
    await source.delete_messages(source_user, "__root__", newer.source_id,
        DeleteMessages(idempotency_key="withdraw-correction", message_ids=["city"]))
    with Session() as session:
        assert session.execute(select(memory_facts.c.active).where(memory_facts.c.content == "Beijing",
            memory_facts.c.user_id == source_user)).scalar_one() is True
    assert await maintain(source_user, runner)
    assert [p.content for p in (await profile.get_user_profiles(source_user, "__root__")).data().profiles] == ["Beijing"]


@pytest.mark.asyncio
async def test_withdraw_latest_support_restores_correct_order_against_other_source(source_user, models, monkeypatch):
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
    async def extract(body, **kwargs):
        return source.ExtractedSource([{**fact("basic", body.messages[0].content), "sub_topic": "city",
            "support_groups": [[m.message_id] for m in body.messages],
            "occurred_at": max(m.occurred_at for m in body.messages)}])
    monkeypatch.setattr(source, "extract_source", extract)
    beijing = await source.import_source(source_user, "__root__", request("beijing", "beijing", messages=[
        {"message_id": mid, "role": "user", "content": "Beijing", "occurred_at": when}
        for mid, when in (("old", day(1)), ("latest", day(3)))]))
    await source.import_source(source_user, "__root__", request("shanghai", "shanghai", messages=[
        {"message_id": "city", "role": "user", "content": "Shanghai", "occurred_at": day(2)}]))
    runner = derive(latest=True, queries=("Beijing", "Shanghai"))
    assert await maintain(source_user, runner)
    assert [p.content for p in (await profile.get_user_profiles(source_user, "__root__")).data().profiles] == ["Beijing"]
    await source.delete_messages(source_user, "__root__", beijing.source_id,
        DeleteMessages(idempotency_key="withdraw-latest-support", message_ids=["latest"]))
    assert await maintain(source_user, runner)
    assert [p.content for p in (await profile.get_user_profiles(source_user, "__root__")).data().profiles] == ["Shanghai"]
    with Session() as session:
        assert all(session.scalars(select(memory_facts.c.active).where(memory_facts.c.user_id == source_user)))


@pytest.mark.asyncio
async def test_failed_empty_scope_rebuild_retains_deleted_ids_for_retry(source_user, models, monkeypatch):
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
    imported = await source.import_source(source_user, "__root__", request())
    assert await maintain(source_user)
    body = DeleteMessages(idempotency_key="remove-all", message_ids=["1", "2"])
    receipt = await source.delete_messages(source_user, "__root__", imported.source_id, body)
    failed = AsyncMock(side_effect=source.SourceError("model_failure", "test", 503, True))
    assert not await maintain(source_user, failed)
    assert source.get_operation(source_user, "__root__", key=body.idempotency_key) == receipt
    assert source.get_source(source_user, "__root__", source_id=imported.source_id).evidence == []
    assert (await profile.get_user_profiles(source_user, "__root__")).data().profiles
    state = status(source_user, "__root__")
    assert state["error"]["code"] == "model_failure"
    maintenance.retry_flush(source_user, "__root__", state["operation_id"])
    assert state["status"] == "pending" and state["attempts"] == 1
    ready(source_user)
    assert await maintain(source_user)
    assert not (await profile.get_user_profiles(source_user, "__root__")).data().profiles


@pytest.mark.asyncio
async def test_cancelled_maintenance_retains_deleted_change_after_evidence_disappears(source_user, models, monkeypatch):
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
    imported = await source.import_source(source_user, "__root__", request())
    assert await maintain(source_user)
    body = DeleteMessages(idempotency_key="cancel-withdrawal", message_ids=["1", "2"])
    receipt = await source.delete_messages(source_user, "__root__", imported.source_id, body)
    started = asyncio.Event()
    async def blocked(context):
        await derive()(context)
        started.set()
        await asyncio.Event().wait()
    execution = asyncio.create_task(maintain(source_user, blocked))
    await asyncio.wait_for(started.wait(), timeout=5)
    execution.cancel()
    with pytest.raises(asyncio.CancelledError):
        await execution
    assert source.get_operation(source_user, "__root__", key=body.idempotency_key) == receipt
    assert status(source_user, "__root__")["error"]["code"] == "maintenance_cancelled"
    assert source.get_source(source_user, "__root__", source_id=imported.source_id).evidence == []
    assert (await profile.get_user_profiles(source_user, "__root__")).data().profiles
    state = status(source_user, "__root__")
    maintenance.retry_flush(source_user, "__root__", state["operation_id"])
    assert state["status"] == "pending" and state["attempts"] == 1
    ready(source_user)
    assert await maintain(source_user)
    assert not (await profile.get_user_profiles(source_user, "__root__")).data().profiles


@pytest.mark.asyncio
async def test_out_of_scope_model_profile_cannot_commit_but_fact_receipt_remains_completed(source_user, models):
    imported = await source.import_source(source_user, "__root__", request())
    async def invalid(context):
        facts = (await context.read("facts"))["items"]
        await context.stage_profile(ProfileMutation(action="upsert", content="unrelated", topic="unrelated",
            sub_topic="value", fact_ids=[f["id"] for f in facts]))
        return context.get_plan(LoopUsage())
    assert not await maintain(source_user, invalid)
    assert imported.status == "completed" and len(imported.result.fact_ids) == 2
    assert status(source_user, "__root__")["error"]["code"] == "invalid_model_output"
    assert source.get_source(source_user, "__root__", source_id=imported.source_id).evidence
    assert not (await profile.get_user_profiles(source_user, "__root__")).data().profiles


@pytest.mark.asyncio
@pytest.mark.parametrize("boundary", ["input", "history"])
async def test_input_and_related_history_capacity_reject_before_model_with_distinct_errors(source_user, models, monkeypatch, boundary):
    prior = await source.import_source(source_user, "__root__", request())
    if boundary == "history":
        with Session.begin() as session:
            session.execute(memory_facts.insert(), [{**fact("work", f"historical evidence {index}"),
                "support_groups": [["1"]], "blob_id": prior.blob_id, "user_id": source_user,
                "project_id": "__root__"} for index in range(201)])
    else:
        monkeypatch.setattr(CONFIG, "source_context_window_tokens", 1)
    model = AsyncMock()
    monkeypatch.setattr(source, "extract_source", model)
    with pytest.raises(source.SourceError) as error:
        await source.import_source(source_user, "__root__", request("capacity", messages=[
            {"message_id": "3", "role": "user", "content": "a small new assertion", "occurred_at": day(3)}]))
    assert error.value.code == ("input_too_long" if boundary == "input" else "related_facts_too_large")
    assert not error.value.retryable
    model.assert_not_awaited()
    assert source.get_operation(source_user, "__root__", operation_id=prior.operation_id) == prior
    assert source.get_operation(source_user, "__root__", key="capacity").result is None


@pytest.mark.asyncio
async def test_capacity_maintenance_keeps_fact_delete_completed_and_only_explicit_retry_resumes(source_user, models, monkeypatch):
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
    imported = await source.import_source(source_user, "__root__", request())
    assert await maintain(source_user)
    body = DeleteMessages(idempotency_key="capacity-withdraw", message_ids=["1"])
    receipt = await source.delete_messages(source_user, "__root__", imported.source_id, body)
    failed = AsyncMock(side_effect=source.SourceError("maintenance_capacity", "test", 413, False))
    assert not await maintain(source_user, failed)
    state = status(source_user, "__root__")
    assert state["status"] == "failed" and not state["error"]["retryable"]
    assert await source.delete_messages(source_user, "__root__", imported.source_id, body) == receipt
    ready(source_user)
    assert claim_for(source_user) is None and failed.await_count == 1
    assert any("Tokyo" in p.content for p in (await profile.get_user_profiles(source_user, "__root__")).data().profiles)
    assert all("Tokyo" not in f.content for f in source.get_source(source_user, "__root__", source_id=imported.source_id).evidence)
    maintenance.retry_flush(source_user, "__root__", state["operation_id"])
    assert await maintain(source_user)
    assert [p.content for p in (await profile.get_user_profiles(source_user, "__root__")).data().profiles] == ["I enjoy chess"]


@pytest.mark.asyncio
async def test_oversized_unrelated_history_is_not_sent_to_model_or_initial_loop(source_user, models, monkeypatch):
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
    async def extract(body, **kwargs):
        topic = "work" if body.source_id == "log-1" else "interest"
        return source.ExtractedSource([{**fact(topic, "chess"), "support_groups": [["1"]]}])
    monkeypatch.setattr(source, "extract_source", extract)
    old = await source.import_source(source_user, "__root__", request())
    assert await maintain(source_user)
    with Session.begin() as session:
        session.execute(memory_facts.insert(), [{**fact("work", "historical evidence " * 120),
            "support_groups": [["1"]], "blob_id": old.blob_id, "user_id": source_user,
            "project_id": "__root__"} for _ in range(80)])
    result = await source.import_source(source_user, "__root__", request("small", "small"))
    assert result.status == "completed"
    async def bounded(context):
        page = await context.read("facts")
        assert [f["content"] for f in page["items"]] == ["chess"]
        assert page["next_cursor"] is None
        return await derive()(context)
    assert await maintain(source_user, bounded)
