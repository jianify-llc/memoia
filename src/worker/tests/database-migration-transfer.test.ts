import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createClient } from "redis";
import {
  parseKey,
  validateValue,
  requireCurrentMonth,
} from "../scripts/usage-transfer";

const run = promisify(execFile);
test("usage parser preserves bucket identity and bigint precision", () => {
  assert.deepEqual(parseKey("p::project::llm::2024-02", "p::"), {
    project_id: "project",
    name: "llm",
    period_type: "month",
    period_start: "2024-02-01",
  });
  assert.throws(() => parseKey("p::project::llm::2024-02-30", "p::"));
  validateValue("9223372036854775807");
  assert.throws(() => validateValue("9223372036854775808"));
  assert.throws(
    () => requireCurrentMonth([], ["project"], "2024-02"),
    /unknown/,
  );
});
test(
  "usage transfer retains absolute expiry, scope and rejects unknown or nonempty destination",
  {
    skip:
      !process.env.MEMOIA_TEST_ADMIN_DATABASE_URL ||
      !process.env.MEMOIA_TEST_REDIS_URL,
    timeout: 30000,
  },
  async () => {
    const adminUrl = process.env.MEMOIA_TEST_ADMIN_DATABASE_URL!,
      redisUrl = process.env.MEMOIA_TEST_REDIS_URL!;
    const admin = new pg.Client({ connectionString: adminUrl }),
      redis = createClient({ url: redisUrl });
    const name = `memoia_usage_${randomUUID().replaceAll("-", "")}`,
      target = new URL(adminUrl);
    target.pathname = `/${name}`;
    const dir = await mkdtemp(join(tmpdir(), "memoia-usage-")),
      installation = `test-${randomUUID()}`,
      prefix = `memobase_telemetry::${installation}::`;
    const cli = (script: string, ...args: string[]) =>
      run(
        process.execPath,
        ["--import", "tsx", `scripts/${script}.ts`, ...args],
        { timeout: 8000 },
      );
    await admin.connect();
    await redis.connect();
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      await cli("migrate", "init", "--target", target.toString());
      await cli("migrate", "bootstrap", "--target", target.toString());
      const assertRedisFailure = async (url: string) => {
        try {
          await cli(
            "usage-transfer",
            "--redis-url",
            url,
            "--installation-id",
            installation,
            "--database-url",
            target.toString(),
            "--source-quiesced",
            "--file",
            join(dir, "should-not-exist.json"),
          );
          assert.fail("Redis connection unexpectedly succeeded");
        } catch (error) {
          const failure = error as Error & {
            killed?: boolean;
            stderr?: string;
            code?: number | string;
          };
          assert.equal(
            failure.killed,
            false,
            "connection failure must exit before the timeout",
          );
          assert.notEqual(failure.code, 0);
          assert.equal(
            failure.stderr,
            "Usage transfer failed; verify inputs, scope, and connectivity\n",
          );
          assert.ok(!failure.stderr.includes(url));
        }
      };
      await assertRedisFailure("redis://127.0.0.1:1/0");
      const badCredentials = new URL(redisUrl);
      badCredentials.username = "migration-test";
      badCredentials.password = "do-not-log-local-secret";
      await assertRedisFailure(badCredentials.toString());
      const month = new Date().toISOString().slice(0, 7),
        expiry = Date.now() + 86400000;
      const input = `${prefix}__root__::llm_input_tokens::${month}`,
        output = `${prefix}__root__::llm_output_tokens::${month}`,
        daily = `${prefix}__root__::events::${month}-01`,
        foreign = `${prefix}other::events::${month}`;
      await redis.set(input, "9223372036854775807", { PXAT: expiry });
      const args = [
        "--redis-url",
        redisUrl,
        "--installation-id",
        installation,
        "--database-url",
        target.toString(),
        "--source-quiesced",
      ];
      await assert.rejects(
        cli("usage-transfer", ...args, "--file", join(dir, "unknown.json")),
      );
      await redis.set(output, "17", { PXAT: expiry });
      await redis.set(daily, "3", { PXAT: expiry });
      await redis.set(foreign, "99", { PXAT: expiry });
      const file = join(dir, "snapshot.json");
      await cli("usage-transfer", ...args, "--file", file);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      const snapshot = JSON.parse(await readFile(file, "utf8"));
      assert.equal(snapshot.buckets.length, 3);
      assert.equal(
        snapshot.buckets.find((b: any) => b.name === "llm_input_tokens").value,
        "9223372036854775807",
      );
      for (const b of snapshot.buckets) assert.equal(b.expires_at_ms, expiry);
      const db = new pg.Client({ connectionString: target.toString() });
      await db.connect();
      try {
        const rows = (
          await db.query(
            "SELECT name,value::text AS value,extract(epoch from expires_at)*1000 AS expiry FROM memoia.usage_counters ORDER BY name",
          )
        ).rows;
        assert.equal(rows.length, 3);
        assert.equal(
          rows.find((r) => r.name === "llm_input_tokens").value,
          "9223372036854775807",
        );
        assert.ok(rows.every((r) => Number(r.expiry) === expiry));
      } finally {
        await db.end();
      }
      await assert.rejects(
        cli("usage-transfer", ...args, "--file", join(dir, "nonempty.json")),
      );
      await assert.rejects(cli("usage-transfer", ...args, "--file", file));
      assert.equal(await redis.get(foreign), "99");
    } finally {
      const keys = await redis.keys(`${prefix}*`);
      if (keys.length) await redis.del(keys);
      await redis.close();
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
