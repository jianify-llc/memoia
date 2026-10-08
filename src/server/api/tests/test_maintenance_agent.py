"""Exercise the real Agents runner over fake HTTP, without provider credentials."""

import asyncio
import json

import httpx
import pytest
from agents import ModelBehaviorError
from openai import AsyncOpenAI, RateLimitError, APIStatusError, InternalServerError

from memoia_server import maintenance_agent as module
from memoia_server.maintenance_agent import (EventMutation, MaintenanceRunError,
                                             LoopPlan, ProfileMutation, run_loop)


class Context:
    project_id = "private-project-id"
    user_id = "private-user-id"
    through_version = 43
    changes = [{"version": 43, "kind": "deleted", "fact_id": "deleted-fact"}]
    allowed_topics = ["relationships"]
    profile_topics = [{"topic": "relationships", "description": "People around the user", "sub_topics": []}]
    event_tag_definitions = [{"name": "emotion", "description": "Expressed emotion only"}]
    language = "en"
    llm_model = "gpt-6-luna"
    reasoning_effort = "high"

    def __init__(self):
        self.active = True
        self.readset = {"facts": {}, "profiles": {}, "events": {}}
        self.staged = []
        self.calls = []
        self.plans = 0

    async def assert_active(self):
        if not self.active:
            raise MaintenanceRunError("LEASE_LOST")

    async def read(self, collection, *, ids=None, cursor=None, query=None, limit=20):
        self.calls.append(("read", collection, ids, cursor, query, limit))
        self.readset[collection]["fact-1"] = 2
        return {"items": [{"id": "fact-1", "revision": 2, "active": True,
                           "content": "The user's colleague Wu cancelled the September hike due to overtime."}],
                "next_cursor": None}

    async def stage_profile(self, change):
        self.calls.append(("profile", change))
        self.staged.append(change)
        return change.id or "new-profile"

    async def stage_event(self, change):
        self.calls.append(("event", change))
        self.staged.append(change)
        return change.id or "new-event"

    async def search(self, query, *, limit=20):
        self.calls.append(("search", query, limit))
        self.readset["facts"]["fact-1"] = 2
        return {"facts": [{"id": "fact-1", "content": "Wu cancelled the hike due to overtime."}],
                "profiles": [], "events": []}

    blob_count = 1

    async def read_changes(self, *, cursor=None, limit=20):
        return {"items": self.changes, "next_cursor": None}

    def get_plan(self, usage):
        self.plans += 1
        return LoopPlan([c for c in self.staged if isinstance(c, ProfileMutation)],
                        [c for c in self.staged if isinstance(c, EventMutation)], self.readset, usage)


def completion(content="Done", *, status="completed", calls=None, refusal=None,
               incomplete_reason=None, input_tokens=10, output_tokens=5, usage=True):
    output = list(calls or [])
    if content is not None or refusal is not None:
        parts = ([{"type": "refusal", "refusal": refusal}] if refusal is not None else
                 [{"type": "output_text", "text": content, "annotations": []}])
        output.append({"id": "msg-local", "type": "message", "status": "completed",
                       "role": "assistant", "content": parts})
    response = {"id": "resp-local", "object": "response", "created_at": 1,
                "model": "gpt-6-luna", "status": status, "output": output,
                "parallel_tool_calls": False}
    if incomplete_reason:
        response["incomplete_details"] = {"reason": incomplete_reason}
    if usage:
        response["usage"] = {"input_tokens": input_tokens, "output_tokens": output_tokens,
                             "total_tokens": input_tokens + output_tokens,
                             "input_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0},
                             "output_tokens_details": {"reasoning_tokens": 0}}
    return response


def tool(name, arguments, call_id="call-1"):
    return {"id": f"fc-{call_id}", "call_id": call_id, "type": "function_call",
            "name": name, "arguments": json.dumps(arguments), "status": "completed"}


@pytest.fixture
def transport(monkeypatch):
    state = {"responses": [], "requests": [], "status": 200, "after_response": None,
             "accounting": [], "paths": [], "outcomes": [], "delays": []}

    async def accounting(project_id, input_tokens, output_tokens, latency):
        state["accounting"].append((project_id, input_tokens, output_tokens, latency))

    async def respond(request):
        state["requests"].append(json.loads(request.content))
        state["paths"].append(request.url.path)
        if state["delays"]:
            await asyncio.sleep(state["delays"].pop(0))
        if state["outcomes"]:
            outcome = state["outcomes"].pop(0)
            if state["after_response"]:
                state["after_response"]()
            if isinstance(outcome, Exception):
                raise outcome
            if "http_status" in outcome:
                return httpx.Response(outcome["http_status"], json=outcome["body"])
            return httpx.Response(200, json=outcome)
        if state["status"] != 200:
            return httpx.Response(state["status"], json={"error": {
                "message": "local failure", "type": "rate_limit_error"}})
        result = state["responses"].pop(0)
        if state["after_response"]:
            state["after_response"]()
        return httpx.Response(200, json=result)

    def new_client():
        return AsyncOpenAI(api_key="local-test-key", base_url="https://example.invalid/v1",
                           max_retries=0,
                           http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)))
    monkeypatch.setattr(module, "_new_client", new_client)
    monkeypatch.setattr(module, "record_completion_usage", accounting)
    monkeypatch.setattr(module.CONFIG, "best_llm_model", "gpt-6-luna")
    return state


@pytest.mark.asyncio
async def test_unified_runner_reads_stages_and_returns_only_after_final(transport):
    change = {"action": "upsert", "id": None, "topic": "relationships",
              "sub_topic": "colleague Wu", "content": "Wu is the user's colleague.",
              "fact_ids": ["fact-1"]}
    transport["responses"] = [
        completion(None, calls=[tool("read_memory", {
            "collection": "facts", "ids": ["fact-1"], "cursor": None, "query": None, "limit": 20})]),
        completion(None, calls=[tool("stage_profile", {"changes": [change]}, "call-2")]),
        completion(),
    ]
    context = Context()
    plan = await run_loop(context)
    assert (plan.profiles + plan.events) == [ProfileMutation(**change)]
    assert plan.readset["facts"] == {"fact-1": 2}
    assert plan.usage.turns == 3
    assert plan.usage.input_tokens == 30 and plan.usage.output_tokens == 15
    assert context.plans == 1
    first = transport["requests"][0]
    assert first["model"] == "gpt-6-luna"
    assert first["reasoning"] == {"effort": "high"}
    assert all(body["service_tier"] == "flex" for body in transport["requests"])
    assert first["parallel_tool_calls"] is False
    assert first["max_output_tokens"] == 32768
    assert "max_tokens" not in first and "max_completion_tokens" not in first and "temperature" not in first
    assert first["store"] is False and first["truncation"] == "disabled"
    assert first["context_management"] == [{"type": "compaction", "compact_threshold": 262144}]
    assert "reasoning.encrypted_content" in first["include"]
    assert all("previous_response_id" not in body and "conversation" not in body for body in transport["requests"])
    assert transport["paths"] == ["/v1/responses"] * 3
    tools = {entry["name"]: entry["parameters"] for entry in first["tools"]}
    assert set(tools) == {"read_memory", "stage_profile", "stage_event", "search_memory", "read_changes"}
    assert "project_id" not in tools["read_memory"]["properties"]
    assert "user_id" not in tools["read_memory"]["properties"]
    assert "deleted-fact" not in first["input"][-1]["content"]
    assert json.loads(first["input"][-1]["content"])["change_count"] == 1
    assert context.user_id not in json.dumps(first)
    assert [(project, inp, out) for project, inp, out, _ in transport["accounting"]] == [
        (context.project_id, 10, 5)] * 3
    assert all(latency >= 0 for _, _, _, latency in transport["accounting"])
    assert "new-profile" in transport["requests"][2]["input"][-1]["output"]


@pytest.mark.asyncio
async def test_custom_topic_definitions_reach_runner_without_guessed_meanings(transport):
    context = Context()
    context.profile_topics = [
        {"topic": "p1", "description": "The current user's own attributes", "sub_topics": []},
        {"topic": "p2", "description": "Friends and relatives, not the user's own attributes",
         "sub_topics": [{"name": "colleague", "description": "Work relationships"}]},
    ]
    context.allowed_topics = [item["topic"] for item in context.profile_topics]
    transport["responses"] = [completion()]
    await run_loop(context)
    payload = json.loads(transport["requests"][0]["input"][-1]["content"])
    assert payload["profile_topics"] == context.profile_topics
    assert "allowed_topics" not in payload


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["profile", "event"])
@pytest.mark.parametrize("effort", ["none", "minimal", "low", "medium", "high", "xhigh", "max"])
async def test_project_model_and_reasoning_override_reach_runner(transport, kind, effort):
    context = Context()
    context.llm_model = "project-model"
    context.reasoning_effort = effort
    transport["responses"] = [completion()]
    await run_loop(context)
    assert transport["requests"][0]["model"] == "project-model"
    assert transport["requests"][0]["reasoning"]["effort"] == effort


@pytest.mark.asyncio
async def test_rejected_completion_still_records_usage_without_committing(transport):
    transport["responses"] = [completion(status="incomplete", incomplete_reason="max_output_tokens")]
    context = Context()
    with pytest.raises(MaintenanceRunError, match="MAINTENANCE_COMPLETION_LENGTH"):
        await run_loop(context)
    assert len(transport["accounting"]) == 1
    assert context.plans == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("tag", ["emotion", "not-configured"])
async def test_event_tags_are_typed_and_limited_to_current_project_config(transport, tag):
    change = {"action": "upsert", "content": "The user felt disappointed.", "fact_ids": ["fact-1"],
              "event_tags": [{"tag": tag, "value": "disappointment"}]}
    transport["responses"] = [
        completion(None, calls=[tool("stage_event", {"changes": [change]})]),
        completion(),
    ]
    context = Context()
    if tag == "emotion":
        plan = await run_loop(context)
        assert (plan.profiles + plan.events)[0].event_tags[0].tag == "emotion"
        tool_schema = next(t["parameters"] for t in transport["requests"][0]["tools"] if t["name"] == "stage_event")
        assert "event_tags" in json.dumps(tool_schema) and '"tag"' in json.dumps(tool_schema)
        assert "event_tag_definitions" in transport["requests"][0]["input"][-1]["content"]
    else:
        with pytest.raises(MaintenanceRunError, match="MAINTENANCE_EVENT_TAG"):
            await run_loop(context)
        assert context.staged == [] and context.plans == 0


@pytest.mark.asyncio
async def test_sdk_tool_wrapper_preserves_caller_retry_classification(transport):
    class ScopedFailure(Exception):
        code = "maintenance_read_conflict"
        retryable = True
    failure = ScopedFailure("scoped failure")
    context = Context()
    async def failing_read(*args, **kwargs):
        raise failure
    context.read = failing_read
    transport["responses"] = [completion(None, calls=[tool("read_memory", {
        "collection": "facts", "ids": ["fact-1"], "cursor": None, "query": None, "limit": 20})])]
    with pytest.raises(ScopedFailure) as caught:
        await run_loop(context)
    assert caught.value is failure and caught.value.retryable is True
    assert context.plans == 0


@pytest.mark.asyncio
async def test_unified_runner_can_stage_event_unknowns_and_profile_tools_together(transport):
    change = {"action": "upsert", "id": None, "title": "September hike cancellation",
              "summary": "Wu cancelled due to overtime", "keywords": "hike, overtime",
              "time": "September 2026", "location": None,
              "content": "Wu cancelled the hike with the user because of overtime.",
              "interpretation": None, "fact_ids": ["fact-1"]}
    transport["responses"] = [completion(None,
                                         calls=[tool("stage_event", {"changes": [change]})]), completion()]
    plan = await run_loop(Context())
    assert (plan.profiles + plan.events) == [EventMutation(**change)]
    assert {t["name"] for t in transport["requests"][0]["tools"]} == {
        "read_memory", "stage_event", "stage_profile", "search_memory", "read_changes"}


@pytest.mark.asyncio
@pytest.mark.parametrize("text", ["Done", "", " \n\t"])
async def test_completed_noop_is_valid(transport, text):
    transport["responses"] = [completion(text)]
    assert (await run_loop(Context())).profiles == []


@pytest.mark.asyncio
@pytest.mark.parametrize("response,code", [
    (completion("partial", status="incomplete", incomplete_reason="max_output_tokens"), "MAINTENANCE_COMPLETION_LENGTH"),
    (completion(None, status="incomplete", incomplete_reason="content_filter"), "MAINTENANCE_COMPLETION_FILTERED"),
    (completion("text", refusal="I cannot help"), "MAINTENANCE_COMPLETION_REFUSED"),
    (completion(None), "MAINTENANCE_COMPLETION_CONTENT"),
    (completion("text", status="unknown"), "MAINTENANCE_COMPLETION_INCOMPLETE"),
    (completion(None, calls=[]), "MAINTENANCE_COMPLETION_CONTENT"),
    (completion(None, calls=[tool("modify_fact", {})]),
     "MAINTENANCE_COMPLETION_TOOLS"),
    (completion("text", status="failed"), "MAINTENANCE_COMPLETION_INCOMPLETE"),
    (completion("Done", usage=False), "MAINTENANCE_USAGE_MISSING"),
])
async def test_invalid_protocol_never_returns_a_plan(transport, response, code):
    transport["responses"] = [response]
    context = Context()
    with pytest.raises(MaintenanceRunError) as error:
        await run_loop(context)
    assert error.value.code == code
    assert context.plans == 0


@pytest.mark.asyncio
async def test_failure_after_staging_does_not_return_partial_plan(transport):
    transport["responses"] = [completion(None, calls=[tool(
        "stage_profile", {"changes": [{"action": "remove", "id": "profile-1"}]})]),
        completion("partial", status="incomplete", incomplete_reason="max_output_tokens")]
    context = Context()
    with pytest.raises(MaintenanceRunError):
        await run_loop(context)
    assert len(context.staged) == 1 and context.plans == 0


@pytest.mark.asyncio
async def test_expired_execution_cannot_invoke_tool_or_return_plan(transport):
    transport["responses"] = [completion(None, calls=[tool(
        "read_memory", {"collection": "facts"})])]
    context = Context()
    transport["after_response"] = lambda: setattr(context, "active", False)
    with pytest.raises(MaintenanceRunError, match="LEASE_LOST"):
        await run_loop(context)
    assert context.calls == [] and context.plans == 0


@pytest.mark.asyncio
async def test_tools_are_serial_even_when_provider_returns_parallel_calls(transport):
    transport["responses"] = [completion(None, calls=[
        tool("read_memory", {"collection": "facts"}, "call-1"),
        tool("read_memory", {"collection": "profiles"}, "call-2")]), completion()]
    context = Context()
    activity = []

    async def read(collection, **kwargs):
        activity.append((collection, "start"))
        await asyncio.sleep(0)
        activity.append((collection, "end"))
        return {"items": []}

    context.read = read
    await run_loop(context)
    assert activity == [("facts", "start"), ("facts", "end"),
                        ("profiles", "start"), ("profiles", "end")]


@pytest.mark.asyncio
@pytest.mark.parametrize("args,code", [
    ({"collection": "facts", "limit": 201}, "MAINTENANCE_READ_LIMIT"),
    ({"collection": "facts", "ids": [str(i) for i in range(201)]}, "MAINTENANCE_READ_LIMIT"),
])
async def test_read_budget_error_is_not_tool_feedback_success(transport, args, code):
    transport["responses"] = [completion(None,
                                         calls=[tool("read_memory", args)])]
    context = Context()
    with pytest.raises(MaintenanceRunError, match=code):
        await run_loop(context)
    assert len(transport["requests"]) == 1 and context.plans == 0


@pytest.mark.asyncio
async def test_disallowed_profile_topic_does_not_stage(transport):
    transport["responses"] = [completion(None, calls=[tool(
        "stage_profile", {"changes": [{"action": "upsert", "topic": "invented-topic",
                                    "sub_topic": "a", "content": "b", "fact_ids": ["fact-1"]}]})])]
    context = Context()
    with pytest.raises(MaintenanceRunError, match="MAINTENANCE_PROFILE_TOPIC"):
        await run_loop(context)
    assert context.staged == [] and context.plans == 0


@pytest.mark.asyncio
async def test_invalid_tool_schema_propagates_instead_of_becoming_completion(transport):
    transport["responses"] = [completion(None, calls=[tool(
        "stage_profile", {"changes": [{"action": "upsert", "content": "unsupported"}]})])]
    context = Context()
    with pytest.raises(ModelBehaviorError):
        await run_loop(context)
    assert context.staged == [] and len(transport["requests"]) == 1


@pytest.mark.asyncio
async def test_no_sdk_retry_after_single_standard_fallback(transport):
    transport["status"] = 429
    with pytest.raises(RateLimitError):
        await run_loop(Context())
    assert [body["service_tier"] for body in transport["requests"]] == ["flex", "default"]


@pytest.mark.asyncio
async def test_turn_limit_has_no_partial_success(transport, monkeypatch):
    monkeypatch.setattr(module, "MAX_TURNS", 2)
    transport["responses"] = [completion(None, calls=[tool(
        "read_memory", {"collection": "facts"}, f"call-{i}")]) for i in range(2)]
    context = Context()
    with pytest.raises(MaintenanceRunError, match="MAINTENANCE_TURN_BUDGET"):
        await run_loop(context)
    assert len(transport["requests"]) == 2 and context.plans == 0


@pytest.mark.asyncio
async def test_final_completion_on_last_permitted_turn_is_success(transport):
    transport["responses"] = [completion(None, calls=[tool(
        "read_memory", {"collection": "facts"}, f"call-{i}")]) for i in range(9)] + [completion()]
    context = Context()
    plan = await run_loop(context)
    assert plan.usage.turns == 10 and len(transport["requests"]) == 10
    assert len(context.calls) == 9 and context.plans == 1


@pytest.mark.asyncio
async def test_large_tool_result_keeps_per_call_completion_allowance(transport):
    context = Context()
    read = context.read
    async def large_read(*args, **kwargs):
        result = await read(*args, **kwargs)
        result["items"][0]["content"] = "word " * 40000
        return result
    context.read = large_read
    transport["responses"] = [completion(None, calls=[tool(
        "read_memory", {"collection": "facts"})]), completion()]
    await run_loop(context)
    assert transport["requests"][1]["max_output_tokens"] == 32768


@pytest.mark.asyncio
async def test_tool_result_over_old_cumulative_budget_can_continue(transport):
    context = Context()
    read = context.read
    async def large_read(*args, **kwargs):
        result = await read(*args, **kwargs)
        result["items"][0]["content"] = "word " * 66000
        return result
    context.read = large_read
    transport["responses"] = [completion(None, calls=[tool("read_memory", {"collection": "facts"})]),
                              completion(input_tokens=66000)]
    plan = await run_loop(context)
    assert len(transport["requests"]) == 2 and plan.usage.input_tokens > 65536
    assert transport["requests"][1]["max_output_tokens"] == 32768


@pytest.mark.asyncio
async def test_second_request_has_no_old_total_budget_cap(transport):
    transport["responses"] = [completion(None, calls=[tool(
        "read_memory", {"collection": "facts"})], input_tokens=30000, output_tokens=10000),
        completion()]
    await run_loop(Context())
    cap = transport["requests"][1]["max_output_tokens"]
    assert cap == 32768


@pytest.mark.asyncio
async def test_actual_output_over_per_call_budget_is_rejected_before_tools(transport):
    transport["responses"] = [completion(None, calls=[tool(
        "read_memory", {"collection": "facts"})], input_tokens=10, output_tokens=32769)]
    context = Context()
    with pytest.raises(MaintenanceRunError, match="MAINTENANCE_COMPLETION_LENGTH"):
        await run_loop(context)
    assert context.calls == [] and context.plans == 0


@pytest.mark.asyncio
async def test_whole_run_timeout_and_cancellation_do_not_return_plans(transport, monkeypatch):
    context = Context()

    async def hanging_read(*args, **kwargs):
        await asyncio.Future()

    context.read = hanging_read
    transport["responses"] = [completion(None, calls=[tool(
        "read_memory", {"collection": "facts"})])]
    monkeypatch.setattr(module, "MAX_SECONDS", 0.03)
    with pytest.raises(MaintenanceRunError, match="MAINTENANCE_TIMEOUT") as error:
        await run_loop(context)
    assert error.value.retryable and context.plans == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["failed", "cancelled", "in_progress", "queued", "incomplete", "unknown", None])
async def test_non_completed_response_status_blocks_tools(transport, status):
    transport["responses"] = [completion(None, status=status, calls=[tool("read_memory", {"collection": "facts"})])]
    context = Context()
    with pytest.raises(MaintenanceRunError, match="MAINTENANCE_COMPLETION_INCOMPLETE"):
        await run_loop(context)
    assert context.calls == [] and context.plans == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("alteration", [
    {"error": {"code": "server_error", "message": "private provider details"}},
    {"incomplete_details": {"reason": "unexpected_reason"}},
    {"output": None}, {"output": [{"type": "web_search_call", "id": "unexpected"}]},
    {"object": "chat.completion"},
])
async def test_malformed_top_level_response_never_returns_plan(transport, alteration):
    response = completion()
    response.update(alteration)
    transport["responses"] = [response]
    context = Context()
    with pytest.raises(MaintenanceRunError):
        await run_loop(context)
    assert context.calls == [] and context.plans == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("alteration", [
    {"status": "incomplete"}, {"role": "user"}, {"phase": "commentary"},
    {"content": []}, {"content": [{"type": "output_text", "text": None, "annotations": []}]},
    {"content": [{"type": "output_text", "text": 1, "annotations": []}]},
])
async def test_incomplete_or_malformed_output_message_cannot_complete_loop(transport, alteration):
    response = completion()
    response["output"][0].update(alteration)
    transport["responses"] = [response]
    context = Context()
    with pytest.raises(MaintenanceRunError):
        await run_loop(context)
    assert context.plans == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("alteration", [
    {"status": "incomplete"}, {"name": "handoff"}, {"call_id": ""},
    {"arguments": "not JSON"}, {"arguments": "[]"},
    {"namespace": "other_agent"}, {"caller": {"type": "program", "caller_id": "program"}},
])
async def test_incomplete_or_unrecognized_tool_call_is_rejected_before_dispatch(transport, alteration):
    call = tool("read_memory", {"collection": "facts"})
    call.update(alteration)
    transport["responses"] = [completion(None, calls=[call])]
    context = Context()
    with pytest.raises(MaintenanceRunError):
        await run_loop(context)
    assert context.calls == [] and context.plans == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("refused", [False, True])
async def test_duplicate_tool_call_ids_and_refusal_with_tools_never_execute(transport, refused):
    call = tool("read_memory", {"collection": "facts"})
    response = (completion(None, calls=[call], refusal="Cannot comply") if refused else
                completion(None, calls=[call, call]))
    transport["responses"] = [response]
    context = Context()
    with pytest.raises(MaintenanceRunError):
        await run_loop(context)
    assert context.calls == [] and context.plans == 0


@pytest.mark.asyncio
async def test_stateless_encrypted_reasoning_is_replayed_by_sdk_without_persistent_thread(transport):
    response = completion(None, calls=[tool("read_memory", {"collection": "facts"})])
    response["output"].insert(0, {"id": "rs-local", "type": "reasoning", "summary": [],
                                  "encrypted_content": "opaque-local-reasoning", "status": "completed"})
    transport["responses"] = [response, completion()]
    await run_loop(Context())
    replay = transport["requests"][1]["input"]
    assert any(item.get("encrypted_content") == "opaque-local-reasoning" for item in replay)
    assert any(item.get("type") == "function_call_output" for item in replay)
    assert all(body["store"] is False and "previous_response_id" not in body
               and "conversation" not in body for body in transport["requests"])


@pytest.mark.asyncio
async def test_tool_reasoning_without_stateless_replay_payload_is_not_discarded(transport):
    response = completion(None, calls=[tool("read_memory", {"collection": "facts"})])
    response["output"].insert(0, {"id": "rs-local", "type": "reasoning", "summary": []})
    transport["responses"] = [response]
    context = Context()
    with pytest.raises(MaintenanceRunError, match="MAINTENANCE_REASONING_REPLAY_MISSING"):
        await run_loop(context)
    assert context.calls == [] and context.plans == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["profile", "event"])
@pytest.mark.parametrize("count", [20, 102, 200])
async def test_complete_small_changes_fit_one_tool_call_without_exhausting_turns(transport, kind, count):
    changes = [{"action": "remove", "id": f"entry-{i}"} for i in range(count)]
    transport["responses"] = [completion(None, calls=[tool(f"stage_{kind}", {"changes": changes})]), completion()]
    context = Context()
    plan = await run_loop(context)
    assert len((plan.profiles + plan.events)) == count and plan.usage.turns == 2
    assert len(context.staged) == count and context.plans == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["profile", "event"])
@pytest.mark.parametrize("count", [0, 201])
async def test_batch_size_limit_stops_without_staging(transport, kind, count):
    transport["responses"] = [completion(None, calls=[tool(f"stage_{kind}", {
        "changes": [{"action": "remove", "id": f"entry-{i}"} for i in range(count)]})])]
    context = Context()
    with pytest.raises(MaintenanceRunError, match="MAINTENANCE_CHANGE_LIMIT"):
        await run_loop(context)
    assert context.staged == [] and context.plans == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["profile", "event"])
async def test_batch_byte_limit_rejects_all_changes_before_staging(transport, kind):
    changes = [{"action": "upsert", "id": None, "content": "x" * 4000,
                "fact_ids": ["fact-1"]} for _ in range(20)]
    if kind == "profile":
        for index, change in enumerate(changes):
            change.update(topic="relationships", sub_topic=f"person-{index}")
    transport["responses"] = [completion(None, calls=[tool(f"stage_{kind}", {"changes": changes})])]
    context = Context()
    with pytest.raises(MaintenanceRunError, match="MAINTENANCE_CHANGE_LIMIT"):
        await run_loop(context)
    assert context.staged == [] and context.plans == 0


@pytest.mark.asyncio
async def test_batch_configuration_is_validated_before_any_change_is_staged(transport):
    transport["responses"] = [completion(None, calls=[tool("stage_profile", {"changes": [
        {"action": "remove", "id": "entry-1"},
        {"action": "upsert", "topic": "unconfigured", "sub_topic": "x", "content": "x", "fact_ids": ["fact-1"]}]})])]
    context = Context()
    with pytest.raises(MaintenanceRunError, match="MAINTENANCE_PROFILE_TOPIC"):
        await run_loop(context)
    assert context.staged == [] and context.plans == 0


@pytest.mark.asyncio
async def test_scoped_search_tool_registers_reads_without_identity_arguments(transport):
    transport["responses"] = [completion(None, calls=[tool("search_memory", {
        "query": "colleague cancelled hiking because overtime", "limit": 10})]), completion()]
    context = Context()
    plan = await run_loop(context)
    assert context.calls == [("search", "colleague cancelled hiking because overtime", 10)]
    assert plan.readset["facts"] == {"fact-1": 2}
    schema = next(t["parameters"] for t in transport["requests"][0]["tools"] if t["name"] == "search_memory")
    assert set(schema["properties"]) == {"query", "limit"}


@pytest.mark.asyncio
@pytest.mark.parametrize("arguments", [
    {"query": " "}, {"query": "x" * 501}, {"query": "x", "limit": 0}, {"query": "x", "limit": 21},
    {"query": "x", "user_id": "other"}, {"query": "x", "project_id": "other"},
])
async def test_search_rejects_invalid_or_foreign_arguments_before_dispatch(transport, arguments):
    transport["responses"] = [completion(None, calls=[tool("search_memory", arguments)])]
    context = Context()
    with pytest.raises(MaintenanceRunError):
        await run_loop(context)
    assert context.calls == [] and context.plans == 0


@pytest.mark.asyncio
async def test_native_compaction_replay_preserves_plan_and_budgets_through_flex_fallback(transport):
    checkpoint = {"id": "cmp-local", "type": "compaction", "encrypted_content": "opaque-checkpoint"}
    transport["outcomes"] = [
        completion(None, calls=[tool("stage_profile", {"changes": [{"action": "remove", "id": "profile-1"}]})]),
        completion(None, calls=[checkpoint, tool("read_memory", {"collection": "facts"}, "read-2")]),
        http_failure(429), completion(),
    ]
    context = Context()
    plan = await run_loop(context)
    assert len((plan.profiles + plan.events)) == 1 and plan.readset["facts"] == {"fact-1": 2}
    assert plan.usage.turns == 4 and plan.usage.input_tokens == 30 and plan.usage.output_tokens == 15
    assert [body["service_tier"] for body in transport["requests"]] == ["flex", "flex", "flex", "default"]
    for request in transport["requests"][2:]:
        assert request["input"][0] == checkpoint
        assert not any(item.get("name") == "stage_profile" for item in request["input"])
        assert any(item.get("type") == "function_call_output" for item in request["input"])
    assert transport["requests"][2]["input"] == transport["requests"][3]["input"]
    assert [call[0] for call in context.calls] == ["profile", "read"]
    assert transport["paths"] == ["/v1/responses"] * 4


@pytest.mark.asyncio
@pytest.mark.parametrize("checkpoint", [
    {"id": "cmp", "type": "compaction", "encrypted_content": ""},
    {"id": "cmp", "type": "compaction", "encrypted_content": None},
    {"id": "", "type": "compaction", "encrypted_content": "opaque"},
])
async def test_invalid_compaction_cannot_dispatch_tools(transport, checkpoint):
    transport["responses"] = [completion(None, calls=[checkpoint, tool("read_memory", {"collection": "facts"})])]
    context = Context()
    with pytest.raises(MaintenanceRunError):
        await run_loop(context)
    assert context.calls == [] and context.plans == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("values", [
    {"input_tokens": -1}, {"output_tokens": None}, {"input_tokens": True}, {"total_tokens": 16},
])
async def test_invalid_usage_metadata_does_not_dispatch_tools(transport, values):
    response = completion(None, calls=[tool("read_memory", {"collection": "facts"})])
    response["usage"].update(values)
    transport["responses"] = [response]
    context = Context()
    with pytest.raises(MaintenanceRunError, match="MAINTENANCE_USAGE_"):
        await run_loop(context)
    assert context.calls == [] and context.plans == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("caller", [None, {"type": "direct"}])
async def test_completed_response_accepts_sdk_optional_tool_status_and_direct_caller(transport, caller):
    call = tool("read_memory", {"collection": "facts"})
    del call["status"]
    call["caller"] = caller
    transport["responses"] = [completion(None, calls=[call]), completion()]
    context = Context()
    plan = await run_loop(context)
    assert plan.usage.turns == 2 and len(context.calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["user_id", "project_id", "unexpected"])
async def test_model_supplied_ownership_and_unknown_arguments_are_rejected(transport, field):
    transport["responses"] = [completion(None, calls=[tool("read_memory", {
        "collection": "facts", field: "another-user"})])]
    context = Context()
    with pytest.raises(MaintenanceRunError, match="MAINTENANCE_TOOL_ARGUMENTS"):
        await run_loop(context)
    assert context.calls == [] and context.plans == 0


def http_failure(status, *, param=None, message="Temporary provider failure", code=None, usage=None):
    body = {"error": {"message": message, "type": "local_test_error", "param": param, "code": code}}
    if usage is not None:
        body["usage"] = usage
    return {"http_status": status, "body": body}


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [http_failure(429), http_failure(500), http_failure(503),
                                         httpx.ReadTimeout("local timeout"), httpx.ConnectError("local connection")])
async def test_flex_transient_failure_retries_only_current_request_with_standard(transport, failure):
    transport["outcomes"] = [failure, completion()]
    plan = await run_loop(Context())
    assert plan.usage.turns == 2 and plan.usage.input_tokens == 10 and plan.usage.output_tokens == 5
    first, second = transport["requests"]
    assert first["service_tier"] == "flex" and second["service_tier"] == "default"
    assert {k: v for k, v in first.items() if k != "service_tier"} == {
        k: v for k, v in second.items() if k != "service_tier"}
    assert len(transport["accounting"]) == 1


@pytest.mark.asyncio
async def test_standard_is_sticky_without_restarting_or_repeating_tools(transport):
    transport["outcomes"] = [
        completion(None, calls=[tool("read_memory", {"collection": "facts"}, "read-1")]),
        http_failure(429),
        completion(None, calls=[tool("stage_profile", {"changes": [{"action": "remove", "id": "profile-1"}]}, "change-1")]),
        completion(),
    ]
    context = Context()
    plan = await run_loop(context)
    assert [body["service_tier"] for body in transport["requests"]] == ["flex", "flex", "default", "default"]
    assert [call[0] for call in context.calls] == ["read", "profile"]
    assert len((plan.profiles + plan.events)) == 1 and plan.usage.turns == 4
    assert transport["requests"][1]["input"] == transport["requests"][2]["input"]
    assert any(item.get("type") == "function_call_output" for item in transport["requests"][2]["input"])


@pytest.mark.asyncio
@pytest.mark.parametrize("message", ["Flex is not supported for this model", "service_tier flex is not allowed"])
async def test_only_explicit_unsupported_flex_parameter_error_can_fallback(transport, message):
    transport["outcomes"] = [http_failure(400, param="service_tier", message=message, code="unsupported_value"), completion()]
    await run_loop(Context())
    assert [body["service_tier"] for body in transport["requests"]] == ["flex", "default"]


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [
    http_failure(401), http_failure(403), http_failure(404),
    http_failure(400, param="model", message="Flex not supported for missing model"),
    http_failure(400, param="service_tier", message="Invalid unrelated configuration"),
    http_failure(422),
])
async def test_auth_invalid_model_and_other_request_errors_do_not_fallback(transport, failure):
    transport["outcomes"] = [failure]
    context = Context()
    with pytest.raises(APIStatusError):
        await run_loop(context)
    assert len(transport["requests"]) == 1 and context.calls == [] and context.plans == 0


@pytest.mark.asyncio
async def test_standard_failure_returns_to_task_retry_owner_without_third_call(transport):
    transport["outcomes"] = [http_failure(429), http_failure(503)]
    context = Context()
    with pytest.raises(InternalServerError):
        await run_loop(context)
    assert [body["service_tier"] for body in transport["requests"]] == ["flex", "default"]
    assert context.plans == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("http_error", [True, False])
async def test_failed_flex_usage_is_charged_without_reducing_per_call_output_allowance(transport, http_error):
    failed = completion(None, status="failed", input_tokens=30000, output_tokens=10000)
    failed["error"] = {"code": "server_error", "message": "Transient failure"}
    transport["outcomes"] = [http_failure(503, usage=failed["usage"]) if http_error else failed, completion()]
    plan = await run_loop(Context())
    assert plan.usage.input_tokens == 30010 and plan.usage.output_tokens == 10005
    assert len(transport["accounting"]) == 2
    assert transport["requests"][1]["max_output_tokens"] == 32768


@pytest.mark.asyncio
async def test_failed_flex_usage_over_old_total_budget_does_not_block_standard(transport):
    usage = completion(input_tokens=65530, output_tokens=10)["usage"]
    transport["outcomes"] = [http_failure(503, usage=usage), completion()]
    context = Context()
    plan = await run_loop(context)
    assert len(transport["requests"]) == len(transport["accounting"]) == 2
    assert plan.usage.input_tokens + plan.usage.output_tokens > 65536
    assert context.plans == 1


@pytest.mark.asyncio
async def test_fallback_cannot_escape_provider_call_limit(transport, monkeypatch):
    monkeypatch.setattr(module, "MAX_TURNS", 1)
    transport["outcomes"] = [http_failure(429)]
    context = Context()
    with pytest.raises(MaintenanceRunError, match="MAINTENANCE_TURN_BUDGET"):
        await run_loop(context)
    assert len(transport["requests"]) == 1 and context.plans == 0


@pytest.mark.asyncio
async def test_lease_loss_after_flex_error_prevents_standard_fallback(transport):
    context = Context()
    transport["outcomes"] = [http_failure(503)]
    transport["after_response"] = lambda: setattr(context, "active", False)
    with pytest.raises(MaintenanceRunError, match="LEASE_LOST"):
        await run_loop(context)
    assert len(transport["requests"]) == 1 and context.plans == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("usage", [{"input_tokens": "private-invalid-value"}, {"input_tokens": 10, "output_tokens": 5, "total_tokens": 1}])
async def test_malformed_error_usage_is_not_hidden_by_fallback(transport, usage, caplog):
    transport["outcomes"] = [http_failure(503, usage=usage)]
    context = Context()
    with pytest.raises(MaintenanceRunError, match="MAINTENANCE_USAGE_"):
        await run_loop(context)
    assert len(transport["requests"]) == 1 and context.plans == 0
    assert "private-invalid-value" not in caplog.text


@pytest.mark.asyncio
async def test_standard_fallback_uses_remaining_loop_time_not_a_new_deadline(transport, monkeypatch):
    # 留出 SDK 初始化及覆盖率开销；总延迟超过共享期限，但不超过错误重置后的期限。
    monkeypatch.setattr(module, "MAX_SECONDS", 3)
    transport["outcomes"] = [http_failure(429), completion()]
    transport["delays"] = [1, 2.5]
    context = Context()
    with pytest.raises(MaintenanceRunError, match="MAINTENANCE_TIMEOUT"):
        await run_loop(context)
    assert [body["service_tier"] for body in transport["requests"]] == ["flex", "default"]
    assert context.calls == [] and context.plans == 0


@pytest.mark.asyncio
async def test_failed_server_response_without_reported_usage_can_fallback_without_invented_cost(transport):
    failed = completion(None, status="failed", usage=False)
    failed["error"] = {"code": "server_error", "message": "Transient failure"}
    transport["outcomes"] = [failed, completion()]
    plan = await run_loop(Context())
    assert plan.usage.turns == 2 and plan.usage.input_tokens == 10
    assert len(transport["accounting"]) == 1


@pytest.mark.asyncio
async def test_failed_response_with_refusal_cannot_use_fallback(transport):
    failed = completion(None, status="failed", refusal="private refusal")
    failed["error"] = {"code": "server_error", "message": "Transient failure"}
    transport["outcomes"] = [failed]
    context = Context()
    with pytest.raises(MaintenanceRunError):
        await run_loop(context)
    assert len(transport["requests"]) == 1 and context.plans == 0
