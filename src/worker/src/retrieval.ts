import type { Runtime } from "./runtime";
import type { Sql, UserScope } from "./db";
import { SourceError } from "./errors";
import { sourceObservations } from "./temporal";
import { embeddings, countTokens, getConfig as getModelConfig } from "./models";
import { parse as parseYaml } from "yaml";

type Query = {
  query?: string | null;
  ids?: string[];
  exclude_ids?: string[];
  limit?: number;
  max_token_size?: number;
  source_ids?: string[];
  recorded_after?: string | null;
  recorded_before?: string | null;
  event_after?: string | null;
  event_before?: string | null;
  created_after?: string | null;
  created_before?: string | null;
  fact_ids?: string[];
  topic?: string | null;
  sub_topic?: string | null;
  navigation?: {
    excludeEventIds: string[];
    excludeProfileIds: string[];
    excludeProfileTopics: string[];
    includeEvents: boolean;
  };
};
const params = (scope: UserScope) => [scope.userId, scope.projectId];
const limit = (input: Query) => input.limit ?? 10;
const budget = (input: Query) => input.max_token_size ?? 8192;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validIds = (ids: unknown): string[] =>
  Array.isArray(ids)
    ? ids
        .filter((id): id is string => typeof id === "string" && uuid.test(id))
        .map((id) => id.toLowerCase())
    : [];
function fits(value: unknown, max: number): boolean {
  return countTokens(JSON.stringify(value)) <= max;
}
async function complete(
  field: string,
  ranking: Array<{ id: string; score: number }>,
  input: Query,
  load: (page: Array<{ id: string; score: number }>) => Promise<any[]>,
) {
  const result: Record<string, any[]> = { [field]: [] };
  if (!fits(result, budget(input)))
    throw new SourceError(
      "query_budget_too_small",
      "Query budget cannot fit an empty result",
      422,
      false,
    );
  for (let start = 0; start < ranking.length; start += 20) {
    const entries = await load(ranking.slice(start, start + 20));
    for (const item of entries) {
      if (fits({ [field]: [...result[field], item] }, budget(input)))
        result[field].push(item);
      if (result[field].length >= limit(input)) return result;
    }
  }
  return result;
}
async function snapshot<T>(
  runtime: Runtime,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  return runtime.db.transaction(fn, {
    isolation: "repeatable read",
    readOnly: true,
  });
}
async function pending(
  tx: Sql,
  scope: UserScope,
  ids: string[],
): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const r = await tx.query(
    `SELECT DISTINCT x.value->>'fact_id' AS id FROM memoia.memory_blobs b
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(b.fact_changes,'[]'::jsonb)) x(value)
    WHERE b.user_id=$1 AND b.project_id=$2 AND b.fact_completed_at IS NOT NULL
      AND (b.flush_operation_id IS NULL OR NOT EXISTS (SELECT 1 FROM memoia.memory_operations o JOIN memoia.queue_tasks t ON t.id=o.id WHERE o.id=b.flush_operation_id AND o.user_id=$1 AND o.project_id=$2 AND o.kind='flush' AND t.status='succeeded'))
      AND x.value->>'kind' IN ('updated','evidence','deleted') AND x.value->>'fact_id'=ANY($3::text[])
    UNION SELECT DISTINCT x.value->>'fact_id' FROM memoia.memory_operations o LEFT JOIN memoia.queue_tasks t ON t.id=o.id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.request->'legacy_changes','[]'::jsonb)) x(value)
    WHERE o.user_id=$1 AND o.project_id=$2 AND o.kind='flush' AND t.status IS DISTINCT FROM 'succeeded'
      AND x.value->>'kind' IN ('updated','evidence','deleted') AND x.value->>'fact_id'=ANY($3::text[])`,
    [...params(scope), ids],
  );
  return new Set(r.rows.map((row) => row.id));
}
async function factRows(tx: Sql, scope: UserScope, ids: string[]) {
  if (!ids.length) return [];
  return (
    await tx.query(
      `SELECT f.*,b.source_id FROM memoia.memory_facts f JOIN memoia.memory_blobs b
    ON b.id=f.blob_id AND b.user_id=f.user_id AND b.project_id=f.project_id
    WHERE f.user_id=$1 AND f.project_id=$2 AND f.id=ANY($3::uuid[])`,
      [...params(scope), ids],
    )
  ).rows;
}
async function evidence(tx: Sql, scope: UserScope, rows: any[]) {
  const bySource = new Map<string, Set<string>>();
  for (const row of rows) {
    const ids = bySource.get(row.source_id) ?? new Set<string>();
    for (const group of row.support_groups ?? [])
      for (const id of group) ids.add(id);
    bySource.set(row.source_id, ids);
  }
  const observations = new Map<string, any[]>();
  for (const [source, ids] of bySource) {
    const r = await tx.query(
      `SELECT message_id,occurred_at,time_zone FROM memoia.memory_messages
      WHERE user_id=$1 AND project_id=$2 AND source_id=$3 AND message_id=ANY($4::text[]) AND NOT deleted`,
      [...params(scope), source, [...ids]],
    );
    observations.set(source, r.rows);
  }
  return new Map(
    rows.map((row) => [
      row.id,
      {
        fact_id: row.id,
        blob_id: row.blob_id,
        content: row.content,
        topic: row.topic,
        sub_topic: row.sub_topic,
        subject: row.subject,
        reporter: row.reporter,
        certainty: row.certainty,
        revision: Number(row.revision),
        created_at: row.created_at,
        updated_at: row.updated_at,
        support_groups: row.support_groups,
        fact_time: row.fact_time,
        source_messages: sourceObservations(
          row.support_groups,
          observations.get(row.source_id) ?? [],
        ),
      },
    ]),
  );
}
function pool(
  kind: "facts" | "events" | "profiles",
  scope: UserScope,
  input: Query,
) {
  const v: any[] = [...params(scope)];
  const add = (x: any) => {
    v.push(x);
    return `$${v.length}`;
  };
  const alias = kind === "facts" ? "f" : kind === "events" ? "e" : "p";
  const clauses = [`${alias}.user_id=$1`, `${alias}.project_id=$2`];
  if (input.ids?.length)
    clauses.push(`${alias}.id=ANY(${add(input.ids)}::uuid[])`);
  if (input.exclude_ids?.length)
    clauses.push(`NOT (${alias}.id=ANY(${add(input.exclude_ids)}::uuid[]))`);
  const temporal = (column: string, start: any, end: any) => {
    if (start) clauses.push(`${column}>=${add(start)}`);
    if (end) clauses.push(`${column}<=${add(end)}`);
  };
  if (kind === "facts") {
    if (input.source_ids?.length)
      clauses.push(`b.source_id=ANY(${add(input.source_ids)}::text[])`);
    if (input.navigation) {
      const n = input.navigation;
      const profiles = `EXISTS (SELECT 1 FROM memoia.user_profiles np WHERE np.user_id=f.user_id AND np.project_id=f.project_id AND NOT (np.id=ANY(${add(n.excludeProfileIds)}::uuid[])) AND (np.attributes->>'topic' IS NULL OR NOT (np.attributes->>'topic'=ANY(${add(n.excludeProfileTopics)}::text[]))) AND np.attributes->'fact_ids' @> jsonb_build_array(f.id::text))`;
      const events = n.includeEvents
        ? ` OR EXISTS (SELECT 1 FROM memoia.memory_event_facts ne JOIN memoia.user_events ee ON ee.id=ne.event_id AND ee.user_id=ne.user_id AND ee.project_id=ne.project_id WHERE ne.user_id=f.user_id AND ne.project_id=f.project_id AND ne.fact_id=f.id AND NOT (ee.id=ANY(${add(n.excludeEventIds)}::uuid[])))`
        : "";
      clauses.push(`(${profiles}${events})`);
    }
    temporal("f.occurred_at", input.recorded_after, input.recorded_before);
    if (input.event_after)
      clauses.push(`f.fact_time->>'end'>=${add(input.event_after)}`);
    if (input.event_before)
      clauses.push(`f.fact_time->>'start'<=${add(input.event_before)}`);
  } else if (kind === "events") {
    temporal("e.created_at", input.created_after, input.created_before);
    if (input.fact_ids?.length || input.event_after || input.event_before) {
      const sub = [
        "ef.event_id=e.id",
        "ef.user_id=e.user_id",
        "ef.project_id=e.project_id",
        `NOT EXISTS (
        SELECT 1 FROM memoia.memory_blobs pb CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pb.fact_changes,'[]'::jsonb)) pc(value)
        WHERE pb.user_id=f.user_id AND pb.project_id=f.project_id AND pb.fact_completed_at IS NOT NULL
          AND (pb.flush_operation_id IS NULL OR NOT EXISTS (SELECT 1 FROM memoia.memory_operations po JOIN memoia.queue_tasks pt ON pt.id=po.id WHERE po.id=pb.flush_operation_id AND po.user_id=f.user_id AND po.project_id=f.project_id AND po.kind='flush' AND pt.status='succeeded'))
          AND pc.value->>'kind' IN ('updated','evidence','deleted') AND pc.value->>'fact_id'=f.id::text)`,
        `NOT EXISTS (
        SELECT 1 FROM memoia.memory_operations po LEFT JOIN memoia.queue_tasks pt ON pt.id=po.id CROSS JOIN LATERAL jsonb_array_elements(COALESCE(po.request->'legacy_changes','[]'::jsonb)) pc(value)
        WHERE po.user_id=f.user_id AND po.project_id=f.project_id AND po.kind='flush' AND pt.status IS DISTINCT FROM 'succeeded'
          AND pc.value->>'kind' IN ('updated','evidence','deleted') AND pc.value->>'fact_id'=f.id::text)`,
      ];
      if (input.fact_ids?.length)
        sub.push(`f.id=ANY(${add(input.fact_ids)}::uuid[])`);
      if (input.event_after)
        sub.push(`f.fact_time->>'end'>=${add(input.event_after)}`);
      if (input.event_before)
        sub.push(`f.fact_time->>'start'<=${add(input.event_before)}`);
      clauses.push(
        `EXISTS (SELECT 1 FROM memoia.memory_event_facts ef JOIN memoia.memory_facts f ON f.id=ef.fact_id AND f.user_id=ef.user_id AND f.project_id=ef.project_id WHERE ${sub.join(" AND ")})`,
      );
    }
  } else {
    if (input.topic != null)
      clauses.push(`p.attributes->>'topic'=${add(input.topic)}`);
    if (input.sub_topic != null)
      clauses.push(`p.attributes->>'sub_topic'=${add(input.sub_topic)}`);
  }
  const from =
    kind === "facts"
      ? "memoia.memory_facts f JOIN memoia.memory_blobs b ON b.id=f.blob_id AND b.user_id=f.user_id AND b.project_id=f.project_id"
      : kind === "events"
        ? "memoia.user_events e"
        : "memoia.user_profiles p";
  const text =
    kind === "facts"
      ? "COALESCE(f.search_text,f.content)"
      : kind === "events"
        ? "concat_ws(' ',e.event_data->>'title',e.event_data->>'summary',e.event_data->>'keywords',e.event_data->>'content',e.event_data->>'event_tip')"
        : "concat_ws(' ',p.content,p.attributes->>'topic',p.attributes->>'sub_topic')";
  const timestamp =
    kind === "facts"
      ? "f.occurred_at"
      : kind === "events"
        ? "e.created_at"
        : "p.updated_at";
  return { v, alias, from, where: clauses.join(" AND "), text, timestamp };
}
async function queryVector(
  runtime: Runtime,
  projectId: string,
  query: string,
): Promise<number[] | null> {
  const config = await getModelConfig(runtime, projectId);
  if (!config.enable_event_embedding) return null;
  try {
    const timer = AbortSignal.timeout(8000);
    const signal = runtime.signal
      ? AbortSignal.any([runtime.signal, timer])
      : timer;
    return (
      (
        await embeddings({ ...runtime, signal }, projectId, [query], "query")
      )[0] ?? null
    );
  } catch (error: any) {
    if (runtime.signal?.aborted) throw error;
    const status = error?.status;
    if (
      (error instanceof SourceError &&
        ![429, 500, 502, 503, 504].includes(error.status)) ||
      (typeof status === "number" &&
        status >= 400 &&
        status < 500 &&
        status !== 429)
    )
      throw new SourceError(
        "query_configuration",
        "Query provider configuration rejected",
        422,
        false,
      );
    return null;
  }
}
async function rank(
  runtime: Runtime,
  scope: UserScope,
  kind: "facts" | "events" | "profiles",
  input: Query,
  sharedVector?: Promise<number[] | null>,
) {
  const base = pool(kind, scope, input);
  const cap = Math.min(500, Math.max(50, limit(input) * 5));
  if (!input.query) {
    const r = await runtime.db.query(
      `SELECT ${base.alias}.id FROM ${base.from} WHERE ${base.where} ORDER BY ${base.timestamp} DESC,${base.alias}.id LIMIT ${cap}`,
      base.v,
    );
    return r.rows.map((row) => ({ id: row.id, score: 0 }));
  }
  const lexical = runtime.db.query(
    `SELECT ${base.alias}.id FROM ${base.from} WHERE ${base.where}
    AND (to_tsvector('simple',${base.text}) @@ websearch_to_tsquery('simple',$${base.v.length + 1}) OR position(lower($${base.v.length + 1}) in lower(${base.text}))>0)
    ORDER BY ts_rank_cd(to_tsvector('simple',${base.text}),websearch_to_tsquery('simple',$${base.v.length + 1})) DESC,${base.alias}.id LIMIT ${cap}`,
    [...base.v, input.query],
  );
  const vector =
    kind === "profiles"
      ? Promise.resolve(null)
      : (sharedVector ?? queryVector(runtime, scope.projectId, input.query));
  const [lex, embedding] = await Promise.all([lexical, vector]);
  const sem = embedding
    ? await runtime.db.query(
        `SELECT ${base.alias}.id FROM ${base.from} WHERE ${base.where} AND ${base.alias}.embedding IS NOT NULL AND 1-(${base.alias}.embedding <=> $${base.v.length + 1}::vector) > 0.2 ORDER BY ${base.alias}.embedding <=> $${base.v.length + 1}::vector,${base.alias}.id LIMIT ${cap}`,
        [...base.v, `[${embedding.join(",")}]`],
      )
    : { rows: [] };
  const scores = new Map<string, number>();
  for (const rows of [lex.rows, sem.rows])
    rows.forEach((row, i) =>
      scores.set(row.id, (scores.get(row.id) ?? 0) + 1 / (61 + i)),
    );
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
async function hydrateFacts(tx: Sql, scope: UserScope, ids: string[]) {
  const rows = await factRows(tx, scope, ids);
  const proof = await evidence(tx, scope, rows);
  return new Map(
    rows.map((row) => [row.id, { row, proof: proof.get(row.id) }]),
  );
}
function factEntry(row: any, proof: any, score: number) {
  return {
    id: row.id,
    content: row.content,
    source_id: row.source_id,
    blob_id: row.blob_id,
    score,
    occurred_at: row.occurred_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    evidence: proof,
  };
}
async function selectedRows(
  tx: Sql,
  scope: UserScope,
  kind: "facts" | "events" | "profiles",
  input: Query,
  ids: string[],
) {
  if (!ids.length) return [];
  const b = pool(kind, scope, input);
  return (
    await tx.query(
      `SELECT ${b.alias}.*${kind === "facts" ? ",b.source_id" : ""} FROM ${b.from} WHERE ${b.where} AND ${b.alias}.id=ANY($${b.v.length + 1}::uuid[])`,
      [...b.v, ids],
    )
  ).rows;
}
async function views(tx: Sql, scope: UserScope, rows: any[]) {
  if (!rows.length) return new Map<string, any>();
  const edges = (
    await tx.query(
      `SELECT event_id,fact_id FROM memoia.memory_event_facts WHERE user_id=$1 AND project_id=$2 AND event_id=ANY($3::uuid[]) ORDER BY fact_id`,
      [...params(scope), rows.map((row) => row.id)],
    )
  ).rows;
  const ids = [...new Set(edges.map((edge) => edge.fact_id))];
  const [pendingIds, hydrated] = await Promise.all([
    pending(tx, scope, ids),
    hydrateFacts(tx, scope, ids),
  ]);
  const result = new Map<string, any>();
  for (const row of rows) {
    const raw = row.event_data ?? {};
    const data: Record<string, unknown> = {};
    for (const key of [
      "title",
      "summary",
      "keywords",
      "event_time",
      "location",
      "content",
      "interpretation",
      "source_id",
      "blob_id",
      "profile_delta",
      "event_tip",
      "event_tags",
    ])
      data[key] = raw[key] ?? null;
    if (Array.isArray(data.profile_delta))
      data.profile_delta = data.profile_delta.map((item: any) => ({
        content: item.content,
        attributes: item.attributes,
      }));
    if (Array.isArray(data.event_tags))
      data.event_tags = data.event_tags.map((item: any) => ({
        tag: item.tag,
        value: item.value,
      }));
    const selected = edges.filter(
      (edge) =>
        edge.event_id === row.id &&
        !pendingIds.has(edge.fact_id) &&
        hydrated.has(edge.fact_id),
    );
    result.set(row.id, {
      ...data,
      evidence: selected.map((edge) => hydrated.get(edge.fact_id)!.proof),
      fact_ids: selected.map((edge) => edge.fact_id),
    });
  }
  return result;
}
async function profileEntries(
  tx: Sql,
  scope: UserScope,
  rows: any[],
  scores: Map<string, number>,
) {
  const ids = [
    ...new Set(rows.flatMap((row) => validIds(row.attributes?.fact_ids))),
  ];
  const [blocked, facts] = await Promise.all([
    pending(tx, scope, ids),
    factRows(tx, scope, ids),
  ]);
  const byId = new Map(facts.map((row) => [row.id, row]));
  return rows.map((row) => {
    const attrs = row.attributes ?? {};
    const factIds = validIds(attrs.fact_ids)
      .filter((id) => !blocked.has(id) && byId.has(id))
      .sort();
    return {
      id: row.id,
      content: row.content,
      topic: attrs.topic ?? "",
      sub_topic: attrs.sub_topic ?? "",
      fact_ids: factIds,
      source_ids: [
        ...new Set(factIds.map((id) => byId.get(id)!.source_id)),
      ].sort(),
      score: scores.get(row.id) ?? 0,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  });
}
export async function queryFacts(
  runtime: Runtime,
  scope: UserScope,
  input: Query,
) {
  const ranking = await rank(runtime, scope, "facts", input);
  return snapshot(runtime, (tx) =>
    complete("facts", ranking, input, async (page) => {
      const rows = await selectedRows(
        tx,
        scope,
        "facts",
        input,
        page.map((x) => x.id),
      );
      const proof = await evidence(tx, scope, rows);
      const byId = new Map(rows.map((row) => [row.id, row]));
      return page.flatMap(({ id, score }) =>
        byId.has(id) ? [factEntry(byId.get(id), proof.get(id), score)] : [],
      );
    }),
  );
}
export async function queryEvents(
  runtime: Runtime,
  scope: UserScope,
  input: Query,
) {
  const ranking = await rank(runtime, scope, "events", input);
  return snapshot(runtime, (tx) =>
    complete("events", ranking, input, async (page) => {
      const rows = await selectedRows(
        tx,
        scope,
        "events",
        input,
        page.map((x) => x.id),
      );
      const data = await views(tx, scope, rows);
      const byId = new Map(rows.map((row) => [row.id, row]));
      const entries = page.flatMap(({ id, score }) => {
        const row = byId.get(id);
        if (!row) return [];
        if (input.fact_ids?.length || input.event_after || input.event_before) {
          const refs = data.get(id).fact_ids as string[];
          if (
            input.fact_ids?.length &&
            !refs.some((x) => input.fact_ids!.includes(x))
          )
            return [];
          if (
            (input.event_after || input.event_before) &&
            !data
              .get(id)
              .evidence.some(
                (p: any) =>
                  p.fact_time &&
                  (!input.event_after ||
                    p.fact_time.end >= input.event_after) &&
                  (!input.event_before ||
                    p.fact_time.start <= input.event_before) &&
                  (!input.fact_ids?.length ||
                    input.fact_ids.includes(p.fact_id)),
              )
          )
            return [];
        }
        return [
          {
            id,
            score,
            event_data: data.get(id),
            created_at: row.created_at,
            updated_at: row.updated_at,
          },
        ];
      });
      return entries;
    }),
  );
}
export async function queryProfiles(
  runtime: Runtime,
  scope: UserScope,
  input: Query,
) {
  const ranking = await rank(runtime, scope, "profiles", input);
  return snapshot(runtime, (tx) =>
    complete("profiles", ranking, input, async (page) => {
      const rows = await selectedRows(
        tx,
        scope,
        "profiles",
        input,
        page.map((x) => x.id),
      );
      const scores = new Map(page.map((x) => [x.id, x.score]));
      const entries = await profileEntries(tx, scope, rows, scores);
      const byId = new Map(entries.map((row) => [row.id, row]));
      return page.flatMap(({ id }) => (byId.has(id) ? [byId.get(id)] : []));
    }),
  );
}
export async function getProfiles(runtime: Runtime, scope: UserScope) {
  return snapshot(runtime, async (tx) => {
    const rows = (
      await tx.query(
        "SELECT * FROM memoia.user_profiles WHERE user_id=$1 AND project_id=$2",
        [...params(scope)],
      )
    ).rows;
    const entries = await profileEntries(tx, scope, rows, new Map());
    const sourceById = new Map(rows.map((row) => [row.id, row.attributes]));
    return {
      profiles: entries
        .map(({ score, fact_ids, ...row }) => {
          const attrs = sourceById.get(row.id);
          return attrs && !Object.hasOwn(attrs, "fact_ids")
            ? { ...row, source_ids: attrs.source_ids ?? [] }
            : row;
        })
        .sort(
          (a, b) =>
            a.topic.localeCompare(b.topic) ||
            a.sub_topic.localeCompare(b.sub_topic) ||
            a.id.localeCompare(b.id),
        ),
    };
  });
}
export async function getEvents(
  runtime: Runtime,
  scope: UserScope,
  count: number,
  days: number,
) {
  return snapshot(runtime, async (tx) => {
    const rows = (
      await tx.query(
        `SELECT * FROM memoia.user_events WHERE user_id=$1 AND project_id=$2 AND created_at>now()-($3 * interval '1 day') ORDER BY created_at DESC,id LIMIT $4`,
        [...params(scope), days, count],
      )
    ).rows;
    const data = await views(tx, scope, rows);
    return {
      events: rows.map((row) => {
        const { fact_ids, ...eventData } = data.get(row.id);
        return {
          id: row.id,
          event_data: eventData,
          created_at: row.created_at,
          updated_at: row.updated_at,
        };
      }),
    };
  });
}
type Search = {
  query: string;
  limit?: number;
  max_token_size?: number;
  exclude_fact_ids?: string[];
  exclude_event_ids?: string[];
  exclude_profile_ids?: string[];
  exclude_profile_topics?: string[];
  include_events?: boolean;
  event_max_tokens?: number | null;
};
async function legacyRank(
  runtime: Runtime,
  scope: UserScope,
  query: string,
  excluded: string[],
  count: number,
  sharedVector?: Promise<number[] | null>,
) {
  const args = [...params(scope), excluded, query];
  const cap = Math.min(500, Math.max(50, count * 5));
  const where = `user_id=$1 AND project_id=$2 AND NOT(id=ANY($3::uuid[])) AND event_data->>'blob_id' IS NULL AND NOT (event_data ? 'memoia_v2')`;
  const text = "COALESCE(event_data->>'event_tip','')";
  const lexical = runtime.db.query(
    `SELECT id FROM memoia.user_events WHERE ${where} AND (to_tsvector('simple',${text}) @@ websearch_to_tsquery('simple',$4) OR position(lower($4) in lower(${text}))>0) ORDER BY ts_rank_cd(to_tsvector('simple',${text}),websearch_to_tsquery('simple',$4)) DESC,id LIMIT ${cap}`,
    args,
  );
  const vector = sharedVector ?? queryVector(runtime, scope.projectId, query);
  const [lex, embedding] = await Promise.all([lexical, vector]);
  const sem = embedding
    ? await runtime.db.query(
        `SELECT id FROM memoia.user_events WHERE ${where} AND embedding IS NOT NULL AND 1-(embedding <=> $4::vector)>0.2 ORDER BY embedding <=> $4::vector,id LIMIT ${cap}`,
        [...params(scope), excluded, `[${embedding.join(",")}]`],
      )
    : { rows: [] };
  const scores = new Map<string, number>();
  for (const rows of [lex.rows, sem.rows])
    rows.forEach((row, i) =>
      scores.set(row.id, (scores.get(row.id) ?? 0) + 1 / (61 + i)),
    );
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
export async function search(
  runtime: Runtime,
  scope: UserScope,
  input: Search,
) {
  const count = input.limit ?? 10,
    max = input.max_token_size ?? 8192,
    excludedFacts = input.exclude_fact_ids ?? [],
    excludedEvents = input.exclude_event_ids ?? [],
    excludedProfiles = input.exclude_profile_ids ?? [],
    excludedTopics = input.exclude_profile_topics ?? [];
  const candidateLimit = Math.min(500, Math.max(50, count * 5));
  const query: Query = {
    query: input.query,
    limit: candidateLimit,
    exclude_ids: excludedFacts,
  };
  const nav: Query = {
    query: input.query,
    limit: candidateLimit,
    ids: excludedFacts,
    navigation: {
      excludeEventIds: excludedEvents,
      excludeProfileIds: excludedProfiles,
      excludeProfileTopics: excludedTopics,
      includeEvents: input.include_events !== false,
    },
  };
  const vector = queryVector(runtime, scope.projectId, input.query);
  const [unseen, seen, legacy] = await Promise.all([
    rank(runtime, scope, "facts", query, vector),
    excludedFacts.length
      ? rank(runtime, scope, "facts", nav, vector)
      : Promise.resolve([]),
    input.include_events === false
      ? Promise.resolve([])
      : legacyRank(
          runtime,
          scope,
          input.query,
          excludedEvents,
          candidateLimit,
          vector,
        ),
  ]);
  return snapshot(runtime, async (tx) => {
    const candidates = [
      ...unseen.slice(0, Math.min(500, Math.max(50, count * 5))),
      ...seen.slice(0, Math.min(500, Math.max(50, count * 5))),
    ];
    const hydrated = await hydrateFacts(
      tx,
      scope,
      candidates.map((x) => x.id),
    );
    const bundle: { facts: any[]; events: any[]; profiles: any[] } = {
      facts: [],
      events: [],
      profiles: [],
    };
    if (!fits(bundle, max))
      throw new SourceError(
        "search_rejected",
        "Search request rejected",
        422,
        false,
      );
    const selectedScores = new Map<string, number>();
    for (const entry of unseen) {
      const found = hydrated.get(entry.id);
      if (!found) continue;
      const next = factEntry(found.row, found.proof, entry.score);
      if (
        bundle.facts.length < count &&
        fits({ ...bundle, facts: [...bundle.facts, next] }, max)
      ) {
        bundle.facts.push(next);
        selectedScores.set(entry.id, entry.score);
      }
    }
    for (const entry of seen)
      if (hydrated.has(entry.id)) selectedScores.set(entry.id, entry.score);
    const ids = [...selectedScores.keys()];
    const scores = ids.map((id) => selectedScores.get(id)!);
    const profiles = ids.length
      ? (
          await tx.query(
            `SELECT p.* FROM memoia.user_profiles p
            CROSS JOIN LATERAL (SELECT max(s.score) AS score FROM unnest($5::text[], $6::float8[]) AS s(id,score)
              WHERE p.attributes->'fact_ids' @> jsonb_build_array(s.id)) matched
            WHERE p.user_id=$1 AND p.project_id=$2 AND NOT(p.id=ANY($3::uuid[]))
              AND (p.attributes->>'topic' IS NULL OR NOT(p.attributes->>'topic'=ANY($4::text[]))) AND matched.score IS NOT NULL
            ORDER BY matched.score DESC,p.id LIMIT $7`,
            [
              ...params(scope),
              excludedProfiles,
              excludedTopics,
              ids,
              scores,
              candidateLimit,
            ],
          )
        ).rows
      : [];
    const profileCandidates = await profileEntries(
      tx,
      scope,
      profiles,
      new Map(),
    );
    const associated: any[] = [];
    for (const p of profileCandidates) {
      const matched = p.fact_ids.filter((id) => selectedScores.has(id));
      if (!matched.length) continue;
      p.score = Math.max(...matched.map((id) => selectedScores.get(id)!));
      associated.push({ kind: "profiles", value: p });
    }
    if (input.include_events !== false) {
      const events = ids.length
        ? (
            await tx.query(
              `SELECT e.* FROM memoia.user_events e JOIN (
                SELECT ef.event_id,max(s.score) AS score FROM memoia.memory_event_facts ef
                JOIN unnest($4::uuid[], $5::float8[]) AS s(id,score) ON s.id=ef.fact_id
                WHERE ef.user_id=$1 AND ef.project_id=$2 AND NOT(ef.event_id=ANY($3::uuid[]))
                GROUP BY ef.event_id
              ) matched ON matched.event_id=e.id
              WHERE e.user_id=$1 AND e.project_id=$2
              ORDER BY matched.score DESC,e.id LIMIT $6`,
              [...params(scope), excludedEvents, ids, scores, candidateLimit],
            )
          ).rows
        : [];
      const data = await views(tx, scope, events);
      const allRefs = [
        ...new Set(
          events.flatMap((row) => data.get(row.id).fact_ids as string[]),
        ),
      ];
      const sourcesById = new Map(
        (await factRows(tx, scope, allRefs)).map((row) => [
          row.id,
          row.source_id,
        ]),
      );
      for (const row of events) {
        const v = data.get(row.id);
        const refs = (v.fact_ids as string[]).filter((id) =>
          selectedScores.has(id),
        );
        if (!refs.length) continue;
        const sources = new Set(
          v.evidence
            .map((p: any) => sourcesById.get(p.fact_id))
            .filter(Boolean),
        );
        const blobs = new Set(v.evidence.map((p: any) => p.blob_id));
        associated.push({
          kind: "events",
          value: {
            id: row.id,
            content: v.content || v.event_tip || "",
            title: v.title ?? null,
            summary: v.summary ?? null,
            keywords: v.keywords ?? null,
            event_time: v.event_time ?? null,
            location: v.location ?? null,
            interpretation: v.interpretation ?? null,
            fact_ids: v.fact_ids,
            source_id: sources.size === 1 ? [...sources][0] : null,
            blob_id: blobs.size === 1 ? [...blobs][0] : null,
            score: Math.max(...refs.map((id) => selectedScores.get(id)!)),
            occurred_at: row.created_at,
            evidence: v.evidence,
          },
        });
      }
      if (legacy.length) {
        const rows = (
          await tx.query(
            `SELECT * FROM memoia.user_events WHERE user_id=$1 AND project_id=$2 AND id=ANY($3::uuid[]) AND event_data->>'blob_id' IS NULL AND NOT(event_data ? 'memoia_v2')`,
            [
              ...params(scope),
              legacy.slice(0, candidateLimit).map((x) => x.id),
            ],
          )
        ).rows;
        const scores = new Map(
          legacy.slice(0, candidateLimit).map((x) => [x.id, x.score]),
        );
        for (const row of rows) {
          const d = row.event_data ?? {};
          associated.push({
            kind: "events",
            value: {
              id: row.id,
              content: d.event_tip || "",
              title: d.title ?? null,
              summary: d.summary ?? null,
              keywords: d.keywords ?? null,
              event_time: d.event_time ?? null,
              location: d.location ?? null,
              interpretation: d.interpretation ?? null,
              fact_ids: [],
              source_id: d.source_id ?? null,
              blob_id: d.blob_id ?? null,
              score: scores.get(row.id),
              occurred_at: row.created_at,
              evidence: [],
            },
          });
        }
      }
    }
    associated.sort(
      (a, b) =>
        b.value.score - a.value.score ||
        a.kind.localeCompare(b.kind) ||
        a.value.id.localeCompare(b.value.id),
    );
    let eventTokens = 0;
    for (const candidate of associated) {
      const list = bundle[candidate.kind as "events" | "profiles"];
      const size = countTokens(JSON.stringify(candidate.value));
      if (
        list.length >= count ||
        (candidate.kind === "events" &&
          input.event_max_tokens != null &&
          eventTokens + size > input.event_max_tokens)
      )
        continue;
      if (
        fits({ ...bundle, [candidate.kind]: [...list, candidate.value] }, max)
      ) {
        list.push(candidate.value);
        if (candidate.kind === "events") eventTokens += size;
      }
    }
    return bundle;
  });
}
async function contextRanking(
  runtime: Runtime,
  scope: UserScope,
  query: string,
) {
  const docs = `(SELECT id,'fact' AS kind,COALESCE(search_text,content) AS text,embedding FROM memoia.memory_facts WHERE user_id=$1 AND project_id=$2
    UNION ALL SELECT id,'event' AS kind,COALESCE(event_data->>'event_tip','') AS text,embedding FROM memoia.user_events
    WHERE user_id=$1 AND project_id=$2 AND event_data->>'blob_id' IS NULL AND NOT(event_data ? 'memoia_v2')) d`;
  const lexical = runtime.db.query(
    `SELECT id,kind FROM ${docs} WHERE to_tsvector('simple',text) @@ websearch_to_tsquery('simple',$3) OR position(lower($3) in lower(text))>0
    ORDER BY ts_rank_cd(to_tsvector('simple',text),websearch_to_tsquery('simple',$3)) DESC,id LIMIT 250`,
    [...params(scope), query],
  );
  const [lex, vector] = await Promise.all([
    lexical,
    queryVector(runtime, scope.projectId, query),
  ]);
  const sem = vector
    ? (
        await runtime.db.query(
          `SELECT id,kind FROM ${docs} WHERE embedding IS NOT NULL AND 1-(embedding <=> $3::vector)>0.2 ORDER BY embedding <=> $3::vector,id LIMIT 250`,
          [...params(scope), `[${vector.join(",")}]`],
        )
      ).rows
    : [];
  const scores = new Map<string, { id: string; kind: string; score: number }>();
  for (const ranking of [lex.rows, sem])
    ranking.forEach((row, i) => {
      const key = `${row.kind}:${row.id}`;
      const old = scores.get(key);
      scores.set(key, {
        id: row.id,
        kind: row.kind,
        score: (old?.score ?? 0) + 1 / (61 + i),
      });
    });
  return [...scores.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.id.localeCompare(b.id) ||
        a.kind.localeCompare(b.kind),
    )
    .slice(0, 50);
}
function contextEntry(row: any, proof: any) {
  const details = {
    fact_time: row.fact_time ?? null,
    source_messages: proof.source_messages,
    source_id: row.source_id,
    blob_id: row.blob_id,
    fact_id: row.id,
    created_at:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : (row.created_at ?? null),
    updated_at:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : (row.updated_at ?? null),
  };
  return `${row.content}\n[Time evidence (fact_time=null means unknown): ${JSON.stringify(details)}]`;
}
export async function context(
  runtime: Runtime,
  scope: UserScope,
  input: { query?: string | null; max_token_size?: number },
) {
  let factsRank: Array<{ id: string; score: number }>;
  let legacy: Array<{ id: string; score: number }>;
  if (input.query) {
    const ranking = await contextRanking(runtime, scope, input.query);
    factsRank = ranking.filter((x) => x.kind === "fact");
    legacy = ranking.filter((x) => x.kind === "event");
  } else {
    const [facts, events] = await Promise.all([
      runtime.db.query(
        `SELECT id,occurred_at AS at FROM memoia.memory_facts WHERE user_id=$1 AND project_id=$2 AND occurred_at>=now()-interval '360 days' ORDER BY occurred_at DESC,id LIMIT 100`,
        params(scope),
      ),
      runtime.db.query(
        `SELECT id,created_at AS at FROM memoia.user_events WHERE user_id=$1 AND project_id=$2 AND created_at>=now()-interval '360 days' AND event_data->>'blob_id' IS NULL AND NOT(event_data ? 'memoia_v2') ORDER BY created_at DESC,id LIMIT 100`,
        params(scope),
      ),
    ]);
    const sorted: Array<{ id: string; at: Date; kind: string }> = [
      ...facts.rows.map((row) => ({ id: row.id, at: row.at, kind: "fact" })),
      ...events.rows.map((row) => ({ id: row.id, at: row.at, kind: "event" })),
    ]
      .sort(
        (a, b) =>
          new Date(b.at).getTime() - new Date(a.at).getTime() ||
          a.id.localeCompare(b.id),
      )
      .slice(0, 100);
    legacy = sorted
      .filter((row) => row.kind === "event")
      .map((row) => ({ id: row.id, score: 1000 - sorted.indexOf(row) }));
    factsRank = sorted
      .filter((row) => row.kind === "fact")
      .map((row) => ({ id: row.id, score: 1000 - sorted.indexOf(row) }));
  }
  return snapshot(runtime, async (tx) => {
    const facts = await hydrateFacts(
      tx,
      scope,
      factsRank.map((x) => x.id),
    );
    const events = legacy.length
      ? (
          await tx.query(
            `SELECT id,event_data FROM memoia.user_events WHERE user_id=$1 AND project_id=$2 AND id=ANY($3::uuid[]) AND event_data->>'blob_id' IS NULL AND NOT(event_data ? 'memoia_v2')`,
            [...params(scope), legacy.map((x) => x.id)],
          )
        ).rows
      : [];
    const eventMap = new Map(
      events.map((row) => [row.id, row.event_data?.event_tip ?? ""]),
    );
    const candidates = [
      ...factsRank.flatMap((x) => {
        const found = facts.get(x.id);
        return found
          ? [{ ...x, entry: contextEntry(found.row, found.proof) }]
          : [];
      }),
      ...legacy.flatMap((x) =>
        eventMap.has(x.id) ? [{ ...x, entry: eventMap.get(x.id) }] : [],
      ),
    ].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const entries: string[] = [];
    for (const item of candidates) {
      const next = [...entries, item.entry].join("\n\n");
      if (item.entry && countTokens(next) <= (input.max_token_size ?? 8192))
        entries.push(item.entry);
    }
    return { context: entries.join("\n\n"), entries };
  });
}
export async function getConfig(runtime: Runtime, projectId: string) {
  const r = await runtime.db.query(
    "SELECT profile_config FROM memoia.projects WHERE project_id=$1",
    [projectId],
  );
  if (!r.rowCount)
    throw new SourceError("project_not_found", "Project not found", 404, false);
  return { profile_config: r.rows[0].profile_config ?? "" };
}
export async function updateConfig(
  runtime: Runtime,
  projectId: string,
  body: { profile_config: string },
) {
  let config: any;
  try {
    config = parseYaml(body.profile_config);
  } catch {
    throw new SourceError(
      "invalid_config",
      "Invalid project configuration",
      400,
      false,
    );
  }
  const allowed = [
    "language",
    "llm_model",
    "reasoning_effort",
    "fact_llm_model",
    "fact_reasoning_effort",
    "fact_temperature",
    "additional_user_profiles",
    "overwrite_user_profiles",
    "event_tags",
  ];
  if (
    body.profile_config.length > 65535 ||
    (config != null &&
      (typeof config !== "object" ||
        Array.isArray(config) ||
        Object.keys(config).some((k) => !allowed.includes(k))))
  )
    throw new SourceError(
      "invalid_config",
      "Invalid project configuration",
      400,
      false,
    );
  config = config ?? {};
  const validSubTopic = (v: any) =>
    typeof v === "string" ||
    (v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof v.name === "string" &&
      Object.keys(v).every((k) =>
        ["name", "description", "update_description"].includes(k),
      ) &&
      (v.description == null || typeof v.description === "string") &&
      (v.update_description == null ||
        typeof v.update_description === "string"));
  const validTopic = (v: any) =>
    v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    typeof v.topic === "string" &&
    Object.keys(v).every((k) =>
      ["topic", "description", "sub_topics"].includes(k),
    ) &&
    (v.sub_topics === undefined ||
      (Array.isArray(v.sub_topics) && v.sub_topics.every(validSubTopic)));
  if (
    ["llm_model", "fact_llm_model"].some(
      (k) =>
        config[k] != null &&
        (typeof config[k] !== "string" || !config[k].trim()),
    ) ||
    ["reasoning_effort", "fact_reasoning_effort"].some(
      (k) =>
        config[k] != null &&
        !["none", "minimal", "low", "medium", "high", "xhigh"].includes(
          config[k],
        ),
    ) ||
    (config.fact_temperature != null &&
      (typeof config.fact_temperature !== "number" ||
        !Number.isFinite(config.fact_temperature) ||
        config.fact_temperature < 0 ||
        config.fact_temperature > 2)) ||
    ["additional_user_profiles", "overwrite_user_profiles"].some(
      (k) =>
        config[k] != null &&
        (!Array.isArray(config[k]) || !config[k].every(validTopic)),
    )
  )
    throw new SourceError(
      "invalid_config",
      "Invalid project configuration",
      400,
      false,
    );
  const r = await runtime.db.query(
    "UPDATE memoia.projects SET profile_config=$2 WHERE project_id=$1 RETURNING project_id",
    [projectId, body.profile_config],
  );
  if (!r.rowCount)
    throw new SourceError("project_not_found", "Project not found", 404, false);
}
export async function getUsage(
  runtime: Runtime,
  projectId: string,
  days: number,
) {
  const r = await runtime.db.query(
    `SELECT (current_date - n)::text AS date,
    COALESCE(sum(c.value) FILTER(WHERE c.name='insert_blob_request'),0)::text AS total_insert,
    COALESCE(sum(c.value) FILTER(WHERE c.name='insert_blob_success_request'),0)::text AS total_success_insert,
    COALESCE(sum(c.value) FILTER(WHERE c.name='llm_input_tokens'),0)::text AS total_input_token,
    COALESCE(sum(c.value) FILTER(WHERE c.name='llm_output_tokens'),0)::text AS total_output_token,
    COALESCE(sum(c.value) FILTER(WHERE c.name='llm_usage_unknown'),0)=0 AS usage_complete
    FROM generate_series(0,$2::int-1) n LEFT JOIN memoia.usage_counters c ON c.project_id=$1
      AND c.period_type='day' AND c.period_start=current_date-n AND c.expires_at>now()
    GROUP BY n ORDER BY n`,
    [projectId, days],
  );
  return {
    usages: r.rows.map((row) => ({
      ...row,
      total_insert: Number(row.total_insert),
      total_success_insert: Number(row.total_success_insert),
      total_input_token: Number(row.total_input_token),
      total_output_token: Number(row.total_output_token),
    })),
  };
}
