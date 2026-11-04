import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { Database } from "../src/db";
import { createUser } from "../src/management";
import { retryOperation } from "../src/facts";
import { consume } from "../src/maintenance";

const adminUrl = process.env.MEMOIA_TEST_ADMIN_DATABASE_URL;
const run = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/migrate.ts", import.meta.url));
const fixture = fileURLToPath(
  new URL("./migration-source.sql", import.meta.url),
);
const project = "migration-fixture";
const oldUser = "00000000-0000-4000-8000-000000000002";
const tombstone = "00000000-0000-4000-8000-000000000005";
const operation = "00000000-0000-4000-8000-000000000006";
const flushOperation = "00000000-0000-4000-8000-000000000007";
const pendingId = "00000000-0000-4000-8000-000000000009";
const failedLegacy = "00000000-0000-4000-8000-000000000008";

async function command(...args: string[]) {
  return run(process.execPath, ["--import", "tsx", script, ...args], {
    timeout: 10_000,
  });
}
async function expectFailure(args: string[], pattern: RegExp) {
  try {
    await command(...args);
    assert.fail("Migration unexpectedly succeeded");
  } catch (error) {
    const result = error as Error & {
      code?: number | string;
      killed?: boolean;
      stderr?: string;
    };
    assert.equal(
      result.killed,
      false,
      "failed migration must exit without a leaked connection keeping it alive",
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr ?? "", pattern);
  }
}

test(
  "copy closes connections on failures, rolls back partial writes, and preserves original receipts",
  { skip: !adminUrl, timeout: 60_000 },
  async () => {
    const suffix = randomBytes(6).toString("hex");
    const sourceName = `memoia_source_${suffix}`,
      targetName = `memoia_target_${suffix}`;
    const source = new URL(adminUrl!),
      target = new URL(adminUrl!);
    source.pathname = `/${sourceName}`;
    target.pathname = `/${targetName}`;
    source.searchParams.set("application_name", `copy_source_${suffix}`);
    target.searchParams.set("application_name", `copy_target_${suffix}`);
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${sourceName}"`);
      await admin.query(`CREATE DATABASE "${targetName}"`);
      await command("init", "--target", target.toString());
      const src = new pg.Client({ connectionString: source.toString() });
      await src.connect();
      try {
        await src.query(
          await readFile(
            new URL("./database-migration-schema.sql", import.meta.url),
            "utf8",
          ),
        );
        await src.query(await readFile(fixture, "utf8"));
        await src.query(
          await readFile(
            new URL("./database-migration-0015.sql", import.meta.url),
            "utf8",
          ),
        );
        await src.query(
          "INSERT INTO memoia.memory_user_states(user_id,project_id,generation,version) VALUES($1,$2,17,8)",
          [oldUser, project],
        );
        await src.query(
          `INSERT INTO memoia.memory_operations(id,user_id,project_id,idempotency_key,kind,request_hash,request,blob_id,status,source_id,input_expires_at,generation)
        VALUES($1,$2,$3,'receipt-original','import',repeat('a',64),'{"messages":[{"message_id":"m1"}]}',
        '00000000-0000-4000-8000-000000000003','processing','dialog','2029-01-01T00:00:00.123456Z',17)`,
          [operation, oldUser, project],
        );
        await src.query(
          `INSERT INTO memoia.memory_operations(id,user_id,project_id,idempotency_key,kind,request_hash,request,status,attempts,available_at)
           VALUES($1,$2,$3,'flush-original','flush',repeat('b',64),'{"blob_ids":[]}', 'processing',2,clock_timestamp())`,
          [flushOperation, oldUser, project],
        );
        await src.query(
          `INSERT INTO memoia.memory_messages(user_id,project_id,source_id,message_id,role,occurred_at,content_hash) VALUES($1,$2,'dialog','m2','user','2024-01-02T12:00:00Z',$3)`,
          [
            oldUser,
            project,
            createHash("sha256")
              .update(
                '{"content":"Pending original input","occurred_at":"2024-01-02T12:00:00+00:00","role":"user"}',
              )
              .digest("hex"),
          ],
        );
        await src.query(
          `INSERT INTO memoia.memory_blobs(id,user_id,project_id,source_id,message_ids,status) VALUES('00000000-0000-4000-8000-000000000010',$1,$2,'dialog','["m2"]','active')`,
          [oldUser, project],
        );
        await src.query(
          `INSERT INTO memoia.memory_operations(id,user_id,project_id,idempotency_key,kind,request_hash,request,status,source_id,input_expires_at,created_at,blob_id)
          VALUES($1,$2,$3,'resume-original','import',repeat('d',64),$4::jsonb,'processing','dialog',clock_timestamp()+interval '7 days',clock_timestamp(),'00000000-0000-4000-8000-000000000010')`,
          [
            pendingId,
            oldUser,
            project,
            JSON.stringify({
              idempotency_key: "resume-original",
              source_id: "dialog",
              metadata: {},
              messages: [
                {
                  message_id: "m2",
                  role: "user",
                  content: "Pending original input",
                  occurred_at: "2024-01-02T12:00:00Z",
                },
              ],
            }),
          ],
        );
        await src.query(
          `INSERT INTO memoia.memory_operations(id,user_id,project_id,idempotency_key,kind,request_hash,request,status,attempts,error)
           VALUES($1,$2,$3,'flush-permanent-failure','flush',repeat('c',64),'{"blob_ids":[]}','failed',2,'{"code":"maintenance_capacity","retryable":false}')`,
          [failedLegacy, oldUser, project],
        );
      } finally {
        await src.end();
      }
      const beforeExpiry = await (async () => {
        const db = new pg.Client({ connectionString: source.toString() });
        await db.connect();
        try {
          return (
            await db.query(
              "SELECT input_expires_at::text AS expiry FROM memoia.memory_operations WHERE id=$1",
              [pendingId],
            )
          ).rows[0].expiry;
        } finally {
          await db.end();
        }
      })();
      const copy = [
        "copy",
        "--source",
        source.toString(),
        "--source-schema",
        "memoia",
        "--target",
        target.toString(),
        "--source-quiesced",
      ];
      const revisionCheck = new pg.Client({
        connectionString: source.toString(),
      });
      await revisionCheck.connect();
      try {
        await revisionCheck.query(
          "UPDATE memoia.alembic_version SET version_num='0014_unknown'",
        );
        await expectFailure(copy, /0015_event_time or 0016_source_cascade/);
        await revisionCheck.query(
          "UPDATE memoia.alembic_version SET version_num='0015_event_time'",
        );
      } finally {
        await revisionCheck.end();
      }
      const sourceDown = new URL(source);
      sourceDown.port = "1";
      await expectFailure(
        [
          "copy",
          "--source",
          sourceDown.toString(),
          "--source-schema",
          "memoia",
          "--target",
          target.toString(),
          "--source-quiesced",
        ],
        /ECONNREFUSED|connect/i,
      );
      const targetDown = new URL(target);
      targetDown.port = "1";
      await expectFailure(
        [
          "copy",
          "--source",
          source.toString(),
          "--source-schema",
          "memoia",
          "--target",
          targetDown.toString(),
          "--source-quiesced",
        ],
        /ECONNREFUSED|connect/i,
      );
      const targetBadAuth = new URL(target);
      targetBadAuth.password = "wrong-local-test";
      await expectFailure(
        [
          "copy",
          "--source",
          source.toString(),
          "--source-schema",
          "memoia",
          "--target",
          targetBadAuth.toString(),
          "--source-quiesced",
        ],
        /password authentication failed/i,
      );
      const active = async () =>
        (
          await admin.query(
            "SELECT application_name FROM pg_stat_activity WHERE application_name=ANY($1::text[])",
            [[`copy_source_${suffix}`, `copy_target_${suffix}`]],
          )
        ).rows;
      assert.deepEqual(await active(), []);

      const dst = new pg.Client({ connectionString: target.toString() });
      await dst.connect();
      try {
        await dst.query(`CREATE FUNCTION memoia.test_reject_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'intentional copy failure'; END $$;
        CREATE TRIGGER test_reject_fact BEFORE INSERT ON memoia.memory_facts FOR EACH ROW EXECUTE FUNCTION memoia.test_reject_fact()`);
      } finally {
        await dst.end();
      }
      await expectFailure(copy, /intentional copy failure/);
      assert.deepEqual(await active(), []);
      const verify = new pg.Client({ connectionString: target.toString() });
      await verify.connect();
      try {
        for (const table of [
          "projects",
          "users",
          "memory_sources",
          "memory_blobs",
          "memory_operations",
          "memory_facts",
          "memory_user_tombstones",
        ]) {
          assert.equal(
            (
              await verify.query(
                `SELECT count(*)::int AS n FROM memoia.${table}`,
              )
            ).rows[0].n,
            0,
            `${table} must roll back`,
          );
        }
        await verify.query(
          "DROP TRIGGER test_reject_fact ON memoia.memory_facts; DROP FUNCTION memoia.test_reject_fact()",
        );
      } finally {
        await verify.end();
      }
      const sourceWithOwner = new pg.Client({
        connectionString: source.toString(),
      });
      await sourceWithOwner.connect();
      try {
        await sourceWithOwner.query(
          "UPDATE memoia.memory_operations SET lease_owner=$2,lease_until=clock_timestamp()+interval '1 minute' WHERE id=$1",
          [flushOperation, randomUUID()],
        );
        await expectFailure(copy, /Drain all flush owners/);
        await sourceWithOwner.query(
          "UPDATE memoia.memory_operations SET lease_owner=NULL,lease_until=NULL WHERE id=$1",
          [flushOperation],
        );
      } finally {
        await sourceWithOwner.end();
      }
      const copied = await command(...copy);
      assert.match(copied.stdout, /memory_facts: 1 verified/);
      assert.deepEqual(await active(), []);

      const worker = new Database(target.toString());
      const newUser = randomUUID();
      try {
        await createUser(worker, project, {
          id: newUser,
          data: { origin: "typescript" },
        });
        const persisted = (
          await worker.query(
            `SELECT id,status,input_expires_at::text AS expires,request,generation FROM memoia.memory_operations WHERE id=$1`,
            [operation],
          )
        ).rows[0];
        assert.equal(persisted.id, operation);
        assert.equal(persisted.status, "processing");
        assert.match(persisted.expires, /2029-01-01 00:00:00\.123456/);
        assert.deepEqual(persisted.request, {
          messages: [{ message_id: "m1" }],
        });
        assert.equal(String(persisted.generation), "17");
        const task = (
          await worker.query(
            "SELECT id,status,run_attempts,execution_ms,fail_reasons FROM memoia.queue_tasks WHERE id=$1",
            [flushOperation],
          )
        ).rows[0];
        assert.equal(task.id, flushOperation);
        assert.equal(task.status, "pending");
        assert.equal(task.run_attempts, 2);
        assert.equal(task.execution_ms, null);
        assert.deepEqual(task.fail_reasons, [
          { resultCode: "TASK_FAILURE_BUDGET_BASELINE", failureCount: 2 },
        ]);
        const expiry = (
          await worker.query(
            "SELECT input_expires_at::text AS expiry FROM memoia.memory_operations WHERE id=$1",
            [pendingId],
          )
        ).rows[0].expiry;
        assert.equal(expiry, beforeExpiry);
        const runtime = {
          db: worker,
          env: {
            OPENAI_API_KEY: "local-only",
            MAINTENANCE_ENABLED: "true",
            MEMOIA_CONFIG: JSON.stringify({ enable_event_embedding: false }),
          },
          deadline: Date.now() + 60000,
        };
        const scope = { userId: oldUser, projectId: project };
        const originalFetch = globalThis.fetch;
        let calls = 0;
        globalThis.fetch = async () => {
          calls++;
          return Response.json({
            status: "completed",
            output: [
              {
                type: "message",
                status: "completed",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      messages: [{ message_id: "m2", facts: [] }],
                    }),
                  },
                ],
              },
            ],
          });
        };
        try {
          const result = await retryOperation(runtime, scope, pendingId);
          assert.equal(result.operation_id, pendingId);
          assert.equal(result.status, "completed");
          await retryOperation(runtime, scope, pendingId);
          assert.equal(calls, 1);
          const saved = (
            await worker.query(
              "SELECT status,request,input_expires_at FROM memoia.memory_operations WHERE id=$1",
              [pendingId],
            )
          ).rows[0];
          assert.equal(saved.status, "completed");
          assert.equal(saved.input_expires_at, null);
          assert.deepEqual(saved.request, {
            source_id: "dialog",
            idempotency_key: "resume-original",
          });
          await consume(runtime, {
            kind: "flush",
            user_id: oldUser,
            project_id: project,
            operation_id: flushOperation,
          });
          assert.equal(
            calls,
            1,
            "completed import is not extracted again during flush",
          );
          assert.equal(
            (
              await worker.query(
                "SELECT status FROM memoia.queue_tasks WHERE id=$1",
                [flushOperation],
              )
            ).rows[0].status,
            "succeeded",
          );
        } finally {
          globalThis.fetch = originalFetch;
        }
      } finally {
        await worker.close();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${sourceName}" WITH (FORCE)`);
      await admin.query(`DROP DATABASE IF EXISTS "${targetName}" WITH (FORCE)`);
      await admin.end();
    }
  },
);
