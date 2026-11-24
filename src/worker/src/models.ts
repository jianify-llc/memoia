/** Provider requests share fixed prompts and numerical usage; no model text enters logs. */
import OpenAI from "openai";
import { setTimeout as delay } from "node:timers/promises";
import { addUsage, debitBilling, type Sql, type UserScope } from "./db.js";
import defaultTopics from "./default-topics.json";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { parse } from "yaml";
import { assertRunning, usesOpenAIBaseUrl, type Runtime } from "./runtime.js";
import { SourceError } from "./errors.js";
import { inSpan } from "./observability.js";
import { readServiceConfig } from "./config.js";
import { writeUsageEvent } from "./usage.js";
import type { components } from "../../../sdks/typescript/src/generated/openapi";

export const countTokens = (text: string): number => encode(text).length;
export function eventIndexText(event: Partial<Pick<
  components["schemas"]["EventData"],
  "title" | "summary" | "keywords" | "event_time" | "location" | "content"
>>): string {
  return [event.title, event.summary, event.keywords, event.event_time, event.location, event.content]
    .filter(Boolean)
    .join("\n");
}
export interface ModelConfig {
  llm_model: string;
  reasoning_effort: string;
  language: string;
  use_timezone?: string;
  fact_llm_model?: string;
  fact_reasoning_effort?: string;
  fact_temperature?: number;
  embedding_provider: "openai" | "jina" | "ollama";
  embedding_model: string;
  embedding_dim: number;
  embedding_batch_size: number;
  embedding_max_token_size: number;
  enable_event_embedding: boolean;
  profile_topics: Array<{
    topic: string;
    description?: string | null;
    sub_topics?: unknown[];
  }>;
  event_tag_definitions: unknown[];
  source_max_input_tokens: number;
  source_context_window_tokens: number;
  source_output_reserve_tokens: number;
}
export async function getConfig(
  runtime: Runtime,
  projectId: string,
  sql: Sql = runtime.db,
): Promise<ModelConfig> {
  return (await getConfigSnapshot(runtime, projectId, sql)).config;
}

export async function getConfigSnapshot(
  runtime: Runtime,
  projectId: string,
  sql: Sql = runtime.db,
): Promise<{ config: ModelConfig; stored: string | null }> {
  const base = readServiceConfig(runtime.env.MEMOIA_CONFIG);
  const row = await sql.query<{ profile_config: string | null }>(
    "SELECT profile_config FROM memoia.projects WHERE project_id=$1",
    [projectId],
  );
  if (!row.rows.length)
    throw new SourceError("project_not_found", "Project was not found", 404);
  const stored = row.rows[0].profile_config;
  const config =
    typeof stored === "string" ? (parse(stored) ?? {}) : (stored ?? {});
  const language =
    (config.language === "en" || config.language === "zh"
      ? config.language
      : null) ??
    base.language ??
    "en";
  const effective: ModelConfig = {
    llm_model: config.llm_model ?? base.best_llm_model ?? "gpt-6-luna",
    reasoning_effort:
      config.reasoning_effort ?? base.llm_reasoning_effort ?? "high",
    fact_llm_model: config.fact_llm_model,
    fact_reasoning_effort: config.fact_reasoning_effort,
    fact_temperature: config.fact_temperature,
    language,
    use_timezone: base.use_timezone ?? "UTC",
    embedding_provider: base.embedding_provider ?? "openai",
    embedding_model: base.embedding_model ?? "text-embedding-3-large",
    embedding_dim: base.embedding_dim ?? 1536,
    embedding_batch_size: base.embedding_batch_size ?? 64,
    embedding_max_token_size: base.embedding_max_token_size ?? 8192,
    enable_event_embedding: base.enable_event_embedding ?? true,
    profile_topics: resolveTopics(base, config, language),
    event_tag_definitions: config.event_tags ?? base.event_tags ?? [],
    source_max_input_tokens: base.source_max_input_tokens ?? 16384,
    source_context_window_tokens: base.source_context_window_tokens ?? 131072,
    source_output_reserve_tokens: base.source_output_reserve_tokens ?? 32768,
  };
  return { config: effective, stored };
}
function resolveTopics(
  base: Record<string, any>,
  config: Record<string, any>,
  language: string,
): ModelConfig["profile_topics"] {
  const defaults = language === "en" ? defaultTopics.en : defaultTopics.zh;
  const topics = base.overwrite_user_profiles ?? [
    ...defaults,
    ...(base.additional_user_profiles ?? []),
  ];
  const selected = config.overwrite_user_profiles?.length
    ? config.overwrite_user_profiles
    : config.additional_user_profiles?.length
      ? [...topics, ...config.additional_user_profiles]
      : topics;
  const normalize = (value: string) =>
    value.toLowerCase().trim().replace(/ /g, "_");
  return selected.map(
    (topic: {
      topic: string;
      description?: string | null;
      sub_topics?: Array<
        | string
        | {
            name: string;
            description?: string | null;
            update_description?: string | null;
          }
      >;
    }) => ({
      topic: normalize(topic.topic),
      description: topic.description ?? null,
      sub_topics: (topic.sub_topics ?? []).map((sub) => ({
        name: normalize(typeof sub === "string" ? sub : sub.name),
        description: typeof sub === "string" ? null : (sub.description ?? null),
        update_description:
          typeof sub === "string" ? null : (sub.update_description ?? null),
      })),
    }),
  );
}
const capturedErrorUsage = new WeakMap<object, unknown>();

/** The SDK otherwise discards top-level usage when it constructs APIError. */
class UsageOpenAI extends OpenAI {
  protected override makeStatusError(
    status: number,
    error: object,
    message: string | undefined,
    headers: Headers,
  ) {
    const result = super.makeStatusError(status, error, message, headers);
    const usage = numericUsageFromError(error);
    if (usage !== null) capturedErrorUsage.set(result, usage);
    return result;
  }
}
export function provider(
  runtime: Runtime,
  fetcher: typeof fetch = runtime.modelFetch ?? fetch,
  timeoutMs = 120_000,
): OpenAI {
  assertRunning(runtime);
  if (!runtime.env.OPENAI_API_KEY)
    throw new SourceError(
      "model_configuration_rejected",
      "Provider credentials are missing",
      503,
    );
  const base = readServiceConfig(runtime.env.MEMOIA_CONFIG);
  return new UsageOpenAI({
    apiKey: runtime.env.OPENAI_API_KEY,
    baseURL: runtime.env.OPENAI_BASE_URL,
    defaultHeaders: base.llm_openai_default_header ?? undefined,
    defaultQuery: base.llm_openai_default_query ?? undefined,
    maxRetries: 0,
    timeout: Math.max(1, Math.min(timeoutMs, runtime.deadline - Date.now())),
    fetch: fetcher,
  });
}
export function supportsPromptCache(runtime: Runtime, model: string): boolean {
  const base = readServiceConfig(runtime.env.MEMOIA_CONFIG);
  if (
    !/^gpt-(?:5\.6|6(?:\.1)?)(?:-(?:luna|sol|astra|terra))?(?:-\d{4}-\d{2}-\d{2})?$/.test(
      model,
    ) ||
    base.llm_prompt_cache_options === false
  )
    return false;
  if (!runtime.env.OPENAI_BASE_URL) return true;
  try {
    const url = new URL(runtime.env.OPENAI_BASE_URL);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return false;
    return (
      base.llm_prompt_cache_options === true ||
      (url.protocol === "https:" &&
        url.hostname === "api.openai.com" &&
        (!url.port || url.port === "443") &&
        url.pathname.replace(/\/+$/, "") === "/v1")
    );
  } catch {
    return false;
  }
}
export async function recordUsage(
  runtime: Runtime,
  projectId: string,
  usage: unknown,
  kind: string,
  providerMetadata?: {
    model?: string | null;
    service_tier?: string | null;
    requested_service_tier?: string | null;
    userId?: string;
    requestedModel?: string;
  },
): Promise<void> {
  const occurredAt = new Date();
  const data = usage as Record<string, unknown> | null;
  const input = data?.input_tokens;
  const output = data?.output_tokens;
  const total = data?.total_tokens;
  const malformed =
    kind === "agent_loop" &&
    (data?.invalid_token_usage === true || invalidTokenUsage(data));
  const invalidCache =
    data?.invalid_cache_usage === true || invalidCacheUsage(data);
  const complete =
    !malformed &&
    Number.isSafeInteger(input) &&
    Number.isSafeInteger(output) &&
    Number.isSafeInteger(total) &&
    Number(input) >= 0 &&
    Number(output) >= 0 &&
    Number(total) >= 0 &&
    Number(total) === Number(input) + Number(output);
  const details = {
    cached_tokens: safeUsageValue(
      (data?.input_tokens_details as Record<string, unknown> | null)
        ?.cached_tokens,
    ),
    cache_write_tokens: safeUsageValue(
      (data?.input_tokens_details as Record<string, unknown> | null)
        ?.cache_write_tokens,
    ),
    cache_write_30m_tokens: safeUsageValue(
      (
        (data?.input_tokens_details as Record<string, unknown> | null)
          ?.cache_write_tokens_details as Record<string, unknown> | null
      )?.ttl_30m_tokens,
    ),
    cache_write_12h_tokens: safeUsageValue(
      (
        (data?.input_tokens_details as Record<string, unknown> | null)
          ?.cache_write_tokens_details as Record<string, unknown> | null
      )?.ttl_12h_tokens,
    ),
  };
  console.info(
    JSON.stringify({
      event: "model_usage",
      kind,
      project_id: projectId,
      operation_id: runtime.operationId ?? null,
      usage_complete: complete,
      input_tokens: complete ? input : null,
      output_tokens: complete ? output : null,
      total_tokens: complete ? total : null,
      ...details,
      model: providerMetadata?.model ?? null,
      service_tier: providerMetadata?.service_tier ?? null,
      requested_service_tier: providerMetadata?.requested_service_tier ?? null,
    }),
  );
  const userId = providerMetadata?.userId;
  if (userId && (kind === "fact_extraction" || kind === "agent_loop")) {
    try {
      await writeUsageEvent(runtime.db, { projectId, userId }, occurredAt, {
        kind,
        provider: "openai",
        model:
          providerMetadata.model ?? providerMetadata.requestedModel ?? null,
        service_tier: providerMetadata.service_tier ?? null,
        usage_valid: !malformed && !invalidCache,
        input_tokens: complete ? Number(input) : null,
        output_tokens: complete ? Number(output) : null,
        ...details,
      });
    } catch {
      // Per-user export and the established project billing have independent write paths.
      console.warn(
        JSON.stringify({
          event: "model_usage_event_failed",
          kind,
          project_id: projectId,
        }),
      );
    }
  }
  if (malformed)
    throw new SourceError(
      "maintenance_usage_invalid",
      "Provider returned invalid token usage",
      502,
    );
  try {
    if (!complete) {
      await addUsage(runtime.db, projectId, { llm_usage_unknown: 1 });
    } else {
      await addUsage(runtime.db, projectId, {
        llm_input_tokens: Number(input),
        llm_output_tokens: Number(output),
      });
      if (!runtime.env.ADMIN_URL) {
        try {
          await debitBilling(runtime.db, projectId, Number(input), Number(output));
        } catch {
          console.warn(
            JSON.stringify({
              event: "billing_debit_failed",
              project_id: projectId,
            }),
          );
        }
      }
      if (runtime.env.ADMIN_URL) {
        try {
          const response = await fetch(
            new URL(
              `/api/v1/billing/project/${encodeURIComponent(projectId)}`,
              runtime.env.ADMIN_URL,
            ),
            {
              method: "PUT",
              headers: {
                Authorization: `Bearer ${runtime.env.ADMIN_TOKEN ?? ""}`,
                "Content-Type": "application/json",
                "X-Request-ID": crypto.randomUUID(),
              },
              body: JSON.stringify({ usage: Number(input) + Number(output) }),
              signal: AbortSignal.timeout(10000),
            },
          );
          if (response.status !== 200)
            throw new Error("External billing failed");
          const result: unknown = await response.json();
          if (
            !result ||
            typeof result !== "object" ||
            (result as { errno?: unknown }).errno !== 0
          )
            throw new Error("External billing failed");
        } catch {
          console.warn(
            JSON.stringify({
              event: "billing_debit_failed",
              project_id: projectId,
            }),
          );
        }
      }
    }
  } catch {
    console.error(
      JSON.stringify({
        event: "usage_record_failed",
        kind,
        project_id: projectId,
      }),
    );
  }
  if (kind === "agent_loop" && output != null && Number(output) > 32768)
    throw new SourceError(
      "maintenance_completion_length",
      "Provider exceeded the single-response output budget",
      502,
    );
}
type EmbeddingPhase = "query" | "document";
function embeddingError(status?: number): SourceError {
  const rejected =
    status !== undefined && [400, 401, 403, 404, 422].includes(status);
  return new SourceError(
    rejected ? "embedding_configuration_rejected" : "embedding_unavailable",
    rejected
      ? "Embedding configuration or credentials were rejected"
      : "Embedding generation failed",
    503,
    !rejected,
  );
}
function embeddingConfigError(): never {
  throw new SourceError(
    "embedding_configuration_rejected",
    "Embedding configuration or response is invalid",
    503,
    false,
  );
}
function validatedVectors(
  rows: unknown,
  count: number,
  dimensions: number,
  indexed: boolean,
): number[][] {
  if (!Array.isArray(rows) || rows.length !== count)
    return embeddingConfigError();
  let vectors: unknown[];
  if (indexed) {
    const ordered: unknown[] = Array(count);
    const indices = new Set<number>();
    for (const item of rows) {
      if (!item || typeof item !== "object") return embeddingConfigError();
      const row = item as { index?: unknown; embedding?: unknown };
      if (
        !Number.isSafeInteger(row.index) ||
        Number(row.index) < 0 ||
        Number(row.index) >= count ||
        indices.has(Number(row.index))
      )
        return embeddingConfigError();
      indices.add(Number(row.index));
      ordered[Number(row.index)] = row.embedding;
    }
    vectors = ordered;
  } else vectors = rows;
  for (const v of vectors)
    if (
      !Array.isArray(v) ||
      v.length !== dimensions ||
      v.some((x) => typeof x !== "number" || !Number.isFinite(x))
    )
      return embeddingConfigError();
  return vectors as number[][];
}
/** One bounded input is sent per batch; query requests are never automatically retried. */
export async function embeddings(
  runtime: Runtime,
  projectId: string,
  texts: string[],
  phase: EmbeddingPhase = "document",
  userId?: string,
  config?: ModelConfig,
): Promise<number[][]> {
  const usageWrites: Promise<void>[] | undefined =
    phase === "query" && runtime.retrievalUsageWrites ? [] : undefined;
  const vectors = inSpan(
    runtime.tracing,
    "memoia.model",
    { kind: "embedding", phase, operation_id: runtime.operationId },
    () => embed(runtime, projectId, texts, phase, userId, usageWrites, config),
  );
  if (usageWrites) {
    // Register at launch because a parallel search query can already fail before usage arrives.
    const drain = async () => {
      await Promise.allSettled(usageWrites);
    };
    runtime.retrievalUsageWrites?.push(vectors.then(drain, drain));
  }
  return vectors;
}

async function embed(
  runtime: Runtime,
  projectId: string,
  texts: string[],
  phase: EmbeddingPhase,
  userId?: string,
  usageWrites?: Promise<void>[],
  resolvedConfig?: ModelConfig,
): Promise<number[][]> {
  if (!texts.length) return [];
  const config = resolvedConfig ?? (await getConfig(runtime, projectId));
  if (phase === "query" && userId) {
    if (!config.enable_event_embedding) return [];
    // Empty accounts have no vectors to match and cannot own a billable embedding.
    const account = await runtime.db.query(
      "SELECT 1 FROM memoia.users WHERE project_id=$1 AND id=$2",
      [projectId, userId],
    );
    if (!account.rows.length) return [];
  }

  if (
    !["openai", "jina", "ollama"].includes(config.embedding_provider) ||
    !Number.isSafeInteger(config.embedding_batch_size) ||
    config.embedding_batch_size < 1 ||
    !Number.isSafeInteger(config.embedding_max_token_size) ||
    config.embedding_max_token_size < 1 ||
    !Number.isSafeInteger(config.embedding_dim) ||
    config.embedding_dim < 1 ||
    typeof config.embedding_model !== "string" ||
    !config.embedding_model ||
    (config.embedding_provider === "jina" &&
      config.embedding_model !== "jina-embeddings-v3")
  )
    embeddingConfigError();
  if (texts.some((text) => countTokens(text) > config.embedding_max_token_size))
    throw new SourceError(
      "embedding_input_too_long",
      "Text exceeds embedding input limit",
      413,
      false,
    );
  const providerName = config.embedding_provider;
  const embeddingKey = runtime.env.EMBEDDING_API_KEY;
  const key =
    embeddingKey ??
    (providerName === "openai" ? runtime.env.OPENAI_API_KEY : undefined);
  const base =
    runtime.env.EMBEDDING_BASE_URL ??
    (embeddingKey == null && providerName === "openai"
      ? runtime.env.OPENAI_BASE_URL
      : undefined) ??
    (providerName === "jina" ? "https://api.jina.ai/v1" : undefined);
  if (!key || (providerName === "ollama" && !base)) embeddingConfigError();
  if (base) {
    try {
      const url = new URL(base);
      if (!["http:", "https:"].includes(url.protocol)) embeddingConfigError();
    } catch {
      embeddingConfigError();
    }
  }
  const scope = userId ? { projectId, userId } : undefined;
  const meter = (input: unknown, model = config.embedding_model) => {
    const write = recordEmbeddingUsage(
      runtime,
      scope,
      providerName,
      model,
      input,
    );
    // HTTP retrieval can return its vectors while the invocation drains its accounting writes.
    if (usageWrites) {
      usageWrites.push(write);
      return;
    }
    return write;
  };
  const vectors: number[][] = [];
  for (
    let offset = 0;
    offset < texts.length;
    offset += config.embedding_batch_size
  ) {
    assertRunning(runtime, 1000);
    const slice = texts.slice(offset, offset + config.embedding_batch_size);
    if (providerName === "openai") {
      const client = new UsageOpenAI({
        apiKey: key,
        baseURL: base,
        fetch: usesOpenAIBaseUrl(base) ? runtime.modelFetch : undefined,
        maxRetries: 0,
        timeout: Math.max(1, Math.min(10_000, runtime.deadline - Date.now())),
      });
      let result: OpenAI.Embeddings.CreateEmbeddingResponse;
      const remaining = AbortSignal.timeout(
        Math.max(1, runtime.deadline - Date.now()),
      );
      const signal = runtime.signal
        ? AbortSignal.any([runtime.signal, remaining])
        : remaining;
      for (let attempt = 0; ; attempt++) {
        try {
          result = await client.embeddings.create(
            {
              model: config.embedding_model,
              input: slice,
              encoding_format: "float",
              dimensions: config.embedding_dim,
            },
            { signal },
          );
          break;
        } catch (error) {
          const usage = errorUsage(error);
          await meter(
            (usage as { input_tokens?: unknown } | null)?.input_tokens,
          );
          const retry =
            phase === "document" &&
            attempt < 2 &&
            !signal.aborted &&
            embeddingRetryDelay(error, attempt);
          if (
            typeof retry === "number" &&
            retry < runtime.deadline - Date.now()
          ) {
            await delay(retry, undefined, { signal }).catch(() => undefined);
            if (!signal.aborted) continue;
          }
          const failure = embeddingError(
            error instanceof OpenAI.APIError ? error.status : undefined,
          );
          if (usage !== null) capturedErrorUsage.set(failure, usage);
          throw failure;
        }
      }
      await meter(
        result?.usage?.prompt_tokens ?? result?.usage?.total_tokens,
        result?.model,
      );
      if (!result || typeof result !== "object") embeddingConfigError();
      vectors.push(
        ...validatedVectors(
          result.data,
          slice.length,
          config.embedding_dim,
          true,
        ),
      );
    } else {
      const path = providerName === "jina" ? "embeddings" : "api/embed";
      const endpoint = new URL(path, `${base!.replace(/\/+$/, "")}/`);
      const payload = {
        model: config.embedding_model,
        input: slice,
        truncate: true,
        dimensions: config.embedding_dim,
        ...(providerName === "jina"
          ? {
              task: phase === "query" ? "retrieval.query" : "retrieval.passage",
            }
          : {}),
      };
      const timeout = Math.max(
        1,
        Math.min(10_000, runtime.deadline - Date.now()),
      );
      const signal = runtime.signal
        ? AbortSignal.any([runtime.signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout);
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal,
        });
      } catch {
        await meter(null);
        throw embeddingError();
      }
      if (response.status !== 200) {
        await meter(null);
        throw embeddingError(response.status);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        await meter(null);
        throw embeddingError();
      }
      const output = body as {
        data?: unknown;
        embeddings?: unknown;
        usage?: { total_tokens?: unknown };
        prompt_eval_count?: unknown;
      } | null;
      await meter(
        providerName === "jina"
          ? output?.usage?.total_tokens
          : output?.prompt_eval_count,
      );
      if (!output || typeof output !== "object") embeddingConfigError();
      vectors.push(
        ...validatedVectors(
          providerName === "jina" ? output.data : output.embeddings,
          slice.length,
          config.embedding_dim,
          providerName === "jina",
        ),
      );
    }
  }
  try {
    await addUsage(runtime.db, projectId, {
      embedding_tokens: countTokens(texts.join("\n")),
    });
  } catch {
    console.warn(
      JSON.stringify({
        event: "embedding_usage_record_failed",
        project_id: projectId,
      }),
    );
  }
  return vectors;
}

function embeddingRetryDelay(error: unknown, attempt: number): number | false {
  if (!(error instanceof OpenAI.APIError)) return false;
  const advised = error.headers?.get("x-should-retry");
  if (advised === "false") return false;
  const status = error.status;
  if (
    advised !== "true" &&
    status !== undefined &&
    ![408, 409, 429].includes(status) &&
    status < 500
  )
    return false;
  const ms = error.headers?.get("retry-after-ms");
  const after = error.headers?.get("retry-after");
  const waitMs = ms ? Number(ms) : NaN;
  const wait = after
    ? Number.isFinite(Number(after))
      ? Number(after) * 1000
      : Date.parse(after) - Date.now()
    : NaN;
  if (waitMs >= 0 && waitMs <= 60_000) return waitMs;
  if (wait >= 0 && wait <= 60_000) return wait;
  return 500 * 2 ** attempt * (1 - Math.random() * 0.25);
}

async function recordEmbeddingUsage(
  runtime: Runtime,
  scope: UserScope | undefined,
  provider: ModelConfig["embedding_provider"],
  model: string,
  input: unknown,
): Promise<void> {
  if (!scope) return;
  try {
    await writeUsageEvent(runtime.db, scope, new Date(), {
      kind: "embedding",
      provider,
      model,
      service_tier: null,
      input_tokens: safeUsageValue(input),
      output_tokens: 0,
    });
  } catch {
    console.warn(
      JSON.stringify({
        event: "embedding_usage_event_failed",
        project_id: scope.projectId,
      }),
    );
  }
}

function numericUsageFromError(error: unknown): unknown {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  for (const candidate of [record, record.error, record.body]) {
    if (!candidate || typeof candidate !== "object") continue;
    const usage = (candidate as Record<string, unknown>).usage;
    if (!usage || typeof usage !== "object") continue;
    const raw = usage as Record<string, unknown>;
    const details = raw.input_tokens_details as Record<string, unknown> | null;
    const writes = details?.cache_write_tokens_details as Record<
      string,
      unknown
    > | null;
    return {
      invalid_token_usage: invalidTokenUsage(raw),
      invalid_cache_usage: invalidCacheUsage(raw),
      input_tokens: safeUsageValue(raw.input_tokens ?? raw.prompt_tokens),
      output_tokens: safeUsageValue(raw.output_tokens),
      total_tokens: safeUsageValue(raw.total_tokens),
      input_tokens_details: {
        cached_tokens: safeUsageValue(details?.cached_tokens),
        cache_write_tokens: safeUsageValue(details?.cache_write_tokens),
        cache_write_tokens_details: {
          ttl_30m_tokens: safeUsageValue(writes?.ttl_30m_tokens),
          ttl_12h_tokens: safeUsageValue(writes?.ttl_12h_tokens),
        },
      },
    };
  }
  return null;
}
export function errorUsage(error: unknown): unknown {
  if (!error || typeof error !== "object") return null;
  return capturedErrorUsage.get(error) ?? numericUsageFromError(error);
}

function safeUsageValue(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}

function invalidTokenUsage(data: Record<string, unknown> | null): boolean {
  const values = [data?.input_tokens, data?.output_tokens, data?.total_tokens];
  if (values.some((value) => value != null && safeUsageValue(value) === null))
    return true;
  return (
    values.every((value) => value != null) &&
    Number(values[2]) !== Number(values[0]) + Number(values[1])
  );
}

function invalidCacheUsage(data: Record<string, unknown> | null): boolean {
  const details = data?.input_tokens_details as Record<string, unknown> | null;
  const writes = details?.cache_write_tokens_details as Record<
    string,
    unknown
  > | null;
  return [
    details?.cached_tokens,
    details?.cache_write_tokens,
    writes?.ttl_30m_tokens,
    writes?.ttl_12h_tokens,
  ].some((value) => value != null && safeUsageValue(value) === null);
}
