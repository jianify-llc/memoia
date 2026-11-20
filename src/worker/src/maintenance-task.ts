import { TaskRepository, type TaskRecord } from "@jianify/legato";
import type { QueryResultRow } from "pg";
import type { Sql } from "./db.js";

export const maintenanceTasks = new TaskRepository<string>("memoia", "uuid");
export const maintenanceRetryPolicy = {
  limit: 4,
  delays: [5, 15, 60],
} as const;

// Fact input expiry belongs to each Blob. The group still has to run and publish their receipts.
export const factFlushRetryPolicy = {
  limit: null,
  delays: maintenanceRetryPolicy.delays,
} as const;

/** Operation is the public identity; task state is the sole execution truth. */
export function projectFlush(
  row: QueryResultRow,
  task: TaskRecord<string>,
): QueryResultRow {
  const stored = task.status === "succeeded" ? task.result : row.result;
  const result =
    row.kind === "flush" && stored && row.request?.public_blob_ids
      ? { ...stored, blob_ids: row.request.public_blob_ids }
      : stored;
  const status =
    task.status === "succeeded"
      ? "completed"
      : task.status === "failed" || task.status === "manual"
        ? "failed"
        : "processing";
  const failure = task.lastFailure;
  return {
    ...row,
    status,
    attempts: task.runAttempts,
    lease_owner: task.leaseId,
    lease_until: task.leaseExpiresAt,
    available_at: task.nextRunAt,
    result,
    error:
      task.status !== "retry_wait" &&
      task.status !== "failed" &&
      task.status !== "manual"
        ? null
        : failure &&
            typeof failure.resultCode === "string" &&
            typeof failure.retryable === "boolean"
          ? { code: failure.resultCode, retryable: failure.retryable }
          : row.error,
  };
}

export async function projectOperation(
  tx: Sql,
  row: QueryResultRow,
): Promise<QueryResultRow> {
  return (await projectOperations(tx, [row]))[0];
}

export async function projectOperations(
  tx: Sql,
  rows: QueryResultRow[],
): Promise<QueryResultRow[]> {
  const ids = [
    ...new Set(
      rows
        .filter((row) => ["flush", "fact_flush"].includes(row.kind))
        .map((row) => String(row.id)),
    ),
  ];
  const tasks = new Map<string, TaskRecord<string>>();
  for (let offset = 0; offset < ids.length; offset += 500) {
    for (const task of await maintenanceTasks.readManyInTx(
      tx,
      ids.slice(offset, offset + 500),
    ))
      tasks.set(task.id, task);
  }
  const projected = rows.map((row) => {
    if (row.kind !== "flush" && row.kind !== "fact_flush") return row;
    const task = tasks.get(String(row.id));
    if (!task) throw new Error("Flush execution task is missing");
    return projectFlush(row, task);
  });
  const recoverable = projected.filter((row) =>
    row.kind === "fact_flush" && row.status === "failed" && row.error?.retryable === true,
  );
  if (recoverable.length) {
    const expired = await tx.query<{ fact_flush_id: string }>(
      `SELECT DISTINCT fact_flush_id FROM memoia.memory_operations WHERE fact_flush_id=ANY($1::uuid[])
         AND (input_expires_at IS NULL OR input_expires_at<=clock_timestamp())`,
      [recoverable.map((row) => row.id)],
    );
    const ids = new Set(expired.rows.map((row) => row.fact_flush_id));
    for (const row of recoverable) {
      if (ids.has(row.id)) row.error = { code: "input_required", retryable: false };
    }
  }
  return projected;
}
