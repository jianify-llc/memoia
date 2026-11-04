import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import pg from "pg";

const run = promisify(execFile);
test(
  "upgrade validates the Drizzle prefix and applies pending migrations atomically",
  { skip: !process.env.MEMOIA_TEST_ADMIN_DATABASE_URL, timeout: 30000 },
  async () => {
    const admin = new pg.Client({
      connectionString: process.env.MEMOIA_TEST_ADMIN_DATABASE_URL,
    });
    const suffix = randomUUID().replaceAll("-", ""),
      names = [`upgrade_${suffix}`, `upgrade_wrong_${suffix}`];
    const urls = names.map((name) => {
      const url = new URL(process.env.MEMOIA_TEST_ADMIN_DATABASE_URL!);
      url.pathname = `/${name}`;
      return url.toString();
    });
    const cli = (action: string, url: string) =>
      run(process.execPath, [
        "--import",
        "tsx",
        "scripts/migrate.ts",
        action,
        "--target",
        url,
      ]);
    await admin.connect();
    try {
      for (const name of names) await admin.query(`CREATE DATABASE "${name}"`);
      await cli("init", urls[0]);
      const db = new pg.Client({ connectionString: urls[0] });
      await db.connect();
      try {
        // Reconstruct the actual prefix after migration 0002.
        await db.query(`BEGIN; ALTER TABLE memoia.queue_tasks DROP CONSTRAINT queue_task_terminal;
        ALTER TABLE memoia.queue_tasks ADD CONSTRAINT queue_task_terminal CHECK ((status IN ('succeeded','failed'))=(finished_at IS NOT NULL));
        DELETE FROM memoia.__drizzle_migrations WHERE id=(SELECT max(id) FROM memoia.__drizzle_migrations); COMMIT`);
        const before = (
          await db.query(
            "SELECT id,hash,created_at FROM memoia.__drizzle_migrations ORDER BY id",
          )
        ).rows;
        assert.equal(before.length, 3);
        await db.query(
          "UPDATE memoia.__drizzle_migrations SET hash='invalid' WHERE id=(SELECT min(id) FROM memoia.__drizzle_migrations)",
        );
        await assert.rejects(cli("upgrade", urls[0]), /known journal prefix/);
        await db.query(
          "UPDATE memoia.__drizzle_migrations SET hash=$1 WHERE id=$2",
          [before[0].hash, before[0].id],
        );
        await db.query(
          "UPDATE memoia.__drizzle_migrations SET created_at=created_at+1 WHERE id=$1",
          [before[0].id],
        );
        await assert.rejects(cli("upgrade", urls[0]), /known journal prefix/);
        await db.query(
          "UPDATE memoia.__drizzle_migrations SET created_at=$1 WHERE id=$2",
          [before[0].created_at, before[0].id],
        );
        await db.query(
          "ALTER TABLE memoia.queue_tasks RENAME COLUMN first_started_at TO unavailable_first_started_at",
        );
        await assert.rejects(cli("upgrade", urls[0]));
        assert.equal(
          (
            await db.query(
              "SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid='memoia.queue_tasks'::regclass AND conname='queue_task_terminal'",
            )
          ).rows[0].n,
          1,
        );
        assert.equal(
          (
            await db.query(
              "SELECT count(*)::int AS n FROM memoia.__drizzle_migrations",
            )
          ).rows[0].n,
          3,
        );
        await db.query(
          "ALTER TABLE memoia.queue_tasks RENAME COLUMN unavailable_first_started_at TO first_started_at",
        );
        await cli("upgrade", urls[0]);
        const after = (
          await db.query(
            "SELECT hash,created_at FROM memoia.__drizzle_migrations ORDER BY id",
          )
        ).rows;
        assert.equal(after.length, 4);
        assert.match(
          (
            await db.query(
              "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='memoia.queue_tasks'::regclass AND conname='queue_task_terminal'",
            )
          ).rows[0].def,
          /first_started_at/,
        );
        await cli("upgrade", urls[0]);
        assert.deepEqual(
          (
            await db.query(
              "SELECT hash,created_at FROM memoia.__drizzle_migrations ORDER BY id",
            )
          ).rows,
          after,
        );
      } finally {
        await db.end();
      }
      const wrong = new pg.Client({ connectionString: urls[1] });
      await wrong.connect();
      try {
        await wrong.query(
          "CREATE SCHEMA wrong; CREATE TABLE wrong.__drizzle_migrations(id serial PRIMARY KEY,hash text NOT NULL,created_at bigint)",
        );
      } finally {
        await wrong.end();
      }
      await assert.rejects(
        cli("upgrade", urls[1]),
        /Missing memoia migration ledger/,
      );
    } finally {
      for (const name of names)
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    }
  },
);
