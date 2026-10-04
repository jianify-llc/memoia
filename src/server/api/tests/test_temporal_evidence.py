"""Time contracts with deterministic model boundaries and isolated PostgreSQL effects."""
import json
from datetime import date, datetime, timezone
from uuid import uuid4
from unittest.mock import AsyncMock

import numpy as np
import pytest
import pytest_asyncio
from pydantic import ValidationError
from sqlalchemy import select, update

from memoia_server.models.source import EventTime, ImportSource, DeleteMessages, SourceMessage, memory_facts
from memoia_server.models.response import EventGistData, UserData
from memoia_server.models.database import User, UserEvent, UserEventGist
from memoia_server.controllers import source, user, event, event_gist
from memoia_server.connectors import Session
from memoia_server.models.utils import Promise
from memoia_server.env import CONFIG
from memoia_server.temporal import query_periods, time_overlap, supported_event_time, render_gist, source_observations


def period(start="2025-04-01", end="2025-04-30", precision="month", expression="去年四月", mid="1"):
    return {"start": start, "end": end, "precision": precision,
            "evidence": [{"message_id": mid, "expression": expression}]}


def test_calendar_precision_and_unknown_are_not_invented_dates():
    assert EventTime.model_validate(period()).precision == "month"
    assert EventTime.model_validate(period(None, None, "unknown", "那时候")).start is None
    for value in [period(end="2025-04-29"), period(start="2025-04-20"),
                  period(precision="day"), period(precision="unknown")]:
        with pytest.raises(ValidationError):
            EventTime.model_validate(value)
    with pytest.raises(ValidationError):
        SourceMessage(message_id="1", role="user", content="hi", occurred_at=datetime.now(timezone.utc), time_zone="fake/zone")


def test_query_time_is_explicit_soft_evidence_and_unknown_stays_unknown():
    periods = query_periods("Kyoto hotel in 2025-04; not 2026-02-30")
    assert periods == [(date(2025, 4, 1), date(2025, 4, 30))]
    assert time_overlap(period(), periods)
    assert query_periods("用户2025-04在京都住的酒店") == periods
    assert query_periods("2024-02") == [(date(2024, 2, 1), date(2024, 2, 29))]
    assert not time_overlap(None, periods)
    assert query_periods("last year, yesterday, person 12345") == []
    assert supported_event_time(period(), [["1", "2"]]) is not None
    assert supported_event_time(period(), [["2"]]) is None


def test_render_retains_precision_raw_expression_and_labels_recording_time():
    gist = EventGistData(content="Sakura Hotel", event_time=period(), source_messages=[
        {"message_id": "1", "recorded_at": "2026-10-03T00:00:00Z", "time_zone": "Asia/Shanghai"}])
    rendered = render_gist(gist)
    assert "2025-04-30" in rendered and "去年四月" in rendered and '"precision":"month"' in rendered
    assert '"recorded_at":"2026-10-03' in rendered
    assert render_gist(EventGistData(content="legacy undated fact")) == "legacy undated fact"
    assert source_observations([["old"]], [{"message_id": "old", "occurred_at": None}]) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("event_time", ["missing", "wrong type", period(end="2025-04-29")])
async def test_real_structured_validation_rejects_missing_or_invalid_time_without_echoing_content(monkeypatch, event_time):
    fact = {"content": "private temporal validation marker", "topic": "life_event", "sub_topic": "travel", "support_groups": [["1"]]}
    if event_time != "missing":
        fact["event_time"] = event_time
    monkeypatch.setattr(source, "openai_complete", AsyncMock(return_value=json.dumps({"facts": [fact], "event_tags": []})))
    monkeypatch.setattr(source, "record_completion_usage", AsyncMock())
    with pytest.raises(source.SourceError) as result:
        await source._structured(source.Extraction, "bounded input", source.EXTRACT_SYSTEM)
    assert "private temporal validation marker" not in str(result.value)
    assert result.value.retryable


@pytest.mark.asyncio
async def test_extraction_anchors_each_message_in_its_recorded_zone_and_rejects_fake_quote(monkeypatch):
    body = ImportSource(idempotency_key="k", source_id="d", messages=[
        {"message_id": "1", "role": "user", "content": "昨天去京都", "occurred_at": "2025-12-31T16:30:00Z", "time_zone": "Asia/Shanghai"},
        {"message_id": "2", "role": "user", "content": "昨天在巴黎", "occurred_at": "2025-12-31T16:30:00Z", "time_zone": "Europe/Paris"},
        {"message_id": "3", "role": "user", "content": "时区未知的昨天", "occurred_at": "2025-12-31T16:30:00Z"}])
    seen = []
    async def structured(model, prompt, system, **kwargs):
        seen.append(json.loads(prompt))
        return source.Extraction(facts=[source.ExtractedFact(content="Kyoto visit", topic="life_event", sub_topic="travel",
            support_groups=[["1"]], event_time=period("2025-12-31", "2025-12-31", "day", "昨天"))], event_tags=[])
    monkeypatch.setattr(source, "_structured", structured)
    result = await source.extract_source(body)
    assert [m["local_recorded_date"] for m in seen[0]["messages"]] == ["2026-01-01", "2025-12-31", None]
    assert result.facts[0]["occurred_at"].year == 2025
    assert result.facts[0]["event_time"]["start"] == "2025-12-31"
    bad = source.Extraction(facts=[source.ExtractedFact(content="Kyoto", topic="life_event", sub_topic="travel",
        support_groups=[["1"]], event_time=period(expression="fabricated quote"))], event_tags=[])
    monkeypatch.setattr(source, "_structured", AsyncMock(return_value=bad))
    with pytest.raises(source.SourceError, match="original source"):
        await source.extract_source(body)


@pytest_asyncio.fixture
async def temporal_user(db_env):
    created = await user.create_user(UserData(), "__root__")
    uid = created.data().id
    try:
        yield str(uid)
    finally:
        with Session.begin() as session:
            session.delete(session.get(User, (uid, "__root__")))


@pytest.mark.asyncio
async def test_storage_read_search_and_retraction_keep_separate_time_evidence(temporal_user, monkeypatch):
    async def extract(body, **kwargs):
        return source.ExtractedSource([{"id": uuid4(), "content": "Stayed at Sakura Hotel in Kyoto",
            "topic": "life_event", "sub_topic": "travel", "support_groups": [["1"], ["2"]],
            "occurred_at": body.messages[0].occurred_at, "event_time": period()}], [])
    async def reconcile(facts, **kwargs):
        return source.Reconciliation(decisions=[source.FactDecision(fact_id=f["id"], include=True) for f in facts],
            profiles=[source.DerivedProfile(content=f["content"], topic=f["topic"], sub_topic=f["sub_topic"], fact_ids=[f["id"]]) for f in facts])
    async def embedding(_, texts, **kwargs):
        return Promise.resolve(np.ones((len(texts), CONFIG.embedding_dim)))
    monkeypatch.setattr(source, "extract_source", extract)
    monkeypatch.setattr(source, "reconcile_facts", reconcile)
    monkeypatch.setattr(source, "get_embedding", embedding)
    monkeypatch.setattr(event_gist, "get_embedding", embedding)
    monkeypatch.setattr(event, "get_embedding", embedding)
    monkeypatch.setattr(source, "_structured", AsyncMock(return_value=source.EventTagging(event_tags=[])))
    body = ImportSource(idempotency_key="temporal", source_id="dialog", messages=[
        {"message_id": "1", "role": "user", "content": "去年四月住京都樱花酒店", "occurred_at": "2026-10-03T00:00:00Z", "time_zone": "Asia/Shanghai"},
        {"message_id": "2", "role": "user", "content": "我住过京都樱花酒店", "occurred_at": "2026-10-03T00:05:00Z", "time_zone": "Asia/Shanghai"}])
    first = await source.import_source(temporal_user, "__root__", body)
    assert first.status == "completed"
    assert await source.import_source(temporal_user, "__root__", body) == first
    evidence = source.get_source(temporal_user, "__root__", source_id="dialog").evidence[0]
    assert evidence.event_time.start == date(2025, 4, 1)
    assert evidence.source_messages[0].recorded_at.year == 2026
    with Session.begin() as session:
        stored = session.execute(select(memory_facts).where(memory_facts.c.user_id == temporal_user)).mappings().one()
        assert stored["event_time"]["precision"] == "month"
        # An old recording timestamp must not exclude a relevant undated/dated event.
        session.execute(update(UserEventGist).where(UserEventGist.user_id == temporal_user).values(created_at=datetime(2020, 1, 1, tzinfo=timezone.utc)))
    found = await event_gist.search_user_event_gists(temporal_user, "__root__", "Kyoto hotel 2025-04", time_range_in_days=1)
    assert found.ok() and len(found.data().gists) == 1
    assert "去年四月" in render_gist(found.data().gists[0].gist_data)
    v2 = await event.hybrid_search_user_events(temporal_user, "__root__", "Kyoto 2025-04")
    assert v2.ok() and v2.data().events[0].evidence[0].event_time.precision == "month"
    deleted = await source.delete_messages(temporal_user, "__root__", "dialog", DeleteMessages(idempotency_key="withdraw", message_ids=["1"]))
    assert deleted.status == "completed"
    remaining = source.get_source(temporal_user, "__root__", source_id="dialog").evidence[0]
    assert remaining.support_groups == [["2"]] and remaining.event_time is None
    assert [m.message_id for m in remaining.source_messages] == ["2"]


@pytest.mark.asyncio
async def test_original_timezone_enrichment_preserves_legacy_identity_without_reinterpreting_dates(temporal_user, monkeypatch):
    monkeypatch.setattr(source, "extract_source", AsyncMock(return_value=source.ExtractedSource([], [])))
    message = {"message_id": "1", "role": "user", "content": "Undated hotel visit", "occurred_at": "2026-01-01T00:00:00Z"}
    old = ImportSource(idempotency_key="old-no-zone", source_id="dialog", messages=[message])
    first = await source.import_source(temporal_user, "__root__", old)
    assert first.status == "completed"
    assert await source.import_source(temporal_user, "__root__", old) == first
    enriched = ImportSource(idempotency_key="new-with-zone", source_id="dialog", messages=[{**message, "time_zone": "Asia/Shanghai"}])
    assert (await source.import_source(temporal_user, "__root__", enriched)).status == "completed"
    from memoia_server.models.source import memory_messages
    with Session() as session:
        row = session.execute(select(memory_messages).where(memory_messages.c.user_id == temporal_user)).mappings().one()
        assert row["time_zone"] == "Asia/Shanghai"
        assert row["content_hash"] == source._message_hash(old.messages[0])
    conflicting = ImportSource(idempotency_key="different-zone", source_id="dialog", messages=[{**message, "time_zone": "Europe/Paris"}])
    with pytest.raises(source.SourceError, match="recorded timezone"):
        await source.import_source(temporal_user, "__root__", conflicting)


@pytest.mark.asyncio
async def test_content_candidates_rank_supported_dates_without_dropping_unknown_or_old_records(temporal_user, monkeypatch):
    async def embedding(_, texts, **kwargs):
        return Promise.resolve(np.ones((len(texts), CONFIG.embedding_dim)))
    monkeypatch.setattr(event_gist, "get_embedding", embedding)
    monkeypatch.setattr(event, "get_embedding", embedding)
    with Session.begin() as session:
        for sid, event_time in [("expected-2025", period()), ("other-2026", period("2026-04-01", "2026-04-30")), ("unknown", None)]:
            evidence = {"fact_id": str(uuid4()), "blob_id": str(uuid4()), "content": "Kyoto hotel stay",
                        "topic": "life_event", "sub_topic": "travel", "support_groups": [["1"]],
                        "event_time": event_time, "source_messages": []}
            record = UserEvent(user_id=temporal_user, project_id="__root__", embedding=np.ones(CONFIG.embedding_dim),
                event_data={"event_tip": "Kyoto hotel stay", "source_id": sid, "evidence": [evidence]})
            session.add(record)
            session.flush()
            gist = UserEventGist(user_id=temporal_user, project_id="__root__", event_id=record.id,
                embedding=np.ones(CONFIG.embedding_dim), gist_data={"content": "Kyoto hotel stay", "source_id": sid, "event_time": event_time})
            gist.created_at = datetime(2020, 1, 1, tzinfo=timezone.utc)
            session.add(gist)
    ranked = await event_gist.search_user_event_gists(temporal_user, "__root__", "京都酒店2025-04", topk=3, time_range_in_days=1)
    assert ranked.ok()
    assert ranked.data().gists[0].gist_data.source_id == "expected-2025"
    assert {g.gist_data.source_id for g in ranked.data().gists} == {"expected-2025", "other-2026", "unknown"}
    hybrid = await event.hybrid_search_user_events(temporal_user, "__root__", "Kyoto hotel 2025-04", limit=3)
    assert hybrid.ok() and hybrid.data().events[0].source_id == "expected-2025"
    assert {e.source_id for e in hybrid.data().events} == {"expected-2025", "other-2026", "unknown"}
    from memoia_server.utils import get_encoded_tokens
    cost = len(get_encoded_tokens(render_gist(ranked.data().gists[0].gist_data)))
    bounded = await event_gist.truncate_event_gists(ranked.data(), cost)
    assert len(bounded.data().gists) == 1
    assert len(get_encoded_tokens(render_gist(bounded.data().gists[0].gist_data))) <= cost
