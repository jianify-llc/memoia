import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { createApp } from "../src/http";
import { createRuntime } from "../src/runtime";

const adminUrl = process.env.MEMOIA_TEST_ADMIN_DATABASE_URL;
const run = promisify(execFile);

test(
  "copy preserves vector data across different source and target collations",
  { skip: !adminUrl },
  async () => {
    const database = `memoia_vector_${randomBytes(6).toString("hex")}`;
    const sourceDatabase = `memoia_vector_source_${randomBytes(6).toString("hex")}`;
    const admin = new pg.Client({ connectionString: adminUrl });
    const target = new URL(adminUrl!);
    target.pathname = `/${database}`;
    const source = new URL(adminUrl!);
    source.pathname = `/${sourceDatabase}`;
    await admin.connect();
    try {
      await admin.query(
        `CREATE DATABASE "${database}" TEMPLATE template0 LOCALE 'C'`,
      );
      await admin.query(
        `CREATE DATABASE "${sourceDatabase}" TEMPLATE template0 LOCALE_PROVIDER icu ICU_LOCALE 'en-US'`,
      );
      const setup = new pg.Client({ connectionString: target.toString() });
      await setup.connect();
      try {
        await setup.query(
          "CREATE SCHEMA extensions; CREATE EXTENSION vector WITH SCHEMA extensions",
        );
      } finally {
        await setup.end();
      }
      const script = new URL("../scripts/migrate.ts", import.meta.url).pathname;

      const sourceDb = new pg.Client({ connectionString: source.toString() });
      await sourceDb.connect();
      let sourceEmbedding: string;
      try {
        await sourceDb.query(
          await readFile(
            new URL("./database-migration-schema.sql", import.meta.url),
            "utf8",
          ),
        );
        await sourceDb.query(
          await readFile(
            new URL("./migration-source.sql", import.meta.url),
            "utf8",
          ),
        );
        await sourceDb.query(
          "INSERT INTO memoia.memory_sources(user_id,project_id,source_id) VALUES ('00000000-0000-4000-8000-000000000002','migration-fixture','Z'),('00000000-0000-4000-8000-000000000002','migration-fixture','a')",
        );
        const order = await sourceDb.query(
          "SELECT array_agg(source_id ORDER BY row_to_json(t)::text) AS ids FROM memoia.memory_sources t WHERE source_id IN ('Z','a')",
        );
        assert.deepEqual(order.rows[0].ids, ["a", "Z"]);
        const facts = await sourceDb.query(
          "SELECT id,embedding::text AS embedding FROM memoia.memory_facts WHERE embedding IS NOT NULL",
        );
        assert.equal(
          facts.rowCount,
          1,
          "fixture must provide one actual vector",
        );
        sourceEmbedding = facts.rows[0].embedding;
      } finally {
        await sourceDb.end();
      }
      await run(process.execPath, [
        "--import",
        "tsx",
        script,
        "init",
        "--target",
        target.toString(),
      ]);
      await run(process.execPath, [
        "--import",
        "tsx",
        script,
        "copy",
        "--source",
        source.toString(),
        "--source-schema",
        "memoia",
        "--target",
        target.toString(),
        "--source-quiesced",
      ]);
      const db = new pg.Client({ connectionString: target.toString() });
      await db.connect();
      try {
        const order = await db.query(
          "SELECT array_agg(source_id ORDER BY row_to_json(t)::text) AS ids FROM memoia.memory_sources t WHERE source_id IN ('Z','a')",
        );
        assert.deepEqual(order.rows[0].ids, ["Z", "a"]);
        const location = await db.query(
          `SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'`,
        );
        assert.equal(location.rows[0].nspname, "extensions");
        const metadata = await db.query(
          "SELECT to_regclass('memoia.__drizzle_migrations') AS ledger, to_regnamespace('drizzle') AS shared",
        );
        assert.equal(metadata.rows[0].ledger, "memoia.__drizzle_migrations");
        assert.equal(metadata.rows[0].shared, null);
        const fact = await db.query(
          "SELECT count(*)::int AS count FROM memoia.memory_facts WHERE embedding IS NOT NULL",
        );
        assert.ok(
          fact.rows[0].count > 0,
          "source fixture must contain a non-null vector",
        );
        const copied = await db.query(
          "SELECT embedding::text AS embedding,extensions.vector_dims(embedding) AS dimensions FROM memoia.memory_facts WHERE embedding IS NOT NULL",
        );
        assert.equal(copied.rowCount, 1);
        assert.equal(copied.rows[0].dimensions, 1536);
        assert.equal(copied.rows[0].embedding, sourceEmbedding);
      } finally {
        await db.end();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await admin.query(
        `DROP DATABASE IF EXISTS "${sourceDatabase}" WITH (FORCE)`,
      );
      await admin.end();
    }
  },
);

test(
  "fresh bootstrap is repeatable and root can create a user and configure the project",
  { skip: !adminUrl },
  async () => {
    const database = `memoia_bootstrap_${randomBytes(6).toString("hex")}`;
    const admin = new pg.Client({ connectionString: adminUrl });
    const target = new URL(adminUrl!);
    target.pathname = `/${database}`;
    const script = new URL("../scripts/migrate.ts", import.meta.url).pathname;
    const command = async (...args: string[]) =>
      run(process.execPath, [
        "--import",
        "tsx",
        script,
        ...args,
        "--target",
        target.toString(),
      ]);
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${database}"`);
      await command("init");
      const db = new pg.Client({ connectionString: target.toString() });
      await db.connect();
      try {
        assert.equal(
          (await db.query("SELECT count(*)::int AS n FROM memoia.projects"))
            .rows[0].n,
          0,
        );
        await command("bootstrap");
        const before = (
          await db.query(`SELECT p.id,p.project_secret,p.profile_config,p.status,b.id AS billing_id,b.usage_left
        FROM memoia.projects p JOIN memoia.project_billings pb ON pb.project_id=p.project_id
        JOIN memoia.billings b ON b.id=pb.billing_id WHERE p.project_id='__root__'`)
        ).rows[0];
        assert.equal(before.project_secret, "__root__");
        assert.equal(before.usage_left, null);
        const app = createApp(createRuntime);
        const env = {
          DATABASE_URL: target.toString(),
          ACCESS_TOKEN: "local-root-token",
          OPENAI_API_KEY: "local-only",
        };
        const call = (method: string, path: string, body?: unknown) =>
          app.request(
            path,
            {
              method,
              headers: {
                Authorization: "Bearer local-root-token",
                ...(body === undefined
                  ? {}
                  : { "Content-Type": "application/json" }),
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            },
            env,
          );
        const user = crypto.randomUUID();
        assert.equal(
          (await call("POST", "/api/users", { id: user })).status,
          201,
        );
        assert.equal(
          (
            await call("PATCH", "/api/project/config", {
              profile_config: "language: en",
            })
          ).status,
          204,
        );
        const config = await call("GET", "/api/project/config");
        assert.equal(config.status, 200);
        assert.equal(
          ((await config.json()) as { profile_config: string }).profile_config,
          "language: en",
        );
        await db.query(
          "UPDATE memoia.projects SET project_secret='retained-secret' WHERE project_id='__root__'",
        );
        await db.query("UPDATE memoia.billings SET usage_left=27 WHERE id=$1", [
          before.billing_id,
        ]);
        await command("bootstrap", "--usage-token-limit-active", "500");
        const after = (
          await db.query(`SELECT p.id,p.project_secret,p.profile_config,p.status,b.id AS billing_id,b.usage_left
        FROM memoia.projects p JOIN memoia.project_billings pb ON pb.project_id=p.project_id
        JOIN memoia.billings b ON b.id=pb.billing_id WHERE p.project_id='__root__'`)
        ).rows;
        assert.equal(after.length, 1);
        assert.deepEqual(after[0], {
          ...before,
          project_secret: "retained-secret",
          profile_config: "language: en",
          usage_left: 27,
        });
        assert.equal(
          (
            await db.query(
              "SELECT count(*)::int AS n FROM memoia.users WHERE project_id='__root__' AND id=$1",
              [user],
            )
          ).rows[0].n,
          1,
        );
      } finally {
        await db.end();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await admin.end();
    }
  },
);
