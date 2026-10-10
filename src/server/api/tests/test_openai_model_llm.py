"""OpenAI 请求契约回归：使用真实 SDK 和本地假 transport，不调用模型。"""

import asyncio
import json
import os
from unittest.mock import AsyncMock

import httpx
import pytest
from openai import AsyncOpenAI

from api import app
from memoia_server import llms
from memoia_server.env import CONFIG
from memoia_server.llms.openai_model_llm import openai_complete
from memoia_server.llms import utils as client_utils
from memoia_server.models.utils import CODE, Promise


@pytest.fixture
def openai_transport(monkeypatch):
    state = {
        "requests": [],
        "status": 200,
        "finish_reason": "stop",
        "content": "answer",
        "refusal": None,
        "choices": True,
        "usage": True,
        "cache_details": None,
        "service_tier": "default",
    }

    def respond(request):
        state["requests"].append(json.loads(request.content))
        if state["status"] != 200:
            return httpx.Response(
                state["status"],
                json={"error": {"message": "mock error", "type": "invalid_request_error"}},
            )
        choice = {
            "index": 0,
            "finish_reason": state["finish_reason"],
            "message": {
                "role": "assistant",
                "content": state["content"],
                "refusal": state["refusal"],
            },
        }
        result = {
            "id": "chatcmpl-test",
            "object": "chat.completion",
            "created": 0,
            "model": "gpt-6-luna",
            "service_tier": state["service_tier"],
            "choices": [choice] if state["choices"] else [],
        }
        if state["usage"]:
            result["usage"] = {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
            }
            if state["cache_details"] is not None:
                result["usage"]["prompt_tokens_details"] = state["cache_details"]
        return httpx.Response(200, json=result)

    client = AsyncOpenAI(
        api_key="mock-key",
        base_url="https://example.invalid/v1",
        max_retries=0,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)),
    )
    monkeypatch.setattr(
        "memoia_server.llms.openai_model_llm.get_openai_async_client_instance",
        lambda: client,
    )
    monkeypatch.setattr(llms, "project_cost_token_billing", AsyncMock(return_value=Promise.resolve(None)))
    monkeypatch.setattr(llms, "capture_int_key", AsyncMock())
    monkeypatch.setattr(CONFIG, "llm_reasoning_effort", "high")
    return state, client


@pytest.mark.asyncio
async def test_accounting_uses_provider_tokens_not_text_estimates(openai_transport):
    _, client = openai_transport
    try:
        result = await llms.llm_complete("__root__", "a short prompt")
        assert result.ok()
        call = llms.project_cost_token_billing.await_args
        assert call.args == ("__root__", 10, 5)
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_one_shot_explicit_cache_excludes_changing_source_input(openai_transport):
    state, client = openai_transport
    try:
        for source in ("private first source", "private second source", "private first source"):
            await openai_complete("gpt-6-luna", source, system_prompt="fixed instructions",
                                  cache_fixed_prompt=True)
        first, second, replay = state["requests"]
        assert first == replay
        assert first["prompt_cache_options"] == second["prompt_cache_options"] == {
            "mode": "explicit", "ttl": "30m"}
        assert first["messages"][0] == second["messages"][0] == {
            "role": "developer", "content": [{"type": "text", "text": "fixed instructions",
                                                   "prompt_cache_breakpoint": {"mode": "explicit"}}]}
        assert first["messages"][1] == {"role": "user", "content": "private first source"}
        assert second["messages"][1] == {"role": "user", "content": "private second source"}
        assert json.dumps(first["messages"]).count("prompt_cache_breakpoint") == 1
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("model,supported", [
    ("gpt-5.6", True), ("gpt-6-luna", True), ("gpt-6-luna-2026-09-22", True),
    ("gpt-6.1-sol", True), ("gpt-5.4", False), ("gpt-4o", False),
    ("custom-project-model", False), ("gpt-6-unknown", False),
])
async def test_fixed_cache_respects_model_capability(openai_transport, model, supported):
    state, client = openai_transport
    try:
        await openai_complete(model, "changing input", system_prompt="fixed instructions",
                              cache_fixed_prompt=True, reasoning_effort="high")
        body = state["requests"][0]
        assert body["model"] == model and body["reasoning_effort"] == "high"
        assert body["messages"][-1] == {"role": "user", "content": "changing input"}
        if supported:
            assert body["prompt_cache_options"] == {"mode": "explicit", "ttl": "30m"}
            assert body["messages"][0]["content"][0]["prompt_cache_breakpoint"] == {"mode": "explicit"}
        else:
            assert "prompt_cache_options" not in body
            assert body["messages"][0] == {"role": "system", "content": "fixed instructions"}
            assert "prompt_cache_breakpoint" not in json.dumps(body)
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["503", "timeout"])
async def test_fact_client_does_not_hide_retries_and_observes_failed_usage(monkeypatch, failure):
    requests, metrics = [], []

    def respond(request):
        requests.append(request)
        if failure == "timeout":
            raise httpx.ReadTimeout("synthetic timeout", request=request)
        return httpx.Response(503, json={"error": {"message": "synthetic failure"},
            "usage": {"prompt_tokens": 10, "completion_tokens": 5,
                      "prompt_tokens_details": {"cached_tokens": 3, "cache_write_tokens": 2}}})

    def new_client(**kwargs):
        return AsyncOpenAI(**kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)))

    monkeypatch.setattr(client_utils, "AsyncOpenAI", new_client)
    monkeypatch.setattr(client_utils, "_global_openai_async_client", None)
    monkeypatch.setattr(CONFIG, "llm_api_key", "mock-key")
    monkeypatch.setattr(CONFIG, "llm_base_url", "https://example.invalid/v1")
    monkeypatch.setattr(CONFIG, "llm_openai_default_query", None)
    monkeypatch.setattr(CONFIG, "llm_openai_default_header", None)
    monkeypatch.setattr(llms, "project_cost_token_billing", AsyncMock(return_value=Promise.resolve(None)))
    monkeypatch.setattr(llms, "capture_int_key", AsyncMock())
    monkeypatch.setattr(llms.telemetry_manager, "increment_counter_metric", lambda *args: metrics.append(args))
    client = client_utils.get_openai_async_client_instance()
    try:
        result = await llms.llm_complete("__root__", "input", usage_kind="fact_extraction")
        assert not result.ok() and result.code() == CODE.SERVICE_UNAVAILABLE
        assert len(requests) == 1
        counts = {name: value for name, value, _ in metrics}
        assert counts[llms.CounterMetricName.LLM_INVOCATIONS] == 1
        if failure == "503":
            llms.project_cost_token_billing.assert_awaited_once_with("__root__", 10, 5)
            assert counts[llms.CounterMetricName.LLM_CACHE_READ_TOKENS] == 3
            assert counts[llms.CounterMetricName.LLM_CACHE_WRITE_TOKENS] == 2
        else:
            llms.project_cost_token_billing.assert_not_awaited()
            assert counts[llms.CounterMetricName.LLM_USAGE_UNKNOWN] == 1
            assert counts[llms.CounterMetricName.LLM_CACHE_USAGE_UNKNOWN] == 1
            assert llms.CounterMetricName.LLM_TOKENS_INPUT not in counts
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_provider_cache_usage_is_scoped_and_logged_without_body(openai_transport, monkeypatch, caplog):
    state, client = openai_transport
    state["cache_details"] = {"cached_tokens": 3, "cache_write_tokens": 2}
    calls, histograms = [], []
    monkeypatch.setattr(llms.telemetry_manager, "increment_counter_metric", lambda *args: calls.append(args))
    monkeypatch.setattr(llms.telemetry_manager, "record_histogram_metric", lambda *args: histograms.append(args))
    try:
        with caplog.at_level("INFO"):
            result = await llms.llm_complete("__root__", "PRIVATE SOURCE", system_prompt="PRIVATE INSTRUCTIONS",
                                              usage_kind="fact_extraction", cache_fixed_prompt=True,
                                              service_tier="default")
        assert result.ok()
        values = {metric: count for metric, count, _ in calls}
        assert values[llms.CounterMetricName.LLM_CACHE_READ_TOKENS] == 3
        assert values[llms.CounterMetricName.LLM_CACHE_WRITE_TOKENS] == 2
        assert values[llms.CounterMetricName.LLM_INVOCATIONS] == 1
        assert llms.CounterMetricName.LLM_CACHE_USAGE_UNKNOWN not in values
        attributes = calls[0][2]
        assert attributes == {"project_id": "__root__", "kind": "fact_extraction", "model": "gpt-6-luna",
                              "service_tier": "default", "requested_service_tier": "default"}
        assert all(item[2] == attributes for item in calls + histograms)
        assert "cache_read=3 cache_write=2" in caplog.text
        assert "PRIVATE SOURCE" not in caplog.text and "PRIVATE INSTRUCTIONS" not in caplog.text
        llms.project_cost_token_billing.assert_awaited_once_with("__root__", 10, 5)
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("details", [None, {"cached_tokens": 3}, {"cached_tokens": 0, "cache_write_tokens": 0}])
async def test_missing_cache_usage_is_unknown_not_zero(openai_transport, monkeypatch, details):
    state, client = openai_transport
    state["cache_details"] = details
    state["service_tier"] = None
    calls = []
    monkeypatch.setattr(llms.telemetry_manager, "increment_counter_metric", lambda *args: calls.append(args))
    try:
        assert (await llms.llm_complete("__root__", "input")).ok()
        values = {metric: count for metric, count, _ in calls}
        if details and "cache_write_tokens" in details:
            assert values[llms.CounterMetricName.LLM_CACHE_READ_TOKENS] == 0
            assert values[llms.CounterMetricName.LLM_CACHE_WRITE_TOKENS] == 0
        else:
            assert values[llms.CounterMetricName.LLM_CACHE_USAGE_UNKNOWN] == 1
            assert llms.CounterMetricName.LLM_CACHE_READ_TOKENS not in values
            assert llms.CounterMetricName.LLM_CACHE_WRITE_TOKENS not in values
        assert all(attributes["service_tier"] == "unknown" for _, _, attributes in calls)
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("read,write", [(True, 0), (-1, 0), (2, "PRIVATE INVALID VALUE"), (8, 3)])
async def test_invalid_cache_counters_do_not_corrupt_memory_or_billing(openai_transport, monkeypatch, caplog, read, write):
    _, client = openai_transport
    calls = []
    monkeypatch.setattr(llms.telemetry_manager, "increment_counter_metric", lambda *args: calls.append(args))
    try:
        await llms.record_completion_usage("__root__", 10, 5, 1, cached_tokens=read, cache_write_tokens=write)
        assert any(metric == llms.CounterMetricName.LLM_CACHE_USAGE_UNKNOWN for metric, _, _ in calls)
        assert not any(metric in (llms.CounterMetricName.LLM_CACHE_READ_TOKENS,
                                  llms.CounterMetricName.LLM_CACHE_WRITE_TOKENS) for metric, _, _ in calls)
        llms.project_cost_token_billing.assert_awaited_once_with("__root__", 10, 5)
        assert "PRIVATE INVALID VALUE" not in caplog.text
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_telemetry_failure_does_not_fail_or_repeat_completion(openai_transport, monkeypatch):
    state, client = openai_transport
    monkeypatch.setattr(llms.telemetry_manager, "increment_counter_metric",
                        lambda *args: (_ for _ in ()).throw(RuntimeError("telemetry unavailable")))
    try:
        assert (await llms.llm_complete("__root__", "input")).ok()
        assert len(state["requests"]) == 1
        llms.project_cost_token_billing.assert_awaited_once_with("__root__", 10, 5)
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_unknown_usage_capture_failure_keeps_result_and_unknown_counters(openai_transport, monkeypatch):
    state, client = openai_transport
    state["usage"] = False
    calls = []
    monkeypatch.setattr(llms, "capture_int_key", AsyncMock(side_effect=RuntimeError("capture unavailable")))
    monkeypatch.setattr(llms.telemetry_manager, "increment_counter_metric", lambda *args: calls.append(args))
    try:
        assert (await llms.llm_complete("__root__", "input")).ok()
        values = {metric: count for metric, count, _ in calls}
        assert values[llms.CounterMetricName.LLM_USAGE_UNKNOWN] == 1
        assert values[llms.CounterMetricName.LLM_CACHE_USAGE_UNKNOWN] == 1
        assert values[llms.CounterMetricName.LLM_INVOCATIONS] == 1
        assert len(state["requests"]) == 1
        llms.project_cost_token_billing.assert_not_awaited()
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_missing_usage_is_unknown_and_does_not_debit(openai_transport, monkeypatch):
    state, client = openai_transport
    state["usage"] = False
    calls = []
    monkeypatch.setattr(llms, "capture_int_key", AsyncMock(return_value=True))
    monkeypatch.setattr(llms.telemetry_manager, "increment_counter_metric", lambda *args: calls.append(args))
    try:
        result = await llms.llm_complete("__root__", "input")
        assert result.ok()
        llms.project_cost_token_billing.assert_not_awaited()
        llms.capture_int_key.assert_awaited_once_with(llms.TelemetryKeyName.llm_usage_unknown, project_id="__root__")
        assert any(call[0] == llms.CounterMetricName.LLM_USAGE_UNKNOWN for call in calls)
        assert not any(call[0] in (llms.CounterMetricName.LLM_TOKENS_INPUT,
                                  llms.CounterMetricName.LLM_TOKENS_OUTPUT) for call in calls)
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_luna_uses_default_reasoning_and_total_budget(openai_transport):
    state, client = openai_transport
    history = [{"role": "assistant", "content": "prior answer"}]
    try:
        result = await openai_complete(
            "gpt-6-luna",
            "input",
            system_prompt="system",
            history_messages=history,
            temperature=0.2,
            max_tokens=1024,
            response_format={"type": "json_object"},
        )
        assert result == "answer"
        body = state["requests"][0]
        assert body["reasoning_effort"] == "high"
        assert "temperature" not in body
        assert body["max_completion_tokens"] == 32768
        assert body["response_format"] == {"type": "json_object"}
        assert body["messages"] == [
            {"role": "system", "content": "system"},
            *history,
            {"role": "user", "content": "input"},
        ]
        assert "max_tokens" not in body
        assert history == [{"role": "assistant", "content": "prior answer"}]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_luna_removes_all_unsupported_sampling_parameters(openai_transport):
    state, client = openai_transport
    try:
        await openai_complete(
            "gpt-6-luna",
            "input",
            temperature=0.2,
            top_p=0.9,
            logprobs=True,
            top_logprobs=2,
        )
        body = state["requests"][0]
        assert body["reasoning_effort"] == "high"
        assert body["max_completion_tokens"] == 32768
        assert not {
            "temperature", "top_p", "logprobs", "top_logprobs", "max_tokens"
        }.intersection(body)
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "caller_options",
    [
        {"max_tokens": 16},
        {"max_tokens": 1024},
        {"reasoning_effort": "none", "max_tokens": 1024},
        {"reasoning_effort": "max", "max_tokens": 1024},
    ],
)
async def test_luna_default_budget_ignores_old_limits_and_preserves_reasoning(
    openai_transport, caller_options
):
    state, client = openai_transport
    try:
        await openai_complete("gpt-6-luna", "input", **caller_options)
        body = state["requests"][0]
        assert body["reasoning_effort"] == caller_options.get("reasoning_effort", "high")
        assert body["max_completion_tokens"] == 32768
        assert "max_tokens" not in body
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("budget", [4096, 32768])
async def test_explicit_completion_budget_is_preserved(openai_transport, budget):
    state, client = openai_transport
    try:
        await openai_complete(
            "gpt-6-luna", "input", max_tokens=16, max_completion_tokens=budget
        )
        body = state["requests"][0]
        assert body["max_completion_tokens"] == budget
        assert body["reasoning_effort"] == "high"
        assert "max_tokens" not in body
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("content", ["", " \n\t"])
async def test_completed_empty_text_is_returned_unchanged(openai_transport, content):
    state, client = openai_transport
    state["content"] = content
    try:
        assert await openai_complete("gpt-6-luna", "input") == content
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("content", ["", " \n\t"])
async def test_empty_structured_content_flush_fails_without_event(
    openai_transport, monkeypatch, content
):
    state, client = openai_transport
    state["content"] = content
    monkeypatch.setattr(CONFIG, "best_llm_model", "gpt-6-luna")
    monkeypatch.setattr(CONFIG, "summary_llm_model", None)
    api_client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
    api_client.headers["Authorization"] = f"Bearer {os.environ['ACCESS_TOKEN']}"
    user_id = (await api_client.post("/api/users", json={})).json()["id"]
    try:
        inserted = (await api_client.post(f"/api/users/{user_id}/blobs", json={
            "source_id": "empty-json", "idempotency_key": "empty-json",
            "messages": [{"message_id": "1", "role": "user", "content": "Hello",
                          "occurred_at": "2026-10-06T00:00:00Z"}]}))
        assert inserted.status_code >= 400
        assert (await api_client.get(f"/api/users/{user_id}/events")).json()["events"] == []
        assert len(state["requests"]) == 1
    finally:
        (await api_client.delete(f"/api/users/{user_id}"))
        (await api_client.aclose())
        await client.close()


@pytest.mark.asyncio
async def test_complete_structured_empty_facts_flush_succeeds_without_event(openai_transport):
    state, model_client = openai_transport
    state["content"] = '{"facts": []}'
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers={"Authorization": f"Bearer {os.environ['ACCESS_TOKEN']}"})
    uid = (await client.post("/api/users", json={})).json()["id"]
    try:
        inserted = (await client.post(f"/api/users/{uid}/blobs", json={"source_id": "empty-facts",
            "idempotency_key": "empty-facts", "messages": [{"message_id": "1", "role": "user",
            "content": "Hello", "occurred_at": "2026-10-06T00:00:00Z"}]}))
        assert inserted.status_code == 200 and inserted.json()["status"] == "completed"
        assert inserted.json()["result"]["event_ids"] == []
        assert (await client.get(f"/api/users/{uid}/events")).json()["events"] == []
        assert len(state["requests"]) == 1
        assert state["requests"][0]["response_format"]["json_schema"]["strict"]
    finally:
        (await client.delete(f"/api/users/{uid}"))
        (await client.aclose())
        await model_client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "changes",
    [
        {"finish_reason": "length", "content": '{"facts": []}'},
        {"finish_reason": "content_filter"},
        {"finish_reason": "unknown_reason"},
        {"finish_reason": None},
        {"finish_reason": "tool_calls"},
        {"content": None},
        {"refusal": "refused"},
        {"choices": False},
        {"status": 400},
    ],
)
async def test_incomplete_or_failed_response_is_not_success(openai_transport, changes):
    state, client = openai_transport
    state.update(changes)
    try:
        result = await llms.llm_complete(
            "__root__", "input", model="gpt-6-luna"
        )
        assert not result.ok()
        assert result.code() == CODE.SERVICE_UNAVAILABLE
        assert len(state["requests"]) == 1
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_startup_sanity_uses_dedicated_completion_budget(openai_transport, monkeypatch):
    state, client = openai_transport
    state["content"] = " OK\n"
    monkeypatch.setattr(CONFIG, "best_llm_model", "gpt-6-luna")
    try:
        await llms.llm_sanity_check()
        await asyncio.sleep(0)
        body = state["requests"][0]
        assert body["reasoning_effort"] == "high"
        assert body["max_completion_tokens"] == 4096
        assert "temperature" not in body and "max_tokens" not in body
        assert "OK" in body["messages"][-1]["content"]
        # 探针预算只属于当前请求，不污染后续正式业务调用。
        await llms.llm_complete("__root__", "business input")
        await asyncio.sleep(0)
        assert state["requests"][1]["max_completion_tokens"] == 32768
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "changes",
    [{"content": ""}, {"content": "unexpected"}, {"content": "OK", "finish_reason": "length"}],
)
async def test_startup_probe_does_not_accept_empty_wrong_or_truncated_output(
    openai_transport, monkeypatch, changes
):
    state, client = openai_transport
    state.update(changes)
    monkeypatch.setattr(CONFIG, "best_llm_model", "gpt-6-luna")
    try:
        with pytest.raises(ValueError, match="LLM sanity check"):
            await llms.llm_sanity_check()
        await asyncio.sleep(0)
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_missing_usage_metadata_does_not_discard_valid_text(openai_transport):
    state, client = openai_transport
    state["usage"] = False
    try:
        assert await openai_complete("gpt-6-luna", "input") == "answer"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_luna_service_default_is_used_only_without_explicit_effort(openai_transport, monkeypatch):
    state, client = openai_transport
    monkeypatch.setattr(CONFIG, "llm_reasoning_effort", "low")
    try:
        await openai_complete("gpt-6-luna", "default")
        await openai_complete("gpt-6-luna", "project override", reasoning_effort="high")
        assert [body["reasoning_effort"] for body in state["requests"]] == ["low", "high"]
    finally:
        await client.close()
