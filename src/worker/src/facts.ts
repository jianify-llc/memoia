import type { QueryResultRow } from "pg";
import { HARD_SLICE_MS, type SliceBudget, TaskLeaseLost, TaskYield } from "@jianify/legato";
import {
  pythonHash,
  pythonJson,
} from "./canonical";
import { assertRunning, type Runtime } from "./runtime";
import {
  bumpMemoryVersion,
  isForgottenUser,
  assertActive,
  lockIdentity,
  type UserScope,
  type Sql,
} from "./db";
import { embeddings, getConfig } from "./models";
import { recordChanges, notifyUser, progress } from "./maintenance";
import { operationReceiptQuery, projectReceipt, maintenanceRetryPolicy, maintenanceTasks } from "./maintenance-task";
import { FACT_EVIDENCE_ID_LIMIT, runFactAgent, type Draft as FactDraft } from "./fact-agent";
import {
  evidenceTime,
  validateFactTime,
  type SourceMessage,
  type ExtractedFact,
  validateFacts,
  retainedGroups,
  supportedFactTime,
  renderSearchFact,
  recordingTimeMicros,
} from "./temporal";
import { SourceError } from "./errors";
import { sourceObservations } from "./temporal";
import { readServiceConfig, reasoningEffort, type ReasoningEffort } from "./config";

function inputRetention(runtime: Runtime) {
  return readServiceConfig(runtime.env.MEMOIA_CONFIG)
    .source_input_retention_seconds;
}

export function publicOperation(row: any) {
  return {
    operation_id: row.id,
    kind: row.kind,
    status: row.status,
    source_id: row.source_id,
    blob_id: row.external_id ?? row.blob_id,
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
    operationReceiptQuery + " WHERE o.user_id=$1 AND o.project_id=$2 AND " +
      (selector.operationId ? "o.id=$3" : "o.idempotency_key=$3"),
    [scope.userId, scope.projectId, selector.operationId ?? selector.key],
  );
  if (!rows.length)
    throw new SourceError("operation_not_found", "Operation not found", 404);
  return publicOperation(projectReceipt(rows[0]));
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
          operationReceiptQuery + " WHERE o.user_id=$1 AND o.project_id=$2 AND o.id=ANY($3::uuid[])",
          [scope.userId, scope.projectId, flushIds],
        )
      ).rows
    : [];
  const flushes = new Map(rawFlushes.map((row) => [row.id, progress(projectReceipt(row))]));
  return rows.map((row) => {
    const status = ["processing", "failed"].includes(row.operation_status)
      ? row.operation_status
      : row.status;
    return {
      blob_id: row.external_id ?? row.id,
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
      flush: flushes.get(row.flush_operation_id) ?? null,
    };
  });
}
export async function getBlob(
  runtime: Runtime,
  scope: UserScope,
  blobId: string,
) {
  const { rows } = await runtime.db.query(blobQuery + " AND (b.external_id=$3 OR (b.external_id IS NULL AND b.id::text=lower($3)))", [
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
      `SELECT message_id,deleted FROM memoia.memory_messages WHERE user_id=$1 AND project_id=$2 AND source_id=$3
       UNION
       SELECT item.message_id,true FROM memoia.memory_operations o
       CROSS JOIN LATERAL jsonb_array_elements_text(o.request->'message_ids') AS item(message_id)
       WHERE o.user_id=$1 AND o.project_id=$2 AND o.source_id=$3 AND o.kind='retract' AND o.status='completed'
         AND NOT EXISTS (SELECT 1 FROM memoia.memory_messages m
           WHERE m.user_id=$1 AND m.project_id=$2 AND m.source_id=$3 AND m.message_id=item.message_id)
       ORDER BY message_id LIMIT $4 OFFSET $5`,
      [...params, limit + 1, messageOffset],
    ),
    runtime.db.query(
      blobQuery +
        " AND b.source_id=$3 ORDER BY b.created_at,b.id LIMIT $4 OFFSET $5",
      [...params, limit + 1, blobOffset],
    ),
    runtime.db.query(
      "SELECT f.*,b.external_id FROM memoia.memory_facts f JOIN memoia.memory_blobs b ON b.id=f.blob_id WHERE f.user_id=$1 AND f.project_id=$2 AND b.source_id=$3 ORDER BY f.occurred_at,f.id LIMIT $4 OFFSET $5",
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
      blob_id: f.external_id ?? f.blob_id,
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
      `INSERT INTO memoia.users (id,project_id)
       SELECT $1::uuid,$2::varchar WHERE NOT EXISTS (
         SELECT 1 FROM memoia.memory_user_tombstones WHERE user_id=$1 AND project_id=$2)
       ON CONFLICT (id,project_id) DO NOTHING`,
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
            ...Object.keys(p._fact_revisions ?? {}),
          ]),
        ),
      ),
    ),
  ];
  const valid = new Map(
    ids.length
      ? (
          await runtime.db.query(
            "SELECT id::text AS id,revision FROM memoia.memory_facts WHERE user_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])",
            [scope.userId, scope.projectId, ids],
          )
        ).rows.map((r) => [r.id, String(r.revision)] as const)
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
            ) &&
            Object.entries(p._fact_revisions ?? {}).every(([id, revision]) =>
              valid.get(id) === String(revision),
            ),
        )
        .map(({ _impact_fact_ids, _fact_revisions, ...p }: any) => p);
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
    operationReceiptQuery + " WHERE o.user_id=$1 AND o.project_id=$2 ORDER BY o.created_at DESC,o.id LIMIT $3 OFFSET $4",
    [scope.userId, scope.projectId, limit, offset],
  );
  return rows.map((row) => publicOperation(projectReceipt(row)));
}
export type ImportInput = {
  idempotency_key: string;
  source_id: string;
  messages: SourceMessage[];
  metadata?: Record<string, unknown>;
  maintenance_reasoning_effort?: ReasoningEffort;
};
type DeleteInput = { idempotency_key: string; message_ids: string[] };
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
function importPayload(input: ImportInput): ImportInput {
  return {
    idempotency_key: input.idempotency_key,
    source_id: input.source_id,
    messages: input.messages.map((m) => {
      const { time_zone, ...rest } = m;
      return {
        ...rest,
        occurred_at: normalizedTime(rest.occurred_at),
        ...(time_zone != null ? { time_zone } : {}),
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
  });
}
async function memoryVersion(db: Sql, scope: UserScope) {
  const { rows: [row] } = await db.query<{ version: string }>(
    "SELECT version FROM memoia.memory_user_states WHERE user_id=$1 AND project_id=$2",
    [scope.userId, scope.projectId],
  );
  return Number(row?.version ?? 0);
}

async function readRegistration(sql: Sql, scope: UserScope, key: string, kind: string, digest: string) {
  const { rows: [existing] } = await sql.query(
    "SELECT id,kind,status,source_id,blob_id,result,error,request_hash FROM memoia.memory_operations WHERE user_id=$1 AND project_id=$2 AND idempotency_key=$3",
    [scope.userId, scope.projectId, key],
  );
  if (existing && (existing.kind !== kind || existing.request_hash !== digest))
    throw new SourceError("idempotency_conflict", "Idempotency key was used for a different request", 409);
  return existing;
}

async function ensureSource(sql: Sql, scope: UserScope, sourceId: string) {
  const args = [scope.userId, scope.projectId];
  await sql.query(
    "INSERT INTO memoia.users (id,project_id,additional_fields) VALUES ($1,$2,'{}'::jsonb) ON CONFLICT DO NOTHING",
    args,
  );
  await sql.query(
    "INSERT INTO memoia.memory_sources (user_id,project_id,source_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
    [...args, sourceId],
  );
}

async function checkForgottenUser(db: Sql, scope: UserScope, error: unknown) {
  if (isForgottenUser(error) || ((error as { code?: string }).code === "23503" && (await db.query(
    "SELECT 1 FROM memoia.memory_user_tombstones WHERE user_id=$1 AND project_id=$2",
    [scope.userId, scope.projectId],
  )).rowCount))
    throw new SourceError("user_forgotten", "User has been forgotten", 410);
}

type FactChange = { kind: "retract" | "correct"; key: string; digest: string };

async function submitFactChange(
  runtime: Runtime,
  scope: UserScope,
  change: FactChange,
  write: (prior: QueryResultRow | undefined) => Promise<QueryResultRow>,
) {
  const read = () => readRegistration(runtime.db, scope, change.key, change.kind, change.digest);
  const prior = await read();
  if (prior?.status === "completed") return publicOperation(prior);
  try {
    return publicOperation(await write(prior));
  } catch (error) {
    if (error instanceof SourceError && [
      "fact_not_found", "fact_revision_conflict", "write_conflict", "idempotency_conflict",
    ].includes(error.code)) {
      const receipt = await read();
      if (receipt?.status === "completed") return publicOperation(receipt);
    }
    await checkForgottenUser(runtime.db, scope, error);
    throw error;
  }
}

async function completeFactChange(
  tx: Sql,
  scope: UserScope,
  change: FactChange,
  receipt: {
    prior?: QueryResultRow;
    sourceId: string;
    messageIds: string[];
    audit: object;
    result: { memory_version: number };
    changes: { fact_id: string; kind: "updated" | "deleted" | "evidence" }[];
  },
) {
  const { prior, sourceId, messageIds, audit, result, changes } = receipt;
  const blobId = prior?.blob_id ?? crypto.randomUUID();
  if (!prior) {
    await tx.query(
      `INSERT INTO memoia.memory_blobs (id,user_id,project_id,source_id,kind,message_ids,status)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [blobId, scope.userId, scope.projectId, sourceId, change.kind, JSON.stringify(messageIds),
        change.kind === "retract" ? "retracted" : "active"],
    );
  }
  if (changes.length) await recordChanges(tx, scope, blobId, result.memory_version, changes);
  const { rows: [completed] } = await tx.query(
    `INSERT INTO memoia.memory_operations AS old
       (id,user_id,project_id,idempotency_key,kind,request_hash,request,source_id,blob_id,status,result)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,'completed',$10::jsonb)
     ON CONFLICT (user_id,project_id,idempotency_key) DO UPDATE
       SET status='completed',result=excluded.result,request=excluded.request,error=NULL,input_expires_at=NULL
     WHERE old.status<>'completed' AND old.id=excluded.id AND old.kind=excluded.kind
       AND old.request_hash=excluded.request_hash
     RETURNING id,kind,status,source_id,blob_id,result,error`,
    [prior?.id ?? crypto.randomUUID(), scope.userId, scope.projectId, change.key, change.kind,
      change.digest, pythonJson(audit), sourceId, blobId, JSON.stringify(result)],
  );
  if (!completed)
    throw new SourceError("idempotency_conflict", "Operation already committed or key used for another request", 409);
  return completed;
}

export async function stageImport(runtime: Runtime, scope: UserScope, input: ImportInput) {
  validateImport(input);
  try {
    return await appendImport(runtime, scope, input);
  } catch (error) {
    await checkForgottenUser(runtime.db, scope, error);
    throw error;
  }
}

async function appendImport(runtime: Runtime, scope: UserScope, input: ImportInput) {
  const payload = importPayload(input);
  const { db } = runtime;
  const { source_id: sourceId, idempotency_key: key, messages } = payload;
  const digest = await hash({ kind: "append", request: payload });
  const prior = await readRegistration(db, scope, key, "append", digest);
  if (prior) return publicOperation({ ...prior, external_id: sourceId });

  await ensureSource(db, scope, sourceId);
  const scopeArgs = [scope.userId, scope.projectId, sourceId];
  const ids = messages.map((m) => m.message_id);
  const hashes = await Promise.all(messages.map(messageHash));
  const known = (await db.query(
    "SELECT message_id,content_hash,time_zone,deleted,processed FROM memoia.memory_messages WHERE user_id=$1 AND project_id=$2 AND source_id=$3 AND message_id=ANY($4::text[])",
    [...scopeArgs, ids],
  )).rows;
  const knownById = new Map(known.map((row) => [row.message_id, row]));
  const conflict = () => new SourceError(
    "message_conflict", "Message identity has different content, visual description, role or recording time", 409,
  );
  const novel: SourceMessage[] = [];
  const changed: { message: SourceMessage; hash: string }[] = [];
  let hasLiveInput = false;
  messages.forEach((message, index) => {
    const row = knownById.get(message.message_id);
    if ((row?.content_hash && row.content_hash !== hashes[index]) ||
        (row?.time_zone && message.time_zone && row.time_zone !== message.time_zone))
      throw conflict();
    if (!row?.deleted) {
      hasLiveInput = true;
      if (!row?.processed) novel.push(message);
    }
    if (!row || (!row.deleted && !row.processed) || (!row.time_zone && message.time_zone))
      changed.push({ message, hash: hashes[index] });
  });
  const saved = {
    ...payload, messages: novel,
    ...(input.maintenance_reasoning_effort === undefined ? {} :
      { maintenance_reasoning_effort: input.maintenance_reasoning_effort }),
  };
  // Persist pending input alongside the message identities it refers to. A
  // concurrent retract either removes both or finishes before this append.
  const { rows: [registration] } = await db.query(
    `WITH messages AS (
       INSERT INTO memoia.memory_messages AS target
         (user_id,project_id,source_id,message_id,content_hash,role,occurred_at,time_zone)
       SELECT $1,$2,$3,m.* FROM unnest($4::text[],$5::text[],$6::text[],$7::timestamptz[],$8::text[]) m(message_id,content_hash,role,occurred_at,time_zone)
       ORDER BY m.message_id
       ON CONFLICT (user_id,project_id,source_id,message_id) DO UPDATE SET
         time_zone=coalesce(target.time_zone,excluded.time_zone)
       WHERE (target.content_hash IS NULL OR target.content_hash=excluded.content_hash)
         AND (target.time_zone IS NULL OR excluded.time_zone IS NULL OR target.time_zone=excluded.time_zone)
       RETURNING message_id,processed,deleted
     ), blob AS (
       INSERT INTO memoia.memory_blobs AS b
         (id,user_id,project_id,source_id,kind,message_ids,status,external_id)
       SELECT $9,$1,$2,$3,'import',$10::jsonb,$11,$3
       WHERE (SELECT count(*) FROM messages)=cardinality($4)
       ON CONFLICT (user_id,project_id,external_id) WHERE external_id IS NOT NULL
       DO UPDATE SET status=CASE WHEN EXCLUDED.status='active' THEN 'active' ELSE b.status END,message_ids=(
         SELECT jsonb_agg(value ORDER BY position) FROM (
           SELECT value,min(ordinality) AS position
           FROM jsonb_array_elements(b.message_ids || EXCLUDED.message_ids) WITH ORDINALITY
           GROUP BY value
         ) ids
       )
       RETURNING id
     ), operation AS (
       INSERT INTO memoia.memory_operations
         (id,user_id,project_id,idempotency_key,kind,request_hash,request,source_id,blob_id,status,input_expires_at)
       SELECT $12,$1,$2,$13,'append',$14,jsonb_set($15::jsonb,'{messages}',(
           SELECT coalesce(jsonb_agg(input.message ORDER BY input.position),'[]'::jsonb)
           FROM jsonb_array_elements($15::jsonb->'messages') WITH ORDINALITY input(message,position)
           JOIN messages m ON m.message_id=input.message->>'message_id' AND NOT m.processed AND NOT m.deleted
         )),$3,blob.id,'staged',clock_timestamp()+$16::double precision*interval '1 second'
       FROM blob
       ON CONFLICT (user_id,project_id,idempotency_key) DO NOTHING
       RETURNING id,kind,status,source_id,blob_id,result,error
     )
     SELECT EXISTS(SELECT 1 FROM blob) AS accepted,(SELECT to_jsonb(o) FROM operation o) AS receipt`,
    [...scopeArgs, changed.map(({ message }) => message.message_id), changed.map(({ hash }) => hash),
      changed.map(({ message }) => message.role), changed.map(({ message }) => message.occurred_at),
      changed.map(({ message }) => message.time_zone ?? null), crypto.randomUUID(),
      JSON.stringify(ids), hasLiveInput ? "active" : "retracted", crypto.randomUUID(),
      key, digest, pythonJson(saved), inputRetention(runtime)],
  );
  if (!registration.accepted) throw conflict();
  const op = registration.receipt;
  const receipt = op ?? await readRegistration(db, scope, key, "append", digest);
  if (!receipt) throw new SourceError("user_not_found", "User not found", 404);
  return publicOperation({ ...receipt, external_id: sourceId });
}

async function insertFacts(
  tx: Sql,
  scope: UserScope,
  blobId: string,
  version: number,
  facts: ExtractedFact[],
  vectors: (number[] | null)[],
) {
  if (facts.length) await tx.query(
    `INSERT INTO memoia.memory_facts
       (id,user_id,project_id,blob_id,content,subject,reporter,certainty,support_groups,occurred_at,fact_time,search_text,embedding,created_version)
     SELECT f.id,$1,$2,$3,f.content,f.subject,f.reporter,f.certainty,f.support_groups,
            f.occurred_at,nullif(f.fact_time,'null'::jsonb),f.search_text,f.embedding,$4
       FROM jsonb_populate_recordset(NULL::memoia.memory_facts,$5::jsonb) AS f`,
    [scope.userId, scope.projectId, blobId, version, JSON.stringify(facts.map((fact, i) => ({
      ...fact,
      search_text: renderSearchFact(fact.content, fact.fact_time),
      embedding: vectors[i] ? `[${vectors[i]!.join(",")}]` : null,
    })))],
  );
  return facts.map((f) => ({ fact_id: f.id, kind: "added" as const }));
}
type PreparedAppend = {
  input_revision: string;
  facts: ExtractedFact[];
  vectors: (number[] | null)[];
};

type MessageSearch = { ids: string[] | null; query: string | null; offset: number };

// Filtering by ID before expansion keeps the relative position and the first
// eligible copy across append receipts. Full scans use the ordinary array iterator.
function pendingInputs(ids?: "$2" | "$5") {
  const messages = ids
    ? `jsonb_path_query(a.request->'messages', '$[*] ? (@.message_id == $ids[*])',
        jsonb_build_object('ids', ${ids}::text[]))`
    : "jsonb_array_elements(a.request->'messages')";
  return `WITH inputs AS (
  SELECT DISTINCT ON (m.message_id) a.id AS append_id,a.created_at,a.user_id,a.project_id,a.source_id,
    m.message_id,input.message,input.position
  FROM memoia.memory_operations a
  CROSS JOIN LATERAL ${messages} WITH ORDINALITY AS input(message, position)
  JOIN memoia.memory_messages m ON m.user_id=a.user_id AND m.project_id=a.project_id
    AND m.source_id=a.source_id AND m.message_id=input.message->>'message_id'
  WHERE a.fact_flush_id=$1 AND a.status='processing' AND a.input_expires_at>clock_timestamp()
    AND NOT m.deleted AND NOT m.processed
  ORDER BY m.message_id,a.created_at,a.id,input.position
)`;
}

export async function prepareFactAppend(
  runtime: Runtime,
  scope: UserScope,
  flushId: string,
  owner: string,
  appendId: string,
  budget: SliceBudget,
  readConfig: () => ReturnType<typeof getConfig>,
): Promise<void> {
  // Load the checkpoint and its primary input together. A reviewed revision
  // only needs its candidate, and a prepared revision needs no input at all.
  const { rows: [op] } = await runtime.db.query<{
    attempts: number;
    generation: number | string | null;
    input_revision: string;
    reviewed: { input_revision: string; facts: PreparedAppend["facts"] } | null;
    draft: { input_revision: string; draft: FactDraft; evidenceIds: string[] } | null;
    messages: SourceMessage[] | null;
  }>(
    `WITH append AS (
       SELECT o.attempts,o.generation,coalesce(f.request->>'input_revision','0') AS input_revision,
         o.request->'fact_prepared'->'input_revision' AS prepared_revision,
         o.request->'fact_review_candidate' AS reviewed,o.request->'fact_draft' AS draft
       FROM memoia.memory_operations o JOIN memoia.memory_operations f ON f.id=o.fact_flush_id
       WHERE o.id=$2 AND o.user_id=$3 AND o.project_id=$4 AND o.fact_flush_id=$1
         AND o.status='processing' AND o.input_expires_at>clock_timestamp()
     )
     SELECT attempts,generation,input_revision,reviewed,draft,
       CASE WHEN reviewed->'input_revision' IS DISTINCT FROM to_jsonb(input_revision)
         THEN ARRAY(${pendingInputs()} SELECT message FROM inputs WHERE append_id=$2 ORDER BY position)
       END AS messages
     FROM append WHERE prepared_revision IS DISTINCT FROM to_jsonb(input_revision)`,
    [flushId, appendId, scope.userId, scope.projectId],
  );
  if (!op) return;
  const activeInput = `SELECT 1 FROM memoia.memory_operations o
    JOIN memoia.memory_operations f ON f.id=o.fact_flush_id JOIN memoia.queue_tasks t ON t.id=o.fact_flush_id
    WHERE t.id=$1 AND o.id=$2 AND t.status='running' AND t.lease_id=$3
      AND t.lease_expires_at>clock_timestamp() AND coalesce(f.request->>'input_revision','0')=$4
      AND o.status='processing' AND o.input_expires_at>clock_timestamp()`;
  const inputIdentity = [flushId, appendId, owner, op.input_revision];
  const messagesFor = async (filter: MessageSearch) => {
    budget.assertActive();
    // The lease and revision gate the source read in the same database snapshot.
    const { rows: [page] } = await runtime.db.query<{ messages: SourceMessage[] }>(
      `SELECT ARRAY(${pendingInputs(filter.ids ? "$5" : undefined)} SELECT message FROM inputs
       WHERE ($5::text[] IS NULL OR message_id=ANY($5))
         AND ($6::text IS NULL OR strpos(lower(message->>'content'),lower($6))>0
              OR strpos(lower(message->>'visual_description'),lower($6))>0)
       ORDER BY created_at,append_id,position LIMIT 11 OFFSET $7) AS messages
       WHERE EXISTS (${activeInput})`,
      [...inputIdentity, filter.ids, filter.query, filter.offset],
    );
    if (!page) throw new TaskYield();
    return { messages: page.messages.slice(0, 10),
      next_offset: page.messages.length === 11 ? filter.offset + 10 : null };
  };
  const evidenceById = async (ids: string[]) => {
    if (!ids.length) return [];
    const idFilter = ids.length <= FACT_EVIDENCE_ID_LIMIT ? "$2" : undefined;
    return (await runtime.db.query<{ message: SourceMessage }>(
      `${pendingInputs(idFilter)} SELECT message FROM inputs WHERE message_id=ANY($2::text[])`,
      [flushId, ids],
    )).rows.map((r) => r.message);
  };
  const assertFactInput = async () => budget.assertActive();
  const updateAppend = (assignment: string, values: unknown[]) => {
    budget.assertActive();
    return runtime.db.query(
      `UPDATE memoia.memory_operations o SET ${assignment}
       FROM memoia.memory_operations f JOIN memoia.queue_tasks t ON t.id=f.id
       WHERE f.id=$3 AND f.user_id=$2 AND f.project_id=$1
         AND t.status='running' AND t.lease_id=$4
         AND o.id=$5 AND o.fact_flush_id=f.id AND o.user_id=$2 AND o.project_id=$1
         AND o.status='processing' AND o.input_expires_at>clock_timestamp()
         AND coalesce(f.request->>'input_revision','0')=$6
         AND o.generation IS NOT DISTINCT FROM $${values.length + 7}::bigint
         AND t.lease_expires_at>clock_timestamp()
         AND t.started_at+${HARD_SLICE_MS}*interval '1 millisecond'>clock_timestamp()`,
      [scope.projectId, scope.userId, flushId, owner, appendId, op.input_revision, ...values, op.generation],
    );
  };
  const save = async (key: string, value: object) => {
    const changed = await updateAppend(
      "request=jsonb_set(o.request,ARRAY[$7::text],$8::jsonb),error=NULL,available_at=NULL",
      [key, JSON.stringify({ ...value, input_revision: op.input_revision })],
    );
    if (!changed.rowCount) throw new TaskYield();
  };
  try {
    const operationRuntime = { ...runtime, operationId: appendId };
    const stored = op.reviewed;
    const staged = op.draft;
    const usableDraft = staged?.input_revision === op.input_revision ? staged : null;
    let extracted: ExtractedFact[];
    if (stored?.input_revision === op.input_revision) extracted = stored.facts;
    else {
      const facts = await runFactAgent(
        operationRuntime,
        scope,
        op.messages ?? [],
        budget,
        usableDraft?.draft ?? null,
        (draft, evidenceIds) => save("fact_draft", { draft, evidenceIds }),
        assertFactInput,
        {
          search: messagesFor,
          previousEvidence: await evidenceById(usableDraft?.evidenceIds ?? []),
          readConfig,
        },
      );
      const evidence = await evidenceById([...new Set(facts.flatMap((fact) => fact.support_groups.flat()))]);
      await assertFactInput();
      extracted = validateFacts({ facts }, evidence).map((fact) => ({
        ...fact, id: crypto.randomUUID(), occurred_at: evidenceTime(fact.support_groups, evidence),
      }));
      await save("fact_review_candidate", { facts: extracted });
    }
    if (budget.shouldYield(30_000)) throw new TaskYield();
    const config = extracted.length ? await readConfig() : null;
    let vectors: (number[] | null)[] = extracted.map(() => null);
    if (config?.enable_event_embedding) {
      await assertFactInput();
      vectors = await embeddings(
        { ...operationRuntime, deadline: budget.softDeadlineAt - 15_000 },
        scope.projectId,
        extracted.map((f) => renderSearchFact(f.content, f.fact_time)),
        "document",
        scope.userId,
        config,
      );
    }
    if (vectors.length !== extracted.length)
      throw new SourceError("embedding_unavailable", "Embedding count mismatch", 503, true);
    await save("fact_prepared", { facts: extracted, vectors });
  } catch (error) {
    if (!(error instanceof SourceError) ||
        !["input_too_long", "invalid_model_output", "fact_model_input_rejected",
          "fact_model_unavailable", "fact_no_progress", "embedding_input_too_long",
          "embedding_unavailable"].includes(error.code)) throw error;
    const attempts = Number(op.attempts) + 1;
    const retry = error.retryable && attempts < maintenanceRetryPolicy.limit;
    const failed = await updateAppend(
        `attempts=$7,
           status=CASE WHEN $8::boolean THEN 'processing' ELSE 'failed' END,
           available_at=CASE WHEN $8 THEN clock_timestamp()+$9*interval '1 minute' END,
           error=$10::jsonb,
           request=CASE WHEN $11 THEN o.request ELSE jsonb_build_object(
             'source_id',o.source_id,'idempotency_key',o.idempotency_key) END,
           input_expires_at=CASE WHEN $11 THEN o.input_expires_at END`,
        [attempts, retry, retry ? maintenanceRetryPolicy.delays[attempts - 1] : null,
          JSON.stringify({ code: error.code, retryable: error.retryable }), error.retryable],
    );
    if (!failed.rowCount) throw new TaskYield();
  }
}

export async function commitFactFlush(
  runtime: Runtime, scope: UserScope, flushId: string, owner: string, budget: SliceBudget,
  rows: { id: string; blob_id: string; prepared: PreparedAppend }[],
) {
  const first = rows[0];
  if (!first || rows.some((row) => !row.prepared)) throw new TaskYield();
  const facts: PreparedAppend["facts"] = [];
  const vectors: PreparedAppend["vectors"] = [];
  const seen = new Set<string>();
  for (const { prepared } of rows) {
    budget.assertActive();
    for (const [index, fact] of prepared.facts.entries()) {
      const { id: _id, support_groups, ...attributes } = fact;
      const key = pythonJson({
        ...attributes,
        support_groups: support_groups.map((group) => [...group].sort()).map(pythonJson).sort(),
      });
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push(fact);
      vectors.push(prepared.vectors[index] ?? null);
    }
  }
  const output = await runtime.db.transaction(async (tx) => {
    const version = await bumpMemoryVersion(tx, scope);
    const changes = await insertFacts(tx, scope, first.blob_id, version, facts, vectors);
    await tx.query(
      `${pendingInputs()}
       UPDATE memoia.memory_messages target SET processed=true FROM inputs
        WHERE target.user_id=inputs.user_id AND target.project_id=inputs.project_id
          AND target.source_id=inputs.source_id AND target.message_id=inputs.message_id`,
      [flushId],
    );
    const output = { event_ids: [], profile_ids: [], fact_ids: changes.map((c) => c.fact_id), memory_version: version };
    const updated = await tx.query(
      `UPDATE memoia.memory_operations a SET status='completed',result=$2::jsonb,error=NULL,
          request=jsonb_build_object('source_id',a.source_id,'idempotency_key',a.idempotency_key),
          input_expires_at=NULL,available_at=NULL
        FROM memoia.memory_operations f
        WHERE f.id=$1 AND a.fact_flush_id=f.id AND a.id=ANY($3::uuid[])
          AND a.status='processing' AND a.input_expires_at>clock_timestamp()
          AND coalesce(f.request->>'input_revision','0')=$4
          AND a.request->'fact_prepared'->>'input_revision'=$4`,
      [flushId, JSON.stringify(output), rows.map(({ id }) => id), first.prepared.input_revision],
    );
    if (updated.rowCount !== rows.length) throw new TaskYield();
    if (changes.length) await recordChanges(tx, scope, first.blob_id, version, changes, true);
    budget.assertActive();
    if (!await maintenanceTasks.completeInTx(tx, flushId, owner, {
      resultCode: "COMPLETED", result: output, executionState: null,
    })) throw new TaskLeaseLost();
    return output;
  });
  if (output.fact_ids.length) await notifyUser(runtime, scope);
}

async function scrubHistory(tx: Sql, scope: UserScope, changed: Set<string>) {
  if (!changed.size) return;
  const { rows } = await tx.query(
    "SELECT id,profiles,added,removed FROM memoia.memory_profile_revisions WHERE user_id=$1 AND project_id=$2",
    [scope.userId, scope.projectId],
  );
  for (const row of rows) {
    const original = [row.profiles, row.added, row.removed];
    const fields = original.map((entries) =>
      (entries ?? []).filter(
        (p: any) =>
          Array.isArray(p._impact_fact_ids) &&
          ![...(p.fact_ids ?? []), ...p._impact_fact_ids].some((id) =>
            changed.has(id),
          ),
      ),
    );
    if (fields.every((entries, i) => entries.length === (original[i]?.length ?? 0)))
      continue;
    const updated = await tx.query(
      `UPDATE memoia.memory_profile_revisions SET profiles=$2::jsonb,added=$3::jsonb,removed=$4::jsonb
       WHERE id=$1 AND profiles IS NOT DISTINCT FROM $5::jsonb
         AND added IS NOT DISTINCT FROM $6::jsonb AND removed IS NOT DISTINCT FROM $7::jsonb`,
      [row.id, ...fields.map((v) => JSON.stringify(v)),
        ...original.map((v) => v == null ? null : JSON.stringify(v))],
    );
    if (!updated.rowCount)
      throw new SourceError("write_conflict", "Profile history changed during Fact publication", 409, true);
  }
}
export async function deleteMessages(
  runtime: Runtime,
  scope: UserScope,
  sourceId: string,
  input: DeleteInput,
) {
  validateDelete(input);
  const payload = { source_id: sourceId, ...input };
  const change = { kind: "retract" as const, key: input.idempotency_key, digest: await hash({ kind: "retract", request: payload }) };
  return submitFactChange(runtime, scope, change, async (prior) => {
    const previousVersion = await memoryVersion(runtime.db, scope);
    const rows = (
      await runtime.db.query(
        `SELECT f.* FROM memoia.memory_blobs b JOIN memoia.memory_facts f
           ON f.blob_id=b.id AND f.user_id=b.user_id AND f.project_id=b.project_id
         WHERE b.user_id=$1 AND b.project_id=$2 AND b.source_id=$3 AND b.message_ids ?| $4::text[]
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(f.support_groups) AS g(evidence)
                       WHERE g.evidence ?| $4::text[])`,
        [scope.userId, scope.projectId, sourceId, input.message_ids],
      )
    ).rows;
    const ids = [...new Set(rows.flatMap((f) => f.support_groups.flat()))];
    const messages = ids.length
      ? (
          await runtime.db.query(
            "SELECT *,occurred_at::text AS occurred_at FROM memoia.memory_messages WHERE user_id=$1 AND project_id=$2 AND source_id=$3 AND message_id=ANY($4::text[])",
            [scope.userId, scope.projectId, sourceId, ids],
          )
        ).rows
      : [];
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
          "document",
          scope.userId,
          config,
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
    const changes = [
      ...removed.map((f) => ({ fact_id: f.id, kind: "deleted" as const })),
      ...surviving.map((f) => ({ fact_id: f.id, kind: "evidence" as const })),
    ];
    const completed = await runtime.db.transaction(async (tx) => {
      await ensureSource(tx, scope, sourceId);
      const version = await bumpMemoryVersion(tx, scope);
      if (version !== previousVersion + 1)
        throw new SourceError("write_conflict", "Fact state changed while preparing the deletion", 409, true);
      await tx.query(
        "DELETE FROM memoia.memory_messages WHERE user_id=$1 AND project_id=$2 AND source_id=$3 AND message_id=ANY($4::text[])",
        [scope.userId, scope.projectId, sourceId, input.message_ids],
      );
      const retracted = await tx.query(
        `UPDATE memoia.memory_operations o
            SET generation=coalesce(o.generation,0)+1,
                request=jsonb_set(o.request-'fact_draft'-'fact_review_candidate'-'fact_prepared','{messages}',
              COALESCE((SELECT jsonb_agg(m.value ORDER BY m.ordinality)
                FROM jsonb_array_elements(o.request->'messages') WITH ORDINALITY m(value,ordinality)
                WHERE NOT (m.value->>'message_id'=ANY($4::text[]))), '[]'::jsonb))
          WHERE o.user_id=$1 AND o.project_id=$2 AND o.source_id=$3 AND o.kind IN ('import','append')
            AND (o.status IN ('staged','processing') OR (o.status='failed' AND o.fact_flush_id IS NOT NULL))
            AND o.request->'messages' IS NOT NULL
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(o.request->'messages') m
              WHERE m->>'message_id'=ANY($4::text[]))
          RETURNING o.blob_id, o.fact_flush_id`,
        [scope.userId, scope.projectId, sourceId, input.message_ids],
      );
      // Extraction can read any evidence in its fixed range. A later unsealed append
      // cannot invalidate that range, even when it uses the same session Blob.
      const flushes = [...new Set(retracted.rows.map((r) => r.fact_flush_id).filter(Boolean))];
      if (flushes.length) {
        await tx.query(
          `UPDATE memoia.memory_operations
            SET request=jsonb_set(request,'{input_revision}',
              to_jsonb(coalesce((request->>'input_revision')::bigint,0)+1))
            WHERE id=ANY($1::uuid[])`,
          [flushes],
        );
        await tx.query(
          `UPDATE memoia.memory_operations SET generation=coalesce(generation,0)+1,
                request=request-'fact_draft'-'fact_review_candidate'-'fact_prepared'
            WHERE fact_flush_id=ANY($1::uuid[]) AND status IN ('processing','failed')`,
          [flushes],
        );
      }
      if (removed.length)
        await tx.query(
          "DELETE FROM memoia.memory_facts WHERE user_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])",
          [scope.userId, scope.projectId, removed.map((f) => f.id)],
        );
      for (const f of surviving)
        await tx.query(
          "UPDATE memoia.memory_facts SET support_groups=$2::jsonb,occurred_at=$3,fact_time=$4::jsonb,search_text=$5,embedding=$6,revision=revision+1,updated_at=now() WHERE id=$1",
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
      await tx.query(
        `UPDATE memoia.memory_blobs b SET status=CASE WHEN EXISTS (
            SELECT 1 FROM memoia.memory_messages m
            WHERE m.user_id=b.user_id AND m.project_id=b.project_id AND m.source_id=b.source_id
              AND b.message_ids ? m.message_id AND NOT m.deleted
          ) THEN 'active' ELSE 'retracted' END
          WHERE b.user_id=$1 AND b.project_id=$2 AND b.source_id=$3 AND b.message_ids ?| $4::text[]`,
        [scope.userId, scope.projectId, sourceId, input.message_ids],
      );
      const result = {
        event_ids: [],
        profile_ids: [],
        fact_ids: rows.map((f) => f.id),
        memory_version: version,
      };
      assertRunning(runtime);
      return completeFactChange(tx, scope, change, {
        prior, sourceId, messageIds: input.message_ids, audit: payload, result, changes,
      });
    });
    if (changes.length) await notifyUser(runtime, scope);
    return completed;
  });
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
export async function updateFact(
  runtime: Runtime,
  scope: UserScope,
  factId: string,
  input: UpdateInput,
) {
  return correctFact(runtime, scope, factId, "update", input);
}
export async function deleteFact(
  runtime: Runtime,
  scope: UserScope,
  factId: string,
  input: CorrectionBase,
) {
  return correctFact(runtime, scope, factId, "delete", input);
}
async function correctFact(
  runtime: Runtime,
  scope: UserScope,
  factId: string,
  action: "update" | "delete",
  input: CorrectionBase | UpdateInput,
) {
  validateCorrection(input, action);
  const fingerprint: Record<string, unknown> = { fact_id: factId, action, ...input };
  if ("fact_time" in input) {
    fingerprint.event_time = input.fact_time;
    delete fingerprint.fact_time;
  }
  const change = { kind: "correct" as const, key: input.idempotency_key, digest: await hash({ kind: "correct", request: fingerprint }) };
  return submitFactChange(runtime, scope, change, async (prior) => {
    const { rows: [fact] } = await runtime.db.query(
      `SELECT f.*,f.occurred_at::text AS occurred_at,b.source_id,b.message_ids
       FROM memoia.memory_facts f JOIN memoia.memory_blobs b
         ON b.id=f.blob_id AND b.user_id=f.user_id AND b.project_id=f.project_id
       WHERE f.id=$1 AND f.user_id=$2 AND f.project_id=$3`,
      [factId, scope.userId, scope.projectId],
    );
    if (!fact) {
      await assertActive(runtime.db, scope);
      throw new SourceError("fact_not_found", "Fact not found", 404);
    }
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
      const { rows: messages } = await runtime.db.query(
        `SELECT m.message_id,m.role,m.occurred_at::text AS occurred_at FROM memoia.memory_blobs b
         JOIN memoia.memory_messages m USING (user_id,project_id,source_id)
         WHERE b.id=$1 AND b.user_id=$2 AND b.project_id=$3
           AND m.message_id=ANY($4::text[]) AND b.message_ids ? m.message_id AND NOT m.deleted`,
        [fact.blob_id, scope.userId, scope.projectId, [...new Set(update.support_groups.flat())]],
      );
      const roles = new Map(messages.map((message) => [message.message_id, message.role]));
      if (update.support_groups.some((group) =>
        group.some((id) => !roles.has(id)) || !group.some((id) => roles.get(id) === "user"),
      )) {
        throw new SourceError(
          "invalid_fact_evidence",
          "Evidence must use undeleted user messages from the original Blob",
          422,
        );
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
          ? await embeddings(runtime, scope.projectId, [value.search_text], "document", scope.userId, config)
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
    const completed = await runtime.db.transaction(async (tx) => {
      const version = changed ? await bumpMemoryVersion(tx, scope) : await memoryVersion(tx, scope);
      const target = [factId, scope.userId, scope.projectId, input.expected_revision];
      const applied = action === "delete"
        ? await tx.query(
            "DELETE FROM memoia.memory_facts WHERE id=$1 AND user_id=$2 AND project_id=$3 AND revision=$4",
            target,
          )
        : changed
          ? await tx.query(
              `UPDATE memoia.memory_facts
               SET content=$5,subject=$6,reporter=$7,certainty=$8,support_groups=$9::jsonb,fact_time=$10::jsonb,
                   occurred_at=$11,search_text=$12,embedding=$13,revision=revision+1,updated_at=now()
               WHERE id=$1 AND user_id=$2 AND project_id=$3 AND revision=$4`,
              [...target, value.content, value.subject, value.reporter, value.certainty,
                JSON.stringify(value.support_groups), JSON.stringify(value.fact_time),
                value.occurred_at, value.search_text, value.embedding],
            )
          : await tx.query(
              "SELECT id FROM memoia.memory_facts WHERE id=$1 AND user_id=$2 AND project_id=$3 AND revision=$4",
              target,
            );
      if (!applied.rowCount)
        throw new SourceError("fact_revision_conflict", "Fact changed; read its current revision before correcting", 409);
      if (changed) await scrubHistory(tx, scope, new Set([factId]));
      const changes = changed
        ? [
            {
              fact_id: factId,
              kind: action === "delete" ? ("deleted" as const) : ("updated" as const),
            },
          ]
        : [];
      const result = {
        event_ids: [],
        profile_ids: [],
        fact_ids: [factId],
        memory_version: version,
      };
      const audit = {
        source_id: fact.source_id,
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
      assertRunning(runtime);
      return completeFactChange(tx, scope, change, {
        prior, sourceId: fact.source_id, messageIds: fact.message_ids, audit, result, changes,
      });
    });
    if (changed) await notifyUser(runtime, scope);
    return completed;
  });
}
export async function purgeExpiredInputs(runtime: Runtime) {
  await runtime.db.query(
    `UPDATE memoia.memory_operations
        SET request=CASE WHEN kind IN ('import','append')
              THEN jsonb_build_object('source_id',source_id,'idempotency_key',idempotency_key)
              ELSE request-'content'-'subject'-'reporter'-'certainty'-'support_groups'-'fact_time' END,
            input_expires_at=NULL,available_at=NULL,
            error=CASE WHEN (kind='correct' AND status='processing') OR (kind IN ('import','append') AND status IN ('staged','processing'))
              THEN jsonb_build_object('code','input_required','retryable',false) ELSE error END,
            status=CASE WHEN (kind='correct' AND status='processing') OR (kind IN ('import','append') AND status IN ('staged','processing')) THEN 'failed' ELSE status END
      WHERE (kind IN ('import','append') AND input_expires_at<=clock_timestamp())
         OR (kind='correct' AND status<>'completed'
             AND (input_expires_at<=clock_timestamp() OR (input_expires_at IS NULL AND status='processing')))`,
    undefined,
    "purge_expired_inputs",
  );
}
export async function retryOperation(
  runtime: Runtime,
  scope: UserScope,
  operationId: string,
) {
  const op = (
    await runtime.db.query(
      "SELECT kind FROM memoia.memory_operations WHERE id=$1 AND user_id=$2 AND project_id=$3",
      [operationId, scope.userId, scope.projectId],
    )
  ).rows[0];
  if (!op)
    throw new SourceError("operation_not_found", "Operation not found", 404);
  if (op.kind === "fact_flush") {
    const { retryFactFlush } = await import("./fact-flush");
    return retryFactFlush(runtime, scope, operationId);
  }
  if (op.kind === "flush") {
    const { retryFlush } = await import("./maintenance");
    return retryFlush(runtime, scope, operationId);
  }
  throw new SourceError(
    "operation_kind_unsupported",
    "Only Fact and maintenance flush tasks can be retried",
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
function validateImport(input: ImportInput) {
  if (
    !input ||
    !reasoningEffort.optional().safeParse(input.maintenance_reasoning_effort).success ||
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
    if ("images" in message) invalidInput("Fact import accepts text only");
    if (message.visual_description !== undefined &&
        (typeof message.visual_description !== "string" || !message.visual_description.trim() || message.visual_description.length > 4096 ||
          /https?:\/\/|data:image\//i.test(message.visual_description)))
      invalidInput("Invalid visual description");
    if (!message.content && !message.visual_description)
      invalidInput("Message requires text or a visual description");
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
