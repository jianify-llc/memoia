import {
  runSlice,
  TaskLeaseLost,
  TaskTimeout,
  TaskYield,
} from "@jianify/legato";
import { pythonHash } from "./canonical.js";
import {
  assertActive,
  LeaseLostError,
  type UserScope,
} from "./db.js";
import { ExpiredAppendInputs, SourceError } from "./errors.js";
import { commitFactFlush, getOperation, prepareFactAppend, publicOperation } from "./facts.js";
import { dispatch } from "./maintenance.js";
import { claimTask, factFlushRetryPolicy, maintenanceTasks, projectFlush, projectOperation } from "./maintenance-task.js";
import { getConfig } from "./models.js";
import type { Runtime, Wakeup } from "./runtime.js";

const MAX_FLUSH_APPENDS = 32;

type FlushInput = { idempotency_key: string; append_operation_ids: string[] };

export async function flushBlob(
  runtime: Runtime,
  scope: UserScope,
  blobId: string,
  input: FlushInput,
) {
  const appendIds = input.append_operation_ids
    .map((id) => id.toLowerCase())
    .sort();
  if (!appendIds.length || appendIds.length > MAX_FLUSH_APPENDS ||
      new Set(appendIds).size !== appendIds.length)
    throw new SourceError(
      "invalid_input",
      `Provide 1 to ${MAX_FLUSH_APPENDS} distinct append operation IDs`,
      422,
    );
  const hash = await pythonHash({
    blob_id: blobId,
    append_operation_ids: appendIds,
  });
  const row = await runtime.db.transaction(async (tx) => {
    const existing = (
      await tx.query(
        "SELECT * FROM memoia.memory_operations WHERE user_id=$1 AND project_id=$2 AND idempotency_key=$3",
        [scope.userId, scope.projectId, input.idempotency_key],
      )
    ).rows[0];
    if (existing) {
      if (existing.kind !== "fact_flush" || existing.request_hash !== hash)
        throw new SourceError(
          "idempotency_conflict",
          "Flush key identifies a different range",
          409,
        );
      return projectOperation(tx, { ...existing, external_id: blobId });
    }
    const staged = await tx.query(
      `SELECT a.id,a.fact_flush_id,a.status,b.id AS internal_id,b.source_id
         FROM memoia.memory_operations a JOIN memoia.memory_blobs b ON b.id=a.blob_id
        WHERE a.user_id=$1 AND a.project_id=$2 AND b.external_id=$3 AND a.kind='append'
          AND a.id=ANY($4::uuid[]) ORDER BY a.created_at,a.id`,
      [scope.userId, scope.projectId, blobId, appendIds],
    );
    if (
      staged.rowCount !== appendIds.length ||
      staged.rows.some(
        (a) => a.fact_flush_id || !["staged", "failed"].includes(a.status),
      )
    )
      throw new SourceError(
        "invalid_fact_flush",
        "Append receipt does not belong to this available Blob range",
        409,
      );
    const blob = staged.rows[0];
    const id = crypto.randomUUID();
    const row = (
      await tx.query(
        `INSERT INTO memoia.memory_operations
        (id,user_id,project_id,idempotency_key,kind,request_hash,request,source_id,blob_id,status)
       VALUES ($1,$2,$3,$4,'fact_flush',$5,$6::jsonb,$7,$8,'processing') RETURNING *`,
        [
          id,
          scope.userId,
          scope.projectId,
          input.idempotency_key,
          hash,
          JSON.stringify({
            append_operation_ids: appendIds,
          }),
          blob.source_id,
          blob.internal_id,
        ],
      )
    ).rows[0];
    const assigned = await tx.query(
      `UPDATE memoia.memory_operations
       SET fact_flush_id=$1,status=CASE WHEN status='staged' THEN 'processing' ELSE status END
       WHERE id=ANY($2::uuid[]) AND fact_flush_id IS NULL AND status IN ('staged','failed')
         AND input_expires_at>clock_timestamp()`,
      [id, appendIds],
    );
    if (assigned.rowCount !== appendIds.length) {
      const expired = await tx.query<{ id: string }>(
        `SELECT id FROM memoia.memory_operations WHERE id=ANY($1::uuid[])
           AND (input_expires_at IS NULL OR input_expires_at<=clock_timestamp()) ORDER BY id`,
        [appendIds],
      );
      if (expired.rowCount) throw new ExpiredAppendInputs(expired.rows.map(({ id }) => id));
      throw new SourceError("invalid_fact_flush", "Append receipt already belongs to a flush", 409);
    }
    const task = await maintenanceTasks.createInTx(tx, {
      id,
      requestKey: id,
      businessKey: id,
      type: "fact_flush",
      userId: scope.userId,
      bizParams: { project_id: scope.projectId, blob_id: blob.internal_id },
    });
    if (!task)
      throw new SourceError("fact_flush_in_progress", "The Blob already has an active Fact flush", 409, true);
    return projectFlush({ ...row, external_id: blobId }, task);
  }).catch(async (error) => {
    if ((error as { constraint?: string }).constraint === "memory_operations_user_id_project_id_idempotency_key_key") {
      const { rows: [existing] } = await runtime.db.query(
        "SELECT * FROM memoia.memory_operations WHERE user_id=$1 AND project_id=$2 AND idempotency_key=$3",
        [scope.userId, scope.projectId, input.idempotency_key],
      );
      if (existing?.kind === "fact_flush" && existing.request_hash === hash)
        return projectOperation(runtime.db, { ...existing, external_id: blobId });
      throw new SourceError("idempotency_conflict", "Flush key identifies a different range", 409);
    }
    throw error;
  });
  if (row.status === "processing") await dispatch(runtime, row);
  return publicOperation(row);
}

export async function retryFactFlush(runtime: Runtime, scope: UserScope, id: string) {
  const result = await runtime.db.transaction(async (tx) => {
    const { rows: [op] } = await tx.query(
      `SELECT id,blob_id,kind,user_id,project_id,request FROM memoia.memory_operations
       WHERE id=$1 AND user_id=$2 AND project_id=$3 AND kind='fact_flush'`,
      [id, scope.userId, scope.projectId],
    );
    if (!op) throw new SourceError("operation_not_found", "Operation not found", 404);
    const task = await maintenanceTasks.readInTx(tx, id);
    if (!task || !["failed", "manual"].includes(task.status) || task.lastFailure?.retryable !== true) return op;
    const { rows: [range] } = await tx.query(
      `SELECT bool_or(input_expires_at IS NULL OR input_expires_at<=clock_timestamp()) AS expired,
              bool_or(status='failed' AND error->>'retryable' IS DISTINCT FROM 'true') AS rejected
         FROM memoia.memory_operations WHERE fact_flush_id=$1`,
      [id],
    );
    if (range?.expired || range?.rejected) return op;

    const valid = await tx.query(
      `UPDATE memoia.memory_operations SET status='processing',generation=coalesce(generation,0)+1,
         attempts=CASE WHEN status='failed' THEN 0 ELSE attempts END,
         error=CASE WHEN status='failed' THEN NULL ELSE error END,
         available_at=CASE WHEN status='failed' THEN NULL ELSE available_at END
       WHERE fact_flush_id=$1 AND input_expires_at>clock_timestamp()
         AND NOT (status='failed' AND error->>'retryable' IS DISTINCT FROM 'true')`,
      [id],
    );
    if (valid.rowCount !== op.request.append_operation_ids.length) throw new TaskLeaseLost();
    // Messages shared with a subsequently committed range may have been processed
    // while this range was failed. Recompute only when that input set can have changed.
    await tx.query(
      `UPDATE memoia.memory_operations SET request=request-'fact_draft'-'fact_review_candidate'-'fact_prepared'
        WHERE fact_flush_id=$1 AND EXISTS (
          SELECT 1 FROM memoia.memory_operations a
          CROSS JOIN LATERAL jsonb_array_elements(a.request->'messages') input
          JOIN memoia.memory_messages m ON m.user_id=a.user_id AND m.project_id=a.project_id
            AND m.source_id=a.source_id AND m.message_id=input->>'message_id' AND m.processed
          WHERE a.fact_flush_id=$1
        )`,
      [id],
    );
    if (!(await maintenanceTasks.recoverInTx(tx, id))) throw new TaskLeaseLost();
    return op;
  }).catch((error) => {
    if ((error as { constraint?: string }).constraint === "uq_memoia_active_fact_blob")
      throw new SourceError("fact_flush_in_progress", "The Blob already has an active Fact flush", 409, true);
    if (error instanceof TaskLeaseLost) return null;
    throw error;
  });
  const receipt = await getOperation(runtime, scope, { operationId: id });
  if (result && receipt.status === "processing") await dispatch(runtime, result);
  return receipt;
}

export async function consumeFactFlush(
  runtime: Runtime,
  message: Extract<Wakeup, { kind: "fact_flush" }>,
) {
  const id = message.operation_id;
  const scope = { userId: message.user_id, projectId: message.project_id };
  const { rows: [record] } = await runtime.db.query(
    "SELECT request FROM memoia.memory_operations WHERE id=$1 AND user_id=$2 AND project_id=$3 AND kind='fact_flush'",
    [id, scope.userId, scope.projectId],
  );
  if (!record) {
    await assertActive(runtime.db, scope);
    return;
  }
  const claimed = await claimTask(runtime.db, id, "fact_flush");
  if (!claimed?.leaseId || !claimed.startedAt || !claimed.leaseExpiresAt) return;
  const { leaseId: owner, startedAt, leaseExpiresAt } = claimed;
  const appendIds = record.request.append_operation_ids as string[];
  const { db } = runtime;
  try {
    await runSlice({
      startedAt,
      leaseExpiresAt,
      signal: runtime.signal,
      renew: () => maintenanceTasks.renewInTx(db, id, owner),
      onTimeout: async () => {
        await maintenanceTasks.revokeInTx(
          db,
          id,
          { code: "fact_flush_timeout", retryable: true },
          factFlushRetryPolicy,
          owner,
        );
      },
      execute: async (budget) => {
        const slice = {
          ...runtime,
          signal: budget.signal,
          deadline: budget.hardDeadlineAt,
        };
        // Each slice shares one project configuration across its appends and model calls.
        let configRead: ReturnType<typeof getConfig> | undefined;
        const readConfig = () =>
          (configRead ??= getConfig(slice, scope.projectId));
        const ready = await runtime.db.query<{ id: string }>(
          `SELECT a.id FROM memoia.memory_operations a JOIN memoia.memory_operations o ON o.id=a.fact_flush_id
            WHERE a.fact_flush_id=$1 AND a.status='processing'
              AND a.input_expires_at>clock_timestamp()
              AND NOT EXISTS (
                SELECT 1 FROM memoia.memory_operations f WHERE f.fact_flush_id=$1
                  AND (f.status='failed' OR f.input_expires_at IS NULL OR f.input_expires_at<=clock_timestamp())
              )
              AND (a.available_at IS NULL OR a.available_at<=clock_timestamp())
              AND a.request->'fact_prepared'->>'input_revision' IS DISTINCT FROM coalesce(o.request->>'input_revision','0')
            ORDER BY a.available_at NULLS FIRST,a.created_at,a.id`,
          [id],
        );
        for (const { id: appendId } of ready.rows) {
          if (budget.shouldYield(30_000)) throw new TaskYield();
          await prepareFactAppend(
            slice,
            scope,
            id,
            owner,
            appendId,
            budget,
            readConfig,
          );
        }
        // The normal path checks ownership and inputs in the publication transaction.
        const { rows } = await db.query(
          `SELECT a.id,a.blob_id,a.status,a.error,a.request->'fact_prepared' AS prepared,
                  a.request->>'maintenance_reasoning_effort' AS maintenance_effort,
                  (a.input_expires_at IS NULL OR a.input_expires_at<=clock_timestamp()) AS expired,
                  (a.request->'fact_prepared'->>'input_revision'=coalesce(o.request->>'input_revision','0')) AS ready,
                  least(coalesce(a.available_at,clock_timestamp()),a.input_expires_at) AS next_run_at
             FROM memoia.memory_operations a JOIN memoia.memory_operations o ON o.id=a.fact_flush_id
            WHERE a.fact_flush_id=$1 ORDER BY a.created_at,a.id`,
          [id],
        );
        if (
          rows.length !== appendIds.length ||
          rows.map((row) => row.id).sort().some((id, i) => id !== appendIds[i])
        )
          throw new SourceError(
            "fact_flush_manifest_mismatch",
            "The sealed append list changed",
            409,
          );
        const failures = rows.filter(
          (row) => row.status === "failed" || row.expired,
        );
        const waiting = rows.filter((row) => !row.ready);
        if (!failures.length && !waiting.length) {
          await commitFactFlush(slice, scope, id, owner, budget, rows.map((row) => ({
            id: row.id, blob_id: row.blob_id, prepared: row.prepared,
            maintenance_effort: row.maintenance_effort,
          })));
          return;
        }
        // Missing input or explicit rejection takes precedence over recoverable failure.
        const failed =
          failures.find(
            (row) => row.expired || row.error?.retryable !== true,
          ) ?? failures[0];
        if (failed) {
          // Permanent rejection clears the payload as well as its expiry.
          const expired =
            failed.expired &&
            !(failed.status === "failed" && failed.error?.retryable === false);
          const task = await maintenanceTasks.failInTx(
            db,
            id,
            owner,
            {
              code: expired
                ? "input_required"
                : (failed.error?.code ?? "fact_flush_failed"),
              retryable: !expired && failed.error?.retryable === true,
              manual: true,
            },
            factFlushRetryPolicy,
          );
          if (!task) throw new TaskLeaseLost();
        } else {
          const next = Math.min(
            ...waiting.map((row) => new Date(row.next_run_at).getTime()),
          );
          if (
            !(await maintenanceTasks.yieldInTx(
              db,
              id,
              owner,
              null,
              new Date(next),
            ))
          )
            throw new TaskLeaseLost();
        }
      },
    });
  } catch (error) {
    if (error instanceof TaskYield || error instanceof LeaseLostError) {
      await maintenanceTasks.yieldInTx(db, id, owner, null);
    } else if (
      !(error instanceof TaskLeaseLost) &&
      !(error instanceof TaskTimeout)
    ) {
      await maintenanceTasks.failInTx(
        db,
        id,
        owner,
        {
          code: error instanceof SourceError ? error.code : "fact_flush_failed",
          retryable:
            !(error instanceof SourceError) ||
            error.code !== "fact_flush_manifest_mismatch",
        },
        factFlushRetryPolicy,
      );
    }
  }
}
