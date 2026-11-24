import { Hono } from "hono";
import type { Runtime, RuntimeEnv } from "./runtime";
import { closeRuntime } from "./runtime";
import { ExpiredAppendInputs, SourceError } from "./errors";
import { InactiveUserError, LeaseLostError } from "./db";
import { authenticate, allows, requiredScope, type Principal } from "./auth";
import * as management from "./management";
import * as retrieval from "./retrieval";
import { parseImportMetadata } from "./canonical";
import { listUsageEvents } from "./usage";
// Generated from the checked-in OpenAPI contract, shared with the SDK.
// @ts-ignore standalone generated JavaScript
import * as generated from "../../../sdks/typescript/src/generated/validators.js";

const factApi = () => import("./facts");
const maintenanceApi = () => import("./maintenance");

type Env = {
  Bindings: RuntimeEnv;
  Variables: { runtime: Runtime; principal: Principal; requestBody: string };
};
type C = any;
type Validator = (value: unknown) => boolean;
const validators = generated as unknown as Record<string, Validator>;
const invalid = (): never => {
  throw new SourceError(
    "invalid_request",
    "Request validation failed",
    422,
    false,
  );
};
function check(name: string, value: unknown): any {
  const validator = validators[`validate${name}`];
  if (!validator || !validator(value)) invalid();
  return value;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function pathUuid(c: C, name: string): string {
  const value = c.req.param(name);
  if (!uuid.test(value)) invalid();
  return value.toLowerCase();
}
function scope(c: C) {
  return {
    userId: pathUuid(c, "user_id"),
    projectId: c.get("principal").projectId,
  };
}
async function readRequestBody(request: Request): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader)
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel().catch(() => {});
          throw new SourceError(
            "body_too_large",
            "Request body exceeds 2 MiB",
            413,
            false,
          );
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
  const buffer = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(buffer);
}
function body(c: C, name: string): any {
  const rawText = c.get("requestBody") ?? "";
  let value: any;
  try {
    value = JSON.parse(rawText);
  } catch {
    return invalid();
  }
  check(name, value);
  if (name === "Import")
    try {
      value.metadata = parseImportMetadata(rawText);
    } catch {
      return invalid();
    }
  for (const key of [
    "ids",
    "exclude_ids",
    "fact_ids",
    "exclude_fact_ids",
    "exclude_event_ids",
    "exclude_profile_ids",
  ])
    if (Array.isArray(value[key]))
      value[key] = value[key].map((id: string) => id.toLowerCase());
  for (const [a, b] of [
    ["recorded_after", "recorded_before"],
    ["created_after", "created_before"],
    ["event_after", "event_before"],
  ])
    if (
      value[a] != null &&
      value[b] != null &&
      (a.startsWith("event_")
        ? value[a] > value[b]
        : Date.parse(value[a]) > Date.parse(value[b]))
    )
      invalid();
  return value;
}
function page(c: C, defaults: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const raw = c.req.query(key);
    const n = raw === undefined ? fallback : Number(raw);
    if (
      !Number.isInteger(n) ||
      n <
        (key === "limit" || key === "last_days" || key === "time_range_in_days"
          ? 1
          : 0) ||
      (key === "limit" && n > 100) ||
      (key === "last_days" && n > 365) ||
      (key === "time_range_in_days" && n > 36500)
    )
      invalid();
    out[key] = n;
  }
  return out;
}
function receipt(c: C, result: any) {
  return c.json(
    result,
    ["processing", "staged"].includes(result.status) ? 202 : 200,
  );
}

export function createApp(
  createRuntime: (env: RuntimeEnv, signal?: AbortSignal) => Runtime,
) {
  const app = new Hono<Env>();
  app.onError((error, c) => {
    if (error instanceof SourceError)
      return c.json(
        {
          detail: {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            ...(error instanceof ExpiredAppendInputs && {
              append_operation_ids: error.appendOperationIds,
            }),
          },
        },
        error.status as any,
      );
    if (error instanceof LeaseLostError)
      return c.json(
        {
          detail: {
            code: "lease_lost",
            message: "User memory is being modified",
            retryable: true,
          },
        },
        409,
      );
    if (error instanceof InactiveUserError)
      return c.json(
        {
          detail: {
            code: "user_not_found",
            message: "User not found",
            retryable: false,
          },
        },
        404,
      );
    return c.json(
      {
        detail: {
          code: "internal_error",
          message: "Service unavailable",
          retryable: true,
        },
      },
      500,
    );
  });
  app.use("/api/*", async (c, next) => {
    const runtime = createRuntime(c.env, c.req.raw.signal);
    if (runtime.waitUntil) runtime.retrievalUsageWrites = [];
    try {
      const deadlineHeader = c.req.header("X-Memoia-Deadline-Ms");
      if (deadlineHeader !== undefined) {
        const value = Number(deadlineHeader);
        if (!Number.isSafeInteger(value) || value <= 0)
          throw new SourceError(
            "invalid_request",
            "Invalid execution deadline",
            422,
            false,
          );
        runtime.deadline = Math.min(runtime.deadline, Date.now() + value);
      }
      c.set("runtime", runtime);
      if (c.req.path !== "/api/healthcheck") {
        const principal = await authenticate(
          runtime.db,
          c.req.header("Authorization") ?? null,
          runtime.env.ACCESS_TOKEN,
        );
        if (!principal)
          throw new SourceError("unauthorized", "Unauthorized", 401, false);
        if (!allows(principal, requiredScope(c.req.method, c.req.path)))
          throw new SourceError(
            "scope_required",
            "API key lacks required scope",
            403,
            false,
          );
        if (
          runtime.env.MEMOIA_WRITES_ENABLED === "false" &&
          requiredScope(c.req.method, c.req.path) !== "read"
        )
          throw new SourceError(
            "maintenance_mode",
            "Memory writes are paused for coordinated maintenance",
            503,
            true,
          );
        c.set("principal", principal);
      }
      if (
        ["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method) &&
        c.req.raw.body
      ) {
        c.set("requestBody", await readRequestBody(c.req.raw));
      }
      await next();
    } finally {
      const usageWrites = runtime.retrievalUsageWrites;
      if (usageWrites?.length && runtime.waitUntil) {
        // The response no longer needs this connection pool. Finish known usage before closing it.
        runtime.waitUntil(
          Promise.allSettled(usageWrites).then(() => closeRuntime(runtime)),
        );
      } else {
        await closeRuntime(runtime);
      }
    }
  });
  const runtime = (c: C): Runtime => c.get("runtime");
  const principal = (c: C): Principal => c.get("principal");
  app.get("/api/healthcheck", async (c) => {
    const { db, env, tracing } = runtime(c);
    if (env.MEMOIA_HEALTHCHECK_DB_TRACE === "true" && tracing) {
      const {
        rows: [backend],
      } = await db.query<{
        pid: number;
        started_at_ms: number;
      }>(
        `SELECT pg_backend_pid() AS pid,
                (EXTRACT(EPOCH FROM backend_start) * 1000)::double precision AS started_at_ms
           FROM pg_catalog.pg_stat_activity
          WHERE pid = pg_backend_pid()`,
        undefined,
        "healthcheck",
      );
      if (backend) {
        try {
          tracing.getActiveSpan()?.setAttributes({
            "memoia.db.backend_pid": backend.pid,
            "memoia.db.backend_started_at_ms": Math.trunc(
              backend.started_at_ms,
            ),
          });
        } catch {}
      }
    } else {
      await db.query("SELECT 1", undefined, "healthcheck");
    }
    return c.json({ status: "ok" });
  });
  app.get("/api/project/identity", (c) =>
    c.json({ project_id: principal(c).projectId }),
  );
  app.get("/api/projects", async (c) => {
    const p = page(c, { limit: 50, offset: 0 });
    return c.json(
      await management.listProjects(
        runtime(c).db,
        principal(c),
        p.limit,
        p.offset,
      ),
    );
  });
  app.post("/api/projects", async (c) =>
    c.json(
      await management.createProject(
        runtime(c).db,
        principal(c),
        body(c, "ProjectCreate").project_id,
      ),
      201,
    ),
  );
  app.patch("/api/projects/:project_id", async (c) =>
    c.json(
      await management.updateProject(
        runtime(c).db,
        principal(c),
        c.req.param("project_id"),
        body(c, "ProjectUpdate").status,
      ),
    ),
  );
  app.get("/api/projects/:project_id/keys", async (c) => {
    const p = page(c, { limit: 50, offset: 0 });
    return c.json(
      await management.listKeys(
        runtime(c).db,
        principal(c),
        c.req.param("project_id"),
        p.limit,
        p.offset,
      ),
    );
  });
  app.post("/api/projects/:project_id/keys", async (c) =>
    c.json(
      await management.createKey(
        runtime(c).db,
        principal(c),
        c.req.param("project_id"),
        body(c, "KeyCreate"),
      ),
      201,
    ),
  );
  app.delete("/api/projects/:project_id/keys/:key_id", async (c) => {
    await management.revokeKey(
      runtime(c).db,
      principal(c),
      c.req.param("project_id"),
      pathUuid(c, "key_id"),
    );
    return c.body(null, 204);
  });
  app.post("/api/projects/:project_id/legacy-token/rotate", async (c) =>
    c.json(
      await management.rotateLegacyToken(
        runtime(c).db,
        principal(c),
        c.req.param("project_id"),
      ),
    ),
  );
  app.post("/api/users", async (c) =>
    c.json(
      await management.createUser(
        runtime(c).db,
        principal(c).projectId,
        body(c, "UserInput"),
      ),
      201,
    ),
  );
  app.get("/api/users", async (c) => {
    const p = page(c, { limit: 10, offset: 0 });
    const search = c.req.query("search") ?? "";
    const orderBy = c.req.query("order_by") ?? "updated_at";
    const desc = c.req.query("order_desc") ?? "true";
    if (
      search.length > 256 ||
      !["updated_at", "profile_count", "event_count"].includes(orderBy) ||
      !["true", "false"].includes(desc)
    )
      invalid();
    return c.json(
      await management.listUsers(runtime(c).db, principal(c).projectId, {
        search,
        orderBy: orderBy as any,
        descending: desc === "true",
        limit: p.limit,
        offset: p.offset,
      }),
    );
  });
  app.get("/api/users/:user_id", async (c) =>
    c.json(await management.getUser(runtime(c).db, scope(c))),
  );
  app.delete("/api/users/:user_id", async (c) =>
    c.json(await (await factApi()).forgetUser(runtime(c), scope(c))),
  );
  app.post("/api/users/:user_id/blobs", async (c) =>
    receipt(
      c,
      await (
        await factApi()
      ).stageImport(runtime(c), scope(c), body(c, "Import")),
    ),
  );
  app.post("/api/users/:user_id/blobs/:blob_id/flush", async (c) =>
    receipt(c, await (await import("./fact-flush.js")).flushBlob(
      runtime(c), scope(c), c.req.param("blob_id"), body(c, "FactFlushInput"),
    )),
  );
  app.get("/api/users/:user_id/operations", async (c) => {
    const p = page(c, { limit: 50, offset: 0 });
    return c.json({
      operations: await (
        await factApi()
      ).listOperations(runtime(c), scope(c), p.limit, p.offset),
    });
  });
  app.get("/api/users/:user_id/operations/by-key/:key", async (c) =>
    c.json(
      await (
        await factApi()
      ).getOperation(runtime(c), scope(c), { key: c.req.param("key") }),
    ),
  );
  app.get("/api/users/:user_id/operations/:operation_id", async (c) =>
    c.json(
      await (
        await factApi()
      ).getOperation(runtime(c), scope(c), {
        operationId: pathUuid(c, "operation_id"),
      }),
    ),
  );
  app.post("/api/users/:user_id/operations/:operation_id/retry", async (c) =>
    receipt(
      c,
      await (
        await factApi()
      ).retryOperation(runtime(c), scope(c), pathUuid(c, "operation_id")),
    ),
  );
  app.get("/api/users/:user_id/maintenance", async (c) =>
    c.json(await (await maintenanceApi()).getStatus(runtime(c), scope(c))),
  );
  app.post("/api/users/:user_id/flush", async (c) =>
    receipt(
      c,
      await (
        await maintenanceApi()
      ).flush(
        runtime(c),
        scope(c),
        body(c, "FlushInput").idempotency_key,
      ),
    ),
  );
  app.get("/api/users/:user_id/sources", async (c) => {
    const p = page(c, { limit: 50, offset: 0 });
    return c.json({
      sources: await (
        await factApi()
      ).listSources(runtime(c), scope(c), p.limit, p.offset),
    });
  });
  app.get("/api/users/:user_id/sources/:source_id", async (c) => {
    const p = page(c, {
      limit: 50,
      message_offset: 0,
      blob_offset: 0,
      evidence_offset: 0,
    });
    return c.json(
      await (
        await factApi()
      ).getSource(runtime(c), scope(c), c.req.param("source_id"), {
        limit: p.limit,
        messageOffset: p.message_offset,
        blobOffset: p.blob_offset,
        evidenceOffset: p.evidence_offset,
      }),
    );
  });
  app.delete("/api/users/:user_id/sources/:source_id/messages", async (c) =>
    receipt(
      c,
      await (
        await factApi()
      ).deleteMessages(
        runtime(c),
        scope(c),
        c.req.param("source_id"),
        body(c, "MessageDeletion"),
      ),
    ),
  );
  app.get("/api/users/:user_id/blobs/:blob_id", async (c) =>
    c.json(
      await (
        await factApi()
      ).getBlob(runtime(c), scope(c), c.req.param("blob_id")),
    ),
  );
  app.put("/api/users/:user_id/facts/:fact_id", async (c) =>
    receipt(
      c,
      await (
        await factApi()
      ).updateFact(
        runtime(c),
        scope(c),
        pathUuid(c, "fact_id"),
        body(c, "UpdateFact"),
      ),
    ),
  );
  app.delete("/api/users/:user_id/facts/:fact_id", async (c) =>
    receipt(
      c,
      await (
        await factApi()
      ).deleteFact(
        runtime(c),
        scope(c),
        pathUuid(c, "fact_id"),
        body(c, "DeleteFact"),
      ),
    ),
  );
  app.get("/api/users/:user_id/history", async (c) => {
    const p = page(c, { limit: 50, offset: 0 });
    return c.json({
      entries: await (
        await factApi()
      ).getHistory(runtime(c), scope(c), p.limit, p.offset),
    });
  });
  app.get("/api/users/:user_id/profiles", async (c) =>
    c.json(await retrieval.getProfiles(runtime(c), scope(c))),
  );
  app.post("/api/users/:user_id/profiles", async (c) =>
    c.json(
      await management.addProfile(
        runtime(c).db,
        scope(c),
        body(c, "ProfileInput"),
      ),
      201,
    ),
  );
  app.get("/api/users/:user_id/profiles/:profile_id", async (c) =>
    c.json(await retrieval.getProfile(runtime(c), scope(c), pathUuid(c, "profile_id"))),
  );
  app.patch("/api/users/:user_id/profiles/:profile_id", async (c) => {
    await management.updateProfile(
      runtime(c).db,
      scope(c),
      pathUuid(c, "profile_id"),
      body(c, "ProfileInput"),
    );
    return c.body(null, 204);
  });
  app.delete("/api/users/:user_id/profiles/:profile_id", async (c) => {
    await management.deleteProfile(
      runtime(c).db,
      scope(c),
      pathUuid(c, "profile_id"),
    );
    return c.body(null, 204);
  });
  app.get("/api/users/:user_id/events", async (c) => {
    const p = page(c, { limit: 10, time_range_in_days: 360 });
    return c.json(
      await retrieval.getEvents(
        runtime(c),
        scope(c),
        p.limit,
        p.time_range_in_days,
      ),
    );
  });
  app.post("/api/users/:user_id/events", async (c) =>
    c.json(await management.addEvent(runtime(c), scope(c), body(c, "EventInput")), 201),
  );
  app.get("/api/users/:user_id/events/:event_id", async (c) =>
    c.json(await retrieval.getEvent(runtime(c), scope(c), pathUuid(c, "event_id"))),
  );
  app.patch("/api/users/:user_id/events/:event_id", async (c) => {
    await management.updateEvent(runtime(c), scope(c), pathUuid(c, "event_id"), body(c, "EventPatch"));
    return c.body(null, 204);
  });
  app.delete("/api/users/:user_id/events/:event_id", async (c) => {
    await management.deleteEvent(
      runtime(c).db,
      scope(c),
      pathUuid(c, "event_id"),
    );
    return c.body(null, 204);
  });
  app.post("/api/users/:user_id/facts/query", async (c) =>
    c.json(
      await retrieval.queryFacts(
        runtime(c),
        scope(c),
        body(c, "FactQuery"),
      ),
    ),
  );
  app.post("/api/users/:user_id/events/query", async (c) =>
    c.json(
      await retrieval.queryEvents(
        runtime(c),
        scope(c),
        body(c, "EventQuery"),
      ),
    ),
  );
  app.post("/api/users/:user_id/profiles/query", async (c) =>
    c.json(
      await retrieval.queryProfiles(
        runtime(c),
        scope(c),
        body(c, "ProfileQuery"),
      ),
    ),
  );
  app.post("/api/users/:user_id/search", async (c) =>
    c.json(
      await retrieval.search(
        runtime(c),
        scope(c),
        body(c, "SearchInput"),
      ),
    ),
  );
  app.post("/api/users/:user_id/context", async (c) =>
    c.json(
      await retrieval.context(
        runtime(c),
        scope(c),
        body(c, "ContextInput"),
      ),
    ),
  );
  app.get("/api/project/config", async (c) =>
    c.json(await retrieval.getConfig(runtime(c), principal(c).projectId)),
  );
  app.patch("/api/project/config", async (c) => {
    await retrieval.updateConfig(
      runtime(c),
      principal(c).projectId,
      body(c, "Config"),
    );
    return c.body(null, 204);
  });
  app.get("/api/project/usage", async (c) => {
    const p = page(c, { last_days: 7 });
    return c.json(
      await retrieval.getUsage(runtime(c), principal(c).projectId, p.last_days),
    );
  });
  app.get("/api/project/usage/events", async (c) => {
    const limit = page(c, { limit: 100 }).limit;
    const date = c.req.query("date");
    const userId = c.req.query("user_id");
    const cursor = c.req.query("cursor");
    check("UsageEventsQuery", { date, limit, user_id: userId, cursor });
    const [time, id, extra] = cursor?.split("/") ?? [];
    if (
      cursor &&
      (!time ||
        !id ||
        extra !== undefined ||
        !uuid.test(id) ||
        !Number.isFinite(Date.parse(time)) ||
        new Date(time).toISOString() !== time ||
        !time.startsWith(`${date}T`))
    )
      invalid();
    return c.json(
      await listUsageEvents(
        runtime(c),
        principal(c).projectId,
        date!,
        limit,
        userId?.toLowerCase(),
        time && id ? { time, id } : undefined,
      ),
    );
  });
  return app;
}
