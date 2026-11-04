import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  Database,
  acquireUserLease,
  assertUserLease,
  finishUserLease,
  renewUserLease,
  LeaseLostError,
  addUsage,
  monthlyTokenUsage,
} from "../src/db";

const url = process.env.MEMOIA_TEST_DATABASE_URL;
test(
  "user lease fences stale writers and rolls back expired writes; usage counters are atomic",
  { skip: !url },
  async () => {
    const db = new Database(url!);
    const projectId = `dbtest_${randomUUID()}`;
    const userId = randomUUID();
    const scope = { userId, projectId };
    try {
      await db.query(
        "INSERT INTO memoia.projects(id,project_id,project_secret,status) VALUES ($1,$2,$3,$4)",
        [randomUUID(), projectId, "local", "active"],
      );
      await db.query("INSERT INTO memoia.users(id,project_id) VALUES ($1,$2)", [
        userId,
        projectId,
      ]);
      const first = await acquireUserLease(db, scope, 10_000);
      await assert.rejects(acquireUserLease(db, scope, 10_000), LeaseLostError);
      await renewUserLease(db, first, 10_000);
      const version = await db.transaction(async (tx) => {
        await assertUserLease(tx, first);
        await tx.query(
          "UPDATE memoia.users SET additional_fields=$3 WHERE id=$1 AND project_id=$2",
          [userId, projectId, { accepted: true }],
        );
        return finishUserLease(tx, first);
      });
      assert.equal(version, "1");
      await assert.rejects(renewUserLease(db, first, 10_000), LeaseLostError);
      const expired = await acquireUserLease(db, scope, 10_000);
      await assert.rejects(
        db.transaction(async (tx) => {
          await assertUserLease(tx, expired);
          await tx.query(
            "UPDATE memoia.users SET additional_fields=$3 WHERE id=$1 AND project_id=$2",
            [userId, projectId, { shouldRollback: true }],
          );
          await tx.query(
            "UPDATE memoia.memory_user_states SET writer_lease_until=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND project_id=$2",
            [userId, projectId],
          );
          await finishUserLease(tx, expired);
        }),
        LeaseLostError,
      );
      const row = await db.query(
        "SELECT additional_fields FROM memoia.users WHERE id=$1 AND project_id=$2",
        [userId, projectId],
      );
      assert.deepEqual(row.rows[0].additional_fields, { accepted: true });
      await db.query(
        "UPDATE memoia.memory_user_states SET writer_lease_until=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND project_id=$2",
        [userId, projectId],
      );
      const next = await acquireUserLease(db, scope, 10_000);
      assert.notEqual(next.generation, expired.generation);
      await db.transaction(async (tx) => {
        await addUsage(tx, projectId, {
          llm_input_tokens: 9,
          llm_output_tokens: 4,
        });
      });
      await Promise.all(
        Array.from({ length: 4 }, () =>
          db.transaction((tx) =>
            addUsage(tx, projectId, {
              llm_input_tokens: 1,
              llm_output_tokens: 1,
            }),
          ),
        ),
      );
      assert.equal(
        await db.transaction((tx) => monthlyTokenUsage(tx, projectId)),
        21,
      );
      const counters = await db.query(
        "SELECT period_type, value::text AS value FROM memoia.usage_counters WHERE project_id=$1 ORDER BY period_type, name",
        [projectId],
      );
      assert.equal(counters.rowCount, 4);
    } finally {
      await db.query("DELETE FROM memoia.projects WHERE project_id=$1", [
        projectId,
      ]);
      await db.close();
    }
  },
);

test(
  "vector types and operators resolve from the installed extension schema",
  { skip: !url },
  async () => {
    const db = new Database(url!);
    try {
      const query = "SELECT '[1,0]'::vector <=> '[1,0]'::vector AS distance";
      assert.equal((await db.query(query)).rows[0].distance, 0);
      assert.equal(
        await db.transaction(
          async (tx) => (await tx.query(query)).rows[0].distance,
        ),
        0,
      );
    } finally {
      await db.close();
    }
  },
);

test(
  "transaction declares snapshot isolation before resolving vector schema",
  { skip: !url },
  async () => {
    const db = new Database(url!);
    try {
      await db.transaction(
        async (tx) => {
          const state = await tx.query(
            "SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only",
          );
          assert.deepEqual(state.rows[0], {
            isolation: "repeatable read",
            read_only: "on",
          });
          const vector = await tx.query(
            "SELECT '[1,0]'::vector <=> '[1,0]'::vector AS distance",
          );
          assert.equal(vector.rows[0].distance, 0);
        },
        { isolation: "repeatable read", readOnly: true },
      );
      await assert.rejects(
        db.transaction(
          (tx) => tx.query("CREATE TEMP TABLE readonly_forbidden (id int)"),
          { isolation: "repeatable read", readOnly: true },
        ),
      );
    } finally {
      await db.close();
    }
  },
);
