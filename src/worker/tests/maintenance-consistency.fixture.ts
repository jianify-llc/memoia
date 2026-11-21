import { test } from "node:test";
import assert from "node:assert/strict";
import { Database } from "../src/db";
import { maintenanceTasks } from "../src/maintenance-task";
import { MaintenanceContext, flush, type Claim } from "../src/maintenance";

test("maintenance rejects related changes before writing and accepts unrelated additions", async () => {
  const db = new Database(process.env.MEMOIA_TEST_DATABASE_URL!);
  try {
    for (const conflict of [
      "fact",
      "model",
      "model-during-publication",
      "topics",
      "event-delete",
      "derived-read-deleted",
      "foreign-publication",
      "deadline",
      "unrelated",
    ] as const) {
      const projectId = `fence_${crypto.randomUUID()}`,
        userId = crypto.randomUUID();
      const scope = { projectId, userId },
        factId = crypto.randomUUID(),
        blobId = crypto.randomUUID();
      const runtime = {
        db,
        env: {
          OPENAI_API_KEY: "unused",
          MEMOIA_CONFIG: '{"enable_event_embedding":false}',
        },
        deadline: Date.now() + 60000,
      };
      const originalQuery = db.query;
      try {
        await db.transaction(async (tx) => {
          await tx.query(
            "INSERT INTO memoia.projects(id,project_id,project_secret,status) VALUES($1,$2,'local','active')",
            [crypto.randomUUID(), projectId],
          );
          await tx.query(
            "INSERT INTO memoia.users(id,project_id) VALUES($1,$2)",
            [userId, projectId],
          );
          await tx.query(
            "INSERT INTO memoia.memory_sources(user_id,project_id,source_id) VALUES($1,$2,'dialog')",
            [userId, projectId],
          );
          await tx.query(
            "INSERT INTO memoia.memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at,processed) VALUES($1,$2,'dialog','m',repeat('a',64),'user',now(),true)",
            [userId, projectId],
          );
          await tx.query(
            "INSERT INTO memoia.memory_blobs(id,user_id,project_id,source_id,message_ids,status,fact_completed_at,fact_changes) VALUES($3,$1,$2,'dialog','[\"m\"]','active',now(),$4::jsonb)",
            [
              userId,
              projectId,
              blobId,
              JSON.stringify([{ kind: "added", fact_id: factId, version: 1 }]),
            ],
          );
          await tx.query(
            "INSERT INTO memoia.memory_facts(id,user_id,project_id,blob_id,content,subject,reporter,certainty,support_groups,occurred_at,search_text) VALUES($3,$1,$2,$4,'Reads books','user','user','asserted','[[\"m\"]]',now(),'Reads books')",
            [userId, projectId, factId, blobId],
          );
        });
        const receipt = await flush(runtime, scope, "fixed");
        const task = await db.transaction((tx) =>
          maintenanceTasks.claimInTx(tx, receipt.operation_id),
        );
        assert.ok(task?.leaseId);
        const owner = task.leaseId;
        const row = (
          await db.query("SELECT * FROM memoia.memory_operations WHERE id=$1", [
            receipt.operation_id,
          ])
        ).rows[0];
        const claim: Claim = {
          ...scope,
          id: row.id,
          owner,

          blobIds: [blobId],
          changes: [{ kind: "added", fact_id: factId, version: 1 }],
        };
        const ctx = new MaintenanceContext(runtime, claim, async () => {});
        await ctx.prepare();
        await ctx.readChanges();
        const profile = await ctx.stage("profiles", [
          {
            action: "upsert",
            content: "Enjoys reading",
            topic: "interests_preferences",
            sub_topic: "reading",
            fact_ids: [factId],
          },
        ]);
        const event = await ctx.stage("events", [
          {
            action: "upsert",
            content: "A reading experience",
            fact_ids: [factId],
          },
        ]);
        if (conflict === "derived-read-deleted") {
          const oldEvent = crypto.randomUUID();
          await db.query(
            "INSERT INTO memoia.user_events(id,user_id,project_id,event_data) VALUES($3,$1,$2,$4::jsonb)",
            [
              userId,
              projectId,
              oldEvent,
              JSON.stringify({
                event_tip: "Previously read background",
                fact_ids: [factId],
                _impact_fact_ids: [crypto.randomUUID()],
              }),
            ],
          );
          await ctx.read("events", [oldEvent]);
          assert.equal(
            (await ctx.stage("events", [{ action: "remove", id: oldEvent }]))
              .staged,
            true,
          );
          await db.query("DELETE FROM memoia.user_events WHERE id=$1", [
            oldEvent,
          ]);
        }
        if (conflict === "fact")
          await db.query(
            "UPDATE memoia.memory_facts SET revision=revision+1,content='Corrected reading statement' WHERE id=$1",
            [factId],
          );
        if (conflict === "model")
          await db.query(
            "UPDATE memoia.projects SET profile_config='llm_model: different-model' WHERE project_id=$1",
            [projectId],
          );
        if (conflict === "topics")
          await db.query(
            "UPDATE memoia.projects SET profile_config=$2 WHERE project_id=$1",
            [
              projectId,
              "overwrite_user_profiles:\n  - topic: other\n    description: other",
            ],
          );
        if (conflict === "event-delete")
          await db.query(
            "INSERT INTO memoia.memory_deleted_events(id,user_id,project_id) VALUES($3,$1,$2)",
            [userId, projectId, event.ids[0]],
          );
        if (conflict === "foreign-publication")
          await db.query(
            "INSERT INTO memoia.user_events(id,user_id,project_id,event_data) VALUES($3,$1,$2,$4::jsonb)",
            [userId, projectId, event.ids[0], JSON.stringify({
              content: "A reading experience",
              memoia_v2: true,
              fact_ids: [factId],
              _impact_fact_ids: [],
            })],
          );
        if (conflict === "unrelated")
          await db.query(
            "INSERT INTO memoia.memory_facts(id,user_id,project_id,blob_id,content,subject,reporter,certainty,support_groups,occurred_at,search_text) VALUES($3,$1,$2,$4,'Unrelated background','user','user','asserted','[[\"m\"]]',now(),'Unrelated background')",
            [userId, projectId, crypto.randomUUID(), blobId],
          );
        if (conflict === "deadline") runtime.deadline = Date.now() - 1;
        const query = db.query.bind(db);
        if (conflict === "model-during-publication") {
          db.query = async (sql, values) => {
            if (sql.includes("INSERT INTO memoia.user_events")) {
              await query(
                "UPDATE memoia.projects SET profile_config='llm_model: changed-before-first-write' WHERE project_id=$1",
                [projectId],
              );
            }
            return query(sql, values);
          };
        }
        if (conflict === "unrelated") {
          await ctx.commit();
          assert.equal(
            (
              await db.query(
                "SELECT status FROM memoia.queue_tasks WHERE id=$1",
                [row.id],
              )
            ).rows[0].status,
            "succeeded",
          );
        } else {
          await assert.rejects(
            ctx.commit(conflict === "foreign-publication" || conflict === "derived-read-deleted"),
            (error: any) =>
              error.code ===
                (conflict === "deadline"
                  ? "execution_deadline"
                  : "maintenance_read_conflict") && error.retryable === true,
          );
          assert.equal(
            (
              await db.query(
                "SELECT status FROM memoia.queue_tasks WHERE id=$1",
                [row.id],
              )
            ).rows[0].status,
            "running",
          );
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int n FROM memoia.user_profiles WHERE id=$1",
                [profile.ids[0]],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int n FROM memoia.user_events WHERE id=$1",
                [event.ids[0]],
              )
            ).rows[0].n,
            conflict === "foreign-publication" ? 1 : 0,
          );
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int n FROM memoia.memory_profile_revisions WHERE operation_id=$1",
                [row.id],
              )
            ).rows[0].n,
            0,
          );
        }
      } finally {
        db.query = originalQuery;
        await db.query("DELETE FROM memoia.projects WHERE project_id=$1", [
          projectId,
        ]);
      }
    }
  } finally {
    await db.close();
  }
});
