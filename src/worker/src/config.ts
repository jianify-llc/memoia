import { z } from "zod";
import { SourceError } from "./errors.js";

const positiveInteger = z.number().int().positive();
const description = z.string().nullish();
const subTopic = z.union([
  z.string(),
  z
    .object({ name: z.string(), description, update_description: description })
    .strict(),
]);
const topics = z
  .array(
    z
      .object({
        topic: z.string(),
        description,
        sub_topics: z.array(subTopic).optional(),
      })
      .strict(),
  )
  .nullish();
const stringMap = z.record(z.string(), z.string()).nullish();
const serviceConfig = z
  .object({
    language: z.enum(["en", "zh"]).optional(),
    use_timezone: z
      .string()
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: zone });
          return true;
        } catch {
          return false;
        }
      })
      .nullish(),
    best_llm_model: z
      .string()
      .refine((value) => !!value.trim())
      .optional(),
    llm_reasoning_effort: z
      .enum(["none", "minimal", "low", "medium", "high", "xhigh"])
      .optional(),
    llm_prompt_cache_options: z.boolean().nullish(),
    llm_openai_default_header: stringMap,
    llm_openai_default_query: stringMap,
    embedding_provider: z.enum(["openai", "jina", "ollama"]).optional(),
    embedding_model: z
      .string()
      .refine((value) => !!value.trim())
      .optional(),
    embedding_dim: positiveInteger.optional(),
    embedding_batch_size: positiveInteger.optional(),
    embedding_max_token_size: positiveInteger.optional(),
    enable_event_embedding: z.boolean().optional(),
    source_max_input_tokens: positiveInteger.optional(),
    source_context_window_tokens: positiveInteger.optional(),
    source_output_reserve_tokens: positiveInteger.optional(),
    source_input_retention_seconds: positiveInteger.default(604800),
    additional_user_profiles: topics,
    overwrite_user_profiles: topics,
    event_tags: z
      .array(z.object({ name: z.string(), description }).strict())
      .nullish(),
  })
  .strict();

/** Bindings are deployment input: reject mistakes before accepting business work. */
export function readServiceConfig(raw?: string): z.infer<typeof serviceConfig> {
  let value: unknown;
  try {
    value = raw === undefined ? {} : JSON.parse(raw);
  } catch {
    throw invalidConfiguration([]);
  }
  const parsed = serviceConfig.safeParse(value);
  if (!parsed.success) {
    const fields = parsed.error.issues.flatMap((issue) =>
      issue.code === "unrecognized_keys" && !issue.path.length
        ? issue.keys
        : [String(issue.path[0] ?? "MEMOIA_CONFIG")],
    );
    throw invalidConfiguration(fields);
  }
  return parsed.data;
}

function invalidConfiguration(fields: string[]): SourceError {
  const names = [...new Set(fields)].sort();
  return new SourceError(
    "service_configuration_invalid",
    `Invalid service configuration${names.length ? ` fields: ${names.join(", ")}` : ""}`,
    503,
    false,
  );
}
