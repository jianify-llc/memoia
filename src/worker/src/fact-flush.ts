import {
  runSlice,
  TaskLeaseLost,
  TaskTimeout,
  TaskYield,
} from "@jianify/legato";
import { pythonHash } from "./canonical.js";
import {
  lockUser,
  LeaseLostError,
  type UserScope,
} from "./db.js";
import { ExpiredAppendInputs, SourceError } from "./errors.js";
import { commitFactFlush, getOperation, prepareFactAppend } from "./facts.js";
import { dispatch } from "./maintenance.js";
import { factFlushRetryPolicy, maintenanceTasks } from "./maintenance-task.js";
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
    await lockUser(tx, scope);
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
      return existing;
    }
    const staged = await tx.query(
      `SELECT a.id,a.fact_flush_id,a.status,b.id AS internal_id,b.source_id, a.request->>'maintenance_reasoning_effort' AS maintenance_effort
         FROM memoia.memory_operations a JOIN memoia.memory_blobs b ON b.id=a.blob_id
        WHERE a.user_id=$1 AND a.project_id=$2 AND b.external_id=$3 AND a.kind='append'
          AND a.id=ANY($4::uuid[]) ORDER BY a.created_at,a.id FOR UPDATE OF a`,
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
    // Retention cleanup updates these same locked rows. Check the deadline only after acquiring them.
    const expired = await tx.query<{ id: string }>(
      `SELECT id FROM memoia.memory_operations WHERE id=ANY($1::uuid[])
         AND (input_expires_at IS NULL OR input_expires_at<=clock_timestamp()) ORDER BY id`,
      [appendIds],
    );
    if (expired.rowCount) throw new ExpiredAppendInputs(expired.rows.map(({ id }) => id));
    const blob = staged.rows[0];
    const active = await tx.query(
      `SELECT 1 FROM memoia.memory_operations o JOIN memoia.queue_tasks t ON t.id=o.id
        WHERE o.blob_id=$1 AND o.kind='fact_flush' AND t.status NOT IN ('succeeded','failed','manual')`,
      [blob.internal_id],
    );
    if (active.rowCount)
      throw new SourceError(
        "fact_flush_in_progress",
        "The Blob already has an active Fact flush",
        409,
        true,
      );
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
            maintenance_reasoning_effort:
              staged.rows.at(-1)?.maintenance_effort,
          }),
          blob.source_id,
          blob.internal_id,
        ],
      )
    ).rows[0];
    await tx.query(
      `UPDATE memoia.memory_operations
          SET fact_flush_id=$1, status=CASE WHEN status='staged' THEN 'processing' ELSE status END
        WHERE id=ANY($2::uuid[])`,
      [id, staged.rows.map((row) => row.id)],
    );
    if (
      !(await maintenanceTasks.createInTx(tx, {
        id,
        requestKey: id,
        businessKey: id,
        type: "fact_flush",
        bizParams: {},
      }))
    )
      throw new Error("Fact flush Task could not be registered");
    return row;
  });
  await dispatch(runtime, row);
  return getOperation(runtime, scope, { operationId: row.id });
}

export async function retryFactFlush(runtime: Runtime, scope: UserScope, id: string) {
  const result = await runtime.db.transaction(async (tx) => {
    await lockUser(tx, scope);
    const { rows: [op] } = await tx.query(
      `SELECT id,blob_id,kind,user_id,project_id FROM memoia.memory_operations
       WHERE id=$1 AND user_id=$2 AND project_id=$3 AND kind='fact_flush'`,
      [id, scope.userId, scope.projectId],
    );
    if (!op) throw new SourceError("operation_not_found", "Operation not found", 404);
    const task = await maintenanceTasks.readInTx(tx, id, true);
    if (!task || !["failed", "manual"].includes(task.status) || task.lastFailure?.retryable !== true) return op;
    await tx.query(
      "SELECT id FROM memoia.memory_operations WHERE fact_flush_id=$1 ORDER BY id FOR UPDATE",
      [id],
    );
    const { rows: [range] } = await tx.query(
      `SELECT bool_or(input_expires_at IS NULL OR input_expires_at<=clock_timestamp()) AS expired,
              bool_or(status='failed' AND error->>'retryable' IS DISTINCT FROM 'true') AS rejected
         FROM memoia.memory_operations WHERE fact_flush_id=$1`,
      [id],
    );
    if (range?.expired || range?.rejected) return op;

    // An older failed range can be resumed after a later one has finished. Only one
    // may be active on the Blob so the set of unprocessed inputs is stable in execution.
    const active = await tx.query(
      `SELECT 1 FROM memoia.memory_operations o JOIN memoia.queue_tasks t ON t.id=o.id
        WHERE o.blob_id=$1 AND o.kind='fact_flush' AND o.id<>$2
          AND t.status NOT IN ('succeeded','failed','manual') LIMIT 1`,
      [op.blob_id, id],
    );
    if (active.rowCount)
      throw new SourceError("fact_flush_in_progress", "The Blob already has an active Fact flush", 409, true);
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
    await tx.query(
      `UPDATE memoia.memory_operations SET status='processing',attempts=0,error=NULL,available_at=NULL
        WHERE fact_flush_id=$1 AND status='failed'`,
      [id],
    );
    if (!(await maintenanceTasks.recoverInTx(tx, id))) throw new TaskLeaseLost();
    return op;
  });
  const receipt = await getOperation(runtime, scope, { operationId: id });
  if (receipt.status === "processing") await dispatch(runtime, result);
  return receipt;
}

export async function consumeFactFlush(
  runtime: Runtime,
  message: Extract<Wakeup, { kind: "fact_flush" }>,
) {
  const id = message.operation_id;
  const scope = { userId: message.user_id, projectId: message.project_id };
  const claimed = await runtime.db.transaction(async (tx) => {
    await lockUser(tx, scope);
    const record = (
      await tx.query(
        `SELECT o.request FROM memoia.memory_operations o
       WHERE o.id=$1 AND o.user_id=$2 AND o.project_id=$3 AND o.kind='fact_flush'
         AND NOT EXISTS (SELECT 1 FROM memoia.memory_operations held
           JOIN memoia.queue_tasks t ON t.id=held.id
           WHERE held.user_id=o.user_id AND held.project_id=o.project_id
             AND held.kind='fact_flush' AND t.status='running')`,
        [id, scope.userId, scope.projectId],
      )
    ).rows[0];
    if (!record) return null;
    const task = await maintenanceTasks.claimInTx(tx, id, {
      type: "fact_flush",
    });
    return task?.leaseId && task.startedAt && task.leaseExpiresAt
      ? {
          owner: task.leaseId,
          startedAt: task.startedAt,
          leaseExpiresAt: task.leaseExpiresAt,
          appendIds: record.request.append_operation_ids as string[],
        }
      : null;
  });
  if (!claimed) return;
  const { owner, startedAt, leaseExpiresAt, appendIds } = claimed;
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
          await prepareFactAppend(slice, scope, id, owner, appendId, budget);
        }
        // The normal path checks ownership and inputs in the publication transaction.
        const { rows } = await db.query(
          `SELECT a.id,a.status,a.error, (a.input_expires_at IS NULL OR a.input_expires_at<=clock_timestamp()) AS expired,
                  (a.request->'fact_prepared'->>'input_revision'=coalesce(o.request->>'input_revision','0')) AS ready,
                  least(coalesce(a.available_at,clock_timestamp()),a.input_expires_at) AS next_run_at
             FROM memoia.memory_operations a JOIN memoia.memory_operations o ON o.id=a.fact_flush_id
            WHERE a.fact_flush_id=$1 ORDER BY a.id`,
          [id],
        );
        if (
          rows.length !== appendIds.length ||
          rows.some((row, i) => row.id !== appendIds[i])
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
          await commitFactFlush(slice, scope, id, owner, budget);
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
