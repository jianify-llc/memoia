import type { paths } from "./generated/openapi.js";
import * as generated from "./generated/validators.js";

type JsonBody<T> = T extends { content: { "application/json": infer R } } ? R : never;
type ResponseBody<T> = T extends { responses: infer R } ? JsonBody<R[Extract<keyof R, 200 | 201>]> : never;
type RequestBody<T> = T extends { requestBody: { content: { "application/json": infer R } } } ? R : never;
export type Operation = ResponseBody<paths["/api/v2/users/{user_id}/sources"]["post"]>;
export type Operations = ResponseBody<paths["/api/v2/users/{user_id}/operations"]["get"]>;
type SourcesQuery = NonNullable<paths["/api/v2/users/{user_id}/sources"]["get"]["parameters"]["query"]>;
type HistoryQuery = NonNullable<paths["/api/v2/users/{user_id}/history"]["get"]["parameters"]["query"]>;
type OperationsQuery = NonNullable<paths["/api/v2/users/{user_id}/operations"]["get"]["parameters"]["query"]>;
export type SourceImport = RequestBody<paths["/api/v2/users/{user_id}/sources"]["post"]>;
export type Retraction = RequestBody<paths["/api/v2/users/{user_id}/sources/{source_id}/retract"]["post"]>;
export type Profiles = ResponseBody<paths["/api/v2/users/{user_id}/profiles"]["get"]>;
export type Sources = ResponseBody<paths["/api/v2/users/{user_id}/sources"]["get"]>;
export type Source = ResponseBody<paths["/api/v2/users/{user_id}/sources/{source_id}"]["get"]>;
export type History = ResponseBody<paths["/api/v2/users/{user_id}/history"]["get"]>;
export type Search = ResponseBody<paths["/api/v2/users/{user_id}/search"]["get"]>;
export type Projects = ResponseBody<paths["/api/v2/projects"]["get"]>;
export type ManagedProject = ResponseBody<paths["/api/v2/projects"]["post"]>;
export type ProjectCreate = RequestBody<paths["/api/v2/projects"]["post"]>;
export type ProjectUpdate = RequestBody<paths["/api/v2/projects/{project_id}"]["patch"]>;
type ProjectsQuery = NonNullable<paths["/api/v2/projects"]["get"]["parameters"]["query"]>;
export type Keys = ResponseBody<paths["/api/v2/projects/{project_id}/keys"]["get"]>;
type KeysQuery = NonNullable<paths["/api/v2/projects/{project_id}/keys"]["get"]["parameters"]["query"]>;
export type KeyCreate = RequestBody<paths["/api/v2/projects/{project_id}/keys"]["post"]>;
export type IssuedKey = ResponseBody<paths["/api/v2/projects/{project_id}/keys"]["post"]>;
export type LegacyToken = ResponseBody<paths["/api/v2/projects/{project_id}/legacy-token/rotate"]["post"]>;

type Validator = (value: unknown) => boolean;
const validators = generated as unknown as Record<string, Validator>;
const operationValidator: Validator = (value) => {
  if (!validators.validateOperation(value)) return false;
  const operation = value as Operation;
  if (operation.status === "completed") return operation.result !== null && operation.source_id !== null && operation.error === null;
  if (operation.status === "failed") return operation.result === null && operation.error !== null;
  return operation.status === "processing" && operation.result === null && operation.error === null;
};
const operationsValidator: Validator = (value) => validators.validateOperations(value) && (value as Operations).operations.every(operationValidator);

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  readTimeoutMs?: number;
  writeTimeoutMs?: number;
  maxAttempts?: number;
}

export interface RequestOptions {
  /** Absolute Unix time in milliseconds; retries share this same budget. */
  deadline?: number;
  signal?: AbortSignal;
}

export class MemoiaError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly outcome: "rejected" | "unknown" = "rejected",
  ) {
    super(`Memoia request failed: ${code}`);
    this.name = "MemoiaError";
  }
}

const positive = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
};
const segment = (value: string): string => {
  if (!value || value.includes("/")) throw new TypeError("Identifiers must be nonempty and cannot contain slashes");
  return encodeURIComponent(value);
};

export class MemoiaClient {
  private readonly origin: string;
  private readonly apiKey: string;
  private readonly transport: typeof fetch;
  private readonly readTimeout: number;
  private readonly writeTimeout: number;
  private readonly attempts: number;

  constructor(options: ClientOptions) {
    const url = new URL(options.baseUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new TypeError("Memoia baseUrl must be an HTTP(S) origin without credentials or an API path");
    }
    if (!options.apiKey.trim()) throw new TypeError("Memoia apiKey is required");
    this.origin = url.origin;
    this.apiKey = options.apiKey;
    this.transport = options.fetch ?? fetch;
    this.readTimeout = positive(options.readTimeoutMs ?? 5_000, "readTimeoutMs");
    this.writeTimeout = positive(options.writeTimeoutMs ?? 90_000, "writeTimeoutMs");
    this.attempts = positive(options.maxAttempts ?? 3, "maxAttempts");
    if (this.attempts > 4) throw new TypeError("maxAttempts cannot exceed four");
  }

  importSource(userId: string, input: SourceImport, options?: RequestOptions): Promise<Operation> {
    if (!validators.validateImport(input)) throw new MemoiaError("INVALID_INPUT", null, false);
    return this.request("POST", `${this.userPath(userId)}/sources`, operationValidator, options, input);
  }

  getOperation(userId: string, operationId: string, options?: RequestOptions): Promise<Operation> {
    return this.request("GET", `${this.userPath(userId)}/operations/${segment(operationId)}`, operationValidator, options);
  }

  getOperationByKey(userId: string, key: string, options?: RequestOptions): Promise<Operation> {
    return this.request("GET", `${this.userPath(userId)}/operations/by-key/${segment(key)}`, operationValidator, options);
  }

  /** Resume only the server's durable accepted request, never reconstruct it. */
  retryOperation(userId: string, operationId: string, options?: RequestOptions): Promise<Operation> {
    return this.request("POST", `${this.userPath(userId)}/operations/${segment(operationId)}/retry`, operationValidator, options);
  }

  listOperations(userId: string, options?: RequestOptions & OperationsQuery): Promise<Operations> {
    return this.request("GET", this.page(`${this.userPath(userId)}/operations`, options, validators.validateOperationsQuery), operationsValidator, options);
  }

  listSources(userId: string, options?: RequestOptions & SourcesQuery): Promise<Sources> {
    return this.request("GET", this.page(`${this.userPath(userId)}/sources`, options, validators.validateSourcesQuery), validators.validateSources, options);
  }

  getSource(userId: string, sourceId: string, options?: RequestOptions): Promise<Source> {
    return this.request("GET", `${this.userPath(userId)}/sources/${segment(sourceId)}`, validators.validateSource, options);
  }

  getSourceByExternalId(userId: string, externalId: string, options?: RequestOptions): Promise<Source> {
    return this.request("GET", `${this.userPath(userId)}/sources/by-external-id/${segment(externalId)}`, validators.validateSource, options);
  }

  retractMessages(userId: string, sourceId: string, input: Retraction, options?: RequestOptions): Promise<Operation> {
    if (!validators.validateRetraction(input)) throw new MemoiaError("INVALID_INPUT", null, false);
    return this.request("POST", `${this.userPath(userId)}/sources/${segment(sourceId)}/retract`, operationValidator, options, input);
  }

  getProfiles(userId: string, options?: RequestOptions): Promise<Profiles> {
    return this.request("GET", `${this.userPath(userId)}/profiles`, validators.validateProfiles, options);
  }

  getHistory(userId: string, options?: RequestOptions & HistoryQuery): Promise<History> {
    return this.request("GET", this.page(`${this.userPath(userId)}/history`, options, validators.validateHistoryQuery), validators.validateHistory, options);
  }

  search(userId: string, query: string, limit = 10, options?: RequestOptions): Promise<Search> {
    if (!query.trim() || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new MemoiaError("INVALID_INPUT", null, false);
    const params = new URLSearchParams({ query, limit: String(limit) });
    return this.request("GET", `${this.userPath(userId)}/search?${params}`, validators.validateSearch, options);
  }

  listProjects(options?: RequestOptions & ProjectsQuery): Promise<Projects> {
    return this.request("GET", this.page("/api/v2/projects", options, validators.validateProjectsQuery), validators.validateProjects, options);
  }

  createProject(input: ProjectCreate, options?: RequestOptions): Promise<ManagedProject> {
    if (!validators.validateProjectCreate(input)) throw new MemoiaError("INVALID_INPUT", null, false);
    return this.request("POST", "/api/v2/projects", validators.validateProject, options, input);
  }

  updateProject(projectId: string, input: ProjectUpdate, options?: RequestOptions): Promise<ManagedProject> {
    if (!validators.validateProjectUpdate(input)) throw new MemoiaError("INVALID_INPUT", null, false);
    return this.request("PATCH", `/api/v2/projects/${segment(projectId)}`, validators.validateProject, options, input);
  }

  listKeys(projectId: string, options?: RequestOptions & KeysQuery): Promise<Keys> {
    return this.request("GET", this.page(`/api/v2/projects/${segment(projectId)}/keys`, options, validators.validateKeysQuery), validators.validateKeys, options);
  }

  createKey(projectId: string, input: KeyCreate, options?: RequestOptions): Promise<IssuedKey> {
    if (!validators.validateKeyCreate(input)) throw new MemoiaError("INVALID_INPUT", null, false);
    return this.request("POST", `/api/v2/projects/${segment(projectId)}/keys`, validators.validateIssuedKey, options, input);
  }

  revokeKey(projectId: string, keyId: string, options?: RequestOptions): Promise<void> {
    return this.request("DELETE", `/api/v2/projects/${segment(projectId)}/keys/${segment(keyId)}`, (value) => value === undefined, options);
  }

  /** Explicit credential replacement; existing clients immediately lose access. */
  rotateLegacyToken(projectId: string, options?: RequestOptions): Promise<LegacyToken> {
    return this.request("POST", `/api/v2/projects/${segment(projectId)}/legacy-token/rotate`, validators.validateLegacyToken, options);
  }

  private userPath(userId: string): string {
    return `/api/v2/users/${segment(userId)}`;
  }

  private page(path: string, options: { limit?: number; offset?: number } | undefined, validate: Validator): string {
    const query = { ...(options?.limit === undefined ? {} : { limit: options.limit }), ...(options?.offset === undefined ? {} : { offset: options.offset }) };
    if (!validate(query)) throw new MemoiaError("INVALID_INPUT", null, false);
    const encoded = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)])).toString();
    return encoded ? `${path}?${encoded}` : path;
  }

  private async request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, validate: Validator, options: RequestOptions = {}, body?: unknown): Promise<T> {
    const limit = method === "GET" ? this.readTimeout : this.writeTimeout;
    const deadline = options.deadline ?? Date.now() + limit;
    if (!Number.isFinite(deadline)) throw new TypeError("deadline must be a finite Unix timestamp");
    // A per-request timeout does not cancel server execution. Never retry a
    // mutation after lost transport acknowledgement; its key is the recovery handle.
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || options.signal?.aborted) throw new MemoiaError("BUDGET_EXHAUSTED", null, false);
      const controller = new AbortController();
      const cancel = () => controller.abort(options.signal?.reason);
      options.signal?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => controller.abort(), Math.min(limit, remaining));
      let error: MemoiaError;
      try {
        const response = await this.transport(`${this.origin}${path}`, {
          method, redirect: "error", cache: "no-store", signal: controller.signal,
          headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (response.status === 204) {
          if (!validate(undefined)) throw new MemoiaError("INVALID_RESPONSE", response.status, false, method === "GET" ? "rejected" : "unknown");
          return undefined as T;
        }
        let payload: unknown;
        try { payload = await response.json(); } catch {
          throw new MemoiaError("INVALID_RESPONSE", response.status, false, method === "GET" ? "rejected" : "unknown");
        }
        if (response.ok) {
          if (!validate(payload)) throw new MemoiaError("INVALID_RESPONSE", response.status, false, method === "GET" ? "rejected" : "unknown");
          return payload as T;
        }
        // Only explicit provider-independent server classification authorizes
        // replay. Raw response bodies and credentials never enter error messages.
        const detail = this.errorDetail(payload);
        const unclassifiedWriteFailure = method !== "GET" && response.status >= 500 && detail.code === "HTTP_ERROR";
        error = new MemoiaError(detail.code, response.status, detail.retryable && [429, 500, 502, 503, 504].includes(response.status), unclassifiedWriteFailure ? "unknown" : "rejected");
      } catch (cause) {
        error = cause instanceof MemoiaError ? cause : new MemoiaError("TRANSPORT_ERROR", null, method === "GET", method === "GET" ? "rejected" : "unknown");
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", cancel);
      }
      if (!error.retryable || options.signal?.aborted || attempt + 1 === this.attempts) throw error;
      const delay = Math.min(250 * 2 ** attempt, 1_000);
      if (deadline - Date.now() <= delay) throw error;
      await this.backoff(delay, options.signal);
    }
    throw new MemoiaError("BUDGET_EXHAUSTED", null, false);
  }

  private errorDetail(payload: unknown): { code: string; retryable: boolean } {
    if (typeof payload !== "object" || payload === null || !("detail" in payload)) return { code: "HTTP_ERROR", retryable: false };
    const detail = payload.detail;
    if (typeof detail !== "object" || detail === null) return { code: "HTTP_ERROR", retryable: false };
    const code = "code" in detail && typeof detail.code === "string" && /^[A-Za-z0-9_]{1,80}$/.test(detail.code) ? detail.code : "HTTP_ERROR";
    return { code, retryable: "retryable" in detail && detail.retryable === true };
  }

  private async backoff(delay: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(new MemoiaError("CANCELLED", null, false)); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, delay);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }
}
