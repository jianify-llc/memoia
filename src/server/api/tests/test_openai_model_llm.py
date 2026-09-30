"""OpenAI 请求契约回归：使用真实 SDK 和本地假 transport，不调用模型。"""

import asyncio
import json
import os
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient
from openai import AsyncOpenAI

from api import app
from memoia_server import llms
from memoia_server.env import CONFIG
from memoia_server.llms.openai_model_llm import openai_complete
from memoia_server.models.utils import CODE


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
            "choices": [choice] if state["choices"] else [],
        }
        if state["usage"]:
            result["usage"] = {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
            }
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
    monkeypatch.setattr(llms, "project_cost_token_billing", AsyncMock())
    return state, client


@pytest.mark.asyncio
async def test_luna_uses_medium_reasoning_and_total_budget(openai_transport):
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
            prompt_id="extract",
            no_cache=True,
            response_format={"type": "json_object"},
        )
        assert result == "answer"
        body = state["requests"][0]
        assert body["reasoning_effort"] == "medium"
        assert "temperature" not in body
        assert body["max_completion_tokens"] == 32768
        assert body["response_format"] == {"type": "json_object"}
        assert body["messages"] == [
            {"role": "system", "content": "system"},
            *history,
            {"role": "user", "content": "input"},
        ]
        assert "max_tokens" not in body
        assert "prompt_id" not in body and "no_cache" not in body
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
        assert body["reasoning_effort"] == "medium"
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
    ],
)
async def test_luna_default_budget_ignores_old_limits_and_fixes_reasoning(
    openai_transport, caller_options
):
    state, client = openai_transport
    try:
        await openai_complete("gpt-6-luna", "input", **caller_options)
        body = state["requests"][0]
        assert body["reasoning_effort"] == "medium"
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
        assert body["reasoning_effort"] == "medium"
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
async def test_empty_json_is_rejected_by_real_parser(openai_transport, content):
    state, client = openai_transport
    state["content"] = content
    try:
        result = await llms.llm_complete(
            "__root__", "Return JSON", model="gpt-6-luna", json_mode=True
        )
        await asyncio.sleep(0)
        assert not result.ok()
        assert result.code() == CODE.UNPROCESSABLE_ENTITY
        assert len(state["requests"]) == 1
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("content", ["", " \n\t"])
async def test_empty_summary_flush_succeeds_without_event(
    openai_transport, monkeypatch, content
):
    state, client = openai_transport
    state["content"] = content
    monkeypatch.setattr(CONFIG, "best_llm_model", "gpt-6-luna")
    monkeypatch.setattr(CONFIG, "summary_llm_model", None)
    api_client = TestClient(app)
    api_client.headers["Authorization"] = f"Bearer {os.environ['ACCESS_TOKEN']}"
    user_id = api_client.post("/api/v1/users", json={}).json()["data"]["id"]
    try:
        inserted = api_client.post(
            f"/api/v1/blobs/insert/{user_id}",
            json={
                "blob_type": "chat",
                "blob_data": {"messages": [{"role": "user", "content": "Hello"}]},
            },
        )
        assert inserted.json()["errno"] == 0
        # 不 mock 摘要函数：执行真实 HTTP → summary → SDK → adapter → 业务空摘要分支。
        flushed = api_client.post(f"/api/v1/users/buffer/{user_id}/chat?wait_process=true")
        assert flushed.json()["errno"] == 0
        assert flushed.json()["data"] == [
            {"event_id": None, "add_profiles": [], "update_profiles": [], "delete_profiles": []}
        ]
        assert api_client.get(f"/api/v1/users/event/{user_id}").json()["data"]["events"] == []
        assert len(state["requests"]) == 1
    finally:
        api_client.delete(f"/api/v1/users/{user_id}")
        api_client.close()
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "content,expected", [('{"facts": []}', {"facts": []}), ("not JSON", {})]
)
async def test_luna_json_mode_preserves_legacy_parser_contract(
    openai_transport, monkeypatch, content, expected
):
    state, client = openai_transport
    state["content"] = content
    monkeypatch.setattr(CONFIG, "best_llm_model", "gpt-6-luna")
    try:
        result = await llms.llm_complete(
            "__root__", "Return JSON", json_mode=True, temperature=0.2
        )
        await asyncio.sleep(0)
        # 旧解析器对无可提取 JSON 的文本返回 {}；参数适配不改写这项既有行为。
        assert result.ok()
        assert result.data() == expected
        body = state["requests"][0]
        assert body["response_format"] == {"type": "json_object"}
        assert body["reasoning_effort"] == "medium"
        assert body["max_completion_tokens"] == 32768
        assert "temperature" not in body and "max_tokens" not in body
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_parser_failure_keeps_existing_error_code(openai_transport, monkeypatch):
    state, client = openai_transport
    monkeypatch.setattr(llms, "convert_response_to_json", lambda _: None)
    try:
        result = await llms.llm_complete(
            "__root__", "Return JSON", model="gpt-6-luna", json_mode=True
        )
        await asyncio.sleep(0)
        assert not result.ok()
        assert result.code() == CODE.UNPROCESSABLE_ENTITY
        assert len(state["requests"]) == 1
    finally:
        await client.close()


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
            "__root__", "Return JSON", model="gpt-6-luna", json_mode=True
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
        assert body["reasoning_effort"] == "medium"
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
