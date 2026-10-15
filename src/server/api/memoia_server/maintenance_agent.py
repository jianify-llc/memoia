"""Bounded SDK runs; database ownership, scheduling and commits stay in the caller."""

import asyncio
import json
import time
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Annotated, Literal, Protocol
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from agents import (Agent, ModelSettings, OpenAIResponsesModel, RunConfig, ToolExecutionConfig,
                    RunContextWrapper, RunHooks, Runner, function_tool, set_tracing_disabled,
                    ModelRetryAdvice, ModelRetryAdviceRequest, ModelRetrySettings, retry_policies)
from agents import _debug
from agents.exceptions import AgentsException, UserError
from openai import AsyncOpenAI, APIConnectionError, APIStatusError, BadRequestError
from openai.types.responses import (Response, ResponseFunctionToolCall,
                                    ResponseOutputMessage, ResponseOutputText,
                                    ResponseOutputRefusal, ResponseReasoningItem, ResponseCompactionItem)
from openai.types.shared import Reasoning, ReasoningEffort
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .env import CONFIG, LOG
from .llms import record_completion_usage
from .llms.utils import get_error_usage, supports_prompt_cache_options
from .prompts.assembly import developer_data, loop_cache_key
from .models.response import EventTag
from .utils import json_size

# SDK tracing and debug sinks must not export or log memory/tool payloads.
set_tracing_disabled(True)
_debug.DONT_LOG_MODEL_DATA = True
_debug.DONT_LOG_TOOL_DATA = True

MAX_SECONDS = 900
REQUEST_TIMEOUT_SECONDS = 600
MAX_COMPLETION_TOKENS = 32768
MAX_PAGE_SIZE = 200
MAX_SEARCH_RESULTS = 20
MAX_TOOL_BYTES = 64 * 1024
COMPACT_THRESHOLD = 256000

ReadCollection = Literal["facts", "profiles", "events"]
ReadSet = dict[ReadCollection, dict[str, int | None]]
# Advertise the same bounds enforced below, preserving the existing safe error codes.
PageLimit = Annotated[int, Field(json_schema_extra={"minimum": 1, "maximum": MAX_PAGE_SIZE})]
SearchLimit = Annotated[int, Field(json_schema_extra={"minimum": 1, "maximum": MAX_SEARCH_RESULTS})]
ToolQuery = Annotated[str, Field(json_schema_extra={"maxLength": 500})]
ReadIds = Annotated[list[str], Field(json_schema_extra={"maxItems": MAX_PAGE_SIZE})]


class ProfileMutation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal["upsert", "remove"]
    id: str | None = Field(default=None, max_length=128,
        description="Use null to create a new profile; to update/remove, copy the exact id returned by a read or stage tool. Never invent an id.")
    content: str | None = Field(default=None, max_length=8000)
    topic: str | None = Field(default=None, max_length=128)
    sub_topic: str | None = Field(default=None, max_length=256)
    fact_ids: list[str] = Field(default_factory=list, max_length=100,
        description="Copy exact Fact ids read from current valid facts. Message, Source and Blob ids are not Fact ids.")

    @model_validator(mode="after")
    def validate_change(self):
        if self.action == "remove":
            if not self.id:
                raise ValueError("Removing a profile requires its existing id")
        elif not all((self.content and self.content.strip(), self.topic,
                      self.sub_topic, self.fact_ids)):
            raise ValueError("A profile requires content, classification and supporting facts")
        if len(set(self.fact_ids)) != len(self.fact_ids):
            raise ValueError("Supporting fact ids must be unique")
        return self


class EventMutation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal["upsert", "remove"]
    id: str | None = Field(default=None, max_length=128,
        description="Use null to create a new event; to update/remove, copy the exact id returned by a read or stage tool. Never invent an id.")
    title: str | None = Field(default=None, max_length=500)
    summary: str | None = Field(default=None, max_length=4000)
    keywords: str | None = Field(default=None, max_length=1000)
    time: str | None = Field(default=None, max_length=1000)
    location: str | None = Field(default=None, max_length=1000)
    content: str | None = Field(default=None, max_length=16000)
    interpretation: str | None = Field(default=None, max_length=4000)
    event_tags: list[EventTag] = Field(default_factory=list, max_length=50)
    fact_ids: list[str] = Field(default_factory=list, max_length=100,
        description="Copy exact Fact ids read from current valid facts. Message, Source and Blob ids are not Fact ids.")

    @model_validator(mode="after")
    def validate_change(self):
        if self.action == "remove":
            if not self.id:
                raise ValueError("Removing an event requires its existing id")
        elif not (self.content and self.content.strip() and self.fact_ids):
            raise ValueError("An event requires factual content and supporting facts")
        if len(set(self.fact_ids)) != len(self.fact_ids):
            raise ValueError("Supporting fact ids must be unique")
        return self


# Action-specific wire schemas expose required support/content to the model.
# Existing DTOs remain the single staging/commit representation.
class ProfileUpsert(ProfileMutation):
    action: Literal["upsert"]
    content: str = Field(min_length=1, max_length=8000)
    topic: str = Field(min_length=1, max_length=128)
    sub_topic: str = Field(min_length=1, max_length=256)
    fact_ids: list[str] = Field(min_length=1, max_length=100,
        description="Copy exact Fact ids from current valid facts already returned by a tool.")


class EventUpsert(EventMutation):
    action: Literal["upsert"]
    content: str = Field(min_length=1, max_length=16000)
    fact_ids: list[str] = Field(min_length=1, max_length=100,
        description="Copy exact Fact ids from current valid facts already returned by a tool.")


class RemoveMemory(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["remove"]
    id: str = Field(min_length=1, max_length=128,
        description="Copy the exact existing id returned by a read or stage tool. Never invent an id.")


@dataclass(frozen=True)
class LoopUsage:
    turns: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    elapsed_seconds: float = 0
    usage_complete: bool = True


@dataclass(frozen=True)
class LoopPlan:
    profiles: list[ProfileMutation]
    events: list[EventMutation]
    readset: ReadSet
    usage: LoopUsage


class MaintenanceContext(Protocol):
    """The worker provides scoped reads and an in-memory, run-local change set."""

    project_id: str
    user_id: str
    operation_id: UUID
    through_version: int
    changes: list[dict]
    profile_topics: list[dict]
    allowed_topics: list[str]
    event_tag_definitions: list[dict]
    language: str
    llm_model: str
    reasoning_effort: ReasoningEffort
    readset: ReadSet

    async def assert_active(self) -> None: ...

    async def read(self, collection: ReadCollection, *, ids: list[str] | None = None,
                   cursor: str | None = None, query: str | None = None,
                   limit: int = 100) -> dict: ...

    async def stage_profile(self, change: ProfileMutation) -> str: ...

    async def search(self, query: str, *, limit: int = 20) -> dict: ...

    async def stage_event(self, change: EventMutation) -> str: ...

    async def stage_batch(self, changes: list[ProfileMutation] | list[EventMutation], kind: Literal["profile", "event"]) -> dict: ...

    def get_plan(self, usage: LoopUsage) -> LoopPlan: ...

    async def read_changes(self, *, cursor: str | None = None, limit: int = 100) -> dict: ...

    blob_count: int


class MaintenanceRunError(AgentsException):
    """A fixed diagnostic code; never retain a provider response or tool arguments."""

    def __init__(self, code: str, *, retryable: bool = False):
        self.code = code
        self.retryable = retryable
        super().__init__(code)


class _StrictMaintenanceModel(OpenAIResponsesModel):
    """Validate the complete provider response before the SDK executes any tools."""

    def __init__(self, client: AsyncOpenAI, context: MaintenanceContext):
        super().__init__(model=context.llm_model, openai_client=client)
        self.context = context
        self.turns = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.usage_complete = True
        self.service_tier = "flex"

    async def _fetch_response(self, system_instructions, input, model_settings,
                              tools, output_schema, handoffs, previous_response_id=None,
                              conversation_id=None,
                              stream=False, prompt=None):
        # Maintenance is non-streaming: a complete response is needed before any tool runs.
        if stream:
            raise MaintenanceRunError("MAINTENANCE_STREAM_UNSUPPORTED")
        if conversation_id or prompt:
            raise MaintenanceRunError("MAINTENANCE_PERSISTENT_CONTEXT_UNSUPPORTED")
        # The SDK owns response chaining and incremental input. A tier fallback
        # retries the same parent/input; only a validated response advances the chain.
        while True:
            await self.context.assert_active()
            # A tier switch retries only this request, not the runner or its tools.
            # Both attempts share the run's deadline; counts are diagnostics only.
            settings = replace(model_settings, max_tokens=MAX_COMPLETION_TOKENS,
                               extra_args={**(model_settings.extra_args or {}),
                                           "service_tier": self.service_tier})
            self.turns += 1
            requested_at = time.monotonic()
            try:
                response = await super()._fetch_response(
                    system_instructions, input, settings, tools, output_schema, handoffs,
                    previous_response_id=previous_response_id, stream=False)
            except (APIConnectionError, APIStatusError) as error:
                await self._record_usage(get_error_usage(error), requested_at)
                await self.context.assert_active()
                if (previous_response_id and isinstance(error, APIStatusError)
                        and error.status_code in {400, 404}
                        and error.code == "previous_response_not_found"
                        and error.param in {None, "previous_response_id"}):
                    # Discard this run's staged plan. The existing Operation retry
                    # starts a fresh chain from current memory, not stale tool history.
                    raise MaintenanceRunError("MAINTENANCE_PARENT_UNAVAILABLE", retryable=True) from None
                if self.service_tier == "flex" and self._flex_fallback_allowed(error):
                    self.service_tier = "default"
                    continue
                raise
            transient_failure = (response.status == "failed" and response.error is not None
                and response.error.code in ("server_error", "rate_limit_exceeded")
                and response.incomplete_details is None and getattr(response, "output", None) == [])
            if not await self._record_usage(response.usage, requested_at,
                                            actual_model=response.model,
                                            service_tier=getattr(response, "service_tier", None)):
                # The pinned SDK accepts absent usage but rejects partial counters.
                # Keep our unknown marker; do not manufacture zero provider usage.
                response.usage = None
            await self.context.assert_active()
            if transient_failure and self.service_tier == "flex":
                self.service_tier = "default"
                continue
            self._validate_completion(response, {tool.name: tool.params_json_schema for tool in tools})
            names = [item.name for item in response.output if isinstance(item, ResponseFunctionToolCall)]
            LOG.info("Maintenance response: operation=%s request=%s tier=%s tools=%s elapsed_ms=%s",
                     getattr(self.context, "operation_id", None), self.turns, self.service_tier,
                     names, round((time.monotonic() - requested_at) * 1000))
            # Only a valid response ends this call; its SDK retries retain the tier.
            # The next model call starts with Flex again, on the same response chain.
            self.service_tier = "flex"
            return response

    async def _record_usage(self, usage, requested_at: float, *, actual_model=None, service_tier=None) -> bool:
        def value(obj, name):
            return obj.get(name) if isinstance(obj, dict) else getattr(obj, name, None)
        input_tokens, output_tokens, total = (value(usage, name) for name in (
            "input_tokens", "output_tokens", "total_tokens"))
        if any(tokens is not None and (type(tokens) is not int or tokens < 0)
               for tokens in (input_tokens, output_tokens, total)):
            raise MaintenanceRunError("MAINTENANCE_USAGE_INVALID")
        complete = all(tokens is not None for tokens in (input_tokens, output_tokens, total))
        if not complete:
            self.usage_complete = False
        else:
            if total != input_tokens + output_tokens:
                raise MaintenanceRunError("MAINTENANCE_USAGE_INVALID")
            self.input_tokens += input_tokens
            self.output_tokens += output_tokens
        # Failed responses can consume tokens too. Account before validation/fallback;
        # read raw provider fields before Agents SDK normalizes missing details to zero.
        details = value(usage, "input_tokens_details")
        await record_completion_usage(self.context.project_id,
                                      input_tokens if complete else None,
                                      output_tokens if complete else None,
                                      (time.monotonic() - requested_at) * 1000,
                                      kind="agent_loop", model=actual_model or self.model,
                                      service_tier=service_tier,
                                      requested_service_tier=self.service_tier,
                                      cached_tokens=value(details, "cached_tokens"),
                                      cache_write_tokens=value(details, "cache_write_tokens"))
        if output_tokens is not None and output_tokens > MAX_COMPLETION_TOKENS:
            raise MaintenanceRunError("MAINTENANCE_COMPLETION_LENGTH")
        return complete

    @staticmethod
    def _flex_fallback_allowed(error) -> bool:
        if isinstance(error, APIConnectionError):
            return True
        if error.status_code in {408, 429} or 500 <= error.status_code < 600:
            return True
        if error.status_code != 400 or error.param != "service_tier":
            return False
        # A generic invalid model/key/prompt must not be disguised as unavailable Flex.
        message = error.body.get("message") if isinstance(error.body, dict) else None
        if not isinstance(message, str):
            return False
        message = message.casefold()
        return "flex" in message and any(reason in message for reason in (
            "not supported", "does not support", "unsupported", "not allowed", "not enabled"))

    def get_retry_advice(self, request: ModelRetryAdviceRequest) -> ModelRetryAdvice:
        # conversation_locked reaches this hook after the pinned Runner's three retries.
        # Let it replay the rejected request once in Standard, preserving its parent,
        # input and tool progress instead of restarting the Agent or tracking retries.
        if not isinstance(request.error, BadRequestError) or request.error.code != "conversation_locked":
            return ModelRetryAdvice(suggested=False)
        if self.service_tier != "flex":
            raise MaintenanceRunError("MAINTENANCE_CONVERSATION_LOCKED", retryable=True) from None
        self.service_tier = "default"
        return ModelRetryAdvice(suggested=True, replay_safety="safe", retry_after=0)

    @staticmethod
    def _validate_completion(response: Response, tool_schemas: dict[str, dict]) -> None:
        if response.status != "completed" or response.error or response.incomplete_details:
            reason = getattr(response.incomplete_details, "reason", None)
            code = {"max_output_tokens": "MAINTENANCE_COMPLETION_LENGTH",
                    "content_filter": "MAINTENANCE_COMPLETION_FILTERED"}.get(
                        reason, "MAINTENANCE_COMPLETION_INCOMPLETE")
            raise MaintenanceRunError(code, retryable=response.status == "failed")
        if (getattr(response, "object", None) != "response" or
                not isinstance(getattr(response, "id", None), str) or not response.id.strip() or
                not isinstance(getattr(response, "output", None), list)):
            raise MaintenanceRunError("MAINTENANCE_COMPLETION_CONTENT")
        call_ids = set()
        messages = []
        for item in response.output:
            if not isinstance(item, (ResponseFunctionToolCall, ResponseOutputMessage, ResponseReasoningItem,
                                     ResponseCompactionItem)):
                raise MaintenanceRunError("MAINTENANCE_COMPLETION_CONTENT")
            # The transport uses SDK model_construct; strictly validate items before
            # the runner can normalize malformed arguments or incomplete messages.
            try:
                type(item).model_validate(item.model_dump(warnings=False), strict=True)
            except ValidationError:
                raise MaintenanceRunError("MAINTENANCE_COMPLETION_CONTENT") from None
            if isinstance(item, ResponseFunctionToolCall):
                if (item.status not in (None, "completed") or item.name not in tool_schemas or
                        not item.call_id or item.call_id in call_ids or item.namespace or
                        (item.caller is not None and item.caller.type != "direct")):
                    raise MaintenanceRunError("MAINTENANCE_COMPLETION_TOOLS")
                call_ids.add(item.call_id)
                try:
                    args = json.loads(item.arguments)
                except (ValueError, TypeError):
                    raise MaintenanceRunError("MAINTENANCE_TOOL_ARGUMENTS") from None
                if not isinstance(args, dict):
                    raise MaintenanceRunError("MAINTENANCE_TOOL_ARGUMENTS")
                # The SDK's generated argument model ignores unknown top-level keys;
                # reject them before dispatch so ownership cannot be model-supplied.
                if args.keys() - tool_schemas[item.name]["properties"].keys():
                    raise MaintenanceRunError("MAINTENANCE_TOOL_ARGUMENTS")
            elif isinstance(item, ResponseCompactionItem):
                if not item.id or not item.encrypted_content:
                    raise MaintenanceRunError("MAINTENANCE_COMPACTION_INVALID")
            elif isinstance(item, ResponseOutputMessage):
                if item.status != "completed" or not item.content:
                    raise MaintenanceRunError("MAINTENANCE_COMPLETION_CONTENT")
                for content in item.content:
                    if isinstance(content, ResponseOutputRefusal):
                        raise MaintenanceRunError("MAINTENANCE_COMPLETION_REFUSED")
                    if not isinstance(content, ResponseOutputText) or not isinstance(content.text, str):
                        raise MaintenanceRunError("MAINTENANCE_COMPLETION_CONTENT")
                messages.append(item)
            else:
                if item.status not in (None, "completed"):
                    raise MaintenanceRunError("MAINTENANCE_COMPLETION_INCOMPLETE")
                # Stored Responses retain reasoning; an encrypted replay payload
                # is not required for this stateful tool chain.
        if not call_ids and (not messages or any(item.phase == "commentary" for item in messages)):
            raise MaintenanceRunError("MAINTENANCE_COMPLETION_CONTENT")


MAINTENANCE_INSTRUCTIONS = (
    Path(__file__).parent / "prompts" / "maintenance.md"
).read_text(encoding="utf-8").strip()


def _maintenance_tools():
    # Only overlapping target IDs need ordered staging. New entries and independent
    # targets/collections remain concurrent; this finite run owns these small locks.
    writes = {}

    @asynccontextmanager
    async def write_targets(collection, changes):
        async with AsyncExitStack() as stack:
            for ident in sorted({change.id for change in changes if change.id is not None}):
                await stack.enter_async_context(writes.setdefault((collection, ident), asyncio.Lock()))
            yield

    @function_tool(failure_error_function=None)
    async def read_memory(ctx: RunContextWrapper[MaintenanceContext],
                          collection: ReadCollection, ids: ReadIds | None = None,
                          cursor: str | None = None, query: ToolQuery | None = None,
                          limit: PageLimit = 100) -> dict:
        """Read current-user entries. ids must be exact returned UUIDs, never names/labels.

        query is a literal, case-insensitive substring within one field, not a
        keyword list or semantic query. Use a known name, topic or text fragment;
        use search_memory for discovery. ids=null pages through matches, or entries
        linked to this flush's changes when query is also null. Use linked pages
        to cover deletion/evidence/time changes, not as a routine first step for additions.
        Also use them when recovery finds that an originally added Fact is now absent.
        An empty linked page does not rule out other existing entries; discover
        related memory before creating a new entry unless it was already returned.
        All pages preserve complete entry text. Follow next_cursor.
        The memory cursor is the last returned ID, not an offset; byte-sized pages
        may contain fewer than limit. pending_delete entries remain visible for
        navigation/rewrite, but their old text is not evidence. Only current Fact
        entries and evidence returned from those Fact rows can support new content.
        Profile/Event pages include bounded current supporting Facts in evidence,
        shared by fact_ids once per page. Only fetch missing support if needed.
        Returned entries and Facts are registered for use without an exact-ID reread.
        """
        if not 1 <= limit <= MAX_PAGE_SIZE or (ids is not None and len(ids) > MAX_PAGE_SIZE):
            LOG.warning("Maintenance bound rejected: tool=read_memory limit=%s id_count=%s", limit, len(ids or []))
            raise MaintenanceRunError("MAINTENANCE_READ_LIMIT")
        if query is not None and len(query) > 500:
            LOG.warning("Maintenance bound rejected: tool=read_memory query_chars=%s", len(query))
            raise MaintenanceRunError("MAINTENANCE_READ_LIMIT")
        await ctx.context.assert_active()
        data = await ctx.context.read(collection, ids=ids, cursor=cursor, query=query, limit=limit)
        await ctx.context.assert_active()
        if not isinstance(data, dict) or not isinstance(data.get("items"), list):
            raise MaintenanceRunError("MAINTENANCE_READ_CONTRACT")
        if len(data["items"]) > limit:
            raise MaintenanceRunError("MAINTENANCE_READ_LIMIT")
        return data

    @function_tool(failure_error_function=None)
    async def search_memory(ctx: RunContextWrapper[MaintenanceContext], query: ToolQuery,
                            limit: SearchLimit = 20) -> dict:
        """Search current-user facts by meaning and words, with related profiles/events.

        Use natural-language questions or multiple keywords to discover relevant memory,
        including existing entries related to added statements before creating new ones.
        Ranked results do not replace complete linked paging for deletion/evidence/time changes.
        Results are complete current entries, already registered for version checks;
        do not read the same entries again. Use read_memory only for additional exact
        IDs, paging or literal text filters. Empty results need no confirmation.
        Supporting Facts are shared once across facts/evidence; fetch missing support only if needed.
        """
        if not query.strip() or len(query) > 500 or not 1 <= limit <= MAX_SEARCH_RESULTS:
            LOG.warning("Maintenance bound rejected: tool=search_memory limit=%s query_chars=%s", limit, len(query))
            raise MaintenanceRunError("MAINTENANCE_READ_LIMIT")
        await ctx.context.assert_active()
        data = await ctx.context.search(query, limit=limit)
        await ctx.context.assert_active()
        if not isinstance(data, dict) or set(data) != {"facts", "profiles", "events"}:
            raise MaintenanceRunError("MAINTENANCE_READ_CONTRACT")
        if any(not isinstance(items, list) or len(items) > limit for items in data.values()):
            raise MaintenanceRunError("MAINTENANCE_READ_LIMIT")
        return data

    @function_tool(failure_error_function=None)
    async def stage_profile(ctx: RunContextWrapper[MaintenanceContext],
                            changes: list[ProfileUpsert | RemoveMemory]) -> dict:
        """Stage supported profile updates/removals in a byte-bounded batch; commit both collections together."""
        if not 1 <= len(changes) <= MAX_PAGE_SIZE or json_size([change.model_dump() for change in changes]) > MAX_TOOL_BYTES:
            raise MaintenanceRunError("MAINTENANCE_CHANGE_LIMIT")
        async with write_targets("profiles", changes):
            await ctx.context.assert_active()
            if any(change.action == "upsert" and change.topic not in ctx.context.allowed_topics for change in changes):
                raise MaintenanceRunError("MAINTENANCE_PROFILE_TOPIC")
            result = await ctx.context.stage_batch([ProfileMutation(**change.model_dump()) for change in changes], "profile")
            await ctx.context.assert_active()
            return result

    @function_tool(failure_error_function=None)
    async def stage_event(ctx: RunContextWrapper[MaintenanceContext],
                          changes: list[EventUpsert | RemoveMemory]) -> dict:
        """Stage supported event updates/removals in a byte-bounded batch; commit both collections together."""
        if not 1 <= len(changes) <= MAX_PAGE_SIZE or json_size([change.model_dump() for change in changes]) > MAX_TOOL_BYTES:
            raise MaintenanceRunError("MAINTENANCE_CHANGE_LIMIT")
        async with write_targets("events", changes):
            await ctx.context.assert_active()
            changes = [EventMutation(**change.model_dump()) for change in changes]
            allowed_tags = {definition["name"] for definition in ctx.context.event_tag_definitions}
            if any(tag.tag not in allowed_tags for change in changes for tag in change.event_tags):
                raise MaintenanceRunError("MAINTENANCE_EVENT_TAG")
            result = await ctx.context.stage_batch(changes, "event")
            await ctx.context.assert_active()
            return result

    @function_tool(failure_error_function=None)
    async def read_changes(ctx: RunContextWrapper[MaintenanceContext],
                           cursor: str | None = None, limit: PageLimit = 100) -> dict:
        """Read fixed Fact changes with current facts (null means absent/deleted); follow every next_cursor before finishing."""
        if not 1 <= limit <= MAX_PAGE_SIZE:
            LOG.warning("Maintenance bound rejected: tool=read_changes limit=%s", limit)
            raise MaintenanceRunError("MAINTENANCE_READ_LIMIT")
        await ctx.context.assert_active()
        result = await ctx.context.read_changes(cursor=cursor, limit=limit)
        await ctx.context.assert_active()
        return result

    return [read_changes, read_memory, search_memory, stage_profile, stage_event]


def _new_client() -> AsyncOpenAI:
    if CONFIG.llm_style != "openai" or not CONFIG.llm_api_key:
        raise MaintenanceRunError("MAINTENANCE_MODEL_CONFIG")
    return AsyncOpenAI(api_key=CONFIG.llm_api_key, base_url=CONFIG.llm_base_url,
                       default_query=CONFIG.llm_openai_default_query,
                       default_headers=CONFIG.llm_openai_default_header,
                       max_retries=0, timeout=REQUEST_TIMEOUT_SECONDS)


class _ToolUsageHooks(RunHooks):
    """Use SDK hooks for bounded numeric diagnostics, never arguments or tool text."""

    def __init__(self, model):
        self.model = model

    async def on_tool_start(self, context, agent, tool):
        LOG.info("Maintenance tool: operation=%s request=%s tool=%s status=start",
                 getattr(context.context, "operation_id", None), self.model.turns, tool.name)

    async def on_tool_end(self, context, agent, tool, result):
        counts = {key: len(value) for key, value in result.items() if isinstance(value, list)} if isinstance(result, dict) else {}
        status = "rejected" if isinstance(result, dict) and result.get("staged") is False else "completed"
        LOG.info("Maintenance tool: operation=%s request=%s tool=%s status=%s counts=%s",
                 getattr(context.context, "operation_id", None), self.model.turns, tool.name, status, counts)


async def run_loop(context: MaintenanceContext) -> LoopPlan:
    """Produce a complete staged plan; only the worker may commit it to PostgreSQL."""
    started = time.monotonic()
    # No current-user timezone contract exists. Never infer it from historical
    # messages or arbitrary user metadata; capture a labelled service reference once.
    reference_zone = CONFIG.use_timezone or "UTC"
    try:
        reference_tz = ZoneInfo(reference_zone)
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        reference_zone, reference_tz = "UTC", timezone.utc
        LOG.warning("Invalid maintenance reference timezone; using UTC")
    reference_time = {"current_date": datetime.now(reference_tz).date().isoformat(),
                      "time_zone": reference_zone, "time_zone_source": "service_default"}
    client = _new_client()
    model = _StrictMaintenanceModel(client, context)
    # Each execution starts a new Responses chain. Its IDs stay run-local;
    # recovery reads current database state instead of resuming an old model chain.
    cache_supported = supports_prompt_cache_options(context.llm_model)
    LOG.info("Prompt cache contract: kind=agent_loop enabled=%s", cache_supported)
    # Instructions are sent every round; only dynamic data enters the stored chain.
    request = [developer_data("project_context", {
        "profile_topics": context.profile_topics, "event_tag_definitions": context.event_tag_definitions,
        "language": context.language, "reference_time": reference_time}, cache=cache_supported),
        developer_data("maintenance_batch", {"through_version": context.through_version,
            "blob_count": context.blob_count, "change_count": len(context.changes)})]
    try:
        async with asyncio.timeout(MAX_SECONDS):
            await context.assert_active()
            agent = Agent[MaintenanceContext](
                name="Memoia memory maintenance",
                instructions=MAINTENANCE_INSTRUCTIONS,
                model=model,
                model_settings=ModelSettings(parallel_tool_calls=True,
                                             reasoning=Reasoning(effort=context.reasoning_effort),
                                             retry=ModelRetrySettings(max_retries=1,
                                                 policy=retry_policies.provider_suggested()),
                                             store=True, truncation="disabled",
                                             prompt_cache_options=({"mode": "implicit", "ttl": "30m"}
                                                 if cache_supported else None),
                                             extra_args=({"prompt_cache_key": loop_cache_key(
                                                 context.project_id, context.user_id, str(context.operation_id))}
                                                 if cache_supported else None),
                                             context_management=[{"type": "compaction", "compact_threshold": COMPACT_THRESHOLD}]),
                tools=_maintenance_tools(),
            )
            await Runner.run(agent, request, context=context, max_turns=None,
                             auto_previous_response_id=True,
                             hooks=_ToolUsageHooks(model),
                             run_config=RunConfig(tracing_disabled=True,
                                                  trace_include_sensitive_data=False,
                                                  tool_execution=ToolExecutionConfig(
                                                      max_function_tool_concurrency=4)))
            await context.assert_active()
            return context.get_plan(LoopUsage(
                turns=model.turns, input_tokens=model.input_tokens,
                output_tokens=model.output_tokens, elapsed_seconds=time.monotonic() - started,
                usage_complete=model.usage_complete))
    except TimeoutError:
        raise MaintenanceRunError("MAINTENANCE_TIMEOUT", retryable=True) from None
    except UserError as error:
        # The SDK wraps exceptions from context tools. Preserve the original caller
        # error for its retry owner; do not classify it by parsing SDK error text.
        if error.__cause__ is not None:
            raise error.__cause__
        raise
    except Exception as error:
        LOG.warning("Maintenance run failed: operation=%s requests=%s error_type=%s",
                    getattr(context, "operation_id", None), model.turns, type(error).__name__)
        raise
    finally:
        await client.close()
