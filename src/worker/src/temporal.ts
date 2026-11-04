import type { JsonNumber } from "./canonical";
import { SourceError } from "./errors";
export interface FactTime {
  start: string | null;
  end: string | null;
  precision: "year" | "month" | "day" | "range" | "unknown";
  evidence: { message_id: string; expression: string }[];
}

export function supportedFactTime(
  value: FactTime | null,
  groups: string[][],
): FactTime | null {
  return value &&
    groups.some((group) =>
      value.evidence.every((item) => group.includes(item.message_id)),
    )
    ? value
    : null;
}

export function retainedGroups(
  groups: string[][],
  retracted: Iterable<string>,
): string[][] {
  const removed = new Set(retracted);
  return groups.filter((group) => group.every((id) => !removed.has(id)));
}

export function recordingTimeMicros(value: string): bigint {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis))
    throw new Error("Invalid evidence recording time");
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? "";
  return (
    BigInt(millis) * 1000n + BigInt(Number(fraction.padEnd(6, "0").slice(3, 6)))
  );
}

export function evidenceTime(
  groups: string[][],
  messages: { message_id: string; occurred_at: string | Date }[],
): string {
  const byId = new Map(messages.map((m) => [m.message_id, m.occurred_at]));
  let latest: { value: string; micros: bigint } | undefined;
  for (const id of groups.flat()) {
    const raw = byId.get(id);
    if (raw == null) throw new Error("Invalid evidence recording time");
    const value = raw instanceof Date ? raw.toISOString() : raw;
    const micros = recordingTimeMicros(value);
    if (!latest || micros > latest.micros) latest = { value, micros };
  }
  if (!latest) throw new Error("Invalid evidence recording time");
  return latest.value;
}

export function renderSearchFact(
  content: string,
  time: FactTime | null,
): string {
  if (!time || time.precision === "unknown" || !time.start || !time.end)
    return content;
  const label =
    time.precision === "year"
      ? time.start.slice(0, 4)
      : time.precision === "month"
        ? time.start.slice(0, 7)
        : time.precision === "day"
          ? time.start
          : `${time.start} to ${time.end}`;
  return `${content}\n[Event time: ${label}; precision: ${time.precision}]`;
}

export function sourceObservations(
  groups: string[][],
  messages: {
    message_id: string;
    occurred_at: string | Date | null;
    time_zone?: string | null;
  }[],
) {
  const ids = new Set(groups.flat());
  return messages
    .filter((m) => ids.has(m.message_id) && m.occurred_at != null)
    .sort((a, b) => a.message_id.localeCompare(b.message_id))
    .map((m) => ({
      message_id: m.message_id,
      recorded_at:
        m.occurred_at instanceof Date
          ? m.occurred_at.toISOString()
          : m.occurred_at,
      time_zone: m.time_zone ?? null,
    }));
}

export interface SourceMessage {
  message_id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  occurred_at: string;
  time_zone?: string | null;
  images?: {
    url: string;
    mimeType: string;
    width: number | JsonNumber;
    height: number | JsonNumber;
    byteSize: number | JsonNumber;
  }[];
}
export interface Fact {
  content: string;
  subject: string;
  reporter: string;
  certainty: "asserted" | "reported" | "uncertain";
  fact_time: FactTime | null;
  support_groups: string[][];
}
export interface ExtractedFact extends Fact {
  id: string;
  occurred_at: string;
}

const hasKeys = (value: any, keys: string[]) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const invalid = (message: string): never => {
  throw new SourceError("invalid_model_output", message, 502, true);
};
function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  if (value.startsWith("0000-")) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
export function validateFactTime(value: any): asserts value is FactTime | null {
  if (value === null) return;
  if (
    !hasKeys(value, ["start", "end", "precision", "evidence"]) ||
    !Array.isArray(value.evidence) ||
    !value.evidence.length ||
    value.evidence.length > 20 ||
    value.evidence.some(
      (e: any) =>
        !hasKeys(e, ["message_id", "expression"]) ||
        typeof e.message_id !== "string" ||
        !e.message_id ||
        typeof e.expression !== "string" ||
        !e.expression ||
        e.expression.length > 1024,
    )
  )
    invalid("Invalid time evidence");
  if (value.precision === "unknown") {
    if (value.start !== null || value.end !== null)
      invalid("Unknown time must not contain dates");
    return;
  }
  if (
    !["year", "month", "day", "range"].includes(value.precision) ||
    !validDate(value.start) ||
    !validDate(value.end) ||
    value.start > value.end
  )
    invalid("Invalid fact time");
  if (value.precision === "day" && value.start !== value.end)
    invalid("Invalid day precision");
  if (
    value.precision === "year" &&
    (value.start.slice(5) !== "01-01" ||
      value.end !== `${value.start.slice(0, 4)}-12-31`)
  )
    invalid("Invalid year precision");
  if (value.precision === "month") {
    const [year, month] = value.start.split("-").map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const last = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
      month - 1
    ];
    if (
      !value.start.endsWith("-01") ||
      value.end !==
        `${value.start.slice(0, 7)}-${String(last).padStart(2, "0")}`
    )
      invalid("Invalid month precision");
  }
}
export function validateFacts(raw: unknown, messages: SourceMessage[]): Fact[] {
  const facts = (raw as any)?.facts;
  if (!hasKeys(raw, ["facts"]) || !Array.isArray(facts) || facts.length > 200)
    invalid("Fact count is invalid");
  const byId = new Map(messages.map((m) => [m.message_id, m]));
  const urls = messages.flatMap((m) =>
    (m.images ?? []).map((i) => i.url.split("?")[0]),
  );
  if (urls.some((url) => JSON.stringify(raw).includes(url)))
    invalid("Fact output contains a temporary image URL");
  for (const fact of facts) {
    if (
      !hasKeys(fact, [
        "content",
        "subject",
        "reporter",
        "certainty",
        "fact_time",
        "support_groups",
      ])
    )
      invalid("Invalid Fact structure");
    for (const [name, max] of [
      ["content", 4096],
      ["subject", 512],
      ["reporter", 512],
    ] as const)
      if (
        typeof fact[name] !== "string" ||
        !fact[name].length ||
        fact[name].length > max
      )
        invalid("Invalid Fact text");
    if (
      !["asserted", "reported", "uncertain"].includes(fact.certainty) ||
      !Array.isArray(fact.support_groups) ||
      !fact.support_groups.length ||
      fact.support_groups.length > 20
    )
      invalid("Invalid Fact evidence");
    const keys = new Set<string>();
    for (const group of fact.support_groups) {
      if (
        !Array.isArray(group) ||
        !group.length ||
        group.some((id: unknown) => typeof id !== "string" || !byId.has(id)) ||
        new Set(group).size !== group.length ||
        !group.some((id: string) => byId.get(id)?.role === "user")
      )
        invalid("Fact evidence must reference supplied user evidence");
      const key = JSON.stringify([...group].sort());
      if (keys.has(key)) invalid("Repeated evidence groups");
      keys.add(key);
    }
    validateFactTime(fact.fact_time);
    if (
      fact.fact_time &&
      (!supportedFactTime(fact.fact_time, fact.support_groups) ||
        fact.fact_time.evidence.some(
          (e: any) => !byId.get(e.message_id)?.content.includes(e.expression),
        ))
    )
      invalid("Time evidence must cite supporting source text");
  }
  return facts;
}
export function normalizeExtraction(
  raw: any,
  messages: SourceMessage[],
): Fact[] {
  const userIds = messages
    .filter((m) => m.role === "user")
    .map((m) => m.message_id);
  if (
    !hasKeys(raw, ["messages"]) ||
    !Array.isArray(raw.messages) ||
    raw.messages.length !== userIds.length ||
    new Set(raw.messages.map((b: any) => b.message_id)).size !==
      userIds.length ||
    raw.messages.some(
      (b: any) =>
        !hasKeys(b, ["message_id", "facts"]) ||
        !userIds.includes(b.message_id) ||
        !Array.isArray(b.facts) ||
        b.facts.length > 200,
    )
  )
    invalid("Extraction must cover each supplied user message exactly once");
  const facts: Fact[] = [];
  for (const id of userIds)
    for (const fact of raw.messages.find((b: any) => b.message_id === id)
      .facts) {
      if (
        !hasKeys(fact, [
          "content",
          "subject",
          "reporter",
          "certainty",
          "fact_time",
          "any_of",
        ]) ||
        !Array.isArray(fact.any_of) ||
        fact.any_of.some((g: any) => !hasKeys(g, ["all_of"])) ||
        !fact.any_of.some(
          (g: any) => Array.isArray(g.all_of) && g.all_of.includes(id),
        )
      )
        invalid("Fact must be supported by its source message");
      const { any_of, ...rest } = fact;
      facts.push({ ...rest, support_groups: any_of.map((g: any) => g.all_of) });
    }
  return validateFacts({ facts }, messages);
}
