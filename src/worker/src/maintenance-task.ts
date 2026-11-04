import { TaskRepository, type TaskRecord } from "@jianify/legato";
import type { QueryResultRow } from "pg";
import type { Sql } from "./db.js";

export const maintenanceTasks = new TaskRepository<string>("memoia", "uuid");
export const maintenanceRetryPolicy = {
  limit: 4,
  delays: [5, 15, 60],
} as const;

/** Operation is the public identity; task state is the sole execution truth. */
export function projectFlush(
  row: QueryResultRow,
  task: TaskRecord<string>,
): QueryResultRow {
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
    result: task.status === "succeeded" ? task.result : row.result,
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
      rows.filter((row) => row.kind === "flush").map((row) => String(row.id)),
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
  return rows.map((row) => {
    if (row.kind !== "flush") return row;
    const task = tasks.get(String(row.id));
    if (!task) throw new Error("Flush execution task is missing");
    return projectFlush(row, task);
  });
}
