/** CPython's json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False). */
export class JsonNumber {
  constructor(readonly source: string) {}
}

function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a, (c) => c.codePointAt(0)!);
  const right = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++)
    if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length;
}
function pythonFloat(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("Non-finite JSON number");
  if (Object.is(value, -0)) return "-0.0";
  if (value === 0) return "0.0";
  const negative = value < 0;
  const repr = Math.abs(value).toString().toLowerCase();
  const [coefficient, exponentText] = repr.split("e");
  const dot = coefficient.indexOf(".");
  const point = dot < 0 ? coefficient.length : dot;
  const raw = coefficient.replace(".", "");
  const first = raw.search(/[1-9]/);
  const exponent =
    point - 1 - first + (exponentText ? Number(exponentText) : 0);
  const digits = raw.slice(first).replace(/0+$/, "");
  const prefix = negative ? "-" : "";
  if (exponent < -4 || exponent >= 16) {
    const mantissa =
      digits[0] + (digits.length > 1 ? "." + digits.slice(1) : "");
    return `${prefix}${mantissa}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  const decimal = exponent + 1;
  if (decimal <= 0) return `${prefix}0.${"0".repeat(-decimal)}${digits}`;
  if (decimal >= digits.length)
    return `${prefix}${digits}${"0".repeat(decimal - digits.length)}.0`;
  return `${prefix}${digits.slice(0, decimal)}.${digits.slice(decimal)}`;
}
function numberText(raw: string): string {
  if (!/[.eE]/.test(raw)) {
    if (raw.replace(/^-/, "").length > 4300)
      throw new RangeError("Integer exceeds Python JSON limit");
    return BigInt(raw).toString();
  }
  return pythonFloat(Number(raw));
}
function quote(value: string): string {
  // CPython's UTF-8 encoding rejects unpaired surrogate code points.
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new TypeError("Unpaired surrogate");
    } else if (c >= 0xdc00 && c <= 0xdfff)
      throw new TypeError("Unpaired surrogate");
  }
  return JSON.stringify(value);
}
export function pythonJson(value: unknown): string {
  if (value instanceof JsonNumber) return numberText(value.source);
  if (value === null) return "null";
  if (typeof value === "string") return quote(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number")
    return Number.isSafeInteger(value) && !Object.is(value, -0)
      ? String(value)
      : pythonFloat(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareCodePoints)
      .map((key) => `${quote(key)}:${pythonJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Value is not JSON");
}
export async function pythonHash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(pythonJson(value)),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

function parseNumbers(text: string): any {
  return JSON.parse(
    text,
    (_key: string, value: unknown, context?: { source?: string }) => {
      if (typeof value !== "number") return value;
      if (!context?.source)
        throw new Error("JSON source tracking is unavailable");
      return new JsonNumber(context.source);
    },
  );
}
/** Recover exact numeric values from persisted JSONB when retrying. */
export function parseImportMetadata(text: string): Record<string, unknown> {
  return parseNumbers(text).metadata ?? {};
}

/** Called after ordinary DTO validation, keeping strict Python integers for attachments. */
export function prepareImportBody<
  T extends {
    metadata?: Record<string, unknown>;
    messages: Array<{
      images?: Array<{ width: unknown; height: unknown; byteSize: unknown }>;
    }>;
  },
>(text: string, body: T): T {
  const parsed = parseNumbers(text);
  body.metadata = parsed.metadata ?? {};
  for (let i = 0; i < body.messages.length; i++) {
    const images = body.messages[i].images ?? [];
    for (let j = 0; j < images.length; j++) {
      const original = parsed.messages[i].images[j];
      for (const key of ["width", "height", "byteSize"] as const) {
        const value = original[key];
        if (
          !(value instanceof JsonNumber) ||
          /[.eE]/.test(value.source) ||
          value.source.replace(/^-/, "").length > 4300
        )
          throw new TypeError("Image dimensions must be integers");
        images[j][key] = value;
      }
    }
  }
  return body;
}
