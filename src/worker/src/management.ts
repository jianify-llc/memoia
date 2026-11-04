import type { Database } from "./db";
import type { Principal, Scope } from "./auth";
import { SourceError } from "./errors";

function authorize(
  principal: Principal,
  projectId?: string,
  root = false,
): void {
  if (principal.isRoot) return;
  if (root || !principal.scopes.includes("admin"))
    throw new SourceError(
      "forbidden",
      "Project administration requires an administrator",
      403,
      false,
    );
  if (projectId !== undefined && projectId !== principal.projectId)
    throw new SourceError(
      "forbidden",
      "Project is outside this key's scope",
      403,
      false,
    );
}
function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
function randomUrl(bytes: number): string {
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(bytes)))
    s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function tokenHash(value: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
const missing = (kind: string): never => {
  throw new SourceError("not_found", `${kind} not found`, 404, false);
};

export async function listProjects(
  db: Database,
  principal: Principal,
  limit: number,
  offset: number,
) {
  authorize(principal);
  const r = await db.query(
    `SELECT project_id,status,created_at FROM memoia.projects
    WHERE ($1::boolean OR project_id=$2) ORDER BY project_id LIMIT $3 OFFSET $4`,
    [principal.isRoot, principal.projectId, limit, offset],
  );
  return { projects: r.rows };
}
export async function createProject(
  db: Database,
  principal: Principal,
  projectId: string,
) {
  authorize(principal, undefined, true);
  try {
    return await db.transaction(async (tx) => {
      const r = await tx.query(
        `INSERT INTO memoia.projects (id,project_id,project_secret,status)
        VALUES ($1,$2,$3,'active') RETURNING project_id,status,created_at`,
        [crypto.randomUUID(), projectId, `sk-${projectId}-${randomHex(32)}`],
      );
      const billingId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO memoia.billings (id,usage_left,next_refill_at) VALUES ($1,-1,date_trunc('month',now())+interval '1 month')`,
        [billingId],
      );
      await tx.query(
        `INSERT INTO memoia.project_billings (project_id,billing_id) VALUES ($1,$2)`,
        [projectId, billingId],
      );
      return r.rows[0];
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505")
      throw new SourceError(
        "project_exists",
        "Project already exists",
        409,
        false,
      );
    throw error;
  }
}
export async function updateProject(
  db: Database,
  principal: Principal,
  projectId: string,
  status: "active" | "suspended",
) {
  authorize(principal, undefined, true);
  if (projectId === "__root__")
    throw new SourceError(
      "project_conflict",
      "The bootstrap project cannot be suspended",
      409,
      false,
    );
  const r = await db.query(
    `UPDATE memoia.projects SET status=$2 WHERE project_id=$1 RETURNING project_id,status,created_at`,
    [projectId, status],
  );
  return r.rows[0] ?? missing("Project");
}
export async function listKeys(
  db: Database,
  principal: Principal,
  projectId: string,
  limit: number,
  offset: number,
) {
  authorize(principal, projectId);
  const r = await db.query(
    `SELECT id AS key_id,name,scopes,expires_at,revoked_at,created_at FROM memoia.project_api_keys
    WHERE project_id=$1 ORDER BY created_at,id LIMIT $2 OFFSET $3`,
    [projectId, limit, offset],
  );
  return { keys: r.rows };
}
export async function createKey(
  db: Database,
  principal: Principal,
  projectId: string,
  body: { name: string; scopes: Scope[]; expires_at?: string | null },
) {
  authorize(principal, projectId);
  if (
    new Set(body.scopes).size !== body.scopes.length ||
    (body.expires_at && Date.parse(body.expires_at) <= Date.now())
  )
    throw new SourceError(
      "invalid_request",
      "Invalid scopes or expiry",
      422,
      false,
    );
  const id = crypto.randomUUID();
  const token = `mka_${id.replace(/-/g, "")}_${randomUrl(32)}`;
  const hash = await tokenHash(token);
  const r = await db.query(
    `INSERT INTO memoia.project_api_keys (id,project_id,name,scopes,expires_at,token_hash)
    SELECT $1,project_id,$3,$4::jsonb,$5,$6 FROM memoia.projects WHERE project_id=$2
    RETURNING id AS key_id,name,scopes,expires_at,revoked_at,created_at`,
    [
      id,
      projectId,
      body.name,
      JSON.stringify(body.scopes),
      body.expires_at ?? null,
      hash,
    ],
  );
  if (!r.rowCount) return missing("Project");
  return { ...r.rows[0], token };
}
export async function revokeKey(
  db: Database,
  principal: Principal,
  projectId: string,
  keyId: string,
): Promise<void> {
  authorize(principal, projectId);
  const r = await db.query(
    `UPDATE memoia.project_api_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE project_id=$1 AND id=$2 RETURNING id`,
    [projectId, keyId],
  );
  if (!r.rowCount) missing("Key");
}
export async function rotateLegacyToken(
  db: Database,
  principal: Principal,
  projectId: string,
) {
  authorize(principal, projectId);
  const token = `sk-${projectId}-${randomHex(32)}`;
  const r = await db.query(
    `UPDATE memoia.projects SET project_secret=$2 WHERE project_id=$1 RETURNING project_id`,
    [projectId, token],
  );
  if (!r.rowCount) return missing("Project");
  return { token };
}

import {
  acquireUserLease,
  assertUserLease,
  finishUserLease,
  releaseUserLease,
  lockIdentity,
} from "./db";
import type { Sql, UserScope } from "./db";

async function userWrite<T>(
  db: Database,
  scope: UserScope,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  const lease = await acquireUserLease(db, scope, 30_000);
  try {
    return await db.transaction(async (tx) => {
      await assertUserLease(tx, lease);
      const result = await fn(tx);
      await finishUserLease(tx, lease);
      return result;
    });
  } catch (error) {
    try {
      await releaseUserLease(db, lease);
    } catch {
      /* Preserve the original failure. */
    }
    throw error;
  }
}
export async function createUser(
  db: Database,
  projectId: string,
  body: { id?: string | null; data?: unknown },
) {
  const id = body.id ?? crypto.randomUUID();
  try {
    await db.transaction(async (tx) => {
      await lockIdentity(tx, { projectId, userId: id });
      const tombstone = await tx.query(
        "SELECT 1 FROM memoia.memory_user_tombstones WHERE user_id=$1 AND project_id=$2",
        [id, projectId],
      );
      if (tombstone.rowCount)
        throw new SourceError(
          "user_forgotten",
          "User identity was permanently forgotten",
          403,
          false,
        );
      await tx.query(
        "INSERT INTO memoia.users (id,project_id,additional_fields) VALUES ($1,$2,$3::jsonb)",
        [id, projectId, JSON.stringify(body.data ?? null)],
      );
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505")
      throw new SourceError("user_exists", "User already exists", 409, false);
    throw error;
  }
  return { id };
}
export async function getUser(db: Database, scope: UserScope) {
  const r = await db.query(
    "SELECT additional_fields AS data, NULL AS id,created_at,updated_at FROM memoia.users WHERE id=$1 AND project_id=$2",
    [scope.userId, scope.projectId],
  );
  return r.rows[0] ?? missing("User");
}
export async function listUsers(
  db: Database,
  projectId: string,
  options: {
    search: string;
    orderBy: "updated_at" | "profile_count" | "event_count";
    descending: boolean;
    limit: number;
    offset: number;
  },
) {
  const order =
    options.orderBy === "updated_at" ? "u.updated_at" : options.orderBy;
  const args = [
    projectId,
    `%${options.search}%`,
    options.limit,
    options.offset,
  ];
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT u.id,u.project_id,u.additional_fields,u.created_at,u.updated_at,
      (SELECT count(*)::int FROM memoia.user_profiles p WHERE p.user_id=u.id AND p.project_id=u.project_id) AS profile_count,
      (SELECT count(*)::int FROM memoia.user_events e WHERE e.user_id=u.id AND e.project_id=u.project_id) AS event_count
      FROM memoia.users u WHERE u.project_id=$1 AND u.id::text LIKE $2 ORDER BY ${order} ${options.descending ? "DESC" : "ASC"},u.id LIMIT $3 OFFSET $4`,
      args,
    ),
    db.query(
      "SELECT count(*)::int AS count FROM memoia.users WHERE project_id=$1 AND id::text LIKE $2",
      args.slice(0, 2),
    ),
  ]);
  return { users: rows.rows, count: count.rows[0].count };
}
export async function addProfile(
  db: Database,
  scope: UserScope,
  body: { content: string; topic: string; sub_topic: string },
) {
  const id = crypto.randomUUID();
  await userWrite(db, scope, (tx) =>
    tx.query(
      "INSERT INTO memoia.user_profiles (id,user_id,project_id,content,attributes) VALUES ($1,$2,$3,$4,$5::jsonb)",
      [
        id,
        scope.userId,
        scope.projectId,
        body.content,
        JSON.stringify({
          topic: body.topic,
          sub_topic: body.sub_topic,
          _impact_fact_ids: [],
        }),
      ],
    ),
  );
  return { id };
}
export async function updateProfile(
  db: Database,
  scope: UserScope,
  id: string,
  body: { content: string; topic: string; sub_topic: string },
) {
  await userWrite(db, scope, async (tx) => {
    const r = await tx.query(
      `UPDATE memoia.user_profiles SET content=$4,attributes=$5::jsonb || COALESCE((SELECT jsonb_object_agg(k,v) FROM jsonb_each(COALESCE(attributes,'{}'::jsonb)) AS old(k,v) WHERE k='_impact_fact_ids' OR (attributes->>'memoia_v2'='true' AND k IN ('memoia_v2','fact_ids','source_ids'))),'{}'::jsonb),
      revision=revision+1,updated_at=now() WHERE id=$3 AND user_id=$1 AND project_id=$2 RETURNING id`,
      [
        scope.userId,
        scope.projectId,
        id,
        body.content,
        JSON.stringify({ topic: body.topic, sub_topic: body.sub_topic }),
      ],
    );
    if (!r.rowCount) missing("Profile");
  });
}
export async function deleteProfile(
  db: Database,
  scope: UserScope,
  id: string,
) {
  await userWrite(db, scope, async (tx) => {
    const r = await tx.query(
      "DELETE FROM memoia.user_profiles WHERE id=$3 AND user_id=$1 AND project_id=$2 RETURNING id",
      [scope.userId, scope.projectId, id],
    );
    if (!r.rowCount) missing("Profile");
  });
}
export async function deleteEvent(db: Database, scope: UserScope, id: string) {
  await userWrite(db, scope, async (tx) => {
    const r = await tx.query(
      "SELECT id FROM memoia.user_events WHERE id=$3 AND user_id=$1 AND project_id=$2 FOR UPDATE",
      [scope.userId, scope.projectId, id],
    );
    if (!r.rowCount) missing("Event");
    await tx.query(
      "UPDATE memoia.memory_blobs SET event_deleted=true WHERE event_id=$3 AND user_id=$1 AND project_id=$2",
      [scope.userId, scope.projectId, id],
    );
    await tx.query(
      "INSERT INTO memoia.memory_deleted_events (id,user_id,project_id) VALUES ($3,$1,$2) ON CONFLICT DO NOTHING",
      [scope.userId, scope.projectId, id],
    );
    await tx.query(
      "DELETE FROM memoia.user_events WHERE id=$3 AND user_id=$1 AND project_id=$2",
      [scope.userId, scope.projectId, id],
    );
  });
}
