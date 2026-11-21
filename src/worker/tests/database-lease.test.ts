import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  Database,
  bumpMemoryVersion,
  addUsage,
  monthlyTokenUsage,
} from "../src/db";

const url = process.env.MEMOIA_TEST_DATABASE_URL;
test(
  "memory versions and usage counters are atomic across concurrent writes",
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
      const versions = await Promise.all([
        bumpMemoryVersion(db, scope),
        bumpMemoryVersion(db, scope),
      ]);
      assert.deepEqual(versions.sort(), [1, 2]);
      await assert.rejects(db.transaction(async (tx) => {
        assert.equal(await bumpMemoryVersion(tx, scope), 3);
        throw new Error("rollback");
      }), /rollback/);
      assert.equal(await bumpMemoryVersion(db, scope), 3);
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
        `SELECT expires_at = period_start + CASE period_type
          WHEN 'day' THEN interval '30 days' ELSE interval '1 month' END AS expected_expiry
        FROM memoia.usage_counters WHERE project_id=$1`,
        [projectId],
      );
      assert.equal(counters.rowCount, 4);
      assert.ok(counters.rows.every((row) => row.expected_expiry));
    } finally {
      await db.query("DELETE FROM memoia.projects WHERE project_id=$1", [
        projectId,
      ]);
      await db.close();
    }
  },
);

test(
  "standalone SQL resolves vector types and operators from the installed schema",
  { skip: !url },
  async () => {
    const db = new Database(url!);
    try {
      const schema = await db.vectorSchema();
      const result = await db.query(
        `SELECT '[1,0]'::${schema}.vector OPERATOR(${schema}.<=>) '[1,0]'::${schema}.vector AS distance`,
      );
      assert.equal(result.rows[0].distance, 0);
    } finally {
      await db.close();
    }
  },
);

test(
  "short write transactions use the PostgreSQL default isolation",
  { skip: !url },
  async () => {
    const db = new Database(url!);
    try {
      await db.transaction(async (tx) => {
        const state = await tx.query(
          "SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only",
        );
        assert.deepEqual(state.rows[0], {
          isolation: "read committed",
          read_only: "off",
        });
      });
    } finally {
      await db.close();
    }
  },
);
