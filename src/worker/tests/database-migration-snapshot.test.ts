import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";

const run = promisify(execFile);
test(
  "snapshot restores only memoia and leaves other schemas intact",
  {
    skip:
      !process.env.MEMOIA_TEST_ADMIN_DATABASE_URL ||
      !process.env.MEMOIA_TEST_PG_TOOLS,
    timeout: 30000,
  },
  async () => {
    const admin = new pg.Client({
      connectionString: process.env.MEMOIA_TEST_ADMIN_DATABASE_URL,
    });
    const suffix = randomUUID().replaceAll("-", ""),
      names = [`snapshot_src_${suffix}`, `snapshot_dst_${suffix}`];
    const urls = names.map((name) => {
      const url = new URL(process.env.MEMOIA_TEST_ADMIN_DATABASE_URL!);
      url.pathname = `/${name}`;
      return url.toString();
    });
    const dir = await mkdtemp(join(tmpdir(), "memoia-snapshot-")),
      file = join(dir, "archive.dump");
    const cli = (script: string, ...args: string[]) =>
      run(
        process.execPath,
        ["--import", "tsx", `scripts/${script}.ts`, ...args],
        {
          env: {
            ...process.env,
            PATH: `${process.env.MEMOIA_TEST_PG_TOOLS}:${process.env.PATH}`,
          },
        },
      );
    await admin.connect();
    try {
      for (const name of names) await admin.query(`CREATE DATABASE "${name}"`);
      for (const url of urls) {
        const db = new pg.Client({ connectionString: url });
        await db.connect();
        try {
          await db.query(
            "CREATE SCHEMA extensions; CREATE EXTENSION vector WITH SCHEMA extensions; CREATE SCHEMA luvel; CREATE TABLE luvel.sentinel(value text); INSERT INTO luvel.sentinel VALUES ('untouched')",
          );
        } finally {
          await db.end();
        }
      }
      await cli("migrate", "init", "--target", urls[0]);
      await cli("migrate", "bootstrap", "--target", urls[0]);
      const foreign = join(dir, "foreign.dump");
      await run(
        "pg_dump",
        [
          "--format=custom",
          "--schema=luvel",
          "--file",
          foreign,
          "--dbname",
          urls[0],
        ],
        {
          env: {
            ...process.env,
            PATH: `${process.env.MEMOIA_TEST_PG_TOOLS}:${process.env.PATH}`,
          },
        },
      );
      await assert.rejects(
        cli("snapshot", "restore", "--target", urls[1], "--file", foreign),
        /unsupported or non-memoia/,
      );
      await cli("snapshot", "export", "--source", urls[0], "--file", file);
      await cli("snapshot", "restore", "--target", urls[1], "--file", file);
      const target = new pg.Client({ connectionString: urls[1] });
      await target.connect();
      try {
        assert.equal(
          (await target.query("SELECT value FROM luvel.sentinel")).rows[0]
            .value,
          "untouched",
        );
        assert.equal(
          (await target.query("SELECT project_id FROM memoia.projects")).rows[0]
            .project_id,
          "__root__",
        );
      } finally {
        await target.end();
      }
      await assert.rejects(
        cli("snapshot", "restore", "--target", urls[1], "--file", file),
      );
      await assert.rejects(
        cli("snapshot", "export", "--source", urls[0], "--file", file),
      );
    } finally {
      for (const name of names)
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
