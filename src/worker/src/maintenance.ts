/** Fixed Blobs and existing Operations own maintenance; Queue messages only wake them. */
import type { QueryResultRow } from "pg";
import { isDeepStrictEqual } from "node:util";
import {
  assertActive,
  isRetryableDatabaseError,
  memoryVersion,
  LeaseLostError,
  type Sql,
  type UserScope,
} from "./db.js";
import { SourceError } from "./errors.js";
import { reasoningEffort, type ReasoningEffort } from "./config.js";
import { inSpan } from "./observability.js";
import {
  assertRunning,
  closeRuntime,
  createRuntime,
  type Runtime,
  type Wakeup,
} from "./runtime.js";
import {
  embeddings,
  eventIndexText,
  getConfig,
  getConfigSnapshot,
  type ModelConfig,
} from "./models.js";
import {
  maintenancePromptHash,
  runMaintenance,
  type MaintenanceContinuation,
} from "./maintenance-agent.js";
import { z } from "zod";
import {
  maintenanceTasks,
  claimTask,
  factFlushRetryPolicy,
  maintenanceRetryPolicy,
  operationReceiptQuery,
  projectOperation,
  projectReceipt,
  projectFlush,
} from "./maintenance-task.js";
import {
  runSlice,
  HARD_SLICE_MS,
  SliceBudget,
  TaskYield,
  TaskLeaseLost,
  TaskTimeout,
  type TaskRecord,
  type Json,
} from "@jianify/legato";

export type Change = {
  kind: string;
  fact_id?: string;
  version?: number;
  maintenance_reasoning_effort?: ReasoningEffort | null;
};
const TABLES = {
  facts: "memory_facts",
  profiles: "user_profiles",
  events: "user_events",
} as const;
export type Collection = keyof typeof TABLES;
export type Mutation = {
  action: "upsert" | "keep" | "remove";
  id?: string | null;
  fact_ids?: string[];
  content?: string | null;
  topic?: string | null;
  sub_topic?: string | null;
  title?: string | null;
  summary?: string | null;
  keywords?: string | null;
  event_time?: string | null;
  location?: string | null;
  interpretation?: string | null;
  event_tags?: unknown[];
};
type Derived = "profiles" | "events";

function memoryFields({ id, action, ...fields }: Mutation) {
  return fields;
}

function alreadyPublished(
  change: Mutation | undefined,
  expected: string | null,
  row: QueryResultRow | undefined,
): boolean {
  if (change?.action === "remove") return !row;
  if (change?.action !== "upsert" || !row?.data?.memoia_v2) return false;
  if (BigInt(row.version) !== BigInt(expected ?? 0) + 1n) return false;
  const {
    memoia_v2,
    source_ids,
    _impact_fact_ids,
    _fact_revisions,
    event_tip,
    blob_ids,
    source_id,
    blob_id,
    ...fields
  } = row.data;
  return isDeepStrictEqual(fields, memoryFields(change));
}

// Each write checks the current task lease and Fact revisions in the same statement.
const publicationFence = `
  allowed AS MATERIALIZED (
    SELECT 1 FROM memoia.queue_tasks t JOIN memoia.projects p
      ON p.project_id=$2 AND p.profile_config IS NOT DISTINCT FROM $7::text
    WHERE t.id=$5 AND t.status='running' AND t.lease_id=$6
      AND t.lease_expires_at>clock_timestamp()
      AND t.started_at+${HARD_SLICE_MS}*interval '1 millisecond'>clock_timestamp()
      AND NOT EXISTS (
        SELECT 1 FROM unnest($3::uuid[],$4::bigint[]) AS seen(id,revision)
        LEFT JOIN memoia.memory_facts f
          ON f.id=seen.id AND f.user_id=$1 AND f.project_id=$2
        WHERE f.revision IS DISTINCT FROM seen.revision
      )
  )`;
const checkpointMutation = z
  .object({
    action: z.enum(["upsert", "keep", "remove"]),
    id: z.string().nullish(),
    fact_ids: z.array(z.string()).optional(),
  })
  .catchall(z.unknown());
const checkpointPairs = z.array(z.tuple([z.string(), z.string().nullable()]));
const checkpointMutations = z.array(z.tuple([z.string(), checkpointMutation]));
export const maintenanceStateSchema = z.object({
  reads: z.object({
    facts: checkpointPairs,
    profiles: checkpointPairs,
    events: checkpointPairs,
  }),
  staged: z.object({
    profiles: checkpointMutations,
    events: checkpointMutations,
  }),
  required: z.object({
    profiles: z.array(z.string()),
    events: z.array(z.string()),
  }),
  derivedReads: z.object({
    profiles: z.array(z.string()),
    events: z.array(z.string()),
  }),
  seen: z.array(z.number().int().nonnegative()),
  unresolved: checkpointPairs,
});
export type MaintenanceState = z.infer<typeof maintenanceStateSchema>;
// Memoia owns this contract; increment it when tool definitions, model settings, or checkpoint serialization change.
const MAINTENANCE_CHECKPOINT_VERSION = 1;
const checkpointSchema = z.object({
  version: z.literal(MAINTENANCE_CHECKPOINT_VERSION),
  identity: z.string(),
  phase: z.enum(["new", "agent_running", "agent_completed"]),
  referenceTime: z.object({
    current_date: z.string(),
    time_zone: z.string(),
    time_zone_source: z.string(),
  }),
  state: maintenanceStateSchema.optional(),
  refs: z
    .object({
      facts: z.array(z.string()),
      profiles: z.array(z.string()),
      events: z.array(z.string()),
    })
    .optional(),
  parentId: z.string().optional(),
  callIds: z.array(z.string()).optional(),
  input: z.array(z.unknown()).optional(),
});
async function digest(value: unknown): Promise<string> {
  const result = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(result), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
function configuredMutation(
  kind: "profiles" | "events",
  change: Mutation,
  config: ModelConfig,
): boolean {
  if (change.action !== "upsert") return true;
  if (kind === "profiles")
    return config.profile_topics.some((topic) => topic.topic === change.topic);
  return (change.event_tags ?? []).every((tag) =>
    config.event_tag_definitions.some(
      (definition) =>
        typeof definition === "object" &&
        definition !== null &&
        "name" in definition &&
        definition.name === (tag as { tag?: string }).tag,
    ),
  );
}
const fail = (code: string, message: string, retryable = false): never => {
  throw new SourceError(code, message, 409, retryable);
};
const factProjection = `id,blob_id,content,subject,reporter,certainty,occurred_at,revision,created_at,updated_at,
  CASE WHEN jsonb_typeof(fact_time)='object' THEN fact_time - 'evidence' END AS fact_time`;
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
export const scoped = (scope: UserScope): unknown[] => [
  scope.userId,
  scope.projectId,
];
function linked(
  kind: "profiles" | "events",
  parameter: string,
  unknown = true,
): string {
  const data = kind === "profiles" ? "attributes" : "event_data";
  const array = (field: string) =>
    `COALESCE(NULLIF(${data}->'${field}','null'::jsonb),'[]'::jsonb)`;
  const conditions = [
    `EXISTS(SELECT 1 FROM jsonb_array_elements_text(${array("fact_ids")}) f WHERE f=ANY(${parameter}::text[]))`,
    `EXISTS(SELECT 1 FROM jsonb_array_elements_text(${array("_impact_fact_ids")}) f WHERE f=ANY(${parameter}::text[]))`,
  ];
  if (unknown) conditions.push(`${data}->>'_impact_fact_ids' IS NULL`);
  if (kind === "events")
    conditions.push(
      `EXISTS(SELECT 1 FROM jsonb_array_elements(${array("evidence")}) e WHERE e->>'fact_id'=ANY(${parameter}::text[]))`,
      `EXISTS(SELECT 1 FROM memoia.memory_event_facts ef WHERE ef.event_id=user_events.id AND ef.user_id=user_events.user_id AND ef.project_id=user_events.project_id AND ef.fact_id::text=ANY(${parameter}::text[]))`,
    );
  return `(${conditions.join(" OR ")})`;
}
async function supportMap(
  tx: Sql,
  scope: UserScope,
  kind: "profiles" | "events",
  ids: string[],
): Promise<Map<string, string[]>> {
  if (!ids.length) return new Map();
  const field = kind === "profiles" ? "attributes" : "event_data";
  const rows = (
    await tx.query(
      `SELECT id,${field} AS data FROM memoia.${TABLES[kind]} WHERE user_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])`,
      [...scoped(scope), ids],
    )
  ).rows;
  const result = new Map(
    rows.map((row) => [
      row.id,
      [
        ...new Set<string>([
          ...(row.data?.fact_ids ?? []),
          ...(kind === "events"
            ? (row.data?.evidence ?? []).flatMap((e: { fact_id?: string }) =>
                e.fact_id ? [e.fact_id] : [],
              )
            : []),
        ]),
      ],
    ]),
  );
  if (kind === "events")
    for (const row of (
      await tx.query(
        "SELECT event_id,fact_id FROM memoia.memory_event_facts WHERE user_id=$1 AND project_id=$2 AND event_id=ANY($3::uuid[])",
        [...scoped(scope), ids],
      )
    ).rows) {
      const old = result.get(row.event_id);
      if (old && !old.includes(row.fact_id)) old.push(row.fact_id);
    }
  return result;
}
export function progress(row: QueryResultRow) {
  const running =
    row.lease_owner && new Date(row.lease_until).getTime() > Date.now();
  return {
    operation_id: row.id,
    status:
      row.status === "completed"
        ? "completed"
        : row.status === "failed"
          ? "failed"
          : running
            ? "running"
            : "pending",
    blob_ids: row.request?.public_blob_ids ?? row.request?.blob_ids ?? [],
    attempts: Number(row.attempts),
    available_at: row.available_at,
    error: row.error,
    retryable: Boolean(row.error?.retryable),
  };
}
function receipt(row: QueryResultRow) {
  return {
    operation_id: row.id,
    kind: row.kind,
    status: row.status,
    source_id: row.source_id,
    blob_id: row.blob_id,
    result: row.result,
    error: row.error,
    flush: progress(row),
  };
}
export async function recordChanges(
  tx: Sql,
  scope: UserScope,
  blobId: string,
  version: number,
  changes: Change[],
  sessionAppend = false,
): Promise<void> {
  const changed = await tx.query(
    `UPDATE memoia.memory_blobs
       SET fact_completed_at=CASE WHEN $5::boolean AND flush_operation_id IS NULL
             THEN COALESCE(fact_completed_at,clock_timestamp()) ELSE clock_timestamp() END,
           fact_changes=CASE WHEN $5::boolean AND flush_operation_id IS NULL
             THEN fact_changes || $4::jsonb ELSE $4::jsonb END,
           flush_operation_id=NULL
     WHERE user_id=$1 AND project_id=$2 AND id=$3
       AND (CASE WHEN $5 THEN external_id IS NOT NULL ELSE fact_completed_at IS NULL AND flush_operation_id IS NULL END)`,
    [
      ...scoped(scope),
      blobId,
      JSON.stringify(
        (changes.length ? changes : [{ kind: "noop" }]).map((c) => ({
          ...c,
          version,
        })),
      ),
      sessionAppend,
    ],
  );
  if (changed.rowCount !== 1)
    fail("blob_conflict", "Fixed Blob has already been committed", true);
  const ids = changes
    .filter((c) => c.fact_id && c.kind !== "added")
    .map((c) => c.fact_id);
  if (ids.length)
    for (const kind of ["profiles", "events"] as const) {
      await tx.query(
        `UPDATE memoia.${TABLES[kind]} SET version=version+1 WHERE user_id=$1 AND project_id=$2 AND ${linked(kind, "$3")}`,
        [...scoped(scope), ids],
      );
    }
}
async function sendWakeup(
  runtime: Runtime,
  message: Wakeup,
  delaySeconds: number,
) {
  if (!runtime.maintenanceWakeup) return;
  assertRunning(runtime);
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      runtime.maintenanceWakeup.send(message, delaySeconds),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new SourceError(
                "maintenance_notification_unconfirmed",
                "Queue notification was not confirmed",
                503,
                true,
              ),
            ),
          Math.min(10_000, runtime.deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function notifyUser(
  runtime: Runtime,
  scope: UserScope,
): Promise<void> {
  if (runtime.env.MAINTENANCE_ENABLED !== "true" || !runtime.maintenanceWakeup)
    return;
  // The committed Blob is the recovery source. This hint needs no open DB connection.
  const notification = sendWakeup(
    runtime,
    { kind: "user", user_id: scope.userId, project_id: scope.projectId },
    30,
  ).catch(() => {
    console.warn(
      JSON.stringify({ event: "maintenance_wakeup_unconfirmed", ...scope }),
    );
  });
  if (runtime.waitUntil) runtime.waitUntil(notification);
  else await notification;
}
async function seal(
  runtime: Runtime,
  scope: UserScope,
  key?: string,
): Promise<QueryResultRow | null> {
  return runtime.db.transaction(async (tx) => {
    if (key !== undefined) {
      const old = await tx.query(
        "SELECT * FROM memoia.memory_operations WHERE user_id=$1 AND project_id=$2 AND idempotency_key=$3",
        [...scoped(scope), key],
      );
      if (old.rows.length) {
        if (old.rows[0].kind !== "flush")
          fail("idempotency_conflict", "Key identifies another operation");
        return projectOperation(tx, old.rows[0]);
      }
    }
    const rows = (
      await tx.query(
        `SELECT b.id,b.external_id,b.xmin::text AS row_version,o.maintenance_effort,prior.efforts,
          page.fact_changes IS NOT NULL AS paged,
          COALESCE(page.fact_changes,b.fact_changes) AS fact_changes
        FROM memoia.memory_blobs b
        LEFT JOIN LATERAL (
          SELECT COALESCE(jsonb_agg(p.change ORDER BY p.position),'[]'::jsonb) AS fact_changes,
            array_agg(p.change->>'version') FILTER (WHERE NOT (p.change ? 'maintenance_reasoning_effort')) AS versions
          FROM (SELECT change,position FROM jsonb_array_elements(b.fact_changes)
                WITH ORDINALITY list(change,position) LIMIT 100) p
        ) page ON (b.external_id IS NOT NULL OR b.kind='retract')
        LEFT JOIN LATERAL (
          SELECT o.request->>'maintenance_reasoning_effort' AS maintenance_effort
          FROM memoia.memory_operations o
          WHERE o.blob_id=b.id AND o.user_id=b.user_id AND o.project_id=b.project_id
            AND o.kind='import' AND b.external_id IS NULL
          ORDER BY o.created_at DESC,o.id DESC LIMIT 1
        ) o ON true
        LEFT JOIN LATERAL (
          SELECT jsonb_object_agg(t.result->>'memory_version', f.request->>'maintenance_reasoning_effort') AS efforts
          FROM memoia.memory_operations f JOIN memoia.queue_tasks t ON t.id=f.id
          WHERE page.versions IS NOT NULL AND f.blob_id=b.id AND f.user_id=b.user_id AND f.project_id=b.project_id
            AND f.kind='fact_flush' AND f.request->>'maintenance_reasoning_effort' IS NOT NULL
            AND t.status='succeeded' AND t.result->>'memory_version'=ANY(page.versions)
        ) prior ON true
        WHERE b.user_id=$1 AND b.project_id=$2 AND b.fact_completed_at IS NOT NULL AND b.flush_operation_id IS NULL
        ORDER BY b.fact_completed_at,b.id LIMIT 100`,
        scoped(scope),
      )
    ).rows;
    // Cron and user hints can race. Only explicit flushes need an empty receipt.
    if (key === undefined && !rows.length) return null;
    const requestKey = key ?? `auto-flush:${crypto.randomUUID()}`;
    const factIds = [
      ...new Set(
        rows.flatMap((row) =>
          row.fact_changes.flatMap((c: Change) =>
            c.fact_id ? [c.fact_id] : [],
          ),
        ),
      ),
    ];
    const current = factIds.length
      ? (
          await tx.query(
            `SELECT ${factProjection} FROM memoia.memory_facts WHERE user_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])`,
            [...scoped(scope), factIds],
          )
        ).rows
      : [];
    const chosen: QueryResultRow[] = [];
    const factsById = new Map(current.map((fact) => [fact.id, fact]));
    let size = 0;
    let effort: ReasoningEffort | undefined;
    let effortVersion = -1;
    const changesForTask = (items: Change[]) =>
      items.map(({ maintenance_reasoning_effort: _, ...change }) => change);
    for (const row of rows) {
      let changes: Change[] = row.fact_changes ?? [];
      const cost = (items: Change[]) => bytes({
        changes: changesForTask(items),
        facts: items.flatMap((change) => {
          const fact = factsById.get(change.fact_id);
          return fact ? [fact] : [];
        }),
      });
      if (row.paged) {
        // Large retractions and session appends share the same bounded flush snapshots.
        let count = 0;
        let estimated = size;
        for (const change of changes) {
          estimated += cost([change]);
          if (estimated > 262144) break;
          count++;
        }
        if (!count && chosen.length) break;
        changes = changes.slice(0, Math.max(1, count));
      } else if (chosen.length && size + cost(changes) > 262144) break;
      for (const change of changes) {
        if (change.kind === "noop") continue;
        const override = reasoningEffort.safeParse(
          change.maintenance_reasoning_effort === undefined
            ? row.efforts?.[change.version ?? 0] ?? row.maintenance_effort
            : change.maintenance_reasoning_effort,
        ).data;
        const version = change.version ?? 0;
        if (override !== undefined && version >= effortVersion) {
          effort = override;
          effortVersion = version;
        }
      }
      chosen.push({ ...row, fact_changes: changesForTask(changes) });
      size += cost(changes);
      if (size > 262144) break;
    }
    const id = crypto.randomUUID();
    const blobIds = chosen.map((b) => b.id);
    const empty = !blobIds.length;
    // Stable compact JSON agrees with Python and never rewrites characters inside an identity.
    const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            JSON.stringify({ idempotency_key: requestKey, kind: "flush" }),
          ),
        ),
      ),
    )
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    const row = (
      await tx.query(
        `INSERT INTO memoia.memory_operations(id,user_id,project_id,idempotency_key,kind,request_hash,request,status,result,error,generation,attempts,available_at)
      VALUES($3,$1,$2,$4,'flush',$5,$6::jsonb,$7,$8::jsonb,$9::jsonb,0,0,clock_timestamp()) RETURNING *`,
        [
          ...scoped(scope),
          id,
          requestKey,
          hash,
          JSON.stringify({
            blob_ids: blobIds,
            public_blob_ids: chosen.map((b) => b.external_id ?? b.id),
            legacy_changes: chosen.filter((b) => b.paged).flatMap((b) => b.fact_changes),
          }),
          "processing",
          empty
            ? JSON.stringify({ blob_ids: [], profile_ids: [], event_ids: [] })
            : null,
          size > 262144
            ? JSON.stringify({ code: "maintenance_capacity", retryable: false })
            : null,
        ],
      )
    ).rows[0];
    let task = await maintenanceTasks.createInTx(tx, {
      id,
      requestKey: id,
      businessKey: id,
      type: "maintenance_flush",
      userId: scope.userId,
      bizParams: { project_id: scope.projectId, ...(effort === undefined ? {} : { reasoning_effort: effort }) },
    });
    if (!task) throw new Error("Could not create flush task");
    if (empty) {
      task = await maintenanceTasks.completeUnstartedInTx(tx, id, {
        resultCode: "COMPLETED",
        result: row.result,
      });
    } else if (size > 262144) {
      task = await maintenanceTasks.decideInTx(
        tx,
        id,
        { status: "pending", runAttempts: 0 },
        {
          status: "failed",
          resultCode: "maintenance_capacity",
        },
      );
    }
    if (!task) throw new Error("Could not initialize flush task");
    if (blobIds.length) {
      const assigned = await tx.query(
        `UPDATE memoia.memory_blobs b
           SET fact_changes=CASE WHEN NOT picked.paged THEN b.fact_changes ELSE
                 COALESCE((SELECT jsonb_agg(change ORDER BY position)
                   FROM jsonb_array_elements(b.fact_changes) WITH ORDINALITY list(change,position)
                   WHERE position>picked.used),'[]'::jsonb) END,
               flush_operation_id=CASE WHEN picked.paged AND jsonb_array_length(b.fact_changes)>picked.used
                 THEN NULL ELSE $3::uuid END
          FROM unnest($4::uuid[],$5::int[],$6::text[],$7::boolean[]) AS picked(id,used,version,paged)
         WHERE b.user_id=$1 AND b.project_id=$2 AND b.id=picked.id
           AND b.flush_operation_id IS NULL AND b.xmin::text=picked.version`,
        [...scoped(scope), id, blobIds, chosen.map((b) => b.fact_changes.length),
          chosen.map((b) => b.row_version), chosen.map((b) => b.paged)],
      );
      if (assigned.rowCount !== blobIds.length) throw new TaskYield();
    }
    return projectFlush(row, task);
  }).catch(async (error) => {
    const duplicate = (error as { constraint?: string }).constraint === "memory_operations_user_id_project_id_idempotency_key_key";
    if (!(error instanceof TaskYield) && !duplicate) throw error;
    if (key === undefined) return null;
    const { rows: [existing] } = await runtime.db.query(
      "SELECT * FROM memoia.memory_operations WHERE user_id=$1 AND project_id=$2 AND idempotency_key=$3",
      [...scoped(scope), key],
    );
    if (existing?.kind === "flush") return projectOperation(runtime.db, existing);
    if (existing) fail("idempotency_conflict", "Key identifies another operation");
    return fail("flush_conflict", "Pending Blob changes changed before sealing", true);
  });
}
export async function flush(runtime: Runtime, scope: UserScope, key: string) {
  const row = await seal(runtime, scope, key);
  if (!row) throw new Error("Explicit flush has no receipt");
  if (row.status === "processing") await dispatch(runtime, row);
  return receipt(row);
}
export async function getStatus(runtime: Runtime, scope: UserScope) {
  const [blobs, ops] = await Promise.all([
    runtime.db.query(
      "SELECT count(*)::integer AS n FROM memoia.memory_blobs WHERE user_id=$1 AND project_id=$2 AND fact_completed_at IS NOT NULL AND flush_operation_id IS NULL",
      scoped(scope),
    ),
    runtime.db.query(
      operationReceiptQuery + " WHERE o.user_id=$1 AND o.project_id=$2 AND o.kind='flush' ORDER BY o.created_at DESC,o.id LIMIT 100",
      scoped(scope),
    ),
  ]);
  return {
    pending_blob_count: blobs.rows[0].n,
    flushes: ops.rows.map((row) => progress(projectReceipt(row))),
  };
}
export async function retryFlush(
  runtime: Runtime,
  scope: UserScope,
  id: string,
) {
  const { db } = runtime;
  const { rows: [op] } = await db.query(
    "SELECT * FROM memoia.memory_operations WHERE user_id=$1 AND project_id=$2 AND id=$3 AND kind='flush'",
    [...scoped(scope), id],
  );
  if (!op) fail("operation_not_found", "Operation not found");
  let task = await maintenanceTasks.readInTx(db, id);
  if (!task) throw new Error("Flush execution task is missing");
  if (task.status === "running") {
    const expired = await maintenanceTasks.revokeInTx(
      db, id, { code: "maintenance_lease_expired", retryable: true, manual: true },
      maintenanceRetryPolicy, task.leaseId ?? undefined,
    );
    if (expired) task = expired;
  }
  if (task.status === "failed" || task.status === "manual")
    task = (await maintenanceTasks.recoverInTx(db, id)) ??
      (await maintenanceTasks.readInTx(db, id)) ?? task;
  const row = projectFlush(op, task);
  if (row.status === "processing") await dispatch(runtime, row);
  return receipt(row);
}
export async function dispatch(runtime: Runtime, row: QueryResultRow) {
  if (runtime.env.MAINTENANCE_ENABLED !== "true" || !runtime.maintenanceWakeup)
    return;
  const { db } = runtime;
  try {
    const reserved = await maintenanceTasks.reserveDispatchInTx(
      db, row.id, row.kind === "flush" ? maintenanceRetryPolicy.limit : undefined,
    );
    if (!reserved) return;
    const delay = Math.max(
      0,
      Math.min(86400, Math.ceil((reserved.nextRunAt.getTime() - Date.now()) / 1000)),
    );
    await sendWakeup(
      runtime,
      {
        kind: row.kind === "fact_flush" ? "fact_flush" : "flush",
        operation_id: row.id,
        user_id: row.user_id,
        project_id: row.project_id,
      },
      delay,
    );
    if (reserved.lastDispatchAttemptAt)
      await maintenanceTasks.acknowledgeDispatchInTx(
        db,
        row.id,
        reserved.lastDispatchAttemptAt,
      );
  } catch {
    console.warn(
      JSON.stringify({
        event: "maintenance_dispatch_unconfirmed",
        operation_id: row.id,
      }),
    );
  }
}
export interface Claim extends UserScope {
  id: string;
  owner: string;
  blobIds: string[];
  changes: Change[];
  task?: TaskRecord<string>;
}
async function claim(
  runtime: Runtime,
  message: Extract<Wakeup, { kind: "flush" }>,
): Promise<Claim | null> {
  const scope = { userId: message.user_id, projectId: message.project_id };
  const { rows: [row] } = await runtime.db.query(
    "SELECT id,request FROM memoia.memory_operations WHERE user_id=$1 AND project_id=$2 AND id=$3 AND kind='flush'",
    [...scoped(scope), message.operation_id],
  );
  if (!row) {
    await assertActive(runtime.db, scope);
    return null;
  }
  const task = await claimTask(runtime.db, row.id, "maintenance_flush");
  if (!task?.leaseId) return null;
  return {
    ...scope, id: row.id, owner: task.leaseId, task,
    blobIds: row.request.blob_ids,
    changes: row.request.legacy_changes ?? [],
  };
}

async function failClaim(runtime: Runtime, c: Claim, error: unknown) {
  const retryable = error instanceof LeaseLostError ||
    (error instanceof SourceError ? error.retryable : isRetryableDatabaseError(error));
  const code =
    error instanceof LeaseLostError
      ? "maintenance_writer_busy"
      : error instanceof SourceError
        ? error.code
        : "maintenance_failed";
  // A successful or superseded task no longer matches this failure update.
  await maintenanceTasks.failInTx(
    runtime.db,
    c.id,
    c.owner,
    { code, retryable },
    maintenanceRetryPolicy,
  );
}
function maintenanceEnabled(runtime: Runtime): boolean {
  return (
    runtime.env.MEMOIA_WRITES_ENABLED !== "false" &&
    runtime.env.MAINTENANCE_ENABLED === "true"
  );
}
async function prepareMaintenance(runtime: Runtime) {
  const candidates = await runtime.db.query<{
    id: string | null;
    user_id: string;
    project_id: string;
    kind: string | null;
  }>(`WITH expired AS (
      SELECT o.id,o.user_id,o.project_id,o.kind
      FROM memoia.memory_operations o JOIN memoia.queue_tasks t ON t.id=o.id
      WHERE o.kind IN ('flush','fact_flush') AND t.status='running'
        AND (t.lease_expires_at<=clock_timestamp() OR t.started_at+${HARD_SLICE_MS}*interval '1 millisecond'<=clock_timestamp())
      LIMIT 100
    ), due AS (
      SELECT user_id,project_id
      FROM memoia.memory_blobs
      WHERE fact_completed_at IS NOT NULL AND flush_operation_id IS NULL
      GROUP BY user_id,project_id
      HAVING least(max(fact_completed_at)+interval '30 seconds',min(fact_completed_at)+interval '120 seconds')<=clock_timestamp()
      LIMIT 100
    )
    SELECT id,user_id,project_id,kind FROM expired
    UNION ALL
    SELECT NULL,user_id,project_id,NULL FROM due
    ORDER BY id NULLS LAST`);
  for (const row of candidates.rows) {
    const scope = { userId: row.user_id, projectId: row.project_id };
    if (row.id === null) {
      await seal(runtime, scope);
      continue;
    }
    await maintenanceTasks.revokeInTx(
      runtime.db,
      row.id,
      { code: "maintenance_lease_expired", retryable: true },
      row.kind === "fact_flush" ? factFlushRetryPolicy : maintenanceRetryPolicy,
    );
  }
}
async function pendingMaintenance(
  runtime: Runtime,
  limit: number,
  notifications: boolean,
) {
  const pending = await runtime.db.query(
    `SELECT * FROM (
    SELECT DISTINCT ON (o.project_id,o.user_id,o.kind) o.id,o.user_id,o.project_id,o.kind,t.next_run_at FROM memoia.memory_operations o JOIN memoia.queue_tasks t ON t.id=o.id WHERE o.kind IN ('flush','fact_flush') AND t.status IN ('pending','queued','retry_wait')
    AND t.next_run_at<=clock_timestamp() AND (NOT $1::boolean OR t.next_dispatch_at IS NULL OR t.next_dispatch_at<=clock_timestamp())
    AND NOT EXISTS(SELECT 1 FROM memoia.memory_operations held JOIN memoia.queue_tasks ht ON ht.id=held.id WHERE held.project_id=o.project_id AND held.user_id=o.user_id AND held.kind=o.kind AND ht.status='running')
    ORDER BY o.project_id,o.user_id,o.kind,t.next_run_at,o.id) candidates ORDER BY next_run_at,id LIMIT $2`,
    [notifications, limit],
  );
  return pending.rows;
}
export async function reconcile(runtime: Runtime) {
  if (!maintenanceEnabled(runtime)) return;
  await prepareMaintenance(runtime);
  const pending = await pendingMaintenance(runtime, 100, true);
  for (const row of pending) await dispatch(runtime, row);
}

/** Node polls execution state directly; Cloudflare notification reservations are not execution leases. */
export async function pollMaintenance(
  runtime: Runtime,
  limit = 4,
): Promise<Extract<Wakeup, { kind: "flush" | "fact_flush" }>[]> {
  if (!Number.isInteger(limit) || limit < 0 || limit > 100)
    throw new RangeError("Invalid maintenance poll limit");
  if (!maintenanceEnabled(runtime)) return [];
  await prepareMaintenance(runtime);
  if (limit === 0) return [];
  return (await pendingMaintenance(runtime, limit, false)).map((row) => ({
    kind: row.kind === "fact_flush" ? "fact_flush" : "flush",
    operation_id: row.id,
    user_id: row.user_id,
    project_id: row.project_id,
  }));
}
export async function consume(runtime: Runtime, message: Wakeup) {
  if (
    runtime.env.MEMOIA_WRITES_ENABLED === "false" ||
    runtime.env.MAINTENANCE_ENABLED !== "true"
  )
    return;
  if (message.kind === "fact_flush") {
    await (await import("./fact-flush.js")).consumeFactFlush(runtime, message);
    return;
  }
  if (message.kind === "user") {
    const result = await runtime.db.query(
      `SELECT least(max(fact_completed_at)+interval '30 seconds',min(fact_completed_at)+interval '120 seconds') AS due
      FROM memoia.memory_blobs WHERE user_id=$1 AND project_id=$2 AND fact_completed_at IS NOT NULL AND flush_operation_id IS NULL`,
      [message.user_id, message.project_id],
    );
    const due = result.rows[0]?.due;
    if (!due) return;
    if (new Date(due).getTime() > Date.now()) {
      await sendWakeup(
        runtime,
        message,
        Math.max(1, Math.ceil((new Date(due).getTime() - Date.now()) / 1000)),
      );
      return;
    }
    const row = await seal(runtime, { userId: message.user_id, projectId: message.project_id });
    if (row?.status === "processing") await dispatch(runtime, row);
    return;
  }
  const c = await claim(runtime, message);
  if (!c) return;
  const claimed = c.task;
  if (!claimed?.startedAt || !claimed.leaseExpiresAt)
    throw new Error("Claim has no slice timing");
  const { startedAt, leaseExpiresAt } = claimed;
  let saved: Json | null = claimed.executionState;
  try {
    await inSpan(runtime.tracing, "memoia.task", { operation_id: c.id }, () =>
      runSlice({
        startedAt,
        leaseExpiresAt,
        signal: runtime.signal,
        renew: () => maintenanceTasks.renewInTx(runtime.db, c.id, c.owner),
        onTimeout: async () => {
          const isolated = createRuntime(runtime.env);
          try {
            await maintenanceTasks.revokeInTx(
              isolated.db,
              c.id,
              { code: "maintenance_timeout", retryable: true },
              maintenanceRetryPolicy,
              c.owner,
            );
          } finally {
            await closeRuntime(isolated);
          }
        },
        execute: async (budget) => {
          const sliceRuntime = {
            ...runtime,
            operationId: c.id,
            signal: budget.signal,
            deadline: budget.hardDeadlineAt + 30_000,
          };
          const batches = await sliceRuntime.db.query(
            "SELECT fact_changes FROM memoia.memory_blobs WHERE user_id=$1 AND project_id=$2 AND flush_operation_id=$3 AND external_id IS NULL ORDER BY fact_completed_at,id",
            [...scoped(c), c.id],
          );
          budget.assertActive();
          c.changes = [...batches.rows.flatMap((batch) => batch.fact_changes), ...c.changes];
          const makeContext = async () => {
            const result = new MaintenanceContext(sliceRuntime, c, () =>
              budget.assertActive(),
            );
            await result.prepare();
            return result;
          };
          let context = await makeContext();
          const prompt = await maintenancePromptHash();
          const contextIdentity = () => digest({
            version: MAINTENANCE_CHECKPOINT_VERSION,
            inputProtocolVersion: 3,
            prompt,
            config: context.config,
            ...(context.effortOverride === undefined
              ? {}
              : { reasoning_effort: context.effortOverride }),
            provider: {
              modelBaseUrl: runtime.env.OPENAI_BASE_URL ?? null,
              embeddingBaseUrl: runtime.env.EMBEDDING_BASE_URL ?? null,
              configuration: runtime.env.MEMOIA_CONFIG ?? null,
            },
            blobIds: c.blobIds,
            changes: c.changes,
          });
          let identity = await contextIdentity();
          const parsed = checkpointSchema.safeParse(saved);
          const timezone = context.config.use_timezone ?? "UTC";
          const referenceTime = parsed.success
            ? parsed.data.referenceTime
            : {
                current_date: new Intl.DateTimeFormat("en-CA", {
                  timeZone: timezone,
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                }).format(new Date()),
                time_zone: timezone,
                time_zone_source: "service_default",
              };
          const persist = async (value: Json) => {
            const next = await maintenanceTasks.saveCheckpointInTx(
              runtime.db,
              c.id,
              c.owner,
              saved,
              value,
            );
            if (!next) throw new TaskLeaseLost();
            saved = next.executionState;
          };
          let restored =
            parsed.success &&
            parsed.data.identity === identity &&
            parsed.data.phase !== "new" &&
            !!parsed.data.state &&
            !!parsed.data.refs;
          const attemptedRestore = restored;
          if (restored && parsed.success) {
            const required = {
              profiles: new Set(context.required.profiles),
              events: new Set(context.required.events),
            };
            try {
              context.restore(parsed.data.state);
            } catch {
              restored = false;
            }
            if (restored)
              restored = await context.validateRestored(
                required,
                parsed.data.phase === "agent_completed",
              );
            if (restored) {
              restored = Object.values(parsed.data.refs!).every(
                (ids) => new Set(ids).size === ids.length,
              );
            }
          }
          if (
            restored &&
            parsed.success &&
            parsed.data.phase === "agent_running"
          ) {
            restored =
              !!parsed.data.parentId &&
              !!parsed.data.callIds?.length &&
              !!parsed.data.input &&
              parsed.data.callIds.length === parsed.data.input.length;
            if (restored) {
              const callIds = parsed.data.callIds!;
              const input = parsed.data.input!;
              const outputIds = input.map((item) =>
                item &&
                typeof item === "object" &&
                "type" in item &&
                item.type === "function_call_result" &&
                "callId" in item &&
                typeof item.callId === "string"
                  ? item.callId
                  : null,
              );
              restored =
                new Set(callIds).size === callIds.length &&
                new Set(outputIds).size === callIds.length &&
                outputIds.every((id) => id !== null && callIds.includes(id));
            }
          }
          if (!restored) {
            if (attemptedRestore) {
              context = await makeContext();
              identity = await contextIdentity();
            }
            await persist({
              version: MAINTENANCE_CHECKPOINT_VERSION,
              identity,
              phase: "new",
              referenceTime,
            });
          }
          const continuation: MaintenanceContinuation = {
            budget,
            referenceTime,
            resume:
              restored &&
              parsed.success &&
              parsed.data.phase === "agent_running"
                ? {
                    parentId: parsed.data.parentId!,
                    callIds: parsed.data.callIds!,
                    input: parsed.data.input!,
                    refs: parsed.data.refs!,
                  }
                : undefined,
            save: async (value) =>
              persist({
                version: MAINTENANCE_CHECKPOINT_VERSION,
                identity,
                ...value,
              } as Json),
          };
          if (
            !(
              restored &&
              parsed.success &&
              parsed.data.phase === "agent_completed"
            ) &&
            c.changes.some((change) => change.kind !== "noop")
          ) {
            try {
              await runMaintenance(context, continuation);
            } catch (error) {
              if (
                !(error instanceof SourceError) ||
                error.code !== "maintenance_parent_unavailable" ||
                !continuation.resume
              )
                throw error;
              context = await makeContext();
              identity = await contextIdentity();
              await persist({
                version: MAINTENANCE_CHECKPOINT_VERSION,
                identity,
                phase: "new",
                referenceTime,
              });
              await runMaintenance(context, {
                ...continuation,
                resume: undefined,
              });
            }
          }
          if (budget.shouldYield()) throw new TaskYield();
          await context.commit(
            restored && parsed.success && parsed.data.phase === "agent_completed",
          );
          try {
            console.info(
              JSON.stringify({
                event: "maintenance_commit",
                operation_id: c.id,
                status: "succeeded",
              }),
            );
          } catch {}
        },
      }),
    );
  } catch (error) {
    if (error instanceof TaskYield) {
      if (!(await maintenanceTasks.yieldInTx(runtime.db, c.id, c.owner, saved)))
        throw new TaskLeaseLost();
    } else if (
      !(error instanceof TaskLeaseLost) &&
      !(error instanceof TaskTimeout)
    ) {
      await failClaim(runtime, c, error);
    }
  }
}

/** The bounded read set and in-memory proposals belong to one execution only. */
export class MaintenanceContext {
  readonly reads: Record<Collection, Map<string, string | null>> = {
    facts: new Map(),
    profiles: new Map(),
    events: new Map(),
  };
  readonly staged = {
    profiles: new Map<string, Mutation>(),
    events: new Map<string, Mutation>(),
  };
  readonly required = {
    profiles: new Set<string>(),
    events: new Set<string>(),
  };
  readonly derivedReads = {
    profiles: new Set<string>(),
    events: new Set<string>(),
  };
  readonly seen = new Set<number>();
  readonly unresolved = new Map<string, string | null>();
  config!: Awaited<ReturnType<typeof getConfig>>;
  get effortOverride() {
    const params = this.claim.task?.bizParams;
    return reasoningEffort.safeParse(
      params && typeof params === "object" && !Array.isArray(params)
        ? params.reasoning_effort
        : undefined,
    ).data;
  }
  constructor(
    readonly runtime: Runtime,
    readonly claim: Claim,
    readonly active: () => void,
  ) {}
  snapshot(): MaintenanceState {
    return {
      reads: {
        facts: [...this.reads.facts],
        profiles: [...this.reads.profiles],
        events: [...this.reads.events],
      },
      staged: {
        profiles: [...this.staged.profiles],
        events: [...this.staged.events],
      },
      required: {
        profiles: [...this.required.profiles],
        events: [...this.required.events],
      },
      derivedReads: {
        profiles: [...this.derivedReads.profiles],
        events: [...this.derivedReads.events],
      },
      seen: [...this.seen],
      unresolved: [...this.unresolved],
    };
  }
  restore(value: unknown): void {
    const state = maintenanceStateSchema.parse(value);
    const setMap = <T>(target: Map<string, T>, pairs: [string, T][]) => {
      if (new Set(pairs.map(([key]) => key)).size !== pairs.length)
        throw new Error("Duplicate checkpoint key");
      target.clear();
      for (const [key, item] of pairs) target.set(key, item);
    };
    for (const kind of ["facts", "profiles", "events"] as const)
      setMap(this.reads[kind], state.reads[kind]);
    for (const kind of ["profiles", "events"] as const) {
      setMap(this.staged[kind], state.staged[kind] as [string, Mutation][]);
      this.required[kind].clear();
      for (const id of state.required[kind]) this.required[kind].add(id);
      this.derivedReads[kind].clear();
      for (const id of state.derivedReads[kind])
        this.derivedReads[kind].add(id);
    }
    this.seen.clear();
    for (const index of state.seen) {
      if (index >= this.claim.changes.length)
        throw new Error("Invalid checkpoint index");
      this.seen.add(index);
    }
    setMap(this.unresolved, state.unresolved);
  }
  async validateRestored(
    requiredBeforeRestore: Record<"profiles" | "events", Set<string>>,
    publishing = false,
  ): Promise<boolean> {
    this.active();
    for (const kind of ["profiles", "events"] as const) {
      const expected = requiredBeforeRestore[kind];
      for (const id of new Set([...expected, ...this.required[kind]]))
        if (
          expected.has(id) !== this.required[kind].has(id) &&
          !(publishing && this.staged[kind].has(id))
        )
          return false;
    }
    return (await this.readSet(publishing)) !== null;
  }

  private async readSet(publishing: boolean) {
    const current: Record<Collection, Map<string, QueryResultRow>> = {
      facts: new Map(),
      profiles: new Map(),
      events: new Map(),
    };
    const published = { profiles: new Set<string>(), events: new Set<string>() };
    let missingRemoval = false;
    for (const kind of ["facts", "profiles", "events"] as const) {
      const reads = this.reads[kind];
      if (!reads.size) continue;
      const data =
        kind === "profiles"
          ? ",attributes AS data"
          : kind === "events"
            ? ",event_data AS data,embedding IS NOT NULL AS has_embedding"
            : "";
      const rows = (
        await this.runtime.db.query(
          `SELECT id,${kind === "facts" ? "revision AS version" : "version"}${data} FROM memoia.${TABLES[kind]} WHERE user_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])`,
          [...scoped(this.claim), [...reads.keys()]],
        )
      ).rows;
      current[kind] = new Map(rows.map((row) => [row.id, row]));
      for (const [id, version] of reads) {
        const row = current[kind].get(id);
        if ((row ? String(row.version) : null) === version) continue;
        if (
          publishing &&
          kind !== "facts" &&
          alreadyPublished(this.staged[kind].get(id), version, row)
        ) {
          if (!row) missingRemoval = true;
          published[kind].add(id);
          continue;
        }
        return null;
      }
    }
    // This task never removes prior text before publishing the upserts that may inherit its influence.
    if (missingRemoval) {
      for (const kind of ["profiles", "events"] as const)
        for (const [id, change] of this.staged[kind])
          if (
            change.action === "upsert" &&
            !published[kind].has(id)
          )
            return null;
    }
    let impact: Set<string> | null = new Set(current.facts.keys());
    for (const kind of ["profiles", "events"] as const) {
      for (const id of this.derivedReads[kind]) {
        const row = current[kind].get(id);
        if (!row) continue;
        const prior = row.data?._impact_fact_ids;
        if (!Array.isArray(prior)) impact = null;
        else for (const fact of prior) impact?.add(fact);
      }
    }
    for (const { kind, fact_id } of this.claim.changes)
      if (kind === "deleted" && fact_id && this.reads.facts.get(fact_id) === null)
        impact?.delete(fact_id);
    for (const kind of ["profiles", "events"] as const) {
      for (const id of published[kind]) {
        const row = current[kind].get(id);
        if (!row || row.data._impact_fact_ids === null) continue;
        const stored = row.data._impact_fact_ids;
        if (!Array.isArray(stored) || !impact || [...impact].some((fact) => !stored.includes(fact)))
          return null;
      }
    }
    this.active();
    return { current, published, impactIds: impact ? [...impact].sort() : null };
  }
  private track(kind: Collection, id: string, value: unknown) {
    const version = value == null ? null : String(value);
    if (this.reads[kind].has(id) && this.reads[kind].get(id) !== version)
      fail("maintenance_read_conflict", "Related memory changed", true);
    this.reads[kind].set(id, version);
  }
  remaining() {
    return Object.fromEntries(
      (["profiles", "events"] as const).map((k) => {
        const ids = [...this.required[k]].filter(
          (id) => !this.staged[k].has(id),
        );
        return [k, { count: ids.length, ids: ids.sort().slice(0, 20) }];
      }),
    );
  }
  async prepare() {
    this.config = await getConfig(this.runtime, this.claim.projectId);
    const allIds = [
      ...new Set(
        this.claim.changes.flatMap((c) => (c.fact_id ? [c.fact_id] : [])),
      ),
    ];
    const allFacts = allIds.length
      ? (
          await this.runtime.db.query(
            `SELECT ${factProjection} FROM memoia.memory_facts WHERE user_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])`,
            [...scoped(this.claim), allIds],
          )
        ).rows
      : [];
    if (bytes({ changes: this.claim.changes, facts: allFacts }) > 262144)
      throw new SourceError(
        "maintenance_capacity",
        "Current facts exceed fixed flush budget",
        413,
      );
    const ids = this.claim.changes
      .filter((c) => c.fact_id && c.kind !== "added")
      .map((c) => c.fact_id);
    if (!ids.length) return;
    for (const kind of ["profiles", "events"] as const) {
      const data = kind === "profiles" ? "attributes" : "event_data";
      const rows = await this.runtime.db.query(
        `SELECT * FROM memoia.${TABLES[kind]} WHERE user_id=$1 AND project_id=$2 AND ${linked(kind, "$3")}`,
        [...scoped(this.claim), ids],
      );
      for (const row of rows.rows) {
        this.track(kind, row.id, row.version);
        this.required[kind].add(row.id);
      }
    }
  }
  async readChanges(cursor: string | null = null, limit = 100) {
    this.active();
    const offset = Number(cursor ?? 0);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > this.claim.changes.length
    )
      fail("invalid_model_output", "Invalid changes cursor");
    const slice = this.claim.changes.slice(offset, offset + limit);
    const ids = slice.flatMap((c) => (c.fact_id ? [c.fact_id] : []));
    const rows = ids.length
      ? (
          await this.runtime.db.query(
            `SELECT ${factProjection} FROM memoia.memory_facts WHERE user_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])`,
            [...scoped(this.claim), ids],
          )
        ).rows
      : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items: unknown[] = [];
    for (const [i, c] of slice.entries()) {
      const fact = c.fact_id ? byId.get(c.fact_id) : null;
      const item = { ...c, current_fact: fact ?? null };
      if (bytes([...items, item]) > 65536) {
        if (!items.length)
          fail("maintenance_capacity", "Complete change exceeds tool budget");
        break;
      }
      if (c.fact_id) this.track("facts", c.fact_id, fact?.revision);
      items.push(item);
      this.seen.add(offset + i);
    }
    const end = offset + items.length;
    return {
      items,
      next_cursor: end < this.claim.changes.length ? String(end) : null,
      remaining_review: this.remaining(),
    };
  }
  async read(
    kind: Collection,
    ids: string[] | null = null,
    cursor: string | null = null,
    query: string | null = null,
    limit = 100,
  ) {
    this.active();
    let conditions = "";
    const values: unknown[] = [...scoped(this.claim)];
    const stage =
      kind === "facts"
        ? new Map<string, Mutation>()
        : new Map(this.staged[kind]);
    if (stage.size) {
      values.push([...stage.keys()]);
      conditions += ` AND NOT(id=ANY($${values.length}::uuid[]))`;
    }
    if (ids) {
      values.push(ids);
      conditions += ` AND id=ANY($${values.length}::uuid[])`;
    }
    if (cursor) {
      values.push(cursor);
      conditions += ` AND id>$${values.length}::uuid`;
    }
    if (query) {
      values.push("%" + query.replace(/[\\%_]/g, "\\$&") + "%");
      const col =
        kind === "events"
          ? "event_data::text"
          : kind === "profiles"
            ? "content||attributes::text"
            : "content";
      conditions += ` AND (${col}) ILIKE $${values.length}`;
    } else if (!ids) {
      const changed = this.claim.changes.flatMap((c) =>
        c.fact_id ? [c.fact_id] : [],
      );
      values.push(changed);
      conditions +=
        kind === "facts"
          ? ` AND id::text=ANY($${values.length}::text[])`
          : ` AND ${linked(
              kind,
              `$${values.length}`,
              this.claim.changes.some((c) => c.fact_id && c.kind !== "added"),
            )}`;
    }
    const rows = (
      await this.runtime.db.query(
        `SELECT ${kind === "facts" ? factProjection : "*"} FROM memoia.${TABLES[kind]} WHERE user_id=$1 AND project_id=$2 ${conditions} ORDER BY id LIMIT ${limit + 1}`,
        values,
      )
    ).rows;
    const overlayIds = [...stage.keys()].filter(
      (id) => (!cursor || id > cursor) && (!ids || ids.includes(id)),
    );
    const originals = overlayIds.length
      ? (
          await this.runtime.db.query(
            `SELECT * FROM memoia.${TABLES[kind]} WHERE user_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])`,
            [...scoped(this.claim), overlayIds],
          )
        ).rows
      : [];
    const supports =
      kind === "facts"
        ? new Map<string, string[]>()
        : await supportMap(this.runtime.db, this.claim, kind, [
            ...rows.map((r) => r.id),
            ...overlayIds,
          ]);
    const itemOf = (row: QueryResultRow): QueryResultRow => {
      if (kind === "facts") return row;
      const data = kind === "profiles" ? row.attributes : row.event_data;
      const item = {
        ...data,
        id: row.id,
        version: row.version,
        ...(kind === "profiles" ? { content: row.content } : {}),
        fact_ids: supports.get(row.id) ?? [],
      };
      delete item._impact_fact_ids;
      delete item._fact_revisions;
      delete item.evidence;
      if (this.required[kind].has(row.id)) {
        for (const field of [
          "content",
          "event_tip",
          "title",
          "summary",
          "keywords",
          "interpretation",
          "event_time",
          "location",
        ])
          delete item[field];
        item.review_required = true;
      }
      return item;
    };
    const candidates = rows.map(itemOf);
    for (const id of overlayIds) {
      const change = stage.get(id);
      if (!change) continue;
      const row = originals.find((r) => r.id === id);
      if (
        (this.reads[kind].get(id) ?? null) !==
        (row ? String(row.version) : null)
      )
        fail("maintenance_read_conflict", "Staged target changed", true);
      if (change.action === "remove" && !row) continue;
      let item: QueryResultRow = row
        ? itemOf(row)
        : { id, version: null, fact_ids: [] };
      // A proposal replaces the stored entry; omitted fields must not leak old prose.
      if (change.action === "upsert")
        item = {
          id,
          version: row?.version ?? null,
          ...change,
          ...(kind === "events" ? { event_tip: change.content } : {}),
        };
      if (change.action === "remove") item.pending_delete = true;
      if (
        query &&
        !JSON.stringify(item)
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase())
      )
        continue;
      candidates.push(item);
    }
    candidates.sort((a, b) => a.id.localeCompare(b.id));
    const items: QueryResultRow[] = [];
    for (const item of candidates.slice(0, limit)) {
      if (
        bytes({ items: [...items, item], remaining_review: this.remaining() }) >
        65536
      ) {
        if (!items.length)
          fail("maintenance_capacity", "Complete entry exceeds tool budget");
        break;
      }
      items.push(item);
    }
    if (ids) {
      const present = new Set(
        (
          await this.runtime.db.query(
            `SELECT id FROM memoia.${TABLES[kind]} WHERE user_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])`,
            [...scoped(this.claim), ids],
          )
        ).rows.map((r) => r.id),
      );
      for (const id of ids)
        if (!present.has(id) && !stage.has(id)) this.track(kind, id, null);
    }
    const knownFacts = new Set<string>();
    if (kind !== "facts") {
      const support = [
        ...new Set(items.flatMap((i) => i.fact_ids ?? [])),
      ] as string[];
      const facts = support.length
        ? (
            await this.runtime.db.query(
              `SELECT ${factProjection} FROM memoia.memory_facts WHERE user_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])`,
              [...scoped(this.claim), support],
            )
          ).rows
        : [];
      for (const item of items) {
        item.evidence = [];
        item.invalid_fact_ids = (item.fact_ids ?? []).filter(
          (id: string) => !facts.some((f) => f.id === id),
        );
        item.support_unknown = !(item.fact_ids ?? []).length;
        for (const fid of item.invalid_fact_ids) this.track("facts", fid, null);
      }
      for (const item of items)
        for (const fact of facts.filter((f) =>
          (item.fact_ids ?? []).includes(f.id),
        )) {
          if (knownFacts.has(fact.id)) continue;
          item.evidence.push(fact);
          if (bytes({ items, remaining_review: this.remaining() }) > 65536) {
            item.evidence.pop();
            continue;
          }
          knownFacts.add(fact.id);
          this.track("facts", fact.id, fact.revision);
        }
    }
    this.active();
    for (const item of items) {
      this.track(kind, item.id, kind === "facts" ? item.revision : item.version);
      if (kind !== "facts" && stage.get(item.id)?.action !== "upsert")
        this.derivedReads[kind].add(item.id);
      if (
        stage.get(item.id) !==
        (kind === "facts" ? undefined : this.staged[kind].get(item.id))
      )
        fail(
          "maintenance_read_conflict",
          "Staged target changed during read",
          true,
        );
    }
    return {
      items,
      next_cursor:
        items.length && candidates.length > items.length
          ? items.at(-1)?.id
          : null,
      remaining_review: this.remaining(),
    };
  }

  private readonly writeQueues = new Map<string, Promise<void>>();
  async stage(kind: "profiles" | "events", changes: Mutation[]) {
    const keys = [
      ...new Set(changes.flatMap((c) => (c.id ? [`${kind}:${c.id}`] : []))),
    ].sort();
    const previous = keys.map(
      (k) => this.writeQueues.get(k) ?? Promise.resolve(),
    );
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const k of keys) this.writeQueues.set(k, gate);
    await Promise.all(previous);
    try {
      return await this.stageUnlocked(kind, changes);
    } finally {
      release();
      for (const k of keys)
        if (this.writeQueues.get(k) === gate) this.writeQueues.delete(k);
    }
  }
  private async stageUnlocked(
    kind: "profiles" | "events",
    changes: Mutation[],
  ) {
    this.active();
    const ids: string[] = [];
    const missing = new Set<string>();
    const proposalSupport = new Map<string, string[]>();
    let emptySupport = false;
    for (const c of changes) {
      const id = c.id ?? crypto.randomUUID();
      ids.push(id);
      if (!c.id) this.track(kind, id, null);
      if (
        c.id &&
        (!this.reads[kind].has(c.id) ||
          (this.reads[kind].get(c.id) !== null &&
            !this.derivedReads[kind].has(c.id)) ||
          (this.reads[kind].get(c.id) === null &&
            !this.staged[kind].has(c.id) &&
            !this.unresolved.has(`${kind}:${c.id}`)))
      )
        fail("maintenance_target_unread", "Read the target before editing it");
      if (c.action === "keep") {
        if (this.required[kind].has(id))
          fail(
            "maintenance_rewrite_required",
            "Rebuild affected memory from current Facts or remove it",
          );
        if (!this.derivedReads[kind].has(id))
          fail(
            "maintenance_target_unread",
            "Read current support before keeping memory",
          );
        const supports = await supportMap(this.runtime.db, this.claim, kind, [
          id,
        ]);
        const support = supports.get(id) ?? [];
        proposalSupport.set(id, support);
        if (!support.length) emptySupport = true;
        for (const fid of support)
          if (this.reads.facts.get(fid) == null) missing.add(fid);
      }
      if (c.action === "upsert") {
        proposalSupport.set(id, c.fact_ids ?? []);
        if (!c.content?.trim() || !c.fact_ids?.length)
          fail(
            "invalid_model_output",
            "Memory requires complete text and support",
          );
        if (!configuredMutation(kind, c, this.config))
          fail(
            "invalid_model_output",
            "Memory topic or event tag is not configured",
          );
        for (const fid of c.fact_ids ?? [])
          if (this.reads.facts.get(fid) == null) missing.add(fid);
        for (const [key, text] of Object.entries(c))
          if (
            typeof text === "string" &&
            !["action", "id", "topic"].includes(key) &&
            /\b[fpe]\d+\b/.test(text)
          )
            fail(
              "maintenance_reference_in_prose",
              "References belong in identity fields",
            );
      }
    }
    if (missing.size || emptySupport) {
      for (const [i, change] of changes.entries()) {
        const key = `${kind}:${ids[i]}`;
        const support = [...(proposalSupport.get(ids[i]) ?? [])]
          .sort()
          .map((id) => [
            id,
            this.reads.facts.has(id) ? this.reads.facts.get(id) : "unread",
          ]);
        const rejected =
          support.some(
            ([, revision]) => revision === null || revision === "unread",
          ) ||
          (change.action === "keep" && !support.length);
        const signature = rejected
          ? JSON.stringify({ ...change, id: ids[i], support })
          : null;
        if (signature !== null && this.unresolved.get(key) === signature)
          fail(
            "maintenance_staging_repeated",
            "Rejected change repeated without correction or new evidence",
          );
        this.unresolved.set(key, signature);
      }
      const invalid = [...missing].filter((id) => this.reads.facts.has(id));
      return {
        staged: false,
        ids,
        error: {
          code:
            invalid.length || emptySupport
              ? "maintenance_support_invalid"
              : "maintenance_support_unread",
          unread_fact_ids: [...missing].filter(
            (id) => !this.reads.facts.has(id),
          ),
          invalid_fact_ids: invalid,
        },
        remaining_review: this.remaining(),
      };
    }
    changes.forEach((c, i) => {
      this.staged[kind].set(ids[i], { ...c, id: ids[i] });
      this.unresolved.delete(`${kind}:${ids[i]}`);
    });
    return { staged: true, ids, remaining_review: this.remaining() };
  }
  async commit(resuming = false) {
    this.active();
    assertRunning(this.runtime, 1000);
    if (this.unresolved.size)
      fail(
        "maintenance_unresolved_staging",
        "Rejected proposals remain unresolved",
      );
    if (
      this.claim.changes.some((c, i) => c.kind !== "noop" && !this.seen.has(i))
    )
      fail("maintenance_incomplete", "Not all changes were read", true);
    if (Object.values(this.remaining()).some((v) => v.count))
      fail(
        "maintenance_unresolved_entries",
        "Required memory decisions remain",
      );
    const { db } = this.runtime;
    await this.publish(resuming);
    this.active();
    assertRunning(this.runtime, 1000);
    const ids = (kind: Derived) =>
      [...this.staged[kind]]
        .filter(([, change]) => change.action === "upsert")
        .map(([id]) => id);
    const completed = await maintenanceTasks.completeInTx(
      db,
      this.claim.id,
      this.claim.owner,
      {
        resultCode: "COMPLETED",
        result: {
          blob_ids: this.claim.blobIds,
          memory_version: Math.max(
            0,
            ...this.claim.changes.map((c) => c.version ?? 0),
          ),
          profile_ids: ids("profiles"),
          event_ids: ids("events"),
        },
        executionState: null,
      },
    );
    if (!completed) throw new TaskLeaseLost();
  }

  private async publish(resuming: boolean) {
    const { db } = this.runtime;
    const scope = scoped(this.claim);
    const { config: currentConfig, stored } = await getConfigSnapshot(
      this.runtime,
      this.claim.projectId,
    );
    if (!isDeepStrictEqual(currentConfig, this.config))
      fail(
        "maintenance_read_conflict",
        "Project model configuration changed",
        true,
      );
    const factVersion = [...this.staged.events.values()].some((change) => change.action === "upsert")
      ? await memoryVersion(db, this.claim)
      : 0;
    const readSet = await this.readSet(resuming);
    if (!readSet)
      return fail("maintenance_read_conflict", "Read memory changed", true);
    const { current, published, impactIds } = readSet;

    const kinds = ["profiles", "events"] as const;
    const altered = this.claim.changes.flatMap((c) =>
      c.fact_id && c.kind !== "added" ? [c.fact_id] : [],
    );
    for (const kind of kinds) {
      for (const change of this.staged[kind].values())
        if (!configuredMutation(kind, change, currentConfig))
          fail(
            "maintenance_read_conflict",
            "Configured topics or event tags changed",
            true,
          );
      if (!altered.length) continue;
      const affected = await db.query(
        `SELECT id FROM memoia.${TABLES[kind]} WHERE user_id=$1 AND project_id=$2 AND ${linked(kind, "$3")}`,
        [...scope, altered],
      );
      for (const { id } of affected.rows)
        if (
          !this.staged[kind].has(id) ||
          this.staged[kind].get(id)?.action === "keep"
        )
          fail(
            "maintenance_unresolved_entries",
            "Changed evidence still has unreviewed memory",
            true,
          );
    }
    const pending = (kind: Derived) =>
      [...this.staged[kind]].filter(
        ([id, change]) =>
          change.action !== "keep" &&
          !published[kind].has(id) &&
          (change.action !== "remove" || current[kind].has(id)),
      );
    const profiles = pending("profiles");
    const events = pending("events");
    if (!profiles.length && !events.length) return;

    const vectors = new Map<string, string>();
    const changedText = new Set<string>();
    const toEmbed: { id: string; text: string }[] = [];
    for (const [id, change] of events) {
      if (change.action !== "upsert") continue;
      const previous = current.events.get(id);
      const text = eventIndexText(change);
      if (!previous || eventIndexText({
        ...previous.data, content: previous.data.content ?? previous.data.event_tip,
      }) !== text) changedText.add(id);
      if (this.config.enable_event_embedding && (changedText.has(id) || !previous?.has_embedding))
        toEmbed.push({ id, text });
    }
    if (toEmbed.length) {
      const generated = await embeddings(this.runtime, this.claim.projectId,
        toEmbed.map(({ text }) => text), "document", this.claim.userId, this.config);
      toEmbed.forEach(({ id }, index) => vectors.set(id, JSON.stringify(generated[index])));
    }

    const supportIds = [
      ...new Set(
        [...profiles, ...events].flatMap(([, change]) => change.fact_ids ?? []),
      ),
    ];
    const support = supportIds.length
      ? (
          await db.query(
            `SELECT f.id,f.blob_id,b.source_id FROM memoia.memory_facts f JOIN memoia.memory_blobs b
       ON b.id=f.blob_id AND b.user_id=f.user_id AND b.project_id=f.project_id
       WHERE f.user_id=$1 AND f.project_id=$2 AND f.id=ANY($3::uuid[])`,
            [...scope, supportIds],
          )
        ).rows
      : [];
    const byFact = new Map(support.map((row) => [row.id, row]));
    const dataFor = (change: Mutation) => ({
      ...memoryFields(change),
      memoia_v2: true,
      source_ids: [
        ...new Set(
          (change.fact_ids ?? []).map((id) => byFact.get(id)?.source_id),
        ),
      ].sort(),
      _impact_fact_ids: impactIds,
    });
    if (support.length !== supportIds.length)
      fail("maintenance_read_conflict", "Fact support changed", true);
    const fence = [
      ...scope,
      [...this.reads.facts.keys()],
      [...this.reads.facts.values()],
      this.claim.id,
      this.claim.owner,
      stored,
    ];

    // Publish upserts before removals, so an earlier removal cannot erase provenance needed on resume.
    for (const [id, change] of events) {
      if (change.action !== "upsert") continue;
      this.active();
      const data = dataFor(change);
      const blobIds = [
        ...new Set(
          (change.fact_ids ?? []).map((fact) => byFact.get(fact)!.blob_id),
        ),
      ].sort();
      // Serialize only publication with the existing Fact version write. Model I/O is already done.
      const written = await db.query(
        `WITH ${publicationFence}, current_facts AS (
           INSERT INTO memoia.memory_user_states AS state(user_id,project_id,version)
           SELECT $1,$2,0 FROM allowed
           WHERE $13::bigint=0 OR EXISTS (
             SELECT 1 FROM memoia.memory_user_states WHERE user_id=$1 AND project_id=$2)
           ON CONFLICT (user_id,project_id) DO UPDATE SET version=state.version
             WHERE state.version=$13::bigint
           RETURNING 1
         ), changed AS (
           UPDATE memoia.user_events SET event_data=$10::jsonb,
             embedding=CASE WHEN $14::boolean THEN $11 ELSE embedding END,
             version=version+1,updated_at=clock_timestamp()
           FROM current_facts
           WHERE id=$8 AND user_id=$1 AND project_id=$2 AND version=$9::bigint
           RETURNING id
         ), created AS (
           INSERT INTO memoia.user_events(id,user_id,project_id,event_data,embedding)
           SELECT $8,$1,$2,$10::jsonb,$11 FROM current_facts
           WHERE $9::bigint IS NULL AND NOT EXISTS (
             SELECT 1 FROM memoia.memory_deleted_events WHERE user_id=$1 AND project_id=$2 AND id=$8)
           ON CONFLICT DO NOTHING
           RETURNING id
         ), saved AS (
           SELECT id FROM changed UNION ALL SELECT id FROM created
         ), removed AS (
           DELETE FROM memoia.memory_event_facts ef USING saved
           WHERE ef.user_id=$1 AND ef.project_id=$2 AND ef.event_id=saved.id
             AND NOT (ef.fact_id=ANY($12::uuid[]))
         ), added AS (
           INSERT INTO memoia.memory_event_facts(event_id,fact_id,user_id,project_id)
           SELECT saved.id,fact_id,$1,$2 FROM saved CROSS JOIN unnest($12::uuid[]) AS facts(fact_id)
           ON CONFLICT DO NOTHING
         ) SELECT id FROM saved`,
        [
          ...fence,
          id,
          this.reads.events.get(id) ?? null,
          JSON.stringify({
            ...data,
            event_tip: change.content,
            blob_ids: blobIds,
            source_id: data.source_ids.length === 1 ? data.source_ids[0] : null,
            blob_id: blobIds.length === 1 ? blobIds[0] : null,
          }),
          vectors.get(id) ?? null,
          change.fact_ids,
          factVersion,
          changedText.has(id) || vectors.has(id),
        ],
      );
      if (!written.rowCount)
        fail(
          "maintenance_read_conflict",
          "Event changed before publication",
          true,
        );
    }
    if (profiles.length)
      await this.publishProfiles(
        fence,
        profiles.map(([id, change]) => ({
          id,
          version: this.reads.profiles.get(id) ?? null,
          content: change.action === "upsert" ? change.content! : null,
          data: change.action === "upsert" ? {
            ...dataFor(change),
            _fact_revisions: Object.fromEntries(
              [...new Set([...(change.fact_ids ?? []), ...(impactIds ?? [])])]
                .flatMap((factId) => {
                  const revision = this.reads.facts.get(factId);
                  return revision == null ? [] : [[factId, revision]];
                }),
            ),
          } : null,
        })),
      );
    for (const [id, change] of events) {
      if (change.action !== "remove") continue;
      this.active();
      const removed = await db.query(
        `WITH ${publicationFence}
         DELETE FROM memoia.user_events USING allowed
         WHERE user_id=$1 AND project_id=$2 AND id=$8 AND version=$9`,
        [...fence, id, this.reads.events.get(id) ?? null],
      );
      if (!removed.rowCount)
        fail("maintenance_read_conflict", "Event changed before removal", true);
    }
  }

  private async publishProfiles(
    fence: unknown[],
    changes: {
      id: string;
      version: string | null;
      content: string | null;
      data: Record<string, unknown> | null;
    }[],
  ) {
    const { db } = this.runtime;
    const scope = scoped(this.claim);
    const pendingRows = (
      await db.query(
        `SELECT b.flush_operation_id AS owner,x.value AS change FROM memoia.memory_blobs b CROSS JOIN LATERAL jsonb_array_elements(b.fact_changes) x
       WHERE b.user_id=$1 AND b.project_id=$2 AND b.fact_completed_at IS NOT NULL AND (b.flush_operation_id IS NULL OR NOT EXISTS(SELECT 1 FROM memoia.memory_operations o JOIN memoia.queue_tasks t ON t.id=o.id WHERE o.id=b.flush_operation_id AND t.status='succeeded'))
       UNION ALL SELECT o.id AS owner,x.value AS change FROM memoia.memory_operations o LEFT JOIN memoia.queue_tasks t ON t.id=o.id CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.request->'legacy_changes','[]')) x WHERE o.user_id=$1 AND o.project_id=$2 AND o.kind='flush' AND t.status IS DISTINCT FROM 'succeeded'`,
        scope,
      )
    ).rows.filter((r) => r.change.fact_id && r.change.kind !== "added");
    const pendingIds = new Set(pendingRows.map((r) => r.change.fact_id));
    const futureIds = new Set(
      pendingRows
        .filter((r) => r.owner !== this.claim.id)
        .map((r) => r.change.fact_id),
    );
    const historySafe = (rows: QueryResultRow[], invalid: Set<string>) =>
      rows
        .filter(
          (r) =>
            r.attributes?.memoia_v2 === true &&
            (!invalid.size ||
              (Array.isArray(r.attributes?._impact_fact_ids) &&
                ![
                  ...(r.attributes.fact_ids ?? []),
                  ...r.attributes._impact_fact_ids,
                ].some((id) => invalid.has(id)))),
        )
        .map((r) => ({
          id: r.id,
          content: r.content,
          topic: r.attributes.topic ?? "",
          sub_topic: r.attributes.sub_topic ?? "",
          fact_ids: [...(r.attributes.fact_ids ?? [])].sort(),
          source_ids: [...(r.attributes.source_ids ?? [])].sort(),
          _impact_fact_ids: r.attributes._impact_fact_ids ?? null,
          _fact_revisions: r.attributes._fact_revisions ?? {},
        }));
    const existing = (
      await db.query(
        "SELECT id,content,attributes FROM memoia.user_profiles WHERE user_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])",
        [...scope, changes.map(({ id }) => id)],
      )
    ).rows;
    const proposed = changes.flatMap(({ id, content, data }) =>
      content === null ? [] : [{ id, content, attributes: data }],
    );
    const old = new Map(historySafe(existing, pendingIds).map((row) => [row.id, row]));
    const next = new Map(historySafe(proposed, futureIds).map((row) => [row.id, row]));
    const history = changes.flatMap(({ id }) => {
      const previous = old.get(id) ?? null;
      const proposed = next.get(id) ?? null;
      return isDeepStrictEqual(previous, proposed) ? [] : [{ id, previous, proposed }];
    });
    this.active();
    const written = await db.query(
      `WITH ${publicationFence}, input AS MATERIALIZED (
         SELECT p.* FROM jsonb_to_recordset($8::jsonb) AS p(id uuid,version bigint,content text,data jsonb)
         CROSS JOIN allowed
       ), removed AS (
         DELETE FROM memoia.user_profiles existing USING input
         WHERE input.content IS NULL AND existing.id=input.id AND existing.user_id=$1
           AND existing.project_id=$2 AND existing.version=input.version RETURNING existing.id
       ), changed AS (
         UPDATE memoia.user_profiles p SET content=input.content,attributes=input.data,
           version=p.version+1,updated_at=clock_timestamp()
         FROM input WHERE input.content IS NOT NULL AND p.id=input.id
           AND p.user_id=$1 AND p.project_id=$2 AND p.version=input.version
         RETURNING p.id
       ), created AS (
         INSERT INTO memoia.user_profiles(id,user_id,project_id,content,attributes)
         SELECT id,$1,$2,content,data FROM input WHERE content IS NOT NULL AND version IS NULL
         ON CONFLICT DO NOTHING RETURNING id
       ), applied AS (
         SELECT id FROM removed UNION ALL SELECT id FROM changed UNION ALL SELECT id FROM created
       ), snapshot_rows AS (
         SELECT p.id,p.content,p.attributes FROM memoia.user_profiles p
         WHERE p.user_id=$1 AND p.project_id=$2 AND NOT EXISTS (SELECT 1 FROM applied a WHERE a.id=p.id)
         UNION ALL
         SELECT i.id,i.content,i.data FROM input i JOIN applied a USING (id) WHERE i.content IS NOT NULL
       ), snapshot AS (
         SELECT id,jsonb_build_object(
           'id',id,'content',content,'topic',COALESCE(attributes->>'topic',''),
           'sub_topic',COALESCE(attributes->>'sub_topic',''),
           'fact_ids',COALESCE(NULLIF(attributes->'fact_ids','null'::jsonb),'[]'::jsonb),
           'source_ids',COALESCE(NULLIF(attributes->'source_ids','null'::jsonb),'[]'::jsonb),
           '_impact_fact_ids',attributes->'_impact_fact_ids',
           '_fact_revisions',COALESCE(attributes->'_fact_revisions','{}'::jsonb)
         ) AS profile
         FROM snapshot_rows WHERE attributes->'memoia_v2'='true'::jsonb AND (
           cardinality($11::text[])=0 OR (
             jsonb_typeof(attributes->'_impact_fact_ids')='array'
             AND NOT (attributes->'_impact_fact_ids' ?| $11::text[])
             AND NOT (COALESCE(attributes->'fact_ids','[]'::jsonb) ?| $11::text[])
           )
         )
       ), delta AS (
         SELECT h.* FROM jsonb_to_recordset($10::jsonb) AS h(id uuid,previous jsonb,proposed jsonb)
         JOIN applied a USING (id)
       ), recorded AS (
         INSERT INTO memoia.memory_profile_revisions AS prior
           (id,user_id,project_id,operation_id,profiles,added,removed)
         SELECT $9,$1,$2,$5,
           COALESCE((SELECT jsonb_agg(profile ORDER BY id) FROM snapshot),'[]'::jsonb),
           COALESCE((SELECT jsonb_agg(proposed ORDER BY id) FROM delta WHERE proposed IS NOT NULL),'[]'::jsonb),
           COALESCE((SELECT jsonb_agg(previous ORDER BY id) FROM delta WHERE previous IS NOT NULL),'[]'::jsonb)
         WHERE EXISTS (SELECT 1 FROM applied)
         ON CONFLICT(operation_id) DO UPDATE SET profiles=excluded.profiles,(added,removed)=(
           WITH earlier AS (
             SELECT COALESCE(b.value->>'id',a.value->>'id') AS id,b.value AS previous,a.value AS proposed
             FROM jsonb_array_elements(prior.removed) b FULL JOIN jsonb_array_elements(prior.added) a
               ON b.value->>'id'=a.value->>'id'
           ), merged AS (
             SELECT COALESCE(e.id,d.id::text) AS id,
               CASE WHEN e.id IS NULL THEN d.previous ELSE e.previous END AS previous,
               CASE WHEN d.id IS NULL THEN e.proposed ELSE d.proposed END AS proposed
             FROM earlier e FULL JOIN delta d ON d.id::text=e.id
           )
           SELECT
             COALESCE(jsonb_agg(proposed ORDER BY id) FILTER (WHERE proposed IS NOT NULL),'[]'::jsonb),
             COALESCE(jsonb_agg(previous ORDER BY id) FILTER (WHERE previous IS NOT NULL),'[]'::jsonb)
           FROM merged WHERE previous IS DISTINCT FROM proposed
         )
       )
       SELECT id FROM applied`,
      [...fence, JSON.stringify(changes), crypto.randomUUID(), JSON.stringify(history), [...futureIds]],
    );
    if (written.rowCount !== changes.length)
      fail(
        "maintenance_read_conflict",
        "Profile changed before publication",
        true,
      );
  }
}
