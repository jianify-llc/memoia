/** Agents SDK owns tool execution; the adapter preserves one native Responses chain per attempt. */
import {
  Agent,
  Runner,
  ToolCallError,
  retryPolicies,
  tool,
  type ModelRequest,
} from "@openai/agents-core";
import { OpenAIResponsesModel } from "@openai/agents-openai";
import OpenAI from "openai";
import {
  SliceBudget,
  TaskYield,
  TaskLeaseLost,
  TaskTimeout,
} from "@jianify/legato";
import { z } from "zod";
import instructions from "../prompts/maintenance.md";
import { inSpan } from "./observability.js";
import {
  provider,
  recordUsage,
  errorUsage,
  supportsPromptCache,
} from "./models.js";
import { SourceError } from "./errors.js";
import {
  type Collection,
  type MaintenanceContext,
  type Mutation,
} from "./maintenance.js";

export async function maintenancePromptHash(): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(instructions),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export class References {
  private ids: Record<Collection, Map<string, string>> = {
    facts: new Map(),
    profiles: new Map(),
    events: new Map(),
  };
  private refs: Record<Collection, Map<string, string>> = {
    facts: new Map(),
    profiles: new Map(),
    events: new Map(),
  };
  snapshot(): Record<Collection, string[]> {
    return {
      facts: [...this.ids.facts.keys()],
      profiles: [...this.ids.profiles.keys()],
      events: [...this.ids.events.keys()],
    };
  }
  static restore(snapshot: Record<Collection, string[]>): References {
    const result = new References();
    for (const kind of ["facts", "profiles", "events"] as const) {
      if (!Array.isArray(snapshot[kind])) throw new Error("Invalid references");
      for (const id of snapshot[kind]) {
        if (typeof id !== "string" || !id || result.ids[kind].has(id))
          throw new Error("Invalid references");
        result.encode(kind, id);
      }
    }
    return result;
  }
  encode(kind: Collection, id: string): string {
    const found = this.ids[kind].get(id);
    if (found) return found;
    const ref = `${kind[0]}${this.ids[kind].size + 1}`;
    this.ids[kind].set(id, ref);
    this.refs[kind].set(ref, id);
    return ref;
  }
  decode(kind: Collection, ref: string): string {
    const id = this.refs[kind].get(ref);
    if (!id)
      throw new SourceError(
        "maintenance_reference_invalid",
        "Use the references returned in this execution",
        502,
      );
    return id;
  }
  entry(
    kind: Collection,
    item: Record<string, unknown>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {
      ...item,
      id: this.encode(kind, String(item.id)),
    };
    for (const field of ["fact_ids", "invalid_fact_ids"])
      if (Array.isArray(result[field]))
        result[field] = (result[field] as string[]).map((id) =>
          this.encode("facts", id),
        );
    if (Array.isArray(result.evidence))
      result.evidence = result.evidence.map((f) => this.entry("facts", f));
    return result;
  }
  progress(value: Record<string, unknown>): Record<string, unknown> {
    const result = { ...value };
    if (value.remaining_review)
      result.remaining_review = Object.fromEntries(
        Object.entries(value.remaining_review).map(([kind, v]) => {
          const group = v as { count: number; ids: string[] };
          return [
            kind,
            {
              ...group,
              ids: group.ids.map((id) => this.encode(kind as Collection, id)),
            },
          ];
        }),
      );
    return result;
  }
  changes(page: {
    items: unknown[];
    next_cursor: string | null;
    remaining_review: unknown;
  }) {
    return this.progress({
      ...page,
      items: page.items.map((raw) => {
        const c = raw as Record<string, unknown>;
        return {
          ...c,
          ...(c.fact_id
            ? { fact_id: this.encode("facts", String(c.fact_id)) }
            : {}),
          current_fact: c.current_fact
            ? this.entry("facts", c.current_fact as Record<string, unknown>)
            : null,
        };
      }),
    });
  }
}
export class MaintenanceModel extends OpenAIResponsesModel {
  private previous: OpenAI.Responses.Response | null = null;
  private requests = 0;
  constructor(
    client: OpenAI,
    readonly context: MaintenanceContext,
    readonly continuation?: {
      budget: SliceBudget;
      resume?: { parentId: string; callIds: string[] };
      boundary: (value: {
        parentId: string;
        callIds: string[];
        input: unknown[];
      }) => Promise<void>;
    },
  ) {
    super(client, context.config.llm_model);
    if (continuation?.resume) {
      this.previous = {
        id: continuation.resume.parentId,
        output: continuation.resume.callIds.map((call_id) => ({
          type: "function_call",
          call_id,
        })),
      } as OpenAI.Responses.Response;
    }
  }
  protected override _buildResponsesCreateRequest(
    request: ModelRequest,
    stream: boolean,
  ) {
    const built = super._buildResponsesCreateRequest(request, stream);
    const body = built.requestData;
    // This SDK lacks Python's automatic parent continuation. Only the last call's native results are sent.
    body.instructions = instructions;
    delete body.prompt_cache_key;
    body.input = (body.input ?? []).map((item: Record<string, unknown>) =>
      item.role === "system" ? { ...item, role: "developer" } : item,
    );
    const cacheEnabled = supportsPromptCache(
      this.context.runtime,
      this.context.config.llm_model,
    );
    if (cacheEnabled)
      body.prompt_cache_options = {
        mode: "implicit",
        ttl: "30m",
        ...(body.previous_response_id
          ? { comparison_response_id: body.previous_response_id }
          : {}),
      };
    if (cacheEnabled && !body.previous_response_id)
      body.input = [
        {
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "---",
              prompt_cache_breakpoint: { mode: "explicit", ttl: "12h" },
            },
          ],
        },
        ...(body.input ?? []),
      ];
    return built;
  }
  protected override async _fetchResponse(
    request: ModelRequest,
    stream: false,
  ): Promise<OpenAI.Responses.Response> {
    await this.context.active();
    let next = request;
    if (this.previous) {
      const calls = this.previous.output.filter(
        (v) => v.type === "function_call",
      );
      const ids = new Set(calls.map((c) => c.call_id));
      const input = (
        typeof request.input === "string" ? [] : request.input
      ).filter(
        (item) => item.type === "function_call_result" && ids.has(item.callId),
      );
      if (
        ids.size !== calls.length ||
        input.length !== ids.size ||
        new Set(
          input.map((item) =>
            item.type === "function_call_result" ? item.callId : null,
          ),
        ).size !== ids.size
      )
        throw new SourceError(
          "maintenance_tool_results_incomplete",
          "Native tool results are incomplete",
          502,
        );
      if (this.continuation) {
        await this.continuation.boundary({
          parentId: this.previous.id,
          callIds: [...ids],
          input,
        });
        if (this.continuation.budget.shouldYield(30_000)) throw new TaskYield();
      }
      next = { ...request, input, previousResponseId: this.previous.id };
    }
    let providerFailure: SourceError | undefined;
    for (const tier of ["flex", "default"] as const) {
      await this.context.active();
      const started = Date.now();
      const requestNumber = ++this.requests;
      try {
        const response = await inSpan(
          this.context.runtime.tracing,
          "memoia.model",
          { kind: "agent_loop", operation_id: this.context.claim.id },
          () =>
            super._fetchResponse(
              {
                ...next,
                modelSettings: {
                  ...next.modelSettings,
                  providerData: {
                    ...next.modelSettings.providerData,
                    service_tier: tier,
                  },
                  timeoutMs: this.continuation
                    ? this.continuation.budget.requestTimeout(600_000)
                    : Math.min(
                        600_000,
                        this.context.runtime.deadline - Date.now() - 30_000,
                      ),
                },
              },
              false,
            ),
        );
        recordCacheDiagnostics(response, this.context.claim.id, requestNumber);
        await recordUsage(
          this.context.runtime,
          this.context.claim.projectId,
          response.usage,
          "agent_loop",
          {
            model: response.model,
            service_tier: response.service_tier,
            requested_service_tier: tier,
          },
        );
        if (
          response.status !== "completed" ||
          response.error ||
          response.incomplete_details
        ) {
          if (
            tier === "flex" &&
            response.status === "failed" &&
            !response.output.length &&
            ["server_error", "rate_limit_exceeded"].includes(
              response.error?.code ?? "",
            )
          ) {
            providerFailure = new SourceError(
              "model_unavailable",
              "Maintenance provider request failed",
              503,
              true,
            );
            continue;
          }
          throw new SourceError(
            "maintenance_model_incomplete",
            "Maintenance response did not complete",
            502,
            true,
          );
        }
        for (const item of response.output) {
          if (
            item.type === "reasoning" ||
            item.type === "function_call" ||
            item.type === "compaction"
          )
            continue;
          if (
            item.type !== "message" ||
            item.status !== "completed" ||
            item.content.some((c) => c.type !== "output_text")
          )
            throw new SourceError(
              "maintenance_model_invalid",
              "Unexpected maintenance output",
              502,
            );
        }
        await this.context.active();
        this.previous = response;
        console.info(
          JSON.stringify({
            event: "maintenance_response",
            operation_id: this.context.claim.id,
            tier,
            elapsed_ms: Date.now() - started,
            tool_names: response.output
              .filter((v) => v.type === "function_call")
              .map((v) => v.name),
          }),
        );
        return response;
      } catch (error) {
        if (error instanceof TaskYield && providerFailure)
          throw providerFailure;
        if (error instanceof OpenAI.APIError)
          await recordUsage(
            this.context.runtime,
            this.context.claim.projectId,
            errorUsage(error),
            "agent_loop",
          );
        if (
          error instanceof OpenAI.APIError &&
          [400, 404].includes(error.status ?? 0) &&
          error.code === "previous_response_not_found"
        )
          throw new SourceError(
            "maintenance_parent_unavailable",
            "Response parent is unavailable; recover original Operation",
            503,
            true,
          );
        if (this.context.runtime.signal?.aborted)
          throw new SourceError(
            "maintenance_timeout",
            "Maintenance attempt was interrupted",
            503,
            true,
          );
        const transient =
          error instanceof OpenAI.APIConnectionError ||
          (error instanceof OpenAI.APIError &&
            ([408, 429].includes(error.status ?? 0) ||
              (error.status ?? 0) >= 500 ||
              ((error.status ?? 0) === 400 &&
                (error.param === "service_tier" ||
                  error.code === "conversation_locked"))));
        if (tier === "flex" && transient) {
          providerFailure = new SourceError(
            "model_unavailable",
            "Maintenance provider request failed",
            503,
            true,
          );
          continue;
        }
        if (error instanceof OpenAI.APIError)
          throw new SourceError(
            "model_unavailable",
            "Maintenance provider request failed",
            503,
            transient,
          );
        throw error;
      }
    }
    throw new SourceError(
      "model_unavailable",
      "Maintenance provider request failed",
      503,
      true,
    );
  }
}
const cacheDiagnosticTypes = new Set([
  "cache_hit",
  "cache_miss",
  "comparison_response_not_found",
  "unavailable",
]);
const cacheMissReasons = new Set([
  "model_changed",
  "prompt_cache_key_changed",
  "service_tier_changed",
  "tools_changed",
  "text_format_changed",
  "reasoning_effort_changed",
  "verbosity_changed",
  "context_compacted",
  "input_changed",
]);
function recordCacheDiagnostics(
  response: OpenAI.Responses.Response,
  operationId: string,
  request: number,
) {
  // Provider diagnostics and the logging sink never determine completion or retry.
  try {
    const diagnostic: unknown = response.prompt_cache_diagnostics;
    if (!diagnostic || typeof diagnostic !== "object") return;
    const value = diagnostic as Record<string, unknown>;
    if (typeof value.type !== "string" || !cacheDiagnosticTypes.has(value.type))
      return;
    const count = (name: string) => {
      const n = value[name];
      return typeof n === "number" && Number.isSafeInteger(n) && n >= 0
        ? n
        : null;
    };
    console.info(
      JSON.stringify({
        event: "llm_cache_diagnostic",
        kind: "agent_loop",
        operation_id: operationId,
        request,
        type: value.type,
        reason:
          value.type === "cache_miss"
            ? typeof value.reason === "string" &&
              cacheMissReasons.has(value.reason)
              ? value.reason
              : "unknown"
            : null,
        comparison_reusable_tokens:
          value.type === "cache_miss"
            ? count("comparison_reusable_tokens")
            : null,
        cache_missed_tokens:
          value.type === "cache_miss" ? count("cache_missed_tokens") : null,
      }),
    );
  } catch {}
}
const ref = z.string().min(1).max(128);
const decision = z
  .object({ action: z.enum(["keep", "remove"]), id: ref })
  .strict();
const support = z.array(ref).min(1).max(100);
const providerRetry = retryPolicies.providerSuggested();
const profile = z
  .object({
    action: z.literal("upsert"),
    id: ref.nullable().optional(),
    content: z.string().min(1).max(8000),
    topic: z.string().min(1).max(128),
    sub_topic: z.string().min(1).max(256),
    fact_ids: support,
  })
  .strict();
const event = z
  .object({
    action: z.literal("upsert"),
    id: ref.nullable().optional(),
    content: z.string().min(1).max(16000),
    title: z.string().max(500).nullable().optional(),
    summary: z.string().max(4000).nullable().optional(),
    keywords: z.string().max(1000).nullable().optional(),
    event_time: z.string().max(1000).nullable().optional(),
    location: z.string().max(1000).nullable().optional(),
    interpretation: z.string().max(4000).nullable().optional(),
    event_tags: z
      .array(z.object({ tag: z.string(), value: z.string() }))
      .max(50)
      .optional(),
    fact_ids: support,
  })
  .strict();
function xml(name: string, value: unknown): string {
  return `<${name} source="memoia">${JSON.stringify(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</${name}>`;
}
export type MaintenanceContinuation = {
  budget: SliceBudget;
  referenceTime: {
    current_date: string;
    time_zone: string;
    time_zone_source: string;
  };
  resume?: {
    parentId: string;
    callIds: string[];
    input: unknown[];
    refs: Record<Collection, string[]>;
  };
  save: (checkpoint: {
    phase: "agent_running" | "agent_completed";
    state: ReturnType<MaintenanceContext["snapshot"]>;
    refs: Record<Collection, string[]>;
    referenceTime: MaintenanceContinuation["referenceTime"];
    parentId?: string;
    callIds?: string[];
    input?: unknown[];
  }) => Promise<void>;
};
export async function runMaintenance(
  context: MaintenanceContext,
  continuation?: MaintenanceContinuation,
): Promise<void> {
  const refs = continuation?.resume
    ? References.restore(continuation.resume.refs)
    : new References();
  const first = continuation?.resume
    ? null
    : refs.changes(await context.readChanges());
  const read = tool({
    name: "read_memory",
    description:
      "Read complete entries by references, or query a literal name/topic/phrase in the selected user collection. No ids/query means only this batch's linked entries. Pages include current support when budget allows; follow next_cursor. Required decisions withhold old prose: rebuild from current support or remove.",
    parameters: z.object({
      collection: z.enum(["facts", "profiles", "events"]),
      ids: z.array(ref).max(200).nullable(),
      cursor: ref.nullable(),
      query: z.string().max(500).nullable(),
      limit: z.number().int().min(1).max(200),
    }),
    errorFunction: null,
    execute: async (args) => {
      const page = await context.read(
        args.collection,
        args.ids?.map((r) => refs.decode(args.collection, r)) ?? null,
        args.cursor ? refs.decode(args.collection, args.cursor) : null,
        args.query,
        args.limit,
      );
      return refs.progress({
        ...page,
        items: page.items.map((item) => refs.entry(args.collection, item)),
        next_cursor: page.next_cursor
          ? refs.encode(args.collection, page.next_cursor)
          : null,
      });
    },
  });
  const changes = tool({
    name: "read_changes",
    description:
      "Read only the remaining fixed Fact change pages. First page is already supplied; follow its next_cursor.",
    parameters: z.object({
      cursor: z.string().nullable(),
      limit: z.number().int().min(1).max(200),
    }),
    errorFunction: null,
    execute: async (args) =>
      refs.changes(await context.readChanges(args.cursor, args.limit)),
  });
  const search = tool({
    name: "search_memory",
    description:
      "Search this user's current Facts by meaning and words, with linked Profiles and Events. Use results already read; this ranked search does not replace mandatory complete reads.",
    parameters: z.object({
      query: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(20),
    }),
    errorFunction: null,
    execute: async (args) => {
      const { search: query } = await import("./retrieval.js");
      const hits = await query(context.runtime, context.claim, {
        query: args.query,
        limit: args.limit,
        max_token_size: 8192,
      });
      const output: Record<string, unknown> = {};
      for (const kind of ["facts", "profiles", "events"] as const) {
        const ids = (hits[kind] ?? []).map((r: { id: string }) => r.id);
        output[kind] = ids.length
          ? (await context.read(kind, ids, null, null, args.limit)).items.map(
              (i) => refs.entry(kind, i),
            )
          : [];
      }
      return refs.progress({
        ...output,
        remaining_review: context.remaining(),
      });
    },
  });
  function stage(kind: "profiles" | "events") {
    return tool({
      name: kind === "profiles" ? "stage_profile" : "stage_event",
      description: `Save proposed ${kind} in this execution. Use upsert with complete current supporting Fact references; keep requires the full target and valid original support read; remove deletes the target at final atomic commit. Errors must be resolved before completion.`,
      parameters: z.object({
        changes: z
          .array(
            kind === "profiles"
              ? z.union([profile, decision])
              : z.union([event, decision]),
          )
          .min(1)
          .max(100),
      }),
      errorFunction: null,
      execute: async (args) => {
        const decoded: Mutation[] = args.changes.map((c) => ({
          ...c,
          id: c.id ? refs.decode(kind, c.id) : null,
          ...("fact_ids" in c
            ? { fact_ids: c.fact_ids.map((f) => refs.decode("facts", f)) }
            : {}),
        }));
        const result = await context.stage(kind, decoded);
        return refs.progress({
          ...result,
          ids: result.ids.map((id) => refs.encode(kind, id)),
          ...(result.error
            ? {
                error: {
                  ...result.error,
                  unread_fact_ids: result.error.unread_fact_ids.map((id) =>
                    refs.encode("facts", id),
                  ),
                  invalid_fact_ids: result.error.invalid_fact_ids.map((id) =>
                    refs.encode("facts", id),
                  ),
                },
              }
            : {}),
        });
      },
    });
  }
  const model = new MaintenanceModel(
    provider(context.runtime, fetch, 600_000),
    context,
    continuation && {
      budget: continuation.budget,
      resume: continuation.resume,
      boundary: async (value) =>
        continuation.save({
          phase: "agent_running",
          state: context.snapshot(),
          refs: refs.snapshot(),
          referenceTime: continuation.referenceTime,
          ...value,
        }),
    },
  );
  const agent = new Agent({
    name: "Memoia memory maintenance",
    instructions,
    model,
    tools: [changes, read, search, stage("profiles"), stage("events")],
    modelSettings: {
      parallelToolCalls: true,
      maxTokens: 32768,
      store: true,
      truncation: "disabled",
      reasoning: {
        effort: context.config.reasoning_effort as "high",
        mode: "standard",
      },
      text: { verbosity: "low" },
      contextManagement: [{ type: "compaction", compactThreshold: 256000 }],
      retry: {
        maxRetries: 1,
        policy: (context) =>
          context.error instanceof TaskYield ||
          context.error instanceof TaskLeaseLost ||
          context.error instanceof TaskTimeout ||
          (context.error instanceof SourceError &&
            !!continuation &&
            continuation.budget.shouldYield(
              30_000 +
                (context.providerAdvice?.retryAfterMs ??
                  context.normalized.retryAfterMs ??
                  0),
            )) ||
          (context.error instanceof SourceError &&
            (context.error.code !== "model_unavailable" ||
              !context.error.retryable))
            ? false
            : providerRetry(context),
      },
    },
  });
  const reference_time = continuation?.referenceTime ?? {
    current_date: new Intl.DateTimeFormat("en-CA", {
      timeZone: context.config.use_timezone ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()),
    time_zone: context.config.use_timezone ?? "UTC",
    time_zone_source: "service_default",
  };
  const input = continuation?.resume?.input ?? [
    {
      role: "system" as const,
      content: xml("project_context", {
        profile_topics: context.config.profile_topics,
        event_tag_definitions: context.config.event_tag_definitions,
        language: context.config.language,
        reference_time,
      }),
    },
    {
      role: "system" as const,
      content: xml("maintenance_batch", {
        change_count: context.claim.changes.length,
        ...first,
      }),
    },
  ];
  try {
    await new Runner({
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
      toolExecution: { maxFunctionToolConcurrency: 4 },
    }).run(agent, input as never, {
      maxTurns: null,
      signal: context.runtime.signal,
    });
    if (continuation)
      await continuation.save({
        phase: "agent_completed",
        state: context.snapshot(),
        refs: refs.snapshot(),
        referenceTime: continuation.referenceTime,
      });
  } catch (error) {
    // Preserve the original domain/SQL failure for the Operation's retry policy.
    throw error instanceof ToolCallError ? error.error : error;
  }
}
