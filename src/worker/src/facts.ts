import {
  pythonHash,
  pythonJson,
  parseImportMetadata,
  JsonNumber,
} from "./canonical";
import { assertRunning, type Runtime } from "./runtime";
import {
  acquireUserLease,
  assertUserLease,
  finishUserLease,
  releaseUserLease,
  renewUserLease,
  lockIdentity,
  LeaseLostError,
  type UserScope,
  type Sql,
  type UserLease,
} from "./db";
import { embeddings, getConfig } from "./models";
import { recordChanges, notifyUser, progress } from "./maintenance";
import { projectOperation, projectOperations } from "./maintenance-task";
import {
  extractSource,
  validateFactTime,
  type SourceMessage,
} from "./extraction";
import { isIP } from "node:net";
import {
  evidenceTime,
  retainedGroups,
  supportedFactTime,
  renderSearchFact,
  recordingTimeMicros,
} from "./temporal";
import { SourceError } from "./errors";
import { sourceObservations } from "./temporal";
import { readServiceConfig } from "./config";

function inputRetention(runtime: Runtime) {
  return readServiceConfig(runtime.env.MEMOIA_CONFIG)
    .source_input_retention_seconds;
}

function publicOperation(row: any) {
  return {
    operation_id: row.id,
    kind: row.kind,
    status: row.status,
    source_id: row.source_id,
    blob_id: row.blob_id,
    result: row.result,
    error: row.error,
    flush: row.kind === "flush" ? progress(row) : null,
  };
}
export async function getOperation(
  runtime: Runtime,
  scope: UserScope,
  selector: { operationId?: string; key?: string },
) {
  const { rows } = await runtime.db.query(
    "SELECT * FROM memoia.memory_operations WHERE user_id=$1 AND project_id=$2 AND " +
      (selector.operationId ? "id=$3" : "idempotency_key=$3"),
    [scope.userId, scope.projectId, selector.operationId ?? selector.key],
  );
  if (!rows.length)
    throw new SourceError("operation_not_found", "Operation not found", 404);
  return publicOperation(await projectOperation(runtime.db, rows[0]));
}
export async function listSources(
  runtime: Runtime,
  scope: UserScope,
  limit = 50,
  offset = 0,
) {
  const { rows } = await runtime.db.query(
    "SELECT source_id,legacy,created_at FROM memoia.memory_sources WHERE user_id=$1 AND project_id=$2 ORDER BY created_at,source_id LIMIT $3 OFFSET $4",
    [scope.userId, scope.projectId, limit, offset],
  );
  return rows;
}
const blobQuery = `SELECT b.*, o.status AS operation_status FROM memoia.memory_blobs b LEFT JOIN memoia.memory_operations o ON o.blob_id=b.id AND o.kind IN ('import','retract','correct') WHERE b.user_id=$1 AND b.project_id=$2`;
async function publicBlobs(runtime: Runtime, scope: UserScope, rows: any[]) {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const events = await runtime.db.query(
    `SELECT f.blob_id,ef.event_id FROM memoia.memory_facts f JOIN memoia.memory_event_facts ef ON ef.fact_id=f.id AND ef.user_id=f.user_id AND ef.project_id=f.project_id WHERE f.user_id=$1 AND f.project_id=$2 AND f.blob_id=ANY($3::uuid[]) UNION SELECT b.id,b.event_id FROM memoia.memory_blobs b JOIN memoia.user_events e ON e.id=b.event_id AND e.user_id=b.user_id AND e.project_id=b.project_id WHERE b.user_id=$1 AND b.project_id=$2 AND b.id=ANY($3::uuid[]) AND NOT b.event_deleted`,
    [scope.userId, scope.projectId, ids],
  );
  const flushIds = [
    ...new Set(rows.map((row) => row.flush_operation_id).filter(Boolean)),
  ];
  const rawFlushes = flushIds.length
    ? (
        await runtime.db.query(
          "SELECT * FROM memoia.memory_operations WHERE user_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])",
          [scope.userId, scope.projectId, flushIds],
        )
      ).rows
    : [];
  const flushes = await projectOperations(runtime.db, rawFlushes);
  return rows.map((row) => {
    const status = ["processing", "failed"].includes(row.operation_status)
      ? row.operation_status
      : row.status;
    return {
      blob_id: row.id,
      source_id: row.source_id,
      status,
      message_ids: row.message_ids,
      event_ids: ["processing", "failed", "rebuilding"].includes(status)
        ? []
        : [
            ...new Set(
              events.rows
                .filter((e) => e.blob_id === row.id)
                .map((e) => e.event_id),
            ),
          ].sort(),
      created_at: row.created_at,
      kind: row.kind,
      flush: row.flush_operation_id
        ? progress(flushes.find((f) => f.id === row.flush_operation_id)!)
        : null,
    };
  });
}
export async function getBlob(
  runtime: Runtime,
  scope: UserScope,
  blobId: string,
) {
  const { rows } = await runtime.db.query(blobQuery + " AND b.id=$3", [
    scope.userId,
    scope.projectId,
    blobId,
  ]);
  if (!rows.length)
    throw new SourceError("blob_not_found", "Blob not found", 404);
  return (await publicBlobs(runtime, scope, rows))[0];
}
export async function getSource(
  runtime: Runtime,
  scope: UserScope,
  sourceId: string,
  options: {
    limit?: number;
    messageOffset?: number;
    blobOffset?: number;
    evidenceOffset?: number;
  } = {},
) {
  const {
    limit = 50,
    messageOffset = 0,
    blobOffset = 0,
    evidenceOffset = 0,
  } = options;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    [messageOffset, blobOffset, evidenceOffset].some(
      (n) => !Number.isInteger(n) || n < 0,
    )
  )
    throw new SourceError("invalid_pagination", "Invalid source page", 400);
  const params = [scope.userId, scope.projectId, sourceId];
  const [source, messages, blobs, facts] = await Promise.all([
    runtime.db.query(
      "SELECT source_id,legacy,created_at FROM memoia.memory_sources WHERE user_id=$1 AND project_id=$2 AND source_id=$3",
      params,
    ),
    runtime.db.query(
      "SELECT * FROM memoia.memory_messages WHERE user_id=$1 AND project_id=$2 AND source_id=$3 ORDER BY message_id LIMIT $4 OFFSET $5",
      [...params, limit + 1, messageOffset],
    ),
    runtime.db.query(
      blobQuery +
        " AND b.source_id=$3 ORDER BY b.created_at,b.id LIMIT $4 OFFSET $5",
      [...params, limit + 1, blobOffset],
    ),
    runtime.db.query(
      "SELECT f.* FROM memoia.memory_facts f JOIN memoia.memory_blobs b ON b.id=f.blob_id WHERE f.user_id=$1 AND f.project_id=$2 AND b.source_id=$3 ORDER BY f.occurred_at,f.id LIMIT $4 OFFSET $5",
      [...params, limit + 1, evidenceOffset],
    ),
  ]);
  if (!source.rows.length)
    throw new SourceError("source_not_found", "Source not found", 404);
  const selected = facts.rows.slice(0, limit);
  const ids = [...new Set(selected.flatMap((f) => f.support_groups.flat()))];
  const observations = ids.length
    ? (
        await runtime.db.query(
          `SELECT message_id,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') || 'Z' AS occurred_at,time_zone FROM memoia.memory_messages WHERE user_id=$1 AND project_id=$2 AND source_id=$3 AND message_id=ANY($4::text[])`,
          [...params, ids],
        )
      ).rows
    : [];
  return {
    ...source.rows[0],
    message_ids: messages.rows.slice(0, limit).map((m) => m.message_id),
    deleted_message_ids: messages.rows
      .slice(0, limit)
      .filter((m) => m.deleted)
      .map((m) => m.message_id),
    blobs: await publicBlobs(runtime, scope, blobs.rows.slice(0, limit)),
    evidence: selected.map((f) => ({
      fact_id: f.id,
      blob_id: f.blob_id,
      content: f.content,
      topic: f.topic,
      sub_topic: f.sub_topic,
      subject: f.subject,
      reporter: f.reporter,
      certainty: f.certainty,
      revision: Number(f.revision),
      created_at: f.created_at,
      updated_at: f.updated_at,
      support_groups: f.support_groups,
      fact_time: f.fact_time,
      source_messages: sourceObservations(
        f.support_groups,
        observations as any,
      ),
    })),
    next_message_offset:
      messages.rows.length > limit ? messageOffset + limit : null,
    next_blob_offset: blobs.rows.length > limit ? blobOffset + limit : null,
    next_evidence_offset:
      facts.rows.length > limit ? evidenceOffset + limit : null,
  };
}
export async function forgetUser(runtime: Runtime, scope: UserScope) {
  await runtime.db.transaction(async (tx) => {
    await lockIdentity(tx, scope);
    await tx.query(
      "SELECT id FROM memoia.users WHERE id=$1 AND project_id=$2 FOR UPDATE",
      [scope.userId, scope.projectId],
    );
    await tx.query(
      "INSERT INTO memoia.memory_user_tombstones (user_id,project_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [scope.userId, scope.projectId],
    );
    await tx.query("DELETE FROM memoia.users WHERE id=$1 AND project_id=$2", [
      scope.userId,
      scope.projectId,
    ]);
  });
  return { user_id: scope.userId, forgotten: true };
}

export async function getHistory(
  runtime: Runtime,
  scope: UserScope,
  limit = 50,
  offset = 0,
) {
  const { rows } = await runtime.db.query(
    "SELECT * FROM memoia.memory_profile_revisions WHERE user_id=$1 AND project_id=$2 ORDER BY created_at,id LIMIT $3 OFFSET $4",
    [scope.userId, scope.projectId, limit, offset],
  );
  const ids = [
    ...new Set(
      rows.flatMap((r) =>
        ["profiles", "added", "removed"].flatMap((k) =>
          (r[k] ?? []).flatMap((p: any) => [
            ...(p.fact_ids ?? []),
            ...(p._impact_fact_ids ?? []),
          ]),
        ),
      ),
    ),
  ];
  const valid = new Set(
    ids.length
      ? (
          await runtime.db.query(
            "SELECT id::text AS id FROM memoia.memory_facts WHERE user_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])",
            [scope.userId, scope.projectId, ids],
          )
        ).rows.map((r) => r.id)
      : [],
  );
  return rows.map((r) => {
    const fields: Record<string, unknown> = {};
    for (const key of ["profiles", "added", "removed"])
      fields[key] = (r[key] ?? [])
        .filter(
          (p: any) =>
            Array.isArray(p._impact_fact_ids) &&
            [...(p.fact_ids ?? []), ...p._impact_fact_ids].every((id) =>
              valid.has(id),
            ),
        )
        .map(({ _impact_fact_ids, ...p }: any) => p);
    return {
      revision_id: r.id,
      operation_id: r.operation_id,
      source_id: r.source_id,
      maintenance_version:
        r.maintenance_version == null ? null : Number(r.maintenance_version),
      created_at: r.created_at,
      profiles: fields.profiles,
      added: fields.added,
      removed: fields.removed,
    };
  });
}

export async function listOperations(
  runtime: Runtime,
  scope: UserScope,
  limit = 50,
  offset = 0,
) {
  const { rows } = await runtime.db.query(
    "SELECT * FROM memoia.memory_operations WHERE user_id=$1 AND project_id=$2 ORDER BY created_at DESC,id LIMIT $3 OFFSET $4",
    [scope.userId, scope.projectId, limit, offset],
  );
  return (await projectOperations(runtime.db, rows)).map(publicOperation);
}
type ImportInput = {
  idempotency_key: string;
  source_id: string;
  messages: SourceMessage[];
  metadata?: Record<string, unknown>;
};
type DeleteInput = { idempotency_key: string; message_ids: string[] };
type LegacyBuffers = { buffer_ids: string[]; blob_ids: string[] };
const canonical = (v: any): any =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
const hash = pythonHash;
function storedImport(input: ImportInput) {
  return {
    ...input,
    messages: input.messages.map(({ images, ...m }) => ({
      ...m,
      ...(images?.length ? { image_count: images.length } : {}),
    })),
  };
}
function importPayload(input: ImportInput): ImportInput {
  return {
    idempotency_key: input.idempotency_key,
    source_id: input.source_id,
    messages: input.messages.map((m) => {
      const { time_zone, images, ...rest } = m;
      return {
        ...rest,
        occurred_at: normalizedTime(rest.occurred_at),
        ...(time_zone != null ? { time_zone } : {}),
        ...(images?.length ? { images } : {}),
      };
    }),
    metadata: input.metadata ?? {},
  };
}
function normalizedTime(value: string): string {
  const m = /^(.*?)(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!m) return value;
  const micros = (m[2] ?? "").padEnd(6, "0").slice(0, 6);
  const fraction = Number(micros) ? "." + micros : "";
  const zone =
    m[3] === "+00:00" || m[3] === "-00:00" ? "Z" : m[3].toUpperCase();
  return m[1] + fraction + zone;
}
async function messageHash(m: SourceMessage) {
  const date = new Date(m.occurred_at);
  const iso = date.toISOString();
  const match = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/i.exec(m.occurred_at);
  const micros = (match?.[1] ?? "").padEnd(6, "0").slice(0, 6);
  const fraction = Number(micros) ? "." + micros : "";
  const utc = iso.slice(0, 19) + fraction + "+00:00";
  return hash({
    role: m.role,
    content: m.content,
    occurred_at: utc,
    ...(m.images?.length ? { images: m.images } : {}),
  });
}
function canProcess(row: any, explicit = false) {
  return (
    row.status !== "completed" &&
    (row.status !== "failed" ||
      row.error?.retryable ||
      (explicit &&
        (["reconciliation_too_large", "related_facts_too_large"].includes(
          row.error?.code,
        ) ||
          (["import", "correct"].includes(row.kind) &&
            row.error?.code === "input_required"))))
  );
}
async function register(
  runtime: Runtime,
  scope: UserScope,
  kind: "import" | "retract",
  sourceId: string,
  payload: any,
  legacyBuffers?: LegacyBuffers,
  retryReceipt?: { id: string; hash: string },
) {
  const digest = retryReceipt?.hash ?? (await hash({ kind, request: payload }));
  const uid = scope.userId,
    pid = scope.projectId;
  return runtime.db.transaction(async (tx) => {
    await lockIdentity(tx, scope);
    const tomb = await tx.query(
      "SELECT 1 FROM memoia.memory_user_tombstones WHERE user_id=$1 AND project_id=$2",
      [uid, pid],
    );
    if (tomb.rowCount)
      throw new SourceError("user_forgotten", "User has been forgotten", 410);
    await tx.query(
      "INSERT INTO memoia.users (id,project_id,additional_fields) VALUES ($1,$2,'{}'::jsonb) ON CONFLICT (id,project_id) DO NOTHING",
      [uid, pid],
    );
    await tx.query(
      "SELECT id FROM memoia.users WHERE id=$1 AND project_id=$2 FOR UPDATE",
      [uid, pid],
    );
    const prev = await tx.query(
      "SELECT * FROM memoia.memory_operations WHERE user_id=$1 AND project_id=$2 AND idempotency_key=$3 FOR UPDATE",
      [uid, pid, payload.idempotency_key],
    );
    const existing = prev.rows[0];
    if (
      retryReceipt &&
      (!existing ||
        existing.id !== retryReceipt.id ||
        existing.request_hash !== retryReceipt.hash)
    )
      throw new SourceError(
        "write_conflict",
        "Original receipt changed",
        409,
        true,
      );
    if (existing && existing.request_hash !== digest)
      throw new SourceError(
        "idempotency_conflict",
        "Idempotency key was used for a different request",
        409,
      );
    await tx.query(
      "INSERT INTO memoia.memory_sources (user_id,project_id,source_id,legacy) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [uid, pid, sourceId, sourceId.startsWith("v1-flush:")],
    );
    if (kind === "import" && (!existing || existing.status !== "completed")) {
      const messages = payload.messages as SourceMessage[];
      const rows = await tx.query(
        "SELECT message_id,content_hash,time_zone FROM memoia.memory_messages WHERE user_id=$1 AND project_id=$2 AND source_id=$3 AND message_id=ANY($4::text[])",
        [uid, pid, sourceId, messages.map((m) => m.message_id)],
      );
      const known = new Map(rows.rows.map((row) => [row.message_id, row]));
      const inserts: { message: SourceMessage; digest: string }[] = [];
      const enrichments: SourceMessage[] = [];
      for (const m of messages) {
        const digest = await messageHash(m);
        const row = known.get(m.message_id);
        if (
          (row?.content_hash && row.content_hash !== digest) ||
          (row && m.time_zone && row.time_zone && row.time_zone !== m.time_zone)
        )
          throw new SourceError(
            "message_conflict",
            "Message identity has different content, image, role or recording time",
            409,
          );
        if (!row) inserts.push({ message: m, digest });
        else if (!row.time_zone && m.time_zone) enrichments.push(m);
      }
      if (inserts.length)
        await tx.query(
          "INSERT INTO memoia.memory_messages (user_id,project_id,source_id,message_id,content_hash,role,occurred_at,time_zone) SELECT $1,$2,$3,m.* FROM unnest($4::text[],$5::text[],$6::text[],$7::timestamptz[],$8::text[]) AS m(message_id,content_hash,role,occurred_at,time_zone)",
          [
            uid,
            pid,
            sourceId,
            inserts.map(({ message }) => message.message_id),
            inserts.map(({ digest }) => digest),
            inserts.map(({ message }) => message.role),
            inserts.map(({ message }) => message.occurred_at),
            inserts.map(({ message }) => message.time_zone ?? null),
          ],
        );
      if (enrichments.length)
        await tx.query(
          "UPDATE memoia.memory_messages AS target SET time_zone=m.time_zone FROM unnest($4::text[],$5::text[]) AS m(message_id,time_zone) WHERE target.user_id=$1 AND target.project_id=$2 AND target.source_id=$3 AND target.message_id=m.message_id",
          [
            uid,
            pid,
            sourceId,
            enrichments.map((m) => m.message_id),
            enrichments.map((m) => m.time_zone),
          ],
        );
    }
    if (existing) {
      if (
        legacyBuffers &&
        existing.status !== "completed" &&
        !existing.request?.legacy_buffers
      ) {
        existing.request = {
          ...existing.request,
          legacy_buffers: legacyBuffers,
        };
        await tx.query(
          "UPDATE memoia.memory_operations SET request=jsonb_set(request,'{legacy_buffers}',$2::jsonb,true) WHERE id=$1",
          [existing.id, JSON.stringify(legacyBuffers)],
        );
      }
      if (
        kind === "import" &&
        !canProcess(existing) &&
        canProcess(existing, true) &&
        (!existing.input_expires_at ||
          new Date(existing.input_expires_at).getTime() <= Date.now())
      )
        await tx.query(
          "UPDATE memoia.memory_operations SET request=$2::jsonb,input_expires_at=clock_timestamp()+$3::double precision*interval '1 second' WHERE id=$1",
          [
            existing.id,
            pythonJson({
              ...storedImport(payload),
              ...(existing.request?.legacy_buffers
                ? { legacy_buffers: existing.request.legacy_buffers }
                : {}),
            }),
            inputRetention(runtime),
          ],
        );
      return existing;
    }
    const blobId = crypto.randomUUID(),
      opId = crypto.randomUUID();
    const mids =
      kind === "import"
        ? payload.messages.map((m: SourceMessage) => m.message_id)
        : payload.message_ids;
    await tx.query(
      "INSERT INTO memoia.memory_blobs (id,user_id,project_id,source_id,kind,message_ids,status) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)",
      [
        blobId,
        uid,
        pid,
        sourceId,
        kind,
        JSON.stringify(mids),
        kind === "import" ? "active" : "retracted",
      ],
    );
    if (kind === "retract")
      for (const id of mids)
        await tx.query(
          "INSERT INTO memoia.memory_messages (user_id,project_id,source_id,message_id,deleted) VALUES ($1,$2,$3,$4,true) ON CONFLICT DO NOTHING",
          [uid, pid, sourceId, id],
        );
    const saved =
      kind === "import"
        ? {
            ...storedImport(payload),
            ...(legacyBuffers ? { legacy_buffers: legacyBuffers } : {}),
          }
        : payload;
    const result = await tx.query(
      "INSERT INTO memoia.memory_operations (id,user_id,project_id,idempotency_key,kind,request_hash,request,source_id,blob_id,status,input_expires_at) VALUES ($1,$2,$3,$4,$5::varchar,$6,$7::jsonb,$8,$9,'processing',CASE WHEN $5::varchar='import' THEN clock_timestamp()+$10::double precision*interval '1 second' ELSE NULL END) RETURNING *",
      [
        opId,
        uid,
        pid,
        payload.idempotency_key,
        kind,
        digest,
        pythonJson(saved),
        sourceId,
        blobId,
        inputRetention(runtime),
      ],
    );
    return result.rows[0];
  });
}
async function runLeased<T>(
  runtime: Runtime,
  scope: UserScope,
  fn: (lease: UserLease) => Promise<T>,
): Promise<T> {
  const lease = await acquireUserLease(runtime.db, scope, 60_000);
  let renewing: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    renewing = renewing.then(() => renewUserLease(runtime.db, lease, 60_000));
    renewing.catch(() => {});
  }, 20_000);
  try {
    return await fn(lease);
  } finally {
    clearInterval(timer);
    try {
      await renewing;
    } catch {}
    try {
      await releaseUserLease(runtime.db, lease);
    } catch {}
  }
}
async function markFailure(
  runtime: Runtime,
  scope: UserScope,
  op: any,
  lease: UserLease,
  error: unknown,
) {
  if (!(error instanceof SourceError) && !(error instanceof LeaseLostError))
    return;
  const e =
    error instanceof LeaseLostError
      ? new SourceError(
          "lease_lost",
          "Processing ownership was lost",
          409,
          true,
        )
      : error;
  await runtime.db.query(
    "UPDATE memoia.memory_operations SET status='failed',error=$5::jsonb WHERE id=$1 AND user_id=$2 AND project_id=$3 AND generation=$4 AND status<>'completed'",
    [
      op.id,
      scope.userId,
      scope.projectId,
      lease.generation,
      JSON.stringify({ code: e.code, retryable: e.retryable }),
    ],
  );
}
export async function importSource(
  runtime: Runtime,
  scope: UserScope,
  input: ImportInput,
  explicitRetry = false,
  legacyBuffers?: LegacyBuffers,
) {
  return processImport(runtime, scope, input, explicitRetry, legacyBuffers);
}
async function processImport(
  runtime: Runtime,
  scope: UserScope,
  input: ImportInput,
  explicitRetry: boolean,
  legacyBuffers?: LegacyBuffers,
  retryReceipt?: { id: string; hash: string },
) {
  validateImport(input);
  const payload = importPayload(input);
  const op = await register(
    runtime,
    scope,
    "import",
    payload.source_id,
    payload,
    legacyBuffers,
    retryReceipt,
  );
  if (
    !canProcess(
      op,
      explicitRetry || payload.messages.some((m) => m.images?.length),
    )
  )
    return publicOperation(op);
  try {
    return await runLeased(runtime, scope, async (lease) => {
      try {
        const state = await runtime.db.transaction(async (tx) => {
          await assertUserLease(tx, lease);
          const current = (
            await tx.query(
              "SELECT * FROM memoia.memory_operations WHERE id=$1 FOR UPDATE",
              [op.id],
            )
          ).rows[0];
          if (
            !canProcess(
              current,
              explicitRetry || payload.messages.some((m) => m.images?.length),
            )
          )
            return { done: publicOperation(current) };
          const result = await tx.query(
            "SELECT *,occurred_at::text AS occurred_at FROM memoia.memory_messages WHERE user_id=$1 AND project_id=$2 AND source_id=$3 AND message_id=ANY($4::text[])",
            [
              scope.userId,
              scope.projectId,
              payload.source_id,
              payload.messages.map((m) => m.message_id),
            ],
          );
          const known = new Map(
            result.rows.map((row) => [row.message_id, row]),
          );
          const active = payload.messages.filter(
            (m) => !known.get(m.message_id)?.deleted,
          );
          const newIds = new Set(
            active
              .filter((m) => !known.get(m.message_id)?.processed)
              .map((m) => m.message_id),
          );
          const fingerprint = await hash({
            messages: active.map((m) => ({
              ...m,
              time_zone: m.time_zone ?? null,
            })),
            new_ids: [...newIds].sort(),
          });
          const valid =
            current.input_expires_at &&
            new Date(current.input_expires_at).getTime() > Date.now();
          const saved =
            valid &&
            current.request?.fact_review_candidate?.input_fingerprint ===
              fingerprint
              ? current.request.fact_review_candidate
              : null;
          let cleanup: LegacyBuffers | undefined =
            current.request?.legacy_buffers;
          if (
            !cleanup &&
            payload.source_id.startsWith("legacy:") &&
            payload.idempotency_key.startsWith("v1-flush:")
          ) {
            const source = (
              await tx.query(
                "SELECT legacy FROM memoia.memory_sources WHERE user_id=$1 AND project_id=$2 AND source_id=$3",
                [scope.userId, scope.projectId, payload.source_id],
              )
            ).rows[0];
            if (source?.legacy) {
              const ids = payload.messages
                .map((m) => m.message_id.split(":", 1)[0])
                .filter((id) =>
                  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                    id,
                  ),
                );
              if (ids.length) {
                const buffers = (
                  await tx.query(
                    "SELECT id,blob_id FROM memoia.buffer_zones WHERE user_id=$1 AND project_id=$2 AND blob_type='chat' AND blob_id=ANY($3::uuid[])",
                    [scope.userId, scope.projectId, ids],
                  )
                ).rows;
                if (buffers.length)
                  cleanup = {
                    buffer_ids: buffers.map((b) => b.id),
                    blob_ids: [
                      ...new Set(buffers.map((b) => b.blob_id)),
                    ].sort(),
                  };
              }
            }
          }
          const request = {
            ...storedImport(payload),
            ...(cleanup ? { legacy_buffers: cleanup } : {}),
            ...(saved ? { fact_review_candidate: saved } : {}),
          };
          await tx.query(
            "UPDATE memoia.memory_operations SET generation=$2,status='processing',error=NULL,request=$3::jsonb,input_expires_at=CASE WHEN input_expires_at>clock_timestamp() THEN input_expires_at ELSE clock_timestamp()+$4::double precision*interval '1 second' END WHERE id=$1",
            [
              op.id,
              lease.generation,
              pythonJson(request),
              inputRetention(runtime),
            ],
          );
          return {
            active,
            newIds,
            fingerprint,
            candidate: saved?.extraction,
            cleanup,
          };
        });
        if ("done" in state) return state.done!;
        const { active, newIds, fingerprint, candidate, cleanup } = state;
        let extracted = newIds.size
          ? await extractSource(
              { ...runtime, operationId: op.id },
              scope.projectId,
              active,
              candidate,
              async (value) => {
                await runtime.db.transaction(async (tx) => {
                  await assertUserLease(tx, lease);
                  const changed = await tx.query(
                    "UPDATE memoia.memory_operations SET request=jsonb_set(request,'{fact_review_candidate}',$4::jsonb,true) WHERE id=$1 AND generation=$2 AND status='processing' AND input_expires_at>clock_timestamp() AND user_id=$3 RETURNING id",
                    [
                      op.id,
                      lease.generation,
                      scope.userId,
                      JSON.stringify({
                        input_fingerprint: fingerprint,
                        extraction: value,
                      }),
                    ],
                  );
                  if (!changed.rowCount)
                    throw new SourceError(
                      "input_required",
                      "Temporary source input expired",
                      409,
                    );
                });
              },
            )
          : [];
        extracted = extracted
          .map((f) => {
            const groups = f.support_groups.filter((g) =>
              g.some((id) => newIds.has(id)),
            );
            return {
              ...f,
              support_groups: groups,
              ...(groups.length
                ? {
                    occurred_at: evidenceTime(groups, active),
                    fact_time: supportedFactTime(f.fact_time, groups),
                  }
                : {}),
            };
          })
          .filter((f) => f.support_groups.length);
        const config = extracted.length
          ? await getConfig(runtime, scope.projectId)
          : null;
        const vectors = config?.enable_event_embedding
          ? await embeddings(
              runtime,
              scope.projectId,
              extracted.map((f) => renderSearchFact(f.content, f.fact_time)),
            )
          : extracted.map(() => null);
        if (vectors.length !== extracted.length)
          throw new SourceError(
            "embedding_unavailable",
            "Embedding count mismatch",
            503,
            true,
          );
        const result = await runtime.db.transaction(async (tx) => {
          await assertUserLease(tx, lease);
          const version = Number(lease.version) + 1;
          const changes = [];
          for (const [i, f] of extracted.entries()) {
            await tx.query(
              "INSERT INTO memoia.memory_facts (id,user_id,project_id,blob_id,content,subject,reporter,certainty,support_groups,occurred_at,fact_time,search_text,embedding,created_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13::vector,$14)",
              [
                f.id,
                scope.userId,
                scope.projectId,
                op.blob_id,
                f.content,
                f.subject,
                f.reporter,
                f.certainty,
                JSON.stringify(f.support_groups),
                f.occurred_at,
                JSON.stringify(f.fact_time),
                renderSearchFact(f.content, f.fact_time),
                vectors[i] ? `[${vectors[i]!.join(",")}]` : null,
                version,
              ],
            );
            changes.push({ fact_id: f.id, kind: "added" });
          }
          await tx.query(
            "UPDATE memoia.memory_messages SET processed=true WHERE user_id=$1 AND project_id=$2 AND source_id=$3 AND message_id=ANY($4::text[])",
            [scope.userId, scope.projectId, payload.source_id, [...newIds]],
          );
          await tx.query(
            "UPDATE memoia.memory_blobs SET status=$2 WHERE id=$1",
            [op.blob_id, active.length ? "active" : "retracted"],
          );
          const output = {
            event_ids: [],
            profile_ids: [],
            fact_ids: extracted.map((f) => f.id),
            memory_version: version,
          };
          await recordChanges(tx, scope, op.blob_id, version, changes);
          await tx.query(
            "UPDATE memoia.memory_operations SET status='completed',result=$2::jsonb,error=NULL,request=$3::jsonb,input_expires_at=NULL WHERE id=$1",
            [
              op.id,
              JSON.stringify(output),
              JSON.stringify({
                source_id: payload.source_id,
                idempotency_key: payload.idempotency_key,
              }),
            ],
          );
          if (cleanup) {
            await tx.query(
              "UPDATE memoia.buffer_zones SET status='done' WHERE user_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])",
              [scope.userId, scope.projectId, cleanup.buffer_ids],
            );
            await tx.query(
              "DELETE FROM memoia.general_blobs WHERE user_id=$1 AND project_id=$2 AND blob_type='chat' AND id=ANY($3::uuid[])",
              [scope.userId, scope.projectId, cleanup.blob_ids],
            );
          }
          assertRunning(runtime);
          await finishUserLease(tx, lease);
          return output;
        });
        await notifyUser(runtime, scope);
        return {
          ...publicOperation(op),
          status: "completed",
          result,
          error: null,
        };
      } catch (error) {
        await markFailure(runtime, scope, op, lease, error);
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof LeaseLostError)
      return getOperation(runtime, scope, { operationId: op.id });
    throw error;
  }
}
async function scrubHistory(tx: Sql, scope: UserScope, changed: Set<string>) {
  if (!changed.size) return;
  const { rows } = await tx.query(
    "SELECT id,profiles,added,removed FROM memoia.memory_profile_revisions WHERE user_id=$1 AND project_id=$2 FOR UPDATE",
    [scope.userId, scope.projectId],
  );
  for (const row of rows) {
    const fields = ["profiles", "added", "removed"].map((k) =>
      (row[k] ?? []).filter(
        (p: any) =>
          Array.isArray(p._impact_fact_ids) &&
          ![...(p.fact_ids ?? []), ...p._impact_fact_ids].some((id) =>
            changed.has(id),
          ),
      ),
    );
    await tx.query(
      "UPDATE memoia.memory_profile_revisions SET profiles=$2::jsonb,added=$3::jsonb,removed=$4::jsonb WHERE id=$1",
      [row.id, ...fields.map((v) => JSON.stringify(v))],
    );
  }
}
export async function deleteMessages(
  runtime: Runtime,
  scope: UserScope,
  sourceId: string,
  input: DeleteInput,
  explicitRetry = false,
) {
  validateDelete(input);
  const payload = { source_id: sourceId, ...input };
  const op = await register(runtime, scope, "retract", sourceId, payload);
  if (!canProcess(op, explicitRetry)) return publicOperation(op);
  try {
    return await runLeased(runtime, scope, async (lease) => {
      try {
        const snapshot = await runtime.db.transaction(async (tx) => {
          await assertUserLease(tx, lease);
          const current = (
            await tx.query(
              "SELECT * FROM memoia.memory_operations WHERE id=$1 FOR UPDATE",
              [op.id],
            )
          ).rows[0];
          if (!canProcess(current, explicitRetry))
            return { done: publicOperation(current) };
          await tx.query(
            "UPDATE memoia.memory_operations SET status='processing',generation=$2,error=NULL WHERE id=$1",
            [op.id, lease.generation],
          );
          const blobs = (
            await tx.query(
              "SELECT id,message_ids FROM memoia.memory_blobs WHERE user_id=$1 AND project_id=$2 AND source_id=$3 AND message_ids ?| $4::text[]",
              [scope.userId, scope.projectId, sourceId, input.message_ids],
            )
          ).rows;
          const rows = blobs.length
            ? (
                await tx.query(
                  "SELECT * FROM memoia.memory_facts WHERE user_id=$1 AND project_id=$2 AND blob_id=ANY($3::uuid[])",
                  [scope.userId, scope.projectId, blobs.map((b) => b.id)],
                )
              ).rows.filter((f) =>
                f.support_groups.some((g: string[]) =>
                  g.some((id) => input.message_ids.includes(id)),
                ),
              )
            : [];
          const ids = [...new Set(blobs.flatMap((b) => b.message_ids))];
          const messages = ids.length
            ? (
                await tx.query(
                  "SELECT *,occurred_at::text AS occurred_at FROM memoia.memory_messages WHERE user_id=$1 AND project_id=$2 AND source_id=$3 AND message_id=ANY($4::text[])",
                  [scope.userId, scope.projectId, sourceId, ids],
                )
              ).rows
            : [];
          return { blobs, rows, messages };
        });
        if ("done" in snapshot) return snapshot.done!;
        const { blobs, rows, messages } = snapshot;
        const withdrawn = new Set([
          ...messages.filter((m) => m.deleted).map((m) => m.message_id),
          ...input.message_ids,
        ]);
        const removed: any[] = [];
        const surviving: any[] = [];
        const reindex: any[] = [];
        for (const fact of rows) {
          const groups = retainedGroups(fact.support_groups, withdrawn);
          if (!groups.length) {
            removed.push(fact);
            continue;
          }
          const time = supportedFactTime(fact.fact_time, groups);
          const value = {
            ...fact,
            support_groups: groups,
            occurred_at: evidenceTime(groups, messages as any),
            fact_time: time,
            search_text: renderSearchFact(fact.content, time),
          };
          if (
            value.search_text !==
            (fact.search_text ?? renderSearchFact(fact.content, fact.fact_time))
          )
            reindex.push(value);
          surviving.push(value);
        }
        const config = reindex.length
          ? await getConfig(runtime, scope.projectId)
          : null;
        const vectors = config?.enable_event_embedding
          ? await embeddings(
              runtime,
              scope.projectId,
              reindex.map((f) => f.search_text),
            )
          : reindex.map(() => null);
        if (vectors.length !== reindex.length)
          throw new SourceError(
            "embedding_unavailable",
            "Embedding count mismatch",
            503,
            true,
          );
        reindex.forEach((f, i) => {
          f.embedding = vectors[i] ? `[${vectors[i]!.join(",")}]` : null;
        });
        const result = await runtime.db.transaction(async (tx) => {
          await assertUserLease(tx, lease);
          const version = Number(lease.version) + 1;
          for (const id of input.message_ids)
            await tx.query(
              "INSERT INTO memoia.memory_messages (user_id,project_id,source_id,message_id,deleted) VALUES ($1,$2,$3,$4,true) ON CONFLICT (user_id,project_id,source_id,message_id) DO UPDATE SET deleted=true",
              [scope.userId, scope.projectId, sourceId, id],
            );
          if (removed.length)
            await tx.query(
              "DELETE FROM memoia.memory_facts WHERE user_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])",
              [scope.userId, scope.projectId, removed.map((f) => f.id)],
            );
          for (const f of surviving)
            await tx.query(
              "UPDATE memoia.memory_facts SET support_groups=$2::jsonb,occurred_at=$3,fact_time=$4::jsonb,search_text=$5,embedding=$6::vector,revision=revision+1,updated_at=now() WHERE id=$1",
              [
                f.id,
                JSON.stringify(f.support_groups),
                f.occurred_at,
                JSON.stringify(f.fact_time),
                f.search_text,
                f.embedding,
              ],
            );
          await scrubHistory(tx, scope, new Set(rows.map((f) => f.id)));
          for (const b of blobs)
            await tx.query(
              "UPDATE memoia.memory_blobs SET status=$2 WHERE id=$1",
              [
                b.id,
                b.message_ids.every((id: string) => withdrawn.has(id))
                  ? "retracted"
                  : "active",
              ],
            );
          const changes = [
            ...removed.map((f) => ({ fact_id: f.id, kind: "deleted" })),
            ...surviving.map((f) => ({ fact_id: f.id, kind: "evidence" })),
          ];
          await recordChanges(tx, scope, op.blob_id, version, changes);
          const output = {
            event_ids: [],
            profile_ids: [],
            fact_ids: rows.map((f) => f.id),
            memory_version: version,
          };
          await tx.query(
            "UPDATE memoia.memory_operations SET status='completed',result=$2::jsonb,error=NULL WHERE id=$1",
            [op.id, JSON.stringify(output)],
          );
          assertRunning(runtime);
          await finishUserLease(tx, lease);
          return output;
        });
        await notifyUser(runtime, scope);
        return {
          ...publicOperation(op),
          status: "completed",
          result,
          error: null,
        };
      } catch (error) {
        await markFailure(runtime, scope, op, lease, error);
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof LeaseLostError)
      return getOperation(runtime, scope, { operationId: op.id });
    throw error;
  }
}
type CorrectionBase = {
  idempotency_key: string;
  expected_revision: number;
  reason: string;
};
type UpdateInput = CorrectionBase & {
  content: string;
  subject: string;
  reporter: string;
  certainty: "asserted" | "reported" | "uncertain";
  support_groups: string[][];
  fact_time: import("./temporal").FactTime | null;
};
async function registerCorrection(
  runtime: Runtime,
  scope: UserScope,
  factId: string,
  action: "update" | "delete",
  input: CorrectionBase | UpdateInput,
) {
  const payload = { fact_id: factId, action, ...input };
  const fingerprint: any = { ...payload };
  if ("fact_time" in fingerprint) {
    fingerprint.event_time = fingerprint.fact_time;
    delete fingerprint.fact_time;
  }
  const digest = await hash({ kind: "correct", request: fingerprint });
  return runtime.db.transaction(async (tx) => {
    await lockIdentity(tx, scope);
    const user = await tx.query(
      "SELECT id FROM memoia.users WHERE id=$1 AND project_id=$2 FOR UPDATE",
      [scope.userId, scope.projectId],
    );
    if (!user.rowCount)
      throw new SourceError("user_not_found", "User not found", 404);
    const prior = (
      await tx.query(
        "SELECT * FROM memoia.memory_operations WHERE user_id=$1 AND project_id=$2 AND idempotency_key=$3 FOR UPDATE",
        [scope.userId, scope.projectId, input.idempotency_key],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_hash !== digest)
        throw new SourceError(
          "idempotency_conflict",
          "Idempotency key was used for a different request",
          409,
        );
      const expired =
        !prior.input_expires_at ||
        new Date(prior.input_expires_at).getTime() <= Date.now();
      if (expired && prior.status !== "completed") {
        if (prior.status === "processing") {
          prior.status = "failed";
          prior.error = { code: "input_required", retryable: false };
        }
        const restored = canProcess(prior, true);
        const {
          content,
          subject,
          reporter,
          certainty,
          support_groups,
          fact_time,
          ...scrubbed
        } = prior.request;
        const saved = restored
          ? { ...payload, source_id: prior.source_id }
          : scrubbed;
        await tx.query(
          "UPDATE memoia.memory_operations SET status=$3,error=$4::jsonb,request=$2::jsonb,input_expires_at=CASE WHEN $5 THEN clock_timestamp()+$6::double precision*interval '1 second' ELSE NULL END WHERE id=$1",
          [
            prior.id,
            JSON.stringify(saved),
            prior.status,
            JSON.stringify(prior.error),
            restored,
            inputRetention(runtime),
          ],
        );
        if (restored) return { op: prior, restored: true };
      }
      return { op: prior, restored: false };
    }
    const original = (
      await tx.query(
        "SELECT b.source_id,b.message_ids FROM memoia.memory_facts f JOIN memoia.memory_blobs b ON b.id=f.blob_id AND b.user_id=f.user_id AND b.project_id=f.project_id WHERE f.id=$1 AND f.user_id=$2 AND f.project_id=$3",
        [factId, scope.userId, scope.projectId],
      )
    ).rows[0];
    if (!original)
      throw new SourceError("fact_not_found", "Fact not found", 404);
    const blobId = crypto.randomUUID(),
      opId = crypto.randomUUID();
    await tx.query(
      "INSERT INTO memoia.memory_blobs (id,user_id,project_id,source_id,kind,status,message_ids) VALUES ($1,$2,$3,$4,'correct','active',$5::jsonb)",
      [
        blobId,
        scope.userId,
        scope.projectId,
        original.source_id,
        JSON.stringify(original.message_ids),
      ],
    );
    const op = (
      await tx.query(
        "INSERT INTO memoia.memory_operations (id,user_id,project_id,idempotency_key,kind,request_hash,request,source_id,blob_id,status,input_expires_at) VALUES ($1,$2,$3,$4,'correct',$5,$6::jsonb,$7,$8,'processing',clock_timestamp()+$9::double precision*interval '1 second') RETURNING *",
        [
          opId,
          scope.userId,
          scope.projectId,
          input.idempotency_key,
          digest,
          JSON.stringify({ ...payload, source_id: original.source_id }),
          original.source_id,
          blobId,
          inputRetention(runtime),
        ],
      )
    ).rows[0];
    return { op, restored: false };
  });
}
export async function updateFact(
  runtime: Runtime,
  scope: UserScope,
  factId: string,
  input: UpdateInput,
  explicitRetry = false,
) {
  return correctFact(runtime, scope, factId, "update", input, explicitRetry);
}
export async function deleteFact(
  runtime: Runtime,
  scope: UserScope,
  factId: string,
  input: CorrectionBase,
  explicitRetry = false,
) {
  return correctFact(runtime, scope, factId, "delete", input, explicitRetry);
}
async function correctFact(
  runtime: Runtime,
  scope: UserScope,
  factId: string,
  action: "update" | "delete",
  input: CorrectionBase | UpdateInput,
  explicitRetry: boolean,
) {
  validateCorrection(input, action);
  const { op, restored } = await registerCorrection(
    runtime,
    scope,
    factId,
    action,
    input,
  );
  if (
    restored ||
    (op.status === "failed" && !explicitRetry) ||
    !canProcess(op, explicitRetry)
  )
    return publicOperation(op);
  try {
    return await runLeased(runtime, scope, async (lease) => {
      try {
        const snap = await runtime.db.transaction(async (tx) => {
          await assertUserLease(tx, lease);
          const current = (
            await tx.query(
              "SELECT * FROM memoia.memory_operations WHERE id=$1 FOR UPDATE",
              [op.id],
            )
          ).rows[0];
          if (
            (current.status === "failed" && !explicitRetry) ||
            !canProcess(current, explicitRetry)
          )
            return { done: publicOperation(current) };
          const fact = (
            await tx.query(
              "SELECT *,occurred_at::text AS occurred_at FROM memoia.memory_facts WHERE id=$1 AND user_id=$2 AND project_id=$3",
              [factId, scope.userId, scope.projectId],
            )
          ).rows[0];
          const original = fact
            ? (
                await tx.query(
                  "SELECT * FROM memoia.memory_blobs WHERE id=$1",
                  [fact.blob_id],
                )
              ).rows[0]
            : null;
          const messages = original
            ? (
                await tx.query(
                  "SELECT *,occurred_at::text AS occurred_at FROM memoia.memory_messages WHERE user_id=$1 AND project_id=$2 AND source_id=$3 AND message_id=ANY($4::text[])",
                  [
                    scope.userId,
                    scope.projectId,
                    op.source_id,
                    original.message_ids,
                  ],
                )
              ).rows
            : [];
          await tx.query(
            "UPDATE memoia.memory_operations SET status='processing',generation=$2,error=NULL WHERE id=$1",
            [op.id, lease.generation],
          );
          return { fact, original, messages, expiry: current.input_expires_at };
        });
        if ("done" in snap) return snap.done!;
        const { fact, original, messages, expiry } = snap;
        if (!expiry || new Date(expiry).getTime() <= Date.now())
          throw new SourceError(
            "input_required",
            "Temporary correction input expired",
            409,
          );
        if (!fact || !original)
          throw new SourceError("fact_not_found", "Fact not found", 404);
        if (Number(fact.revision) !== input.expected_revision)
          throw new SourceError(
            "fact_revision_conflict",
            "Fact changed; read its current revision before correcting",
            409,
          );
        let value: any = null,
          changed = true;
        if (action === "update") {
          const update = input as UpdateInput;
          const known = new Map(
            messages.filter((m) => !m.deleted).map((m) => [m.message_id, m]),
          );
          if (
            !Array.isArray(update.support_groups) ||
            !update.support_groups.length ||
            update.support_groups.length > 20
          )
            throw new SourceError(
              "invalid_fact_evidence",
              "Invalid evidence groups",
              422,
            );
          const keys = new Set<string>();
          for (const group of update.support_groups) {
            if (
              !Array.isArray(group) ||
              !group.length ||
              new Set(group).size !== group.length ||
              group.some(
                (id) => !original.message_ids.includes(id) || !known.has(id),
              ) ||
              !group.some((id) => known.get(id)?.role === "user")
            )
              throw new SourceError(
                "invalid_fact_evidence",
                "Evidence must use undeleted user messages from the original Blob",
                422,
              );
            const key = JSON.stringify([...group].sort());
            if (keys.has(key))
              throw new SourceError(
                "invalid_fact_evidence",
                "Repeated evidence group",
                422,
              );
            keys.add(key);
          }
          if (
            update.fact_time &&
            !supportedFactTime(update.fact_time, update.support_groups)
          )
            throw new SourceError(
              "invalid_fact_evidence",
              "Time evidence must be jointly supported by a fact evidence group",
              422,
            );
          value = {
            content: update.content,
            subject: update.subject,
            reporter: update.reporter,
            certainty: update.certainty,
            support_groups: update.support_groups,
            fact_time: update.fact_time,
            occurred_at: evidenceTime(update.support_groups, messages as any),
          };
          changed =
            [
              "content",
              "subject",
              "reporter",
              "certainty",
              "support_groups",
              "fact_time",
            ].some(
              (k) =>
                JSON.stringify(canonical(fact[k])) !==
                JSON.stringify(canonical(value[k])),
            ) ||
            recordingTimeMicros(fact.occurred_at) !==
              recordingTimeMicros(value.occurred_at);
          value.search_text = renderSearchFact(value.content, value.fact_time);
          value.embedding = fact.embedding;
          if (
            value.search_text !==
            (fact.search_text ?? renderSearchFact(fact.content, fact.fact_time))
          ) {
            const config = await getConfig(runtime, scope.projectId);
            const vectors = config.enable_event_embedding
              ? await embeddings(runtime, scope.projectId, [value.search_text])
              : [null];
            if (vectors.length !== 1)
              throw new SourceError(
                "embedding_unavailable",
                "Embedding count mismatch",
                503,
                true,
              );
            value.embedding = vectors[0] ? `[${vectors[0].join(",")}]` : null;
          }
        }
        const result = await runtime.db.transaction(async (tx) => {
          await assertUserLease(tx, lease);
          const current = (
            await tx.query(
              "SELECT * FROM memoia.memory_operations WHERE id=$1 AND generation=$2 AND status='processing' AND input_expires_at>clock_timestamp() FOR UPDATE",
              [op.id, lease.generation],
            )
          ).rows[0];
          if (!current)
            throw new SourceError(
              "input_required",
              "Temporary correction input expired or ownership changed",
              409,
            );
          const actual = (
            await tx.query(
              "SELECT revision FROM memoia.memory_facts WHERE id=$1 AND user_id=$2 AND project_id=$3 FOR UPDATE",
              [factId, scope.userId, scope.projectId],
            )
          ).rows[0];
          if (!actual || Number(actual.revision) !== input.expected_revision)
            throw new SourceError(
              "fact_revision_conflict",
              "Fact changed; read its current revision before correcting",
              409,
            );
          const version = Number(lease.version) + (changed ? 1 : 0);
          if (action === "delete")
            await tx.query(
              "DELETE FROM memoia.memory_facts WHERE id=$1 AND user_id=$2 AND project_id=$3",
              [factId, scope.userId, scope.projectId],
            );
          else if (changed)
            await tx.query(
              "UPDATE memoia.memory_facts SET content=$2,subject=$3,reporter=$4,certainty=$5,support_groups=$6::jsonb,fact_time=$7::jsonb,occurred_at=$8,search_text=$9,embedding=$10::vector,revision=revision+1,updated_at=now() WHERE id=$1",
              [
                factId,
                value.content,
                value.subject,
                value.reporter,
                value.certainty,
                JSON.stringify(value.support_groups),
                JSON.stringify(value.fact_time),
                value.occurred_at,
                value.search_text,
                value.embedding,
              ],
            );
          if (changed) await scrubHistory(tx, scope, new Set([factId]));
          const changes = changed
            ? [
                {
                  fact_id: factId,
                  kind: action === "delete" ? "deleted" : "updated",
                },
              ]
            : [];
          await recordChanges(tx, scope, op.blob_id, version, changes);
          const output = {
            event_ids: [],
            profile_ids: [],
            fact_ids: [factId],
            memory_version: version,
          };
          const audit = {
            source_id: op.source_id,
            idempotency_key: input.idempotency_key,
            fact_id: factId,
            action,
            reason: input.reason,
            before_revision: Number(fact.revision),
            after_revision:
              action === "delete"
                ? null
                : Number(fact.revision) + Number(changed),
          };
          await tx.query(
            "UPDATE memoia.memory_operations SET status='completed',result=$2::jsonb,error=NULL,request=$3::jsonb,input_expires_at=NULL WHERE id=$1",
            [op.id, JSON.stringify(output), JSON.stringify(audit)],
          );
          assertRunning(runtime);
          if (changed) await finishUserLease(tx, lease);
          return output;
        });
        await notifyUser(runtime, scope);
        return {
          ...publicOperation(op),
          status: "completed",
          result,
          error: null,
        };
      } catch (error) {
        await markFailure(runtime, scope, op, lease, error);
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof LeaseLostError)
      return getOperation(runtime, scope, { operationId: op.id });
    throw error;
  }
}
export async function purgeExpiredInputs(runtime: Runtime) {
  await runtime.db.transaction(async (tx) => {
    await tx.query(
      "UPDATE memoia.memory_operations SET request=jsonb_build_object('source_id',source_id,'idempotency_key',idempotency_key),input_expires_at=NULL WHERE kind='import' AND input_expires_at<=clock_timestamp()",
    );
    await tx.query(
      "UPDATE memoia.memory_operations SET request=request-'content'-'subject'-'reporter'-'certainty'-'support_groups'-'fact_time',input_expires_at=NULL,error=CASE WHEN status='processing' THEN jsonb_build_object('code','input_required','retryable',false) ELSE error END,status=CASE WHEN status='processing' THEN 'failed' ELSE status END WHERE kind='correct' AND status<>'completed' AND (input_expires_at<=clock_timestamp() OR (input_expires_at IS NULL AND status='processing'))",
    );
    await tx.query(
      "DELETE FROM memoia.general_blobs WHERE blob_type='chat' AND created_at<clock_timestamp()-$1::double precision*interval '1 second'",
      [inputRetention(runtime)],
    );
  });
}
export async function retryOperation(
  runtime: Runtime,
  scope: UserScope,
  operationId: string,
) {
  const op = (
    await runtime.db.query(
      "SELECT *,request::text AS request_text FROM memoia.memory_operations WHERE id=$1 AND user_id=$2 AND project_id=$3",
      [operationId, scope.userId, scope.projectId],
    )
  ).rows[0];
  if (!op)
    throw new SourceError("operation_not_found", "Operation not found", 404);
  if (op.kind === "flush") {
    const { retryFlush } = await import("./maintenance");
    return retryFlush(runtime, scope, operationId);
  }
  if (!canProcess(op, true)) return publicOperation(op);
  if (op.kind === "import" || op.kind === "correct") {
    if (
      !op.input_expires_at ||
      new Date(op.input_expires_at).getTime() <= Date.now()
    ) {
      await purgeExpiredInputs(runtime);
      throw new SourceError(
        "input_required",
        "Temporary input expired; query the receipt and resupply the original request and key",
        409,
      );
    }
  }
  if (op.kind === "import") {
    if (op.request.messages.some((m: any) => m.image_count))
      throw new SourceError(
        "input_required",
        "Image input is not stored; query the receipt and resupply the original batch and key",
        409,
      );
    const { legacy_buffers, fact_review_candidate, ...body } = op.request;
    body.metadata = parseImportMetadata(op.request_text);
    return processImport(runtime, scope, body, true, legacy_buffers, {
      id: op.id,
      hash: op.request_hash,
    });
  }
  if (op.kind === "retract")
    return deleteMessages(
      runtime,
      scope,
      op.source_id,
      {
        idempotency_key: op.request.idempotency_key,
        message_ids: op.request.message_ids,
      },
      true,
    );
  if (op.kind === "correct") {
    const { action, fact_id, source_id, ...body } = op.request;
    if (action === "update")
      return updateFact(runtime, scope, fact_id, body, true);
    if (action === "delete")
      return deleteFact(runtime, scope, fact_id, body, true);
  }
  throw new SourceError(
    "operation_kind_unsupported",
    "Operation kind cannot be retried",
    409,
  );
}

function invalidInput(message: string): never {
  throw new SourceError("invalid_input", message, 422);
}
function validKey(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 255 &&
    !value.includes("/")
  );
}
function publicIp4(host: string): boolean {
  const p = host.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return false;
  const [a, b, c, d] = p;
  if (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  )
    return false;
  if (
    (a === 192 && b === 0 && c === 0 && d !== 9 && d !== 10) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 192 && b === 88 && c === 99)
  )
    return false;
  return true;
}
function publicIp6(host: string): boolean {
  // URL canonicalizes embedded IPv4 to hexadecimal groups.
  const split = host.toLowerCase().split("::");
  if (split.length > 2) return false;
  const left = split[0] ? split[0].split(":") : [];
  const right = split[1] ? split[1].split(":") : [];
  const fill = 8 - left.length - right.length;
  if ((split.length === 1 && fill !== 0) || (split.length === 2 && fill < 1))
    return false;
  const words = [...left, ...Array(fill).fill("0"), ...right].map((x) =>
    parseInt(x, 16),
  );
  if (
    words.length !== 8 ||
    words.some((x) => !Number.isInteger(x) || x < 0 || x > 65535)
  )
    return false;
  const [a, b, c, d, e, f, g, h] = words;
  if (words.slice(0, 5).every((x) => x === 0) && f === 0xffff)
    return publicIp4(`${g >> 8}.${g & 255}.${h >> 8}.${h & 255}`);
  if (words.slice(0, 7).every((x) => x === 0) && (h === 0 || h === 1))
    return false;
  const special2001 = a === 0x2001 && b < 0x200;
  const exception2001 =
    special2001 &&
    ((b === 1 &&
      c === 0 &&
      d === 0 &&
      e === 0 &&
      f === 0 &&
      g === 0 &&
      (h === 1 || h === 2)) ||
      b === 3 ||
      (b === 4 && c === 0x112) ||
      (b >= 0x20 && b <= 0x2f) ||
      (b >= 0x30 && b <= 0x3f));
  if (
    (a & 0xfe00) === 0xfc00 ||
    (a & 0xffc0) === 0xfe80 ||
    (a & 0xff00) === 0xff00 ||
    (a === 0x2001 && b === 0xdb8) ||
    (a === 0x100 && b === 0 && c === 0 && d === 0) ||
    (a === 0x64 && b === 0xff9b && c === 1) ||
    a === 0x2002 ||
    (a === 0x3fff && b < 0x1000) ||
    (special2001 && !exception2001)
  )
    return false;
  return true;
}
function validateImage(
  image: SourceMessage["images"] extends (infer T)[] | undefined ? T : never,
) {
  if (
    !image ||
    typeof image.url !== "string" ||
    image.url.length < 1 ||
    image.url.length > 4096 ||
    /[\u0000-\u0020\\"<>]/.test(image.url)
  )
    invalidInput("Invalid image URL");
  let url: URL;
  try {
    url = new URL(image.url);
  } catch {
    return invalidInput("Invalid image URL");
  }
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !host ||
    url.username ||
    url.password ||
    url.hash ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    (isIP(host) === 4 && !publicIp4(host)) ||
    (isIP(host) === 6 && !publicIp6(host))
  )
    invalidInput("Image URL must be public without credentials or fragment");
  if (
    !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(
      image.mimeType,
    )
  )
    invalidInput("Invalid image attachment");
  const toInteger = (value: number | JsonNumber): bigint => {
    if (
      value instanceof JsonNumber &&
      /^-?\d+$/.test(value.source) &&
      value.source.replace(/^-/, "").length <= 4300
    )
      return BigInt(value.source);
    if (typeof value === "number" && Number.isSafeInteger(value))
      return BigInt(value);
    return invalidInput("Invalid image integer");
  };
  const width = toInteger(image.width),
    height = toInteger(image.height),
    size = toInteger(image.byteSize);
  if (width <= 0n || height <= 0n || size <= 0n || size > 10485760n)
    invalidInput("Invalid image attachment");
}
function validateImport(input: ImportInput) {
  if (
    !input ||
    !validKey(input.idempotency_key) ||
    !validKey(input.source_id) ||
    !Array.isArray(input.messages) ||
    !input.messages.length ||
    input.messages.length > 1000
  )
    invalidInput("Invalid source import");
  const ids = new Set<string>();
  for (const message of input.messages) {
    if (
      !message ||
      typeof message.message_id !== "string" ||
      !message.message_id ||
      message.message_id.length > 255 ||
      ids.has(message.message_id) ||
      !["user", "assistant", "system", "tool"].includes(message.role) ||
      typeof message.content !== "string" ||
      message.content.length > 262144 ||
      typeof message.occurred_at !== "string" ||
      !/(?:Z|[+-]\d{2}:\d{2})$/i.test(message.occurred_at) ||
      !Number.isFinite(Date.parse(message.occurred_at))
    )
      invalidInput("Invalid source message");
    ids.add(message.message_id);
    if (message.time_zone != null) {
      if (
        typeof message.time_zone !== "string" ||
        message.time_zone.length > 100
      )
        invalidInput("Invalid recording timezone");
      try {
        new Intl.DateTimeFormat("en", { timeZone: message.time_zone });
      } catch {
        invalidInput("Invalid recording timezone");
      }
    }
    if (
      message.images !== undefined &&
      (!Array.isArray(message.images) || message.images.length > 1)
    )
      invalidInput("Invalid image attachments");
    for (const image of message.images ?? []) validateImage(image);
    if (!message.content && !message.images?.length)
      invalidInput("Message requires text or an image");
  }
}
function validateDelete(input: DeleteInput) {
  if (
    !input ||
    !validKey(input.idempotency_key) ||
    !Array.isArray(input.message_ids) ||
    !input.message_ids.length ||
    input.message_ids.length > 1000 ||
    new Set(input.message_ids).size !== input.message_ids.length ||
    input.message_ids.some(
      (id) => typeof id !== "string" || !id || id.length > 255,
    )
  )
    invalidInput("Invalid message deletion");
}
function validateCorrection(
  input: CorrectionBase | UpdateInput,
  action: "update" | "delete",
) {
  if (
    !input ||
    !validKey(input.idempotency_key) ||
    !Number.isSafeInteger(input.expected_revision) ||
    input.expected_revision < 1 ||
    typeof input.reason !== "string" ||
    !input.reason ||
    input.reason.length > 1024
  )
    invalidInput("Invalid correction");
  if (action === "delete") return;
  const value = input as UpdateInput;
  if (
    [
      ["content", 4096],
      ["subject", 512],
      ["reporter", 512],
    ].some(
      ([key, max]) =>
        typeof (value as any)[key] !== "string" ||
        !(value as any)[key] ||
        (value as any)[key].length > max,
    ) ||
    !["asserted", "reported", "uncertain"].includes(value.certainty) ||
    !Array.isArray(value.support_groups) ||
    !value.support_groups.length ||
    value.support_groups.length > 20
  )
    invalidInput("Invalid Fact correction");
  const groups = new Set<string>();
  for (const group of value.support_groups) {
    if (
      !Array.isArray(group) ||
      !group.length ||
      group.some((id) => typeof id !== "string" || !id || id.length > 255) ||
      new Set(group).size !== group.length
    )
      invalidInput("Invalid evidence group");
    const key = JSON.stringify([...group].sort());
    if (groups.has(key)) invalidInput("Repeated evidence group");
    groups.add(key);
  }
  try {
    validateFactTime(value.fact_time);
  } catch {
    invalidInput("Invalid Fact time");
  }
}
