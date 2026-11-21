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

export async function claimTask(sql: Sql, id: string, type: "fact_flush" | "maintenance_flush") {
  try {
    return await maintenanceTasks.claimInTx(sql, id, {
      type,
      limit: type === "maintenance_flush" ? maintenanceRetryPolicy.limit : null,
    });
  } catch (error) {
    if ((error as { constraint?: string }).constraint === "uq_memoia_running_task_scope") return null;
    throw error;
  }
}

/** Operation is the public identity; task state is the sole execution truth. */
export function projectFlush(
  row: QueryResultRow,
  task: Pick<TaskRecord<string>, "status" | "result" | "lastFailure" | "runAttempts" | "leaseId" | "leaseExpiresAt" | "nextRunAt">,
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

// Keep receipt metadata in one snapshot, without loading message bodies or checkpoint state.
export const operationReceiptQuery = `
  SELECT o.id,o.kind,o.status,o.source_id,o.blob_id,o.result,o.error,b.external_id,
    CASE WHEN o.kind='flush' THEN
      jsonb_build_object('public_blob_ids',o.request->'public_blob_ids','blob_ids',o.request->'blob_ids')
    END AS request,
    t.status AS task_status,t.result AS task_result,
    jsonb_build_object('resultCode',t.fail_reasons->-1->'resultCode','retryable',t.fail_reasons->-1->'retryable') AS task_last_failure,
    t.run_attempts AS task_attempts,t.lease_id AS task_lease_id,
    t.lease_expires_at AS task_lease_until,t.next_run_at AS task_next_run_at,
    CASE WHEN o.kind='fact_flush' AND t.status IN ('failed','manual') THEN EXISTS (
      SELECT 1 FROM memoia.memory_operations a WHERE a.fact_flush_id=o.id
        AND (a.input_expires_at IS NULL OR a.input_expires_at<=clock_timestamp())
    ) ELSE false END AS task_input_expired
  FROM memoia.memory_operations o
  LEFT JOIN memoia.memory_blobs b ON b.id=o.blob_id AND b.user_id=o.user_id AND b.project_id=o.project_id
  LEFT JOIN memoia.queue_tasks t ON t.id=o.id AND o.kind IN ('flush','fact_flush')`;

export function projectReceipt(row: QueryResultRow): QueryResultRow {
  if (row.kind !== "flush" && row.kind !== "fact_flush") return row;
  if (row.task_status == null) throw new Error("Flush execution task is missing");
  const projected = projectFlush(row, {
    status: row.task_status,
    result: row.task_result,
    lastFailure: row.task_last_failure,
    runAttempts: Number(row.task_attempts),
    leaseId: row.task_lease_id,
    leaseExpiresAt: row.task_lease_until,
    nextRunAt: row.task_next_run_at,
  });
  if (row.task_input_expired && projected.error?.retryable === true)
    projected.error = { code: "input_required", retryable: false };
  return projected;
}

export async function projectOperation(
  tx: Sql,
  row: QueryResultRow,
): Promise<QueryResultRow> {
  if (row.kind !== "flush" && row.kind !== "fact_flush") return row;
  const { rows: [receipt] } = await tx.query(
    operationReceiptQuery + " WHERE o.id=$1 AND o.user_id=$2 AND o.project_id=$3",
    [row.id, row.user_id, row.project_id],
  );
  if (!receipt) throw new Error("Flush operation is missing");
  return { ...row, ...projectReceipt(receipt), request: row.request };
}
