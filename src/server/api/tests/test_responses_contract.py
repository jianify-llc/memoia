"""One-shot Responses wire and failure contract, using the locked SDK only."""
import asyncio
import json
from unittest.mock import AsyncMock

import httpx
from openai import AsyncOpenAI
import pytest

from memoia_server.controllers import source
from memoia_server.env import CONFIG
from memoia_server.llms import openai_model_llm


def response_body(text='{"facts": []}', **changes):
    return {"id": "resp-fixture", "object": "response", "created_at": 0,
            "model": "gpt-6-luna", "status": "completed", "error": None,
            "incomplete_details": None, "service_tier": "default",
            "output": [{"id": "msg-fixture", "type": "message", "role": "assistant",
                        "status": "completed", "content": [{"type": "output_text", "text": text,
                                                               "annotations": []}]}],
            "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15,
                      "input_tokens_details": {"cached_tokens": 3, "cache_write_tokens": 2},
                      "output_tokens_details": {"reasoning_tokens": 0}}, **changes}


@pytest.fixture
def responses_transport(monkeypatch):
    state = {"calls": [], "body": response_body(), "status": 200}
    def respond(request):
        state["calls"].append(request)
        assert request.url.path == "/v1/responses", "No old protocol fallback"
        return httpx.Response(state["status"], json=state["body"])
    client = AsyncOpenAI(api_key="fixture-only", base_url="https://example.invalid/v1", max_retries=0,
                         http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)))
    monkeypatch.setattr(openai_model_llm, "get_openai_async_client_instance", lambda: client)
    monkeypatch.setattr(CONFIG, "llm_base_url", None)
    monkeypatch.setattr(CONFIG, "llm_prompt_cache_options", None)
    accounting = AsyncMock()
    monkeypatch.setattr(source, "record_completion_usage", accounting)
    return state, client, accounting


@pytest.mark.asyncio
async def test_fact_uses_native_responses_schema_and_fixed_only_cache(responses_transport):
    state, client, accounting = responses_transport
    try:
        assert (await source._structured(source.Extraction, "reference XML", "fixed prompt")).facts == []
        wire = json.loads(state["calls"][0].content)
        assert wire["input"] == [
            {"role": "developer", "content": [{"type": "input_text", "text": "fixed prompt",
                                                 "prompt_cache_breakpoint": {"mode": "explicit"}}]},
            {"role": "developer", "content": [{"type": "input_text", "text": "reference XML"}]},
        ]
        assert wire["text"]["format"] == {"type": "json_schema", "name": "Extraction", "strict": True,
                                           "schema": source.Extraction.model_json_schema()}
        assert wire["prompt_cache_options"] == {"mode": "explicit", "ttl": "30m"}
        assert not {"instructions", "messages", "response_format", "prompt_cache_key"}.intersection(wire)
        assert wire["store"] is False and wire["truncation"] == "disabled"
        assert wire["max_output_tokens"] == CONFIG.source_output_reserve_tokens
        assert wire["service_tier"] == "default" and wire["reasoning"] == {"effort": CONFIG.llm_reasoning_effort, "mode": "standard"}
        assert state["calls"][0].extensions["timeout"] == dict.fromkeys(("connect", "read", "write", "pool"), 120)
        assert accounting.await_count == 1
        assert accounting.await_args.args[1:3] == (10, 5)
        assert accounting.await_args.kwargs["cached_tokens"] == 3
        assert accounting.await_args.kwargs["cache_write_tokens"] == 2
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("changes", [
    {"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}},
    {"status": "failed", "error": {"code": "server_error", "message": "PRIVATE PROVIDER"}},
    {"status": "queued"}, {"output": []},
    {"output": [{"type": "message", "id": "msg", "role": "assistant", "status": "completed",
                 "content": [{"type": "refusal", "refusal": "PRIVATE REFUSAL"}]}]},
    {"output": [{"type": "function_call", "id": "fc", "call_id": "call", "name": "not-a-one-shot-tool",
                 "arguments": "{}", "status": "completed"}]},
])
async def test_responses_failures_record_usage_without_partial_results(responses_transport, changes):
    state, client, accounting = responses_transport
    state["body"] = response_body(**changes)
    try:
        with pytest.raises(source.SourceError) as error:
            await source._structured(source.Extraction, "PRIVATE SOURCE", "fixed prompt")
        assert error.value.code == "model_unavailable" and error.value.retryable
        assert "PRIVATE" not in error.value.message
        assert len(state["calls"]) == 1 and accounting.await_count == 1
        assert accounting.await_args.args[1:3] == (10, 5)
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("text", ["not JSON", '{"facts": [{"content": "PRIVATE CONTENT"}]}'])
async def test_structured_validation_failure_keeps_actual_usage(responses_transport, text):
    state, client, accounting = responses_transport
    state["body"] = response_body(text)
    try:
        with pytest.raises(source.SourceError) as error:
            await source._structured(source.Extraction, "reference", "fixed prompt")
        assert error.value.code == "invalid_model_output" and "PRIVATE" not in error.value.message
        assert len(state["calls"]) == 1 and accounting.await_args.args[1:3] == (10, 5)
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [400, 401, 403, 404])
async def test_response_configuration_failure_stays_permanent(responses_transport, status):
    state, client, accounting = responses_transport
    state.update(status=status, body={"error": {"message": "PRIVATE CREDENTIAL", "type": "invalid_request_error"}})
    try:
        with pytest.raises(source.SourceError) as error:
            await source._structured(source.Extraction, "reference", "fixed prompt")
        assert error.value.code == "model_configuration_rejected" and not error.value.retryable
        assert "PRIVATE" not in error.value.message
        assert len(state["calls"]) == 1 and accounting.await_args.args[1:3] == (None, None)
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_cancelled_one_shot_never_retries_or_reports_completion(monkeypatch):
    entered, cancelled = asyncio.Event(), asyncio.Event()
    requests = []
    async def respond(request):
        requests.append(request)
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
    client = AsyncOpenAI(api_key="fixture-only", base_url="https://example.invalid/v1", max_retries=0,
                         http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)))
    monkeypatch.setattr(openai_model_llm, "get_openai_async_client_instance", lambda: client)
    accounting = AsyncMock()
    task = asyncio.create_task(openai_model_llm.openai_complete("gpt-6-luna", "reference", on_usage=accounting))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert cancelled.is_set() and len(requests) == 1
        accounting.assert_not_awaited()
    finally:
        if not task.done():
            task.cancel()
        await client.close()


@pytest.mark.asyncio
async def test_native_reasoning_and_multiple_text_parts_keep_complete_output(responses_transport):
    state, client, _ = responses_transport
    state["body"]["output"].insert(0, {"type": "reasoning", "id": "reasoning-fixture", "summary": []})
    state["body"]["output"][1]["content"] = [
        {"type": "output_text", "text": '{"facts":', "annotations": []},
        {"type": "output_text", "text": ' []}', "annotations": []},
    ]
    try:
        assert (await source._structured(source.Extraction, "reference", "fixed prompt")).facts == []
        assert len(state["calls"]) == 1
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_text_plus_unexpected_tool_is_not_a_complete_one_shot_result(responses_transport):
    state, client, accounting = responses_transport
    state["body"]["output"].append({"type": "function_call", "id": "fc", "call_id": "call",
        "name": "not-a-one-shot-tool", "arguments": "{}", "status": "completed"})
    try:
        with pytest.raises(source.SourceError) as error:
            await source._structured(source.Extraction, "reference", "fixed prompt")
        assert error.value.code == "model_unavailable" and len(state["calls"]) == 1
        assert accounting.await_args.args[1:3] == (10, 5)
    finally:
        await client.close()
