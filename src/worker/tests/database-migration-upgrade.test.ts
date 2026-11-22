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
        const projectId = "version-upgrade", userId = randomUUID();
        const profileId = randomUUID(), eventId = randomUUID();
        // Reconstruct the actual prefix after migration 0002.
        await db.query(`BEGIN;
        ALTER TABLE memoia.user_profiles RENAME COLUMN version TO revision;
        ALTER TABLE memoia.user_events RENAME COLUMN version TO revision;
        DROP INDEX memoia.uq_memoia_running_task_scope, memoia.uq_memoia_active_fact_blob;
        DROP TRIGGER reject_forgotten_user ON memoia.users;
        DROP FUNCTION memoia.reject_forgotten_user();
        ALTER TABLE memoia.queue_tasks DROP CONSTRAINT queue_task_terminal;
        ALTER TABLE memoia.queue_tasks ADD CONSTRAINT queue_task_terminal CHECK ((status IN ('succeeded','failed'))=(finished_at IS NOT NULL));
        ALTER TABLE memoia.memory_blobs DROP COLUMN external_id;
        ALTER TABLE memoia.memory_operations DROP CONSTRAINT ck_memory_flush_lease;
        ALTER TABLE memoia.memory_operations DROP COLUMN fact_flush_id;
        ALTER TABLE memoia.memory_operations ADD CONSTRAINT ck_memory_flush_lease CHECK (
          (lease_owner IS NULL)=(lease_until IS NULL) AND attempts BETWEEN 0 AND 4
          AND (kind='flush' OR (lease_owner IS NULL AND attempts=0 AND available_at IS NULL)));
        ALTER TABLE memoia.memory_operations DROP CONSTRAINT memory_operations_kind_check, DROP CONSTRAINT memory_operations_status_check;
        ALTER TABLE memoia.memory_operations
          ADD CONSTRAINT memory_operations_kind_check CHECK (kind IN ('import','retract','correct','legacy_import','flush')),
          ADD CONSTRAINT memory_operations_status_check CHECK (status IN ('processing','completed','failed'));
        DELETE FROM memoia.__drizzle_migrations WHERE id IN (SELECT id FROM memoia.__drizzle_migrations ORDER BY id OFFSET 3); COMMIT`);
        await db.query(
          "INSERT INTO memoia.projects(id,project_id,project_secret,status) VALUES($1,$2,'local','active')",
          [randomUUID(), projectId],
        );
        await db.query("INSERT INTO memoia.users(id,project_id) VALUES($1,$2)", [userId, projectId]);
        await db.query(
          "INSERT INTO memoia.user_profiles(id,user_id,project_id,content,revision) VALUES($1,$2,$3,'sample profile',17)",
          [profileId, userId, projectId],
        );
        await db.query(
          "INSERT INTO memoia.user_events(id,user_id,project_id,event_data,revision) VALUES($1,$2,$3,'{}',29)",
          [eventId, userId, projectId],
        );
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
        assert.equal(after.length, 9);
        assert.equal((await db.query("SELECT version FROM memoia.user_profiles WHERE id=$1", [profileId])).rows[0].version, "17");
        assert.equal((await db.query("SELECT version FROM memoia.user_events WHERE id=$1", [eventId])).rows[0].version, "29");
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
