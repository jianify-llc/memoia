import type { Database } from "./db";

export type Scope = "read" | "write" | "admin";
export type Principal = { projectId: string; scopes: Scope[]; isRoot: boolean };

async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

async function equalSecret(left: string, right: string): Promise<boolean> {
  const a = await digest(left),
    b = await digest(right);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Authenticate against current project/key state on every request. */
export async function authenticate(
  db: Database,
  authorization: string | null,
  rootToken?: string,
): Promise<Principal | null> {
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice(7).trim();
  if (!token || token.includes(" ")) return null;
  if (rootToken?.trim() && (await equalSecret(token, rootToken.trim()))) {
    return { projectId: "__root__", scopes: ["admin"], isRoot: true };
  }
  if (token.startsWith("mka_")) {
    const match = /^mka_([a-fA-F0-9-]+)_(.+)$/.exec(token);
    if (!match) return null;
    const raw = match[1].replace(/-/g, "");
    if (!/^[a-fA-F0-9]{32}$/.test(raw)) return null;
    const id = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
    const result = await db.query<{
      project_id: string;
      scopes: Scope[];
      token_hash: string;
    }>(
      `SELECT k.project_id,k.scopes,k.token_hash FROM memoia.project_api_keys k
       JOIN memoia.projects p ON p.project_id=k.project_id
       WHERE k.id=$1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now()) AND p.status<>'suspended'`,
      [id],
    );
    const row = result.rows[0];
    if (!row || !(await equalSecret(await digest(token), row.token_hash)))
      return null;
    return { projectId: row.project_id, scopes: row.scopes, isRoot: false };
  }
  const match = /^sk-(.+)-([^-]+)$/.exec(token);
  if (!match) return null;
  const result = await db.query<{ project_id: string; project_secret: string }>(
    `SELECT project_id,project_secret FROM memoia.projects WHERE project_id=$1 AND status<>'suspended'`,
    [match[1]],
  );
  const row = result.rows[0];
  if (!row || !(await equalSecret(token, row.project_secret))) return null;
  return { projectId: row.project_id, scopes: ["admin"], isRoot: false };
}

export function requiredScope(method: string, path: string): Scope {
  const read =
    ["GET", "HEAD", "OPTIONS"].includes(method) ||
    (method === "POST" &&
      /\/(context|search|facts\/query|events\/query|profiles\/query)$/.test(
        path,
      ));
  if (read) return "read";
  return path === "/api/project/config" ? "admin" : "write";
}

export function allows(principal: Principal, scope: Scope): boolean {
  return principal.scopes.includes("admin") || principal.scopes.includes(scope);
}
