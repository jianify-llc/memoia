/** Fixed Blobs and existing Operations own maintenance; Queue messages only wake them. */
import type { QueryResultRow } from "pg";
import {
  acquireUserLease,
  isDatabaseTransportError,
  LeaseLostError,
  assertActive,
  assertUserLease,
  finishUserLease,
  lockUser,
  releaseUserLease,
  type Sql,
  type UserScope,
} from "./db.js";
import { SourceError } from "./errors.js";
import { inSpan } from "./observability.js";
import {
  assertRunning,
  closeRuntime,
  createRuntime,
  type Runtime,
  type Wakeup,
} from "./runtime.js";
import { embeddings, getConfig, type ModelConfig } from "./models.js";
import {
  maintenancePromptHash,
  runMaintenance,
  type MaintenanceContinuation,
} from "./maintenance-agent.js";
import { z } from "zod";
import {
  maintenanceTasks,
  maintenanceRetryPolicy,
  projectOperation,
  projectOperations,
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

export type Change = { kind: string; fact_id?: string; version?: number };
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
    blob_ids: row.request?.blob_ids ?? [],
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
): Promise<void> {
  const changed = await tx.query(
    `UPDATE memoia.memory_blobs SET fact_completed_at=clock_timestamp(),fact_changes=$4::jsonb
    WHERE user_id=$1 AND project_id=$2 AND id=$3 AND fact_completed_at IS NULL AND flush_operation_id IS NULL`,
    [
      ...scoped(scope),
      blobId,
      JSON.stringify(
        (changes.length ? changes : [{ kind: "noop" }]).map((c) => ({
          ...c,
          version,
        })),
      ),
    ],
  );
  if (changed.rowCount !== 1)
    fail("blob_conflict", "Fixed Blob has already been committed", true);
  const ids = changes
    .filter((c) => c.fact_id && c.kind !== "added")
    .map((c) => c.fact_id);
  if (ids.length)
    for (const kind of ["profiles", "events"] as const) {
      const data = kind === "profiles" ? "attributes" : "event_data";
      await tx.query(
        `UPDATE memoia.${TABLES[kind]} SET revision=revision+1 WHERE user_id=$1 AND project_id=$2 AND ${linked(kind, "$3")}`,
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
  try {
    await sendWakeup(
      runtime,
      { kind: "user", user_id: scope.userId, project_id: scope.projectId },
      30,
    );
  } catch {
    console.warn(
      JSON.stringify({ event: "maintenance_wakeup_unconfirmed", ...scope }),
    );
  }
}
async function seal(
  runtime: Runtime,
  scope: UserScope,
  key: string,
): Promise<QueryResultRow> {
  return runtime.db.transaction(async (tx) => {
    await lockUser(tx, scope);
    const old = await tx.query(
      "SELECT * FROM memoia.memory_operations WHERE user_id=$1 AND project_id=$2 AND idempotency_key=$3",
      [...scoped(scope), key],
    );
    if (old.rows.length) {
      if (old.rows[0].kind !== "flush")
        fail("idempotency_conflict", "Key identifies another operation");
      return projectOperation(tx, old.rows[0]);
    }
    const rows = (
      await tx.query(
        `SELECT * FROM memoia.memory_blobs WHERE user_id=$1 AND project_id=$2 AND fact_completed_at IS NOT NULL AND flush_operation_id IS NULL ORDER BY fact_completed_at,id LIMIT 100 FOR UPDATE`,
        scoped(scope),
      )
    ).rows;
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
            "SELECT id,content,subject,reporter,certainty,support_groups,occurred_at,fact_time,created_at,updated_at FROM memoia.memory_facts WHERE user_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])",
            [...scoped(scope), factIds],
          )
        ).rows
      : [];
    const chosen: QueryResultRow[] = [];
    let size = 0;
    for (const row of rows) {
      const ids = new Set(row.fact_changes.map((c: Change) => c.fact_id));
      const cost = bytes({
        changes: row.fact_changes,
        facts: current.filter((f) => ids.has(f.id)),
      });
      if (chosen.length && size + cost > 262144) break;
      chosen.push(row);
      size += cost;
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
            JSON.stringify({ idempotency_key: key, kind: "flush" }),
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
          key,
          hash,
          JSON.stringify({ blob_ids: blobIds }),
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
      bizParams: {},
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
    if (blobIds.length)
      await tx.query(
        "UPDATE memoia.memory_blobs SET flush_operation_id=$3 WHERE user_id=$1 AND project_id=$2 AND id=ANY($4::uuid[])",
        [...scoped(scope), id, blobIds],
      );
    return projectFlush(row, task);
  });
}
export async function flush(runtime: Runtime, scope: UserScope, key: string) {
  const row = await seal(runtime, scope, key);
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
      "SELECT * FROM memoia.memory_operations WHERE user_id=$1 AND project_id=$2 AND kind='flush' ORDER BY created_at DESC,id LIMIT 100",
      scoped(scope),
    ),
  ]);
  return {
    pending_blob_count: blobs.rows[0].n,
    flushes: (await projectOperations(runtime.db, ops.rows)).map(progress),
  };
}
export async function retryFlush(
  runtime: Runtime,
  scope: UserScope,
  id: string,
) {
  const row = await runtime.db.transaction(async (tx) => {
    await lockUser(tx, scope);
    const op = (
      await tx.query(
        "SELECT * FROM memoia.memory_operations WHERE user_id=$1 AND project_id=$2 AND id=$3 AND kind='flush' FOR UPDATE",
        [...scoped(scope), id],
      )
    ).rows[0];
    if (!op) fail("operation_not_found", "Operation not found");
    let task = await maintenanceTasks.readInTx(tx, id, true);
    if (!task) throw new Error("Flush execution task is missing");
    if (task.status === "running") {
      const expired = await maintenanceTasks.revokeInTx(
        tx,
        id,
        { code: "maintenance_lease_expired", retryable: true, manual: true },
        maintenanceRetryPolicy,
      );
      if (expired) task = expired;
    }
    if (task.status === "failed" || task.status === "manual") {
      task = (await maintenanceTasks.recoverInTx(tx, id)) ?? task;
    }
    return projectFlush(op, task);
  });
  if (row.status === "processing") await dispatch(runtime, row);
  return receipt(row);
}
async function dispatch(runtime: Runtime, row: QueryResultRow) {
  if (runtime.env.MAINTENANCE_ENABLED !== "true" || !runtime.maintenanceWakeup)
    return;
  const reserved = await runtime.db.transaction((tx) =>
    maintenanceTasks.reserveDispatchInTx(tx, row.id, 4),
  );
  if (!reserved) return;
  const delay = Math.max(
    0,
    Math.min(
      86400,
      Math.ceil((reserved.nextRunAt.getTime() - Date.now()) / 1000),
    ),
  );
  try {
    await sendWakeup(
      runtime,
      {
        kind: "flush",
        operation_id: row.id,
        user_id: row.user_id,
        project_id: row.project_id,
      },
      delay,
    );
    if (reserved.lastDispatchAttemptAt)
      await runtime.db.transaction((tx) =>
        maintenanceTasks.acknowledgeDispatchInTx(
          tx,
          row.id,
          reserved.lastDispatchAttemptAt!,
        ),
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
  return runtime.db.transaction(async (tx) => {
    await lockUser(tx, scope);
    const held = await tx.query(
      "SELECT 1 FROM memoia.memory_operations o JOIN memoia.queue_tasks t ON t.id=o.id WHERE o.user_id=$1 AND o.project_id=$2 AND o.kind='flush' AND t.status='running'",
      scoped(scope),
    );
    if (held.rowCount) return null;
    const row = (
      await tx.query(
        "SELECT * FROM memoia.memory_operations WHERE user_id=$1 AND project_id=$2 AND id=$3 AND kind='flush' FOR UPDATE",
        [...scoped(scope), message.operation_id],
      )
    ).rows[0];
    if (!row) return null;
    const task = await maintenanceTasks.claimInTx(tx, row.id, {
      type: "maintenance_flush",
      limit: 4,
    });
    if (!task?.leaseId) return null;
    const batches = await tx.query(
      "SELECT fact_changes FROM memoia.memory_blobs WHERE user_id=$1 AND project_id=$2 AND flush_operation_id=$3 ORDER BY fact_completed_at,id",
      [...scoped(scope), row.id],
    );
    return {
      ...scope,
      id: row.id,
      owner: task.leaseId,
      task,
      blobIds: row.request.blob_ids,
      changes: [
        ...batches.rows.flatMap((b) => b.fact_changes),
        ...(row.request.legacy_changes ?? []),
      ],
    };
  });
}
async function owned(tx: Sql, c: Claim, lock = false) {
  await assertActive(tx, c);
  return maintenanceTasks.assertOwnedInTx(tx, c.id, c.owner, lock);
}
async function failClaim(runtime: Runtime, c: Claim, error: unknown) {
  const retryable =
    error instanceof LeaseLostError || isDatabaseTransportError(error)
      ? true
      : error instanceof SourceError
        ? error.retryable
        : Boolean(
            error &&
              typeof error === "object" &&
              "code" in error &&
              [
                "08006",
                "08001",
                "57P01",
                "40001",
                "40P01",
                "55P03",
                "57014",
              ].includes(String(error.code)),
          );
  const code =
    error instanceof LeaseLostError
      ? "maintenance_writer_busy"
      : error instanceof SourceError
        ? error.code
        : "maintenance_failed";
  await runtime.db.transaction(async (tx) => {
    await lockUser(tx, c);
    // A lost COMMIT response may already have committed the original receipt.
    const receipt = await tx.query(
      "SELECT status FROM memoia.queue_tasks WHERE id=$1 FOR UPDATE",
      [c.id],
    );
    if (receipt.rows[0]?.status === "succeeded") return;
    await owned(tx, c, true);
    const failed = await maintenanceTasks.failInTx(
      tx,
      c.id,
      c.owner,
      { code, retryable },
      maintenanceRetryPolicy,
    );
    if (!failed) throw new TaskLeaseLost();
  });
}
function maintenanceEnabled(runtime: Runtime): boolean {
  return (
    runtime.env.MEMOIA_WRITES_ENABLED !== "false" &&
    runtime.env.MAINTENANCE_ENABLED === "true"
  );
}
async function prepareMaintenance(runtime: Runtime) {
  const expired = await runtime.db
    .query(`SELECT o.id,o.user_id,o.project_id FROM memoia.memory_operations o JOIN memoia.queue_tasks t ON t.id=o.id
    WHERE o.kind='flush' AND t.status='running' AND (t.lease_expires_at<=clock_timestamp() OR t.started_at+${HARD_SLICE_MS}*interval '1 millisecond'<=clock_timestamp()) LIMIT 100`);
  for (const row of expired.rows)
    await runtime.db.transaction(async (tx) => {
      await lockUser(tx, { userId: row.user_id, projectId: row.project_id });
      await maintenanceTasks.revokeInTx(
        tx,
        row.id,
        { code: "maintenance_lease_expired", retryable: true },
        maintenanceRetryPolicy,
      );
    });
  const due = await runtime.db
    .query(`SELECT user_id,project_id FROM memoia.memory_blobs WHERE fact_completed_at IS NOT NULL AND flush_operation_id IS NULL
    GROUP BY user_id,project_id HAVING least(max(fact_completed_at)+interval '30 seconds',min(fact_completed_at)+interval '120 seconds')<=clock_timestamp() LIMIT 100`);
  for (const s of due.rows)
    await seal(
      runtime,
      { userId: s.user_id, projectId: s.project_id },
      `auto-flush:${crypto.randomUUID()}`,
    );
  await runtime.db.query(
    "DELETE FROM memoia.usage_counters WHERE expires_at<=clock_timestamp()",
  );
}
async function pendingMaintenance(
  runtime: Runtime,
  limit: number,
  notifications: boolean,
) {
  const pending = await runtime.db.query(
    `SELECT * FROM (
    SELECT DISTINCT ON (o.project_id,o.user_id) o.*,t.next_run_at FROM memoia.memory_operations o JOIN memoia.queue_tasks t ON t.id=o.id WHERE o.kind='flush' AND t.status IN ('pending','queued','retry_wait')
    AND t.next_run_at<=clock_timestamp() AND (NOT $1::boolean OR t.next_dispatch_at IS NULL OR t.next_dispatch_at<=clock_timestamp())
    AND NOT EXISTS(SELECT 1 FROM memoia.memory_operations held JOIN memoia.queue_tasks ht ON ht.id=held.id WHERE held.project_id=o.project_id AND held.user_id=o.user_id AND held.kind='flush' AND ht.status='running')
    ORDER BY o.project_id,o.user_id,t.next_run_at,o.id) candidates ORDER BY next_run_at,id LIMIT $2`,
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
): Promise<Extract<Wakeup, { kind: "flush" }>[]> {
  if (!Number.isInteger(limit) || limit < 0 || limit > 100)
    throw new RangeError("Invalid maintenance poll limit");
  if (!maintenanceEnabled(runtime)) return [];
  await prepareMaintenance(runtime);
  if (limit === 0) return [];
  return (await pendingMaintenance(runtime, limit, false)).map((row) => ({
    kind: "flush",
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
    const row = await seal(
      runtime,
      { userId: message.user_id, projectId: message.project_id },
      `auto-flush:${crypto.randomUUID()}`,
    );
    await dispatch(runtime, row);
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
        renew: async () =>
          (
            await runtime.db.transaction((tx) =>
              maintenanceTasks.renewInTx(tx, c.id, c.owner),
            )
          )?.leaseExpiresAt ?? null,
        onTimeout: async () => {
          const isolated = createRuntime(runtime.env);
          try {
            await isolated.db.transaction(async (tx) => {
              await lockUser(tx, c);
              await maintenanceTasks.revokeInTx(
                tx,
                c.id,
                { code: "maintenance_timeout", retryable: true },
                maintenanceRetryPolicy,
                c.owner,
              );
            });
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
          const active = async () => {
            budget.assertActive();
            await owned(runtime.db, c);
          };
          const makeContext = async () => {
            const result = new MaintenanceContext(sliceRuntime, c, active);
            await result.prepare();
            return result;
          };
          let context = await makeContext();
          const identity = await digest({
            version: MAINTENANCE_CHECKPOINT_VERSION,
            prompt: await maintenancePromptHash(),
            config: context.config,
            provider: {
              modelBaseUrl: runtime.env.OPENAI_BASE_URL ?? null,
              embeddingBaseUrl: runtime.env.EMBEDDING_BASE_URL ?? null,
              configuration: runtime.env.MEMOIA_CONFIG ?? null,
            },
            blobIds: c.blobIds,
            changes: c.changes,
          });
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
            const previous = saved;
            const next = await runtime.db.transaction(async (tx) => {
              await lockUser(tx, c);
              return maintenanceTasks.saveCheckpointInTx(
                tx,
                c.id,
                c.owner,
                previous,
                value,
              );
            });
            if (!next) throw new TaskLeaseLost();
            saved = next.executionState;
          };
          let restored =
            parsed.success &&
            parsed.data.identity === identity &&
            parsed.data.phase !== "new" &&
            !!parsed.data.state &&
            !!parsed.data.refs;
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
            if (restored) restored = await context.validateRestored(required);
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
            context = await makeContext();
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
          if (budget.shouldYield(30_000)) throw new TaskYield();
          await context.commit();
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
      await runtime.db.transaction(async (tx) => {
        await lockUser(tx, c);
        if (!(await maintenanceTasks.yieldInTx(tx, c.id, c.owner, saved)))
          throw new TaskLeaseLost();
      });
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
  constructor(
    readonly runtime: Runtime,
    readonly claim: Claim,
    readonly active: () => Promise<void>,
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
  ): Promise<boolean> {
    await this.active();
    for (const kind of ["profiles", "events"] as const) {
      const expected = requiredBeforeRestore[kind];
      if (
        expected.size !== this.required[kind].size ||
        [...expected].some((id) => !this.required[kind].has(id))
      )
        return false;
    }
    for (const kind of ["facts", "profiles", "events"] as const) {
      const reads = this.reads[kind];
      if (!reads.size) continue;
      const rows = (
        await this.runtime.db.query(
          `SELECT id,revision FROM memoia.${TABLES[kind]} WHERE user_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])`,
          [...scoped(this.claim), [...reads.keys()]],
        )
      ).rows;
      const current = new Map(
        rows.map((row) => [row.id, String(row.revision)]),
      );
      for (const [id, revision] of reads)
        if ((current.get(id) ?? null) !== revision) return false;
    }
    await this.active();
    return true;
  }
  private track(kind: Collection, id: string, revision: unknown) {
    const rev = revision == null ? null : String(revision);
    if (this.reads[kind].has(id) && this.reads[kind].get(id) !== rev)
      fail("maintenance_read_conflict", "Related memory changed", true);
    this.reads[kind].set(id, rev);
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
            "SELECT id,content,subject,reporter,certainty,support_groups,occurred_at,fact_time,created_at,updated_at FROM memoia.memory_facts WHERE user_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])",
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
        this.track(kind, row.id, row.revision);
        this.required[kind].add(row.id);
      }
    }
  }
  async readChanges(cursor: string | null = null, limit = 100) {
    await this.active();
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
            "SELECT id,blob_id,content,subject,reporter,certainty,support_groups,occurred_at,fact_time,revision,created_at,updated_at FROM memoia.memory_facts WHERE user_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])",
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
    await this.active();
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
        `SELECT * FROM memoia.${TABLES[kind]} WHERE user_id=$1 AND project_id=$2 ${conditions} ORDER BY id LIMIT ${limit + 1}`,
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
      if (kind === "facts") {
        const {
          embedding,
          search_text,
          user_id,
          project_id,
          included,
          ...rest
        } = row;
        return rest;
      }
      const data = kind === "profiles" ? row.attributes : row.event_data;
      const item = {
        ...data,
        id: row.id,
        revision: row.revision,
        ...(kind === "profiles" ? { content: row.content } : {}),
        fact_ids: supports.get(row.id) ?? [],
      };
      delete item._impact_fact_ids;
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
        (row ? String(row.revision) : null)
      )
        fail("maintenance_read_conflict", "Staged target changed", true);
      if (change.action === "remove" && !row) continue;
      let item: QueryResultRow = row
        ? itemOf(row)
        : { id, revision: null, fact_ids: [] };
      // A proposal replaces the stored entry; omitted fields must not leak old prose.
      if (change.action === "upsert")
        item = {
          id,
          revision: row?.revision ?? null,
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
              "SELECT id,blob_id,content,subject,reporter,certainty,support_groups,occurred_at,fact_time,revision,created_at,updated_at FROM memoia.memory_facts WHERE user_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])",
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
    await this.active();
    for (const item of items) {
      this.track(kind, item.id, item.revision);
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
    await this.active();
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
  async commit() {
    await this.active();
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
    const eventUpserts = [...this.staged.events.values()].filter(
      (c) => c.action === "upsert",
    );
    const indexText = (c: Mutation) =>
      [c.title, c.summary, c.keywords, c.event_time, c.location, c.content]
        .filter(Boolean)
        .join("\n");
    const vectors: Array<number[] | null> = eventUpserts.map(() => null);
    if (this.config.enable_event_embedding && eventUpserts.length) {
      const existing = (
        await this.runtime.db.query(
          "SELECT id,event_data,embedding FROM memoia.user_events WHERE user_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])",
          [...scoped(this.claim), eventUpserts.map((c) => c.id)],
        )
      ).rows;
      const pending: number[] = [];
      for (const [i, change] of eventUpserts.entries()) {
        const old = existing.find((row) => row.id === change.id);
        const prior = old?.event_data;
        const oldText = prior
          ? indexText({ ...prior, content: prior.content ?? prior.event_tip })
          : null;
        if (old && old.embedding !== null && oldText === indexText(change))
          vectors[i] =
            typeof old.embedding === "string"
              ? JSON.parse(old.embedding)
              : old.embedding;
        else pending.push(i);
      }
      if (pending.length) {
        const fresh = await embeddings(
          this.runtime,
          this.claim.projectId,
          pending.map((i) => indexText(eventUpserts[i])),
        );
        pending.forEach((i, j) => {
          vectors[i] = fresh[j];
        });
      }
    }
    const lease = await acquireUserLease(this.runtime.db, this.claim, 30_000);
    try {
      await this.runtime.db.transaction(async (tx) => {
        await assertUserLease(tx, lease);
        await owned(tx, this.claim, true);
        await tx.query(
          "SELECT project_id FROM memoia.projects WHERE project_id=$1 FOR SHARE",
          [this.claim.projectId],
        );
        const currentConfig = await getConfig(
          this.runtime,
          this.claim.projectId,
          tx,
        );
        if (JSON.stringify(currentConfig) !== JSON.stringify(this.config))
          fail(
            "maintenance_read_conflict",
            "Project model configuration changed",
            true,
          );
        for (const kind of ["profiles", "events"] as const)
          for (const change of this.staged[kind].values())
            if (!configuredMutation(kind, change, currentConfig))
              fail(
                "maintenance_read_conflict",
                "Configured topics or event tags changed",
                true,
              );
        for (const kind of ["facts", "profiles", "events"] as const) {
          const reads = this.reads[kind];
          if (!reads.size) continue;
          const current = (
            await tx.query(
              `SELECT id,revision FROM memoia.${TABLES[kind]} WHERE user_id=$1 AND project_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE`,
              [...scoped(this.claim), [...reads.keys()]],
            )
          ).rows;
          for (const [id, rev] of reads)
            if (
              String(current.find((r) => r.id === id)?.revision ?? "null") !==
              String(rev ?? "null")
            )
              fail("maintenance_read_conflict", "Read memory changed", true);
        }
        const altered = this.claim.changes
          .filter((c) => c.fact_id && c.kind !== "added")
          .map((c) => c.fact_id);
        for (const kind of ["profiles", "events"] as const) {
          const field = kind === "profiles" ? "attributes" : "event_data";
          if (altered.length) {
            const affected = await tx.query(
              `SELECT id FROM memoia.${TABLES[kind]} WHERE user_id=$1 AND project_id=$2 AND ${linked(kind, "$3")}`,
              [...scoped(this.claim), altered],
            );
            for (const row of affected.rows)
              if (
                !this.staged[kind].has(row.id) ||
                this.staged[kind].get(row.id)?.action === "keep"
              )
                fail(
                  "maintenance_unresolved_entries",
                  "Changed evidence still has unreviewed memory",
                  true,
                );
          }
        }
        let impact: string[] | null = [...this.reads.facts.entries()]
          .filter(([, r]) => r !== null)
          .map(([id]) => id);
        // Reading old derived text carries its influence forward; unknown legacy provenance stays unknown.
        for (const kind of ["profiles", "events"] as const) {
          const field = kind === "profiles" ? "attributes" : "event_data";
          const ids = [...this.derivedReads[kind]].filter(
            (id) => this.reads[kind].get(id) != null,
          );
          if (!ids.length) continue;
          const prior = await tx.query(
            `SELECT ${field}->'_impact_fact_ids' AS impact FROM memoia.${TABLES[kind]} WHERE user_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])`,
            [...scoped(this.claim), ids],
          );
          for (const row of prior.rows) {
            if (!Array.isArray(row.impact)) {
              impact = null;
              break;
            }
            if (impact) impact.push(...row.impact);
          }
        }
        if (impact)
          impact = [...new Set(impact)].filter(
            (id) =>
              !this.claim.changes.some(
                (c) =>
                  c.kind === "deleted" &&
                  c.fact_id === id &&
                  this.reads.facts.get(id) === null,
              ),
          );
        const pendingRows = await tx.query(
          `SELECT b.flush_operation_id AS owner,x.value AS change FROM memoia.memory_blobs b CROSS JOIN LATERAL jsonb_array_elements(b.fact_changes) x
        WHERE b.user_id=$1 AND b.project_id=$2 AND b.fact_completed_at IS NOT NULL AND (b.flush_operation_id IS NULL OR NOT EXISTS(SELECT 1 FROM memoia.memory_operations o JOIN memoia.queue_tasks t ON t.id=o.id WHERE o.id=b.flush_operation_id AND t.status='succeeded'))
        UNION ALL SELECT o.id AS owner,x.value AS change FROM memoia.memory_operations o LEFT JOIN memoia.queue_tasks t ON t.id=o.id CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.request->'legacy_changes','[]')) x WHERE o.user_id=$1 AND o.project_id=$2 AND o.kind='flush' AND t.status IS DISTINCT FROM 'succeeded'`,
          scoped(this.claim),
        );
        const pendingIds = new Set(
          pendingRows.rows
            .filter((r) => r.change.fact_id && r.change.kind !== "added")
            .map((r) => r.change.fact_id),
        );
        const futureIds = new Set(
          pendingRows.rows
            .filter(
              (r) =>
                r.owner !== this.claim.id &&
                r.change.fact_id &&
                r.change.kind !== "added",
            )
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
            }));
        const before = historySafe(
          (
            await tx.query(
              "SELECT id,content,attributes FROM memoia.user_profiles WHERE user_id=$1 AND project_id=$2 ORDER BY id",
              scoped(this.claim),
            )
          ).rows,
          pendingIds,
        );
        for (const kind of ["profiles", "events"] as const)
          for (const [id, c] of this.staged[kind]) {
            if (c.action === "keep") continue;
            if (
              kind === "events" &&
              (
                await tx.query(
                  "SELECT 1 FROM memoia.memory_deleted_events WHERE user_id=$1 AND project_id=$2 AND id=$3",
                  [...scoped(this.claim), id],
                )
              ).rowCount
            )
              fail(
                "maintenance_read_conflict",
                "Event was explicitly deleted",
                true,
              );
            if (c.action === "remove") {
              await tx.query(
                `DELETE FROM memoia.${TABLES[kind]} WHERE user_id=$1 AND project_id=$2 AND id=$3`,
                [...scoped(this.claim), id],
              );
              continue;
            }
            const support = (
              await tx.query(
                "SELECT f.id,f.blob_id,b.source_id FROM memoia.memory_facts f JOIN memoia.memory_blobs b ON b.id=f.blob_id AND b.user_id=f.user_id AND b.project_id=f.project_id WHERE f.user_id=$1 AND f.project_id=$2 AND f.id=ANY($3::uuid[])",
                [...scoped(this.claim), c.fact_ids],
              )
            ).rows;
            if (support.length !== new Set(c.fact_ids ?? []).size)
              fail("maintenance_read_conflict", "Fact support changed", true);
            const data = {
              ...c,
              memoia_v2: true,
              fact_ids: c.fact_ids,
              source_ids: [...new Set(support.map((f) => f.source_id))],
              _impact_fact_ids: impact,
            };
            delete data.id;
            delete (data as Partial<Mutation>).action;
            if (kind === "profiles") {
              const written = await tx.query(
                `INSERT INTO memoia.user_profiles(id,user_id,project_id,content,attributes) VALUES($3,$1,$2,$4,$5::jsonb) ON CONFLICT(id,project_id) DO UPDATE SET content=excluded.content,attributes=excluded.attributes,revision=user_profiles.revision+1,updated_at=clock_timestamp() WHERE user_profiles.user_id=excluded.user_id`,
                [...scoped(this.claim), id, c.content, JSON.stringify(data)],
              );
              if (written.rowCount !== 1)
                fail(
                  "maintenance_read_conflict",
                  "Target belongs to another user",
                  true,
                );
            } else {
              const index = eventUpserts.findIndex((v) => v.id === id);
              const blobIds = [...new Set(support.map((f) => f.blob_id))];
              const event = {
                ...data,
                event_tip: c.content,
                blob_ids: blobIds,
                source_id:
                  data.source_ids.length === 1 ? data.source_ids[0] : null,
                blob_id: blobIds.length === 1 ? blobIds[0] : null,
              };
              const written = await tx.query(
                `INSERT INTO memoia.user_events(id,user_id,project_id,event_data,embedding) VALUES($3,$1,$2,$4::jsonb,$5::vector) ON CONFLICT(id,project_id) DO UPDATE SET event_data=excluded.event_data,embedding=excluded.embedding,revision=user_events.revision+1,updated_at=clock_timestamp() WHERE user_events.user_id=excluded.user_id`,
                [
                  ...scoped(this.claim),
                  id,
                  JSON.stringify(event),
                  vectors[index] ? JSON.stringify(vectors[index]) : null,
                ],
              );
              if (written.rowCount !== 1)
                fail(
                  "maintenance_read_conflict",
                  "Target belongs to another user",
                  true,
                );
              await tx.query(
                "DELETE FROM memoia.memory_event_facts WHERE user_id=$1 AND project_id=$2 AND event_id=$3",
                [...scoped(this.claim), id],
              );
              for (const f of support)
                await tx.query(
                  "INSERT INTO memoia.memory_event_facts(event_id,fact_id,user_id,project_id)VALUES($3,$4,$1,$2)",
                  [...scoped(this.claim), id, f.id],
                );
            }
          }
        if (
          [...this.staged.profiles.values()].some((c) => c.action !== "keep")
        ) {
          const after = historySafe(
            (
              await tx.query(
                "SELECT id,content,attributes FROM memoia.user_profiles WHERE user_id=$1 AND project_id=$2 ORDER BY id",
                scoped(this.claim),
              )
            ).rows,
            futureIds,
          );
          const old = new Map(before.map((r) => [r.id, JSON.stringify(r)]));
          const next = new Map(after.map((r) => [r.id, JSON.stringify(r)]));
          await tx.query(
            "INSERT INTO memoia.memory_profile_revisions(id,user_id,project_id,operation_id,profiles,added,removed)VALUES($3,$1,$2,$4,$5::jsonb,$6::jsonb,$7::jsonb)",
            [
              ...scoped(this.claim),
              crypto.randomUUID(),
              this.claim.id,
              JSON.stringify(after),
              JSON.stringify(
                after.filter((r) => old.get(r.id) !== JSON.stringify(r)),
              ),
              JSON.stringify(
                before.filter((r) => next.get(r.id) !== JSON.stringify(r)),
              ),
            ],
          );
        }
        const result = {
          blob_ids: this.claim.blobIds,
          memory_version: Math.max(
            0,
            ...this.claim.changes.map((c) => c.version ?? 0),
          ),
          profile_ids: [...this.staged.profiles.values()]
            .filter((c) => c.action === "upsert")
            .map((c) => c.id),
          event_ids: eventUpserts.map((c) => c.id),
        };
        assertRunning(this.runtime, 1000);
        const completed = await maintenanceTasks.completeInTx(
          tx,
          this.claim.id,
          this.claim.owner,
          { resultCode: "COMPLETED", result, executionState: null },
        );
        if (!completed)
          fail("maintenance_lease_lost", "Flush expired during commit", true);
        await finishUserLease(tx, lease);
      });
    } finally {
      await releaseUserLease(this.runtime.db, lease).catch(() => {});
    }
  }
}
