import { test } from "node:test";
import assert from "node:assert/strict";
import { Database } from "../src/db.js";
import { closeRuntime, createRuntime } from "../src/runtime.js";
import { createCloudflareRuntime } from "../src/cloudflare-runtime.js";

const env = { OPENAI_API_KEY: "unused", DATABASE_URL: "postgresql://unused" };

test("Node requests borrow one process pool without closing it", async () => {
  const db = new Database(env.DATABASE_URL, { maxConnections: 8 });
  const original = db.close.bind(db);
  let closes = 0;
  db.close = async () => {
    closes++;
    await original();
  };
  const first = createRuntime(env, undefined, db);
  const second = createRuntime(env, undefined, db);
  assert.equal(first.db, second.db);
  await closeRuntime(first);
  await closeRuntime(second);
  assert.equal(closes, 0);
  await db.close();
  assert.equal(closes, 1);
});

test("Cloudflare invocation still closes its own database", async () => {
  const runtime = createRuntime(env);
  const original = runtime.db.close.bind(runtime.db);
  let closes = 0;
  runtime.db.close = async () => {
    closes++;
    await original();
  };
  await closeRuntime(runtime);
  assert.equal(closes, 1);
});

test("Cloudflare queue adapter preserves receiver, identity and delay; Node relies on polling", async () => {
  const sent: unknown[] = [];
  const queue = {
    async send(message: unknown, options: unknown) {
      assert.equal(this, queue);
      sent.push(message, options);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  };
  const cloudflare = createCloudflareRuntime({
    ...env,
    MAINTENANCE_QUEUE: queue,
  });
  const node = createRuntime(env);
  const message = { kind: "user" as const, user_id: "u", project_id: "p" };
  try {
    assert.ok(cloudflare.maintenanceWakeup);
    assert.equal(node.maintenanceWakeup, undefined);
    await cloudflare.maintenanceWakeup.send(message, 30);
    assert.deepEqual(sent, [message, { delaySeconds: 30 }]);
  } finally {
    await closeRuntime(cloudflare);
    await closeRuntime(node);
  }
});

test("Cloudflare normalizes Hyperdrive while retaining inherited credentials for independent cleanup", async () => {
  const cloudflareEnv = Object.assign(
    Object.create({
      OPENAI_API_KEY: "inherited-key",
      ACCESS_TOKEN: "inherited-token",
      DATABASE_URL: "postgresql://fallback-unused",
      HYPERDRIVE: { connectionString: "postgresql://hyperdrive-unused" },
    }),
    { MAINTENANCE_ENABLED: "true" },
  );
  const runtime = createCloudflareRuntime(cloudflareEnv);
  const isolated = createRuntime(runtime.env);
  try {
    assert.equal(runtime.env.DATABASE_URL, "postgresql://hyperdrive-unused");
    assert.equal(runtime.env.ACCESS_TOKEN, "inherited-token");
    assert.equal(isolated.env.OPENAI_API_KEY, "inherited-key");
    assert.equal(isolated.env.MAINTENANCE_ENABLED, "true");
    assert.notEqual(isolated.db, runtime.db);
    assert.equal(isolated.ownsDatabase, true);
  } finally {
    await closeRuntime(isolated);
    await closeRuntime(runtime);
  }
});
