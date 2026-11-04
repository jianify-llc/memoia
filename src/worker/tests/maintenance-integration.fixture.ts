import { test } from "node:test";
import assert from "node:assert/strict";
import { Database, acquireUserLease, releaseUserLease } from "../src/db";
import {
  MaintenanceContext,
  consume,
  flush,
  retryFlush,
  type Claim,
} from "../src/maintenance";
import { getHistory, forgetUser } from "../src/facts";
import { createUser } from "../src/management";
import { getEvents } from "../src/retrieval";
import { maintenanceTasks, projectOperation } from "../src/maintenance-task";

test("maintenance repairs required legacy support atomically, preserves history, and fences stale plans", async () => {
  const db = new Database(process.env.MEMOIA_TEST_DATABASE_URL!);
  const projectId = `loop_${crypto.randomUUID()}`,
    userId = crypto.randomUUID(),
    scope = { projectId, userId };
  const runtime = {
    db,
    env: {
      OPENAI_API_KEY: "no-real-model",
      MEMOIA_CONFIG: JSON.stringify({ enable_event_embedding: false }),
    },
    deadline: Date.now() + 60000,
  };
  const blob = crypto.randomUUID(),
    facts = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ],
    profile = crypto.randomUUID(),
    event = crypto.randomUUID();
  const validators = await import(
    new URL(
      "../../../sdks/typescript/src/generated/validators.js",
      import.meta.url,
    ).href
  );
  async function context(key: string): Promise<MaintenanceContext> {
    const operation = await flush(runtime, scope, key);
    const task = await db.transaction((tx) =>
      maintenanceTasks.claimInTx(tx, operation.operation_id),
    );
    assert.ok(task?.leaseId);
    const owner = task.leaseId;
    const op = (
      await db.query("SELECT * FROM memoia.memory_operations WHERE id=$1", [
        operation.operation_id,
      ])
    ).rows[0];
    const batches = (
      await db.query(
        "SELECT fact_changes FROM memoia.memory_blobs WHERE flush_operation_id=$1",
        [op.id],
      )
    ).rows;
    const claim: Claim = {
      ...scope,
      id: op.id,
      owner,

      blobIds: op.request.blob_ids,
      changes: batches.flatMap((r) => r.fact_changes),
    };
    const ctx = new MaintenanceContext(runtime, claim, async () => {});
    await ctx.prepare();
    return ctx;
  }
  try {
    await db.query(
      "INSERT INTO memoia.projects(id,project_id,project_secret,status)VALUES($1,$2,'local','active')",
      [crypto.randomUUID(), projectId],
    );
    await createUser(db, projectId, { id: userId });
    await db.query(
      "INSERT INTO memoia.memory_sources(user_id,project_id,source_id)VALUES($1,$2,'dialog')",
      [userId, projectId],
    );
    await db.query(
      "INSERT INTO memoia.memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at,processed)VALUES($1,$2,'dialog','m',repeat('a',64),'user',now(),true)",
      [userId, projectId],
    );
    await db.query(
      "INSERT INTO memoia.memory_blobs(id,user_id,project_id,source_id,message_ids,status,fact_completed_at,fact_changes)VALUES($3,$1,$2,'dialog','[\"m\"]','active',now(),$4::jsonb)",
      [
        userId,
        projectId,
        blob,
        JSON.stringify([{ kind: "updated", fact_id: facts[0], version: 1 }]),
      ],
    );
    for (const [i, id] of facts.entries())
      await db.query(
        "INSERT INTO memoia.memory_facts(id,user_id,project_id,blob_id,content,subject,reporter,certainty,support_groups,occurred_at,search_text)VALUES($3,$1,$2,$4,$5::text,'user','user','asserted','[[\"m\"]]',now(),$5)",
        [userId, projectId, id, blob, `Current fact ${i}`],
      );
    await db.query(
      "INSERT INTO memoia.user_profiles(id,user_id,project_id,content,attributes)VALUES($3,$1,$2,'OLD corrected text',$4::jsonb)",
      [
        userId,
        projectId,
        profile,
        JSON.stringify({
          memoia_v2: true,
          topic: "work",
          sub_topic: "role",
          fact_ids: [facts[0], facts[1]],
          source_ids: ["dialog"],
          _impact_fact_ids: [facts[0], facts[1]],
        }),
      ],
    );
    await db.query(
      "INSERT INTO memoia.user_events(id,user_id,project_id,event_data)VALUES($3,$1,$2,$4::jsonb)",
      [
        userId,
        projectId,
        event,
        JSON.stringify({
          event_tip: "OLD legacy story",
          title: "Old title",
          interpretation: "Old speculation",
          _impact_fact_ids: null,
        }),
      ],
    );
    await db.query(
      "INSERT INTO memoia.memory_event_facts(event_id,fact_id,user_id,project_id)VALUES($3,$4,$1,$2)",
      [userId, projectId, event, facts[1]],
    );
    const ctx = await context("flush:,中文");
    assert.equal(ctx.required.profiles.has(profile), true);
    assert.equal(ctx.required.events.has(event), true);
    await assert.rejects(
      ctx.stage("profiles", [{ action: "remove", id: profile }]),
      /Read the target/,
    );
    const p = await ctx.read("profiles", [profile]);
    assert.equal(p.items[0].content, undefined);
    assert.equal(p.items[0].review_required, true);
    const e = await ctx.read("events", [event]);
    assert.deepEqual(e.items[0].fact_ids, [facts[1]]);
    assert.equal(e.items[0].evidence.length, 1);
    await assert.rejects(
      ctx.stage("profiles", [{ action: "keep", id: profile }]),
      /Rebuild affected/,
    );
    const page = await ctx.read("facts", facts.slice(0, 3), null, null, 1);
    assert.equal(page.items.length, 1);
    const unreturned = facts.filter((f) => !ctx.reads.facts.has(f));
    assert.ok(unreturned.every((f) => ctx.reads.facts.get(f) !== null));
    const proposal = {
      action: "upsert" as const,
      id: null,
      content: "New valid profile",
      topic: "work",
      sub_topic: "project",
      fact_ids: [facts[3]],
    };
    const rejected = await ctx.stage("profiles", [proposal]);
    assert.equal(rejected.staged, false);
    await ctx.read("facts", [facts[3]]);
    const fixed = await ctx.stage("profiles", [
      { ...proposal, id: rejected.ids[0] },
    ]);
    assert.equal(fixed.staged, true);
    const absentId = crypto.randomUUID();
    const validProposal = { ...proposal, id: fixed.ids[0] };
    const unknown = await ctx.stage("profiles", [
      validProposal,
      { ...proposal, fact_ids: [absentId] },
    ]);
    assert.deepEqual(unknown.error?.unread_fact_ids, [absentId]);
    await ctx.read("facts", [absentId]);
    const absentProposal = {
      ...proposal,
      id: unknown.ids[1],
      content: "A corrected proposal still needing valid support",
      fact_ids: [absentId],
    };
    const absent = await ctx.stage("profiles", [validProposal, absentProposal]);
    assert.deepEqual(absent.error?.invalid_fact_ids, [absentId]);
    await assert.rejects(
      ctx.stage("profiles", [absentProposal]),
      (error: any) => error.code === "maintenance_staging_repeated",
    );
    assert.equal(
      (
        await ctx.stage("profiles", [
          validProposal,
          { ...absentProposal, fact_ids: [facts[3]] },
        ])
      ).staged,
      true,
    );
    await ctx.readChanges();
    await ctx.read("facts", facts);
    await ctx.stage("profiles", [
      {
        action: "upsert",
        id: profile,
        content: "Current role and retained background",
        topic: "work",
        sub_topic: "role",
        fact_ids: [facts[0], facts[1]],
      },
    ]);
    await ctx.stage("events", [
      {
        action: "upsert",
        id: event,
        content: "Retained valid legacy story",
        fact_ids: [facts[1]],
      },
    ]);
    const replacement = (await ctx.read("events", [event])).items[0];
    assert.equal(replacement.content, "Retained valid legacy story");
    assert.equal(replacement.event_tip, replacement.content);
    assert.equal(replacement.title, undefined);
    assert.equal(replacement.interpretation, undefined);
    assert.equal(replacement.support_unknown, false);
    assert.deepEqual(replacement.fact_ids, [facts[1]]);
    assert.equal(
      (await ctx.read("events", null, null, "Old title")).items.length,
      0,
    );
    await ctx.commit();
    const state = await projectOperation(
      db,
      (
        await db.query("SELECT * FROM memoia.memory_operations WHERE id=$1", [
          ctx.claim.id,
        ])
      ).rows[0],
    );
    assert.equal(state.status, "completed");
    assert.ok(state.result.profile_ids.includes(profile));
    assert.ok(state.result.event_ids.includes(event));
    const history = { entries: await getHistory(runtime, scope) };
    assert.ok(validators.validateHistory(JSON.parse(JSON.stringify(history))));
    assert.equal(history.entries.length, 1);
    const data = (
      await db.query("SELECT event_data FROM memoia.user_events WHERE id=$1", [
        event,
      ])
    ).rows[0].event_data;
    assert.equal(data.content, "Retained valid legacy story");
    assert.equal(data._impact_fact_ids, null);
    assert.equal(data.source_id, "dialog");
    assert.equal(data.blob_id, blob);
    const readBack = await getEvents(runtime, scope, 100, 7);
    assert.ok(validators.validateEvents(JSON.parse(JSON.stringify(readBack))));
    assert.equal(
      readBack.events.find((r: any) => r.id === event)?.event_data.source_id,
      "dialog",
    );
    assert.equal(
      readBack.events.find((r: any) => r.id === event)?.event_data.blob_id,
      blob,
    );
    const eventSupport = [facts[1]];
    for (const sourceId of ["dialog", "other"]) {
      if (sourceId === "other")
        await db.query(
          "INSERT INTO memoia.memory_sources(user_id,project_id,source_id) VALUES($1,$2,$3)",
          [userId, projectId, sourceId],
        );
      const message = crypto.randomUUID(),
        extraBlob = crypto.randomUUID(),
        extraFact = crypto.randomUUID();
      await db.query(
        "INSERT INTO memoia.memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at,processed) VALUES($1,$2,$3,$4,repeat('a',64),'user',now(),true)",
        [userId, projectId, sourceId, message],
      );
      await db.query(
        'INSERT INTO memoia.memory_blobs(id,user_id,project_id,source_id,message_ids,status,fact_completed_at,fact_changes) VALUES($3,$1,$2,$4,$5::jsonb,\'active\',now(),\'[{"kind":"noop","version":1}]\')',
        [userId, projectId, extraBlob, sourceId, JSON.stringify([message])],
      );
      await db.query(
        "INSERT INTO memoia.memory_facts(id,user_id,project_id,blob_id,content,support_groups,occurred_at) VALUES($3,$1,$2,$4,'Additional support',$5::jsonb,now())",
        [userId, projectId, extraFact, extraBlob, JSON.stringify([[message]])],
      );
      eventSupport.push(extraFact);
      const next = await context(`multi-${sourceId}`);
      await next.readChanges();
      await next.read("events", [event]);
      await next.read("facts", eventSupport);
      await next.stage("events", [
        {
          action: "upsert",
          id: event,
          content: "Retained valid legacy story",
          fact_ids: eventSupport,
        },
      ]);
      await next.commit();
      const view = (await getEvents(runtime, scope, 100, 7)).events.find(
        (r: any) => r.id === event,
      )!.event_data;
      assert.equal(view.source_id, sourceId === "dialog" ? "dialog" : null);
      assert.equal(
        view.blob_id,
        null,
        "multiple batches have no singular Blob",
      );
      assert.equal(view.evidence.length, eventSupport.length);
    }
    // Original failed/expired flush is explicitly recoverable without a replacement identity.
    const retryBlob = crypto.randomUUID();
    await db.query(
      `INSERT INTO memoia.memory_blobs(id,user_id,project_id,source_id,message_ids,status,fact_completed_at,fact_changes)
      VALUES($3,$1,$2,'dialog','["m"]','active',now(),'[{"kind":"noop","version":1}]')`,
      [userId, projectId, retryBlob],
    );
    const original = await flush(runtime, scope, "retry-original");
    await db.transaction((tx) =>
      maintenanceTasks.decideInTx(
        tx,
        original.operation_id,
        { status: "pending", runAttempts: 0 },
        { status: "failed", resultCode: "maintenance_failed" },
      ),
    );
    const retried = await retryFlush(runtime, scope, original.operation_id);
    assert.equal(retried.operation_id, original.operation_id);
    assert.equal(retried.status, "processing");
    const running = await db.transaction((tx) =>
      maintenanceTasks.claimInTx(tx, original.operation_id),
    );
    assert.ok(running);
    await db.query(
      "UPDATE memoia.queue_tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [original.operation_id],
    );
    const takeover = await retryFlush(runtime, scope, original.operation_id);
    assert.equal(takeover.flush.status, "pending");
    const forgottenClaim = await db.transaction((tx) =>
      maintenanceTasks.claimInTx(tx, original.operation_id),
    );
    assert.ok(forgottenClaim?.leaseId);
    await db.transaction((tx) =>
      maintenanceTasks.saveCheckpointInTx(
        tx,
        original.operation_id,
        forgottenClaim.leaseId!,
        null,
        { private: "checkpoint" },
      ),
    );
    // The same UUID in another letter case cannot bypass permanent forgetting.
    await forgetUser(runtime, scope);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM memoia.queue_tasks WHERE id=$1",
          [original.operation_id],
        )
      ).rows[0].n,
      0,
    );
    await assert.rejects(
      db.transaction((tx) =>
        maintenanceTasks.assertOwnedInTx(
          tx,
          original.operation_id,
          forgottenClaim.leaseId!,
        ),
      ),
    );
    await assert.rejects(
      createUser(db, projectId, { id: userId.toUpperCase() }),
      /forgotten/,
    );
  } finally {
    await db.query("DELETE FROM memoia.projects WHERE project_id=$1", [
      projectId,
    ]);
    await db.close();
  }
});

test("writer lease contention backs off the original flush without rerunning the model", async () => {
  const db = new Database(process.env.MEMOIA_TEST_DATABASE_URL!);
  const scope = {
    projectId: `busy_${crypto.randomUUID()}`,
    userId: crypto.randomUUID(),
  };
  const runtime = {
    db,
    env: {
      OPENAI_API_KEY: "local-mock",
      MAINTENANCE_ENABLED: "true",
      MEMOIA_CONFIG: JSON.stringify({ enable_event_embedding: false }),
    },
    deadline: Date.now() + 120000,
  };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({
      id: "resp_busy",
      object: "response",
      created_at: 1,
      status: "completed",
      error: null,
      incomplete_details: null,
      model: "gpt-6-luna",
      output: [
        {
          type: "message",
          id: "msg_busy",
          role: "assistant",
          content: [{ type: "output_text", text: "Done", annotations: [] }],
          status: "completed",
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    });
  };
  try {
    await db.query(
      "INSERT INTO memoia.projects(id,project_id,project_secret,status) VALUES($1,$2,'local','active')",
      [crypto.randomUUID(), scope.projectId],
    );
    await createUser(db, scope.projectId, { id: scope.userId });
    await db.query(
      "INSERT INTO memoia.memory_sources(user_id,project_id,source_id) VALUES($1,$2,'s')",
      [scope.userId, scope.projectId],
    );
    await db.query(
      "INSERT INTO memoia.memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at) VALUES($1,$2,'s','m',repeat('a',64),'user',now())",
      [scope.userId, scope.projectId],
    );
    await db.query(
      `INSERT INTO memoia.memory_blobs(id,user_id,project_id,source_id,message_ids,status,fact_completed_at,fact_changes)
      VALUES($3,$1,$2,'s','["m"]','active',now(),'[{"kind":"noop","version":1}]')`,
      [scope.userId, scope.projectId, crypto.randomUUID()],
    );
    const operation = await flush(runtime, scope, "busy-writer");
    const writer = await acquireUserLease(db, scope, 60000);
    const message = {
      kind: "flush" as const,
      user_id: scope.userId,
      project_id: scope.projectId,
      operation_id: operation.operation_id,
    };
    await consume(runtime, message);
    const row = await projectOperation(
      db,
      (
        await db.query("SELECT * FROM memoia.memory_operations WHERE id=$1", [
          operation.operation_id,
        ])
      ).rows[0],
    );
    assert.equal(row.id, operation.operation_id);
    assert.equal(row.status, "processing");
    assert.deepEqual(row.error, {
      code: "maintenance_writer_busy",
      retryable: true,
    });
    assert.equal(Number(row.attempts), 1);
    assert.equal(row.lease_owner, null);
    assert.equal(row.lease_until, null);
    assert.ok(new Date(row.available_at).getTime() > Date.now());
    assert.equal(calls, 0);
    await consume(runtime, message);
    assert.equal(calls, 0, "a wakeup during backoff must not call the model");
    await releaseUserLease(db, writer);
  } finally {
    globalThis.fetch = originalFetch;
    await db.query("DELETE FROM memoia.projects WHERE project_id=$1", [
      scope.projectId,
    ]);
    await db.close();
  }
});
