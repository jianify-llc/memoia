import promptSystem from "../prompts/fact_extraction.md";
import { completion, countTokens, getConfig } from "./models";
import { SourceError } from "./errors";
import type { Runtime } from "./runtime";
import {
  evidenceTime,
  normalizeExtraction,
  validateFacts,
  type SourceMessage,
  type Fact,
  type ExtractedFact,
} from "./temporal";
export {
  normalizeExtraction,
  validateFacts,
  validateFactTime,
} from "./temporal";
export type { SourceMessage, Fact, ExtractedFact } from "./temporal";

import frozenSchema from "./fact-schema.json";
export const extractionSchema = frozenSchema;

export async function extractSource(
  runtime: Runtime,
  projectId: string,
  messages: SourceMessage[],
  candidate?: unknown,
  saveCandidate?: (value: { facts: Fact[] }) => Promise<void>,
): Promise<ExtractedFact[]> {
  const config = await getConfig(runtime, projectId);
  const data = messages.map((m) => ({
    message_id: m.message_id,
    role: m.role,
    time_zone: m.time_zone ?? null,
    content: m.content,
    occurred_at: m.occurred_at,
    local_recorded_date: m.time_zone
      ? localDate(m.occurred_at, m.time_zone)
      : null,
    ...((m.images?.length ?? 0) ? { image_count: m.images!.length } : {}),
  }));
  const json = pythonJson({ messages: data })
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const prompt = `<source_material source="memoia">${json}</source_material>`;
  const images = messages.flatMap((m) =>
    (m.images ?? []).map((i) => ({ message_id: m.message_id, url: i.url })),
  );
  if (
    countTokens(messages.map((m) => m.content).join("\n")) >
      config.source_max_input_tokens ||
    countTokens(prompt + promptSystem.trim()) +
      config.source_output_reserve_tokens +
      images.length * 16384 >
      config.source_context_window_tokens
  )
    throw new SourceError(
      "input_too_long",
      "Complete source exceeds model budget",
      413,
    );
  let facts: Fact[];
  const legacy =
    candidate != null &&
    Array.isArray((candidate as any)?.facts) &&
    (candidate as any).facts.length > 0 &&
    (candidate as any).facts.every(
      (f: any) =>
        Object.keys(f).sort().join(",") ===
        "certainty,content,reporter,subject",
    );
  if (candidate != null && !legacy) facts = validateFacts(candidate, messages);
  else {
    const response = await completion(runtime, {
      projectId,
      prompt,
      system: promptSystem.trim(),
      schema: extractionSchema,
      ...(images.length ? { images } : {}),
    });
    facts = normalizeExtraction(response, messages);
    if (saveCandidate) await saveCandidate({ facts });
  }
  return facts.map((fact) => ({
    id: crypto.randomUUID(),
    ...fact,
    occurred_at: evidenceTime(fact.support_groups, messages),
  }));
}

function localDate(value: string, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function pythonJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(pythonJson).join(", ") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .map(([key, item]) => JSON.stringify(key) + ": " + pythonJson(item))
        .join(", ") +
      "}"
    );
  return JSON.stringify(value);
}
