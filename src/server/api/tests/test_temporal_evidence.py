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
from memoia_server.controllers import source, user, event
from memoia_server.connectors import Session
from memoia_server.models.utils import Promise
from memoia_server.env import CONFIG
from memoia_server.temporal import supported_event_time, render_gist, source_observations
from memoia_server.llms import embeddings


def period(start="2025-04-01", end="2025-04-30", precision="month", expression="去年四月", mid="1"):
    return {"start": start, "end": end, "precision": precision,
            "evidence": [{"message_id": mid, "expression": expression}]}


@pytest.mark.asyncio
@pytest.mark.parametrize("event_time, label", [
    (None, None),
    (period(None, None, "unknown", "那时候"), None),
    (period("2026-01-01", "2026-12-31", "year"), "2026; precision: year"),
    (period(), "2025-04; precision: month"),
    (period("2024-02-01", "2024-02-29", "month"), "2024-02; precision: month"),
    (period("2026-04-03", "2026-04-03", "day"), "2026-04-03; precision: day"),
    (period("2026-04-03", "2026-06-15", "range"), "2026-04-03 to 2026-06-15; precision: range"),
])
async def test_embedding_input_contains_only_fact_and_supported_event_time(monkeypatch, event_time, label):
    factory = AsyncMock(return_value=np.ones((1, CONFIG.embedding_dim)))
    monkeypatch.setitem(embeddings.FACTORIES, CONFIG.embedding_provider, factory)
    monkeypatch.setattr(CONFIG, "enable_event_embedding", True)
    fact = {"content": "Kyoto hotel stay", "event_time": event_time,
            "occurred_at": "2026-10-06T00:00:00Z", "source_id": "private-source"}
    before = json.dumps(fact, sort_keys=True)
    content, vectors = await source._event_vectors("__root__", [fact])
    text = "Kyoto hotel stay" if label is None else f"Kyoto hotel stay\n[Event time: {label}]"
    assert content == f"- {text}"
    factory.assert_awaited_once_with(CONFIG.embedding_model, [text], "document")
    assert len(vectors) == 1
    assert json.dumps(fact, sort_keys=True) == before
    assert "2026-10-06" not in content and "private-source" not in content


@pytest.mark.asyncio
async def test_embedding_disabled_retains_supported_time_for_lexical_search(monkeypatch):
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
    factory = AsyncMock()
    monkeypatch.setattr(source, "get_embedding", factory)
    content, vectors = await source._event_vectors("__root__", [{"content": "Kyoto hotel", "event_time": period()}])
    assert content == "- Kyoto hotel\n[Event time: 2025-04; precision: month]"
    assert vectors == [None]
    factory.assert_not_awaited()


@pytest.mark.asyncio
async def test_time_marker_uses_complete_embedding_input_budget_without_truncation(monkeypatch):
    from memoia_server.utils import get_encoded_tokens
    monkeypatch.setattr(CONFIG, "enable_event_embedding", True)
    monkeypatch.setattr(CONFIG, "embedding_max_token_size", len(get_encoded_tokens("- Kyoto")))
    factory = AsyncMock(return_value=np.ones((1, CONFIG.embedding_dim)))
    monkeypatch.setitem(embeddings.FACTORIES, CONFIG.embedding_provider, factory)
    with pytest.raises(source.SourceError) as result:
        await source._event_vectors("__root__", [{"content": "Kyoto", "event_time": period()}])
    assert result.value.code == "embedding_input_too_long"
    factory.assert_not_awaited()


def test_calendar_precision_and_unknown_are_not_invented_dates():
    assert EventTime.model_validate(period()).precision == "month"
    assert EventTime.model_validate(period(None, None, "unknown", "那时候")).start is None
    for value in [period(end="2025-04-29"), period(start="2025-04-20"),
                  period(precision="day"), period(precision="unknown")]:
        with pytest.raises(ValidationError):
            EventTime.model_validate(value)
    with pytest.raises(ValidationError):
        SourceMessage(message_id="1", role="user", content="hi", occurred_at=datetime.now(timezone.utc), time_zone="fake/zone")


def test_withdrawn_time_anchor_does_not_survive_independent_untimed_support():
    assert supported_event_time(period(), [["1", "2"]]) is not None
    assert supported_event_time(period(), [["2"]]) is None


@pytest.mark.asyncio
async def test_extraction_contract_keeps_undated_content_support_without_requiring_time_support(monkeypatch):
    body = ImportSource(idempotency_key="independent", source_id="visit", messages=[
        {"message_id": "d", "role": "user", "content": "In May 2024 I visited Bluebird Cafe in Lisbon",
         "occurred_at": "2026-10-03T00:00:00Z", "time_zone": "Asia/Shanghai"},
        {"message_id": "u", "role": "user", "content": "I have visited Bluebird Cafe in Lisbon once",
         "occurred_at": "2026-10-03T00:05:00Z", "time_zone": "Asia/Shanghai"}])
    output = {"facts": [{"content": "Visited Bluebird Cafe in Lisbon", "topic": "life_event", "sub_topic": "travel",
        "support_groups": [["d"], ["u"]],
        "event_time": period("2024-05-01", "2024-05-31", "month", "May 2024", "d")}], "event_tags": []}
    monkeypatch.setattr(source, "openai_complete", AsyncMock(return_value=json.dumps(output)))
    monkeypatch.setattr(source, "record_completion_usage", AsyncMock())
    extracted = await source.extract_source(body)
    fact = extracted.facts[0]
    assert fact["support_groups"] == [["d"], ["u"]]
    assert fact["event_time"]["evidence"] == [{"message_id": "d", "expression": "May 2024"}]
    remaining = source.retained_groups(fact["support_groups"], {"d"})
    assert remaining == [["u"]]
    assert supported_event_time(fact["event_time"], remaining) is None


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
@pytest.mark.parametrize("fail_rebuild", [False, True])
async def test_storage_read_search_and_retraction_keep_separate_time_evidence(temporal_user, monkeypatch, fail_rebuild):
    async def extract(body, **kwargs):
        return source.ExtractedSource([{"id": uuid4(), "content": "Stayed at Sakura Hotel in Kyoto",
            "topic": "life_event", "sub_topic": "travel", "support_groups": [["1"], ["2"]],
            "occurred_at": body.messages[0].occurred_at, "event_time": period()}], [])
    async def reconcile(facts, **kwargs):
        return source.Reconciliation(decisions=[source.FactDecision(fact_id=f["id"], include=True) for f in facts],
            profiles=[source.DerivedProfile(content=f["content"], topic=f["topic"], sub_topic=f["sub_topic"], fact_ids=[f["id"]]) for f in facts])
    document_inputs = []
    fail_next = False
    async def embedding(_, texts, **kwargs):
        nonlocal fail_next
        if kwargs.get("phase") != "query":
            document_inputs.append(list(texts))
            if fail_next:
                fail_next = False
                return Promise.reject(503, "Controlled embedding failure")
        return Promise.resolve(np.ones((len(texts), CONFIG.embedding_dim)))
    monkeypatch.setattr(CONFIG, "enable_event_embedding", True)
    monkeypatch.setattr(source, "extract_source", extract)
    monkeypatch.setattr(source, "reconcile_facts", reconcile)
    monkeypatch.setattr(source, "get_embedding", embedding)
    monkeypatch.setattr(event, "get_embedding", embedding)
    monkeypatch.setattr(source, "_structured", AsyncMock(return_value=source.EventTagging(event_tags=[])))
    body = ImportSource(idempotency_key="temporal", source_id="dialog", messages=[
        {"message_id": "1", "role": "user", "content": "去年四月住京都樱花酒店", "occurred_at": "2026-10-03T00:00:00Z", "time_zone": "Asia/Shanghai"},
        {"message_id": "2", "role": "user", "content": "我住过京都樱花酒店", "occurred_at": "2026-10-03T00:05:00Z", "time_zone": "Asia/Shanghai"}])
    first = await source.import_source(temporal_user, "__root__", body)
    assert first.status == "completed"
    assert await source.import_source(temporal_user, "__root__", body) == first
    assert document_inputs == [[
        "Stayed at Sakura Hotel in Kyoto\n[Event time: 2025-04; precision: month]",
    ]]
    evidence = source.get_source(temporal_user, "__root__", source_id="dialog").evidence[0]
    assert evidence.event_time.start == date(2025, 4, 1)
    assert evidence.source_messages[0].recorded_at.year == 2026
    with Session.begin() as session:
        stored = session.execute(select(memory_facts).where(memory_facts.c.user_id == temporal_user)).mappings().one()
        assert stored["event_time"]["precision"] == "month"
        assert stored["content"] == "Stayed at Sakura Hotel in Kyoto"
        derived = session.query(UserEvent).filter_by(user_id=temporal_user, project_id="__root__").one()
        assert derived.event_data["event_tip"] == "- Stayed at Sakura Hotel in Kyoto\n[Event time: 2025-04; precision: month]"
        assert session.query(UserEventGist).filter_by(user_id=temporal_user, project_id="__root__").one().gist_data["content"] == stored["content"]
        # An old recording timestamp must not exclude a relevant undated/dated event.
        session.execute(update(UserEvent).where(UserEvent.user_id == temporal_user).values(created_at=datetime(2020, 1, 1, tzinfo=timezone.utc)))
    found = await event.hybrid_search_user_events(temporal_user, "__root__", "Kyoto 2025-04")
    assert found.ok() and found.data().events[0].evidence[0].event_time.precision == "month"
    assert "去年四月" in str(found.data().events[0].evidence[0].event_time)
    with monkeypatch.context() as context:
        context.setattr(CONFIG, "enable_event_embedding", False)
        lexical = await event.hybrid_search_user_events(temporal_user, "__root__", "2025-04")
        assert lexical.ok() and [e.source_id for e in lexical.data().events] == ["dialog"]
    deletion = DeleteMessages(idempotency_key="withdraw", message_ids=["1"])
    if fail_rebuild:
        fail_next = True
        with pytest.raises(source.SourceError) as error:
            await source.delete_messages(temporal_user, "__root__", "dialog", deletion)
        assert error.value.code == "embedding_unavailable" and error.value.retryable
        failed = source.get_operation(temporal_user, "__root__", key="withdraw")
        assert failed.status == "failed"
        with Session() as session:
            assert session.query(UserEvent).filter_by(user_id=temporal_user, project_id="__root__").count() == 0
            assert session.query(UserEventGist).filter_by(user_id=temporal_user, project_id="__root__").count() == 0
        assert (await event.hybrid_search_user_events(temporal_user, "__root__", "Kyoto")).data().events == []
        deleted = await source.retry_operation(temporal_user, "__root__", failed.operation_id)
        assert deleted.operation_id == failed.operation_id
    else:
        deleted = await source.delete_messages(temporal_user, "__root__", "dialog", deletion)
    assert deleted.status == "completed"
    remaining = source.get_source(temporal_user, "__root__", source_id="dialog").evidence[0]
    assert remaining.support_groups == [["2"]] and remaining.event_time is None
    assert [m.message_id for m in remaining.source_messages] == ["2"]
    assert document_inputs[1:] == [["Stayed at Sakura Hotel in Kyoto"]] * (2 if fail_rebuild else 1)
    with Session() as session:
        derived = session.query(UserEvent).filter_by(user_id=temporal_user, project_id="__root__").one()
        assert derived.event_data["event_tip"] == "- Stayed at Sakura Hotel in Kyoto"
        assert derived.event_data["evidence"][0]["event_time"] is None
        gist = session.query(UserEventGist).filter_by(event_id=derived.id, project_id="__root__").one()
        assert gist.gist_data["search_text"] == "Stayed at Sakura Hotel in Kyoto"
        assert derived.embedding is None
    assert await source.delete_messages(temporal_user, "__root__", "dialog", deletion) == deleted
    assert len(document_inputs) == (3 if fail_rebuild else 2)


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
@pytest.mark.parametrize("query", [
    "京都酒店2026-04", "不是2026-04，是2026-05的京都酒店", "2026-04之前的京都酒店",
    "2026-04之后的京都酒店", "2026-04至2026-06的京都酒店",
])
async def test_dates_do_not_add_scores_to_content_ranking_or_drop_unknown_old_records(temporal_user, monkeypatch, query):
    query_vector = np.zeros(CONFIG.embedding_dim)
    query_vector[0] = 1
    async def embedding(_, texts, **kwargs):
        return Promise.resolve(np.tile(query_vector, (len(texts), 1)))
    monkeypatch.setattr(event, "get_embedding", embedding)
    with Session.begin() as session:
        for sid, event_time, similarity in [
            ("unknown", None, 1),
            ("other-month", period("2026-05-01", "2026-05-31"), .99),
            ("matching-month", period("2026-04-01", "2026-04-30"), .98),
            ("year-only", period("2026-01-01", "2026-12-31", "year"), .975),
        ]:
            vector = np.zeros(CONFIG.embedding_dim)
            vector[:2] = [similarity, np.sqrt(1 - similarity ** 2)]
            evidence = {"fact_id": str(uuid4()), "blob_id": str(uuid4()), "content": "Kyoto hotel stay",
                        "topic": "life_event", "sub_topic": "travel", "support_groups": [["1"]],
                        "event_time": event_time, "source_messages": []}
            record = UserEvent(user_id=temporal_user, project_id="__root__", embedding=vector,
                event_data={"event_tip": "Kyoto hotel stay", "source_id": sid, "evidence": [evidence]})
            session.add(record)
            session.flush()
            gist = UserEventGist(user_id=temporal_user, project_id="__root__", event_id=record.id,
                embedding=vector, gist_data={"content": "Kyoto hotel stay", "source_id": sid, "event_time": event_time})
            record.created_at = datetime(2020, 1, 1, tzinfo=timezone.utc)
            session.add(gist)
    expected = ["unknown", "other-month", "matching-month", "year-only"]
    hybrid = await event.hybrid_search_user_events(temporal_user, "__root__", query, limit=4)
    assert hybrid.ok()
    assert [e.source_id for e in hybrid.data().events] == expected
    assert [e.score for e in hybrid.data().events] == pytest.approx([1 / 61, 1 / 62, 1 / 63, 1 / 64])
