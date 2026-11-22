import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import pg from "pg";
import { Database, DatabaseUnavailableError } from "../src/db";
import { createApp } from "../src/http";
import type { Runtime } from "../src/runtime";

const never = () => new Promise<never>(() => {});
function fixture(
  query: (sql: string) => Promise<unknown>,
  end = async () => {},
  tracing?: Tracing,
  checkoutError?: Error,
) {
  const db = new Database("postgres://unused", {
    transactionTimeoutMs: 35,
    closeTimeoutMs: 20,
    tracing,
  });
  const releases: boolean[] = [];
  const client = Object.assign(new EventEmitter(), {
    query,
    release: (discard: boolean) => releases.push(discard),
  });
  (db as unknown as { pool: unknown }).pool = {
    connect: async () => {
      if (checkoutError) throw checkoutError;
      return client;
    },
    end,
  };
  return { db, releases, client };
}
const result = { rows: [{}], rowCount: 1 };

test("a blackholed query is bounded and the connection is destroyed without rollback", async () => {
  const queries: string[] = [];
  const { db, releases } = fixture(async (sql) => {
    queries.push(sql);
    return sql === "blackhole" ? never() : result;
  });
  await assert.rejects(db.query("blackhole"), DatabaseUnavailableError);
  assert.deepEqual(releases, [true]);
  assert.deepEqual(queries, ["blackhole"]);
  await db.close();
});

test("a blackholed rollback and pool close are bounded and destroy checked out connections", async () => {
  const { db, releases } = fixture(
    async (sql) => (sql === "ROLLBACK" ? never() : result),
    never,
  );
  await assert.rejects(
    db.transaction(async () => {
      throw new Error("bad SQL");
    }),
    DatabaseUnavailableError,
  );
  assert.deepEqual(releases, [true]);
  await db.close();
});

test("transport errors discard connections; ordinary SQL errors roll back and remain unchanged", async () => {
  for (const transport of [true, false]) {
    const failure = transport
      ? Object.assign(new Error("socket closed"), { code: "ECONNRESET" })
      : Object.assign(new Error("syntax error"), { code: "42601" });
    const queries: string[] = [];
    const { db, releases } = fixture(async (sql) => {
      queries.push(sql);
      if (sql === "broken") throw failure;
      return result;
    });
    await assert.rejects(
      db.transaction((tx) => tx.query("broken")),
      transport
        ? DatabaseUnavailableError
        : (error: unknown) => error === failure,
    );
    assert.deepEqual(releases, [transport]);
    assert.equal(queries.includes("ROLLBACK"), !transport);
    await db.close();
  }
});

test("close stops waiting for a checked out blackholed client", async () => {
  const { db, releases } = fixture(
    async (sql) => (sql === "blackhole" ? never() : result),
    never,
  );
  const pending = db.query("blackhole");
  await new Promise((resolve) => setTimeout(resolve, 1));
  await db.close();
  assert.deepEqual(releases, [true]);
  await assert.rejects(pending, DatabaseUnavailableError);
});

test("COMMIT response timeout is an unknown outcome and never rolls back on that connection", async () => {
  const queries: string[] = [];
  const { db, releases } = fixture(async (sql) => {
    queries.push(sql);
    return sql === "COMMIT" ? never() : result;
  });
  await assert.rejects(
    db.transaction((tx) => tx.query("write")),
    DatabaseUnavailableError,
  );
  assert.deepEqual(releases, [true]);
  assert.ok(!queries.includes("ROLLBACK"));
  await db.close();
});

test("idle pool error is observed and does not log connection details", async () => {
  const db = new Database("postgres://unused");
  const pool = (db as unknown as { pool: EventEmitter }).pool;
  const messages: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    messages.push(...args);
  };
  try {
    pool.emit("error", new Error("secret connection details"));
    assert.deepEqual(messages, ['{"event":"database_idle_connection_error"}']);
  } finally {
    console.warn = originalWarn;
    await db.close();
  }
});

test("checked-out client error destroys it once and removes our listener", async () => {
  const queries: string[] = [];
  const { db, client, releases } = fixture(async (sql) => {
    queries.push(sql);
    return result;
  });
  await assert.rejects(
    db.transaction(async (tx) => {
      client.emit(
        "error",
        Object.assign(new Error("socket lost"), { code: "ECONNRESET" }),
      );
      await tx.query("must not run");
    }),
    DatabaseUnavailableError,
  );
  assert.deepEqual(releases, [true]);
  assert.equal(client.listenerCount("error"), 0);
  assert.ok(!queries.includes("ROLLBACK"));
  assert.ok(!queries.includes("must not run"));
  await db.close();
});

test("client error while query rejects is consumed and cannot double release", async () => {
  let rejectQuery!: (error: Error) => void;
  const { db, client, releases } = fixture(async (sql) =>
    sql === "in flight"
      ? new Promise((_, reject) => {
          rejectQuery = reject;
        })
      : result,
  );
  const pending = db.query("in flight");
  await new Promise((resolve) => setTimeout(resolve, 1));
  const failure = Object.assign(new Error("socket lost"), {
    code: "ECONNRESET",
  });
  rejectQuery(failure);
  client.emit("error", failure);
  await assert.rejects(pending, DatabaseUnavailableError);
  assert.deepEqual(releases, [true]);
  assert.equal(client.listenerCount("error"), 0);
  await db.close();
});

test("traces distinguish checkout, PostgreSQL rejection at BEGIN, and local deadline", async () => {
  const events: Array<{ name: string; attributes: Record<string, unknown> }> =
    [];
  const tracing = {
    enterSpan(name: string, callback: (span: unknown) => Promise<unknown>) {
      const attributes: Record<string, unknown> = {};
      events.push({ name, attributes });
      return callback({
        setAttribute(key: string, value: unknown) {
          attributes[key] = value;
        },
        setAttributes(values: object) {
          Object.assign(attributes, values);
        },
        setStatus() {},
      });
    },
  } as unknown as Tracing;
  const rejected = Object.assign(
    new pg.DatabaseError("private-role-canary", 0, "error"),
    {
      code: "53300",
    },
  );
  const { db } = fixture(
    async (sql) => {
      if (sql.startsWith("BEGIN")) throw rejected;
      return result;
    },
    undefined,
    tracing,
  );
  await assert.rejects(
    db.transaction((tx) => tx.query("private-sql-canary"), { operation: "healthcheck" }),
    DatabaseUnavailableError,
  );
  assert.equal(events[0]?.name, "memoia.db.acquire");
  assert.equal(events[0]?.attributes["db.operation.name"], "healthcheck");
  assert.equal(events[1]?.name, "memoia.db.query");
  assert.equal(events[1]?.attributes["memoia.db.phase"], "begin");
  assert.equal(events[1]?.attributes["db.response.status_code"], "53300");
  assert.ok(!JSON.stringify(events).includes("canary"));
  assert.ok(!events.some((event) => event.name === "memoia.db.deadline"));
  await db.close();

  const slow = fixture(never, undefined, tracing);
  await assert.rejects(
    slow.db.transaction(async () => {}, { operation: "purge_expired_inputs" }),
    DatabaseUnavailableError,
  );
  const deadline = events.find((event) => event.name === "memoia.db.deadline");
  assert.equal(
    deadline?.attributes["db.operation.name"],
    "purge_expired_inputs",
  );
  assert.deepEqual(slow.releases, [true]);
  await slow.db.close();
});

test("healthcheck returns a safe 503 when PostgreSQL rejects checkout or the standalone query", async () => {
  const rejected = Object.assign(
    new pg.DatabaseError("private-role-canary", 0, "error"),
    {
      code: "53300",
    },
  );
  for (const phase of ["checkout", "query"]) {
    const queries: string[] = [];
    const { db, releases } = fixture(
      async (sql) => {
        queries.push(sql);
        throw rejected;
      },
      undefined,
      undefined,
      phase === "checkout" ? rejected : undefined,
    );
    const app = createApp(() => ({
      db,
      env: { OPENAI_API_KEY: "unused" },
      deadline: Date.now() + 1000,
    }));
    const response = await app.request("/api/healthcheck");
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      detail: {
        code: "database_unavailable",
        message: "Database temporarily unavailable",
        retryable: true,
      },
    });
    assert.deepEqual(queries, phase === "checkout" ? [] : ["SELECT 1"]);
    assert.deepEqual(releases, phase === "checkout" ? [] : [true]);
  }
});

test("a 53300 after BEGIN keeps the original write error", async () => {
  const rejected = Object.assign(
    new pg.DatabaseError("private-role-canary", 0, "error"),
    {
      code: "53300",
    },
  );
  const calls: string[] = [];
  const { db } = fixture(async (sql) => {
    calls.push(sql);
    if (sql === "COMMIT") throw rejected;
    return result;
  });
  await assert.rejects(
    db.transaction((tx) => tx.query("fixture-write")),
    (error) => error === rejected,
  );
  assert.equal(calls.filter((sql) => sql === "fixture-write").length, 1);
  assert.equal(calls.filter((sql) => sql === "COMMIT").length, 1);
  await db.close();
});

test("healthcheck records the origin session only when enabled", async () => {
  const startedAt = 1795047846222;
  for (const enabled of [false, true]) {
    const queries: string[] = [];
    const attributes: Record<string, unknown> = {};
    const tracing = {
      enterSpan(_name: string, callback: (span: unknown) => Promise<unknown>) {
        return callback({ setAttributes() {} });
      },
      getActiveSpan() {
        return {
          setAttributes(values: object) {
            Object.assign(attributes, values);
          },
        };
      },
    } as unknown as Tracing;
    const { db } = fixture(
      async (sql) => {
        queries.push(sql);
        return { ...result, rows: [{ pid: 123, started_at_ms: startedAt }] };
      },
      undefined,
      tracing,
    );
    const env: Runtime["env"] = {
      OPENAI_API_KEY: "unused",
      ...(enabled ? { MEMOIA_HEALTHCHECK_DB_TRACE: "true" } : {}),
    };
    const app = createApp(() => ({
      db,
      env,
      tracing,
      deadline: Date.now() + 1000,
    }));
    const response = await app.request("/api/healthcheck");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
    assert.equal(queries.length, 1);
    if (enabled) {
      assert.match(queries[0]!, /pg_backend_pid\(\)/);
    } else {
      assert.deepEqual(queries, ["SELECT 1"]);
    }
    assert.deepEqual(
      attributes,
      enabled
        ? {
            "memoia.db.backend_pid": 123,
            "memoia.db.backend_started_at_ms": startedAt,
          }
        : {},
    );
  }
});
