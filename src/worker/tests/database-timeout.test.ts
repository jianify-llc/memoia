import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Database, DatabaseUnavailableError } from "../src/db";

const never = () => new Promise<never>(() => {});
function fixture(
  query: (sql: string) => Promise<unknown>,
  end = async () => {},
) {
  const db = new Database("postgres://unused", {
    transactionTimeoutMs: 35,
    closeTimeoutMs: 20,
  });
  const releases: boolean[] = [];
  const client = Object.assign(new EventEmitter(), {
    query,
    release: (discard: boolean) => releases.push(discard),
  });
  (db as unknown as { pool: unknown }).pool = {
    connect: async () => client,
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
  assert.ok(!queries.includes("ROLLBACK"));
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
      db.query("broken"),
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
  await assert.rejects(db.query("write"), DatabaseUnavailableError);
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
