"""Transient image inputs: wire, identity and body-free durable provenance."""
import json
import asyncio
from xml.etree import ElementTree
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import httpx
import pytest
from openai import AsyncOpenAI
from pydantic import ValidationError
from sqlalchemy import delete, insert, select, update

from memoia_server.controllers import source
from memoia_server.connectors import Session
from memoia_server.env import CONFIG
from memoia_server.llms import openai_model_llm
from memoia_server.models.database import User
from memoia_server.models.source import (
    SourceMessage, SourceObservation, memory_sources, memory_blobs,
    memory_messages, memory_operations, memory_facts,
)
from memoia_server.temporal import source_observations

IMAGE = {"url": "https://images.example.com/user/original.png", "mimeType": "image/png",
         "width": 100, "height": 80, "byteSize": 1234}
BASE = {"message_id": "m1", "role": "user", "content": "", "occurred_at": "2026-01-01T00:00:00Z"}


def image_request(key="image-import", image=None):
    return source.ImportSource.model_validate({"idempotency_key": key, "source_id": "dialog-image",
        "messages": [{**BASE, "images": [image or IMAGE]}]})


def extracted(content="The user shared a picture of a bicycle."):
    return source.MessageExtraction.model_validate({"messages": [{"message_id": "m1", "facts": [{
        "content": content, "subject": "the user", "reporter": "the user", "certainty": "asserted",
        "any_of": [{"all_of": ["m1"]}], "fact_time": None}]}]})


def test_image_identity_is_hashed_but_not_returned_as_evidence():
    message = image_request().messages[0]
    other = image_request(image={**IMAGE, "url": IMAGE["url"] + "2"}).messages[0]
    assert source._message_hash(message) != source._message_hash(other)
    plain = SourceMessage.model_validate({**BASE, "content": "A bicycle"})
    assert source._message_hash(plain) == source._hash({"role": "user", "content": "A bicycle",
        "occurred_at": "2026-01-01T00:00:00+00:00"})
    evidence = source_observations([["m1"]], [{**BASE, "images": [IMAGE]}])
    assert evidence == [{"message_id": "m1", "recorded_at": BASE["occurred_at"], "time_zone": None}]
    assert "images" not in memory_messages.c
    with pytest.raises(ValidationError):
        SourceObservation.model_validate({**evidence[0], "images": [IMAGE]})
    payload = image_request().model_dump(mode="json")
    stored = source._stored_import_input(payload)
    assert stored["messages"][0]["image_count"] == 1
    assert IMAGE["url"] not in json.dumps(stored)
    assert payload["messages"][0]["images"][0]["url"] == IMAGE["url"]


@pytest.mark.parametrize("patch", [
    {"url": "http://127.0.0.1/a"}, {"url": "https://localhost/a"},
    {"url": "https://[::1]/a"}, {"url": "https://x:y@example.com/a"},
    {"url": "https://example.com/a#frag"}, {"url": "https://example.com/a\nprivate"},
    {"url": "data:image/png;base64,AAA"}, {"byteSize": 10485761},
    {"mimeType": "image/svg+xml"}, {"width": 0}, {"height": True},
])
def test_image_rejects_invalid_declared_attachment(patch):
    with pytest.raises(ValidationError):
        image_request(image={**IMAGE, **patch})


def test_image_input_is_bounded_and_empty_text_requires_an_image():
    with pytest.raises(ValidationError):
        SourceMessage.model_validate(BASE)
    with pytest.raises(ValidationError):
        SourceMessage.model_validate({**BASE, "images": [IMAGE, IMAGE]})
    for mime in ("image/jpeg", "image/png", "image/webp", "image/gif"):
        assert image_request(image={**IMAGE, "mimeType": mime, "byteSize": 10 * 1024 * 1024})


@pytest.mark.asyncio
async def test_image_is_sent_as_native_input_and_not_copied_into_developer_material(monkeypatch):
    calls = []
    def respond(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, json={"id": "r", "object": "response", "created_at": 0,
            "model": "gpt-6-luna", "status": "completed", "error": None,
            "output": [{"id": "m", "type": "message", "role": "assistant", "status": "completed",
                        "content": [{"type": "output_text", "text": extracted().model_dump_json(), "annotations": []}]}]})
    client = AsyncOpenAI(api_key="fixture", max_retries=0,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)))
    monkeypatch.setattr(openai_model_llm, "get_openai_async_client_instance", lambda: client)
    monkeypatch.setattr(source, "record_completion_usage", AsyncMock())
    budget = Mock(wraps=source.validate_budget)
    monkeypatch.setattr(source, "validate_budget", budget)
    try:
        result = await source.extract_source(image_request())
        assert result.facts[0]["support_groups"] == [["m1"]]
        assert len(calls) == 1 and calls[0]["store"] is False
        inputs = calls[0]["input"]
        assert inputs[-1] == {"role": "user", "content": [
            {"type": "input_text", "text": 'Source image: {"message_id": "m1"}'},
            {"type": "input_image", "image_url": IMAGE["url"], "detail": "auto"}]}
        assert IMAGE["url"] not in json.dumps(inputs[:-1])
        material = json.loads(ElementTree.fromstring(inputs[-2]["content"][0]["text"]).text)
        assert material["messages"][0]["image_count"] == 1
        budget.assert_called_once_with(inputs[-2]["content"][0]["text"], source.EXTRACT_SYSTEM,
                                       source_text="", image_count=1)
        assert calls[0]["text"]["format"]["type"] == "json_schema"
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("saved_candidate", [False, True])
@pytest.mark.parametrize("query", ["", "?public=1"])
async def test_model_url_echo_is_rejected_before_candidate_or_embedding(monkeypatch, saved_candidate, query):
    request = image_request(image={**IMAGE, "url": IMAGE["url"] + query})
    result = extracted("The bicycle is pictured at " + IMAGE["url"])
    model = AsyncMock(return_value=result)
    monkeypatch.setattr(source, "_structured", model)
    save = AsyncMock()
    canonical = source._normalize_extraction(result, request).model_dump(mode="json")
    with pytest.raises(source.SourceError) as error:
        await source.extract_source(request, candidate=canonical if saved_candidate else None,
                                    save_candidate=save)
    assert error.value.code == "invalid_model_output" and IMAGE["url"] not in str(error.value)
    save.assert_not_called()
    assert model.await_count == int(not saved_candidate)


@pytest.mark.asyncio
async def test_one_image_and_text_fit_separate_text_and_context_budgets(monkeypatch):
    model = AsyncMock(return_value=extracted())
    monkeypatch.setattr(source, "_structured", model)
    monkeypatch.setattr(CONFIG, "source_max_input_tokens", 16384)
    monkeypatch.setattr(CONFIG, "source_context_window_tokens", 131072)
    body = image_request()
    body.messages[0].content = "The picture shows my bicycle. " * 1000
    result = await source.extract_source(body)
    assert len(result.facts) == 1 and model.await_count == 1
    assert len(model.call_args.kwargs["images"]) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("overflow", ["text", "images"])
@pytest.mark.parametrize("saved_candidate", [False, True])
async def test_effective_input_overflow_rejects_before_model_or_candidate(monkeypatch, overflow, saved_candidate):
    model, save = AsyncMock(), AsyncMock()
    monkeypatch.setattr(source, "_structured", model)
    monkeypatch.setattr(CONFIG, "source_context_window_tokens", 131072)
    body = image_request()
    if overflow == "text":
        monkeypatch.setattr(CONFIG, "source_max_input_tokens", 1)
        body.messages[0].content = "This complete message exceeds the text quota."
    else:
        body.messages = [SourceMessage.model_validate({**BASE, "message_id": str(i), "images": [IMAGE]}) for i in range(8)]
    with pytest.raises(source.SourceError) as error:
        await source.extract_source(body, save_candidate=save, candidate={"facts": []} if saved_candidate else None)
    assert error.value.code == "input_too_long" and error.value.status == 413
    model.assert_not_called()
    save.assert_not_called()


@pytest.fixture
def image_uid(db_env):
    uid = uuid4()
    with Session.begin() as session:
        session.execute(insert(User.__table__).values(id=uid, project_id="__root__", additional_fields={}))
    try:
        yield uid
    finally:
        with Session.begin() as session:
            session.execute(delete(User).where(User.id == uid, User.project_id == "__root__"))


@pytest.fixture
def image_model(monkeypatch):
    model = AsyncMock(return_value=extracted())
    monkeypatch.setattr(source, "_structured", model)
    monkeypatch.setattr(CONFIG, "enable_event_embedding", False)
    return model


@pytest.mark.asyncio
async def test_integration_image_success_replay_conflict_deletion_and_late_import(image_uid, image_model):
    body = image_request()
    first = await source.import_source(image_uid, "__root__", body)
    assert first.status == "completed" and len(first.result.fact_ids) == 1
    assert await source.import_source(image_uid, "__root__", body) == first
    assert image_model.await_count == 1
    with Session() as session:
        for table in (memory_sources, memory_blobs, memory_messages, memory_operations, memory_facts):
            rows = [dict(row) for row in session.execute(select(table).where(
                table.c.user_id == image_uid, table.c.project_id == "__root__")).mappings()]
            assert IMAGE["url"] not in json.dumps(rows, default=str)
        stored = session.execute(select(memory_messages).where(memory_messages.c.user_id == image_uid)).mappings().one()
        assert stored["content_hash"] == source._message_hash(body.messages[0])
        assert stored["processed"] is True
    provenance = source.get_source(image_uid, "__root__", source_id="dialog-image")
    assert provenance.evidence[0].source_messages[0].message_id == "m1"
    assert IMAGE["url"] not in provenance.model_dump_json()
    with pytest.raises(source.SourceError) as conflict:
        await source.import_source(image_uid, "__root__", image_request("changed-image", {**IMAGE, "url": IMAGE["url"] + "2"}))
    assert conflict.value.code == "message_conflict"
    deletion = await source.delete_messages(image_uid, "__root__", body.source_id,
        source.DeleteMessages(idempotency_key="delete-image", message_ids=["m1"]))
    assert deletion.status == "completed"
    late = await source.import_source(image_uid, "__root__", image_request("late-image"))
    assert late.status == "completed" and not late.result.fact_ids
    assert image_model.await_count == 1
    assert not source.get_source(image_uid, "__root__", source_id="dialog-image").evidence


@pytest.mark.asyncio
async def test_integration_failed_embedding_reuses_candidate_then_clears_image_input(image_uid, image_model, monkeypatch):
    vectors = AsyncMock(side_effect=[source.SourceError("embedding_unavailable", "Unavailable", 503, True), [None]])
    monkeypatch.setattr(source, "_fact_vectors", vectors)
    with pytest.raises(source.SourceError):
        await source.import_source(image_uid, "__root__", image_request())
    failed = source.get_operation(image_uid, "__root__", key="image-import")
    with Session() as session:
        row = session.execute(select(memory_operations).where(memory_operations.c.id == failed.operation_id)).mappings().one()
        assert row["request"]["messages"][0]["image_count"] == 1
        assert IMAGE["url"] not in json.dumps(dict(row), default=str)
        assert IMAGE["url"] not in json.dumps(row["request"][source._EXTRACTION_CANDIDATE])
        deadline = row["input_expires_at"]
    with pytest.raises(source.SourceError) as missing:
        await source.retry_operation(image_uid, "__root__", failed.operation_id)
    assert missing.value.code == "input_required"
    assert image_model.await_count == 1 and vectors.await_count == 1
    completed = await source.import_source(image_uid, "__root__", image_request())
    assert completed.operation_id == failed.operation_id
    assert completed.status == "completed" and image_model.await_count == 1
    assert vectors.await_count == 2 and IMAGE["url"] not in repr(vectors.call_args_list)
    with Session() as session:
        row = session.execute(select(memory_operations).where(memory_operations.c.id == failed.operation_id)).mappings().one()
        assert row["input_expires_at"] is None and IMAGE["url"] not in json.dumps(row["request"])
    assert deadline > datetime.now(timezone.utc)


@pytest.mark.asyncio
@pytest.mark.parametrize("published_input_required", [False, True])
async def test_integration_failed_image_input_expires_and_original_receipt_requires_resupply(image_uid, image_model, published_input_required):
    image_model.side_effect = source.SourceError("model_unavailable", "Unavailable", 503, True)
    with pytest.raises(source.SourceError):
        await source.import_source(image_uid, "__root__", image_request())
    failed = source.get_operation(image_uid, "__root__", key="image-import")
    with Session.begin() as session:
        session.execute(update(memory_operations).where(memory_operations.c.id == failed.operation_id)
                        .values(input_expires_at=datetime.now(timezone.utc) - timedelta(seconds=1),
                                **({"error": {"code": "input_required", "retryable": False}}
                                   if published_input_required else {})))
    source.purge_expired_inputs()
    with Session() as session:
        row = session.execute(select(memory_operations).where(memory_operations.c.id == failed.operation_id)).mappings().one()
        assert IMAGE["url"] not in json.dumps(row["request"])
        assert row["status"] == "failed" and row["request_hash"]
    with pytest.raises(source.SourceError) as expired:
        await source.retry_operation(image_uid, "__root__", failed.operation_id)
    assert expired.value.code == "input_required" and image_model.await_count == 1
    image_model.side_effect = None
    recovered = await source.import_source(image_uid, "__root__", image_request())
    assert recovered.status == "completed" and recovered.operation_id == failed.operation_id
    assert image_model.await_count == 2


@pytest.mark.asyncio
async def test_integration_image_concurrent_same_key_uses_original_processing_handle(image_uid, image_model):
    entered, release = asyncio.Event(), asyncio.Event()
    async def waiting(*args, **kwargs):
        entered.set()
        await release.wait()
        return extracted()
    image_model.side_effect = waiting
    first = asyncio.create_task(source.import_source(image_uid, "__root__", image_request()))
    try:
        await asyncio.wait_for(entered.wait(), 5)
        pending = source.get_operation(image_uid, "__root__", key="image-import")
        assert pending.status == "processing"
        with Session() as session:
            row = session.execute(select(memory_operations).where(memory_operations.c.id == pending.operation_id)).mappings().one()
            assert row["request"]["messages"][0]["image_count"] == 1
            assert IMAGE["url"] not in json.dumps(dict(row), default=str)
        duplicate = await source.import_source(image_uid, "__root__", image_request())
        assert duplicate.operation_id == pending.operation_id and duplicate.status == "processing"
        assert image_model.await_count == 1
    finally:
        release.set()
        completed = await first
    assert completed.status == "completed"
    assert await source.import_source(image_uid, "__root__", image_request()) == completed
    assert image_model.await_count == 1


@pytest.mark.asyncio
async def test_integration_image_commit_receipt_loss_is_read_back_without_reextraction(image_uid, image_model, monkeypatch):
    original = source.get_operation
    def lost_receipt(*args, **kwargs):
        raise TimeoutError("Synthetic lost acknowledgement after commit")
    monkeypatch.setattr(source, "get_operation", lost_receipt)
    with pytest.raises(TimeoutError):
        await source.import_source(image_uid, "__root__", image_request())
    receipt = original(image_uid, "__root__", key="image-import")
    assert receipt.status == "completed"
    assert await source.import_source(image_uid, "__root__", image_request()) == receipt
    assert image_model.await_count == 1


@pytest.mark.asyncio
async def test_integration_permanent_image_error_is_not_replayed_by_resupply(image_uid, image_model):
    image_model.side_effect = source.SourceError("model_configuration_rejected", "Rejected", 503, False)
    with pytest.raises(source.SourceError):
        await source.import_source(image_uid, "__root__", image_request())
    receipt = source.get_operation(image_uid, "__root__", key="image-import")
    assert await source.retry_operation(image_uid, "__root__", receipt.operation_id) == receipt
    assert await source.import_source(image_uid, "__root__", image_request()) == receipt
    assert image_model.await_count == 1


@pytest.mark.asyncio
async def test_integration_image_http_contract_and_private_validation_error(image_uid, image_model):
    from api import app
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test",
                                 headers={"Authorization": "Bearer secret"}) as client:
        response = await client.post(f"/api/users/{image_uid}/blobs", json=image_request().model_dump(mode="json"))
        assert response.status_code == 200 and response.json()["status"] == "completed"
        result = await client.get(f"/api/users/{image_uid}/sources/dialog-image")
        assert result.status_code == 200 and IMAGE["url"] not in result.text
        assert result.json()["evidence"][0]["source_messages"][0]["message_id"] == "m1"
        invalid = image_request("invalid-image").model_dump(mode="json")
        invalid["messages"][0]["images"][0]["url"] = "https://PRIVATE_IMAGE_CREDENTIAL@example.com/image.png"
        result = await client.post(f"/api/users/{image_uid}/blobs", json=invalid)
        assert result.status_code == 422 and "PRIVATE_IMAGE_CREDENTIAL" not in result.text
        assert image_model.await_count == 1


@pytest.mark.asyncio
async def test_integration_image_context_overflow_cannot_commit_facts(image_uid, image_model, monkeypatch):
    monkeypatch.setattr(CONFIG, "source_context_window_tokens", 131072)
    body = image_request()
    body.messages = [SourceMessage.model_validate({**BASE, "message_id": str(i), "images": [IMAGE]}) for i in range(8)]
    with pytest.raises(source.SourceError) as error:
        await source.import_source(image_uid, "__root__", body)
    assert error.value.code == "input_too_long"
    image_model.assert_not_called()
    with Session() as session:
        assert session.execute(select(memory_facts).where(memory_facts.c.user_id == image_uid)).first() is None
        row = session.execute(select(memory_operations).where(memory_operations.c.user_id == image_uid)).mappings().one()
        assert row["status"] == "failed" and IMAGE["url"] not in json.dumps(dict(row), default=str)


@pytest.mark.asyncio
async def test_integration_budget_uses_only_effective_model_material(image_uid, image_model, monkeypatch):
    body = image_request()
    body.messages.insert(0, SourceMessage.model_validate({**BASE, "message_id": "deleted-image",
        "content": "Already deleted context. " * 7000, "images": [IMAGE]}))
    body.metadata = {"caller_note": "Not model input. " * 2000}
    await source.delete_messages(image_uid, "__root__", body.source_id,
        source.DeleteMessages(idempotency_key="delete-before-import", message_ids=["deleted-image"]))
    monkeypatch.setattr(CONFIG, "source_context_window_tokens", 54000)
    monkeypatch.setattr(CONFIG, "source_output_reserve_tokens", 32768)
    budget = Mock(wraps=source.validate_budget)
    monkeypatch.setattr(source, "validate_budget", budget)

    result = await source.import_source(image_uid, "__root__", body)

    assert result.status == "completed" and len(result.result.fact_ids) == 1
    assert image_model.await_count == budget.call_count == 1
    material = json.loads(ElementTree.fromstring(budget.call_args.args[0]).text)
    assert [message["message_id"] for message in material["messages"]] == ["m1"]
    assert "caller_note" not in budget.call_args.args[0] and IMAGE["url"] not in budget.call_args.args[0]
    assert budget.call_args.kwargs == {"source_text": "", "image_count": 1}
    assert len(image_model.call_args.kwargs["images"]) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("deleted", [False, True])
async def test_integration_noop_images_skip_budget_model_and_embedding(image_uid, image_model, monkeypatch, deleted):
    body = image_request()
    await source.import_source(image_uid, "__root__", body)
    if deleted:
        await source.delete_messages(image_uid, "__root__", body.source_id,
            source.DeleteMessages(idempotency_key="delete-image", message_ids=["m1"]))
    monkeypatch.setattr(CONFIG, "source_context_window_tokens", 1)
    budget, embedding = Mock(wraps=source.validate_budget), AsyncMock()
    monkeypatch.setattr(source, "validate_budget", budget)
    monkeypatch.setattr(source, "get_embedding", embedding)

    result = await source.import_source(image_uid, "__root__", body.model_copy(update={"idempotency_key": "noop-image"}))

    assert result.status == "completed" and result.result.fact_ids == []
    assert image_model.await_count == 1
    budget.assert_not_called()
    embedding.assert_not_awaited()
