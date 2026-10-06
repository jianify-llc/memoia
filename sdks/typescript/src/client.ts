import type { components, paths } from "./generated/openapi.js";
import * as generated from "./generated/validators.js";

type JsonBody<T> = T extends { content: { "application/json": infer R } } ? R : never;
type ResponseBody<T> = T extends { responses: infer R } ? JsonBody<R[Extract<keyof R, 200 | 201>]> : never;
type RequestBody<T> = T extends { requestBody: { content: { "application/json": infer R } } } ? R : never;
export type Operation = ResponseBody<paths["/api/users/{user_id}/blobs"]["post"]>;
export type ForgottenUser = ResponseBody<paths["/api/users/{user_id}"]["delete"]>;
export type Operations = ResponseBody<paths["/api/users/{user_id}/operations"]["get"]>;
export type SourceQuery = NonNullable<paths["/api/users/{user_id}/sources/{source_id}"]["get"]["parameters"]["query"]>;
type SourcesQuery = NonNullable<paths["/api/users/{user_id}/sources"]["get"]["parameters"]["query"]>;
type HistoryQuery = NonNullable<paths["/api/users/{user_id}/history"]["get"]["parameters"]["query"]>;
type OperationsQuery = NonNullable<paths["/api/users/{user_id}/operations"]["get"]["parameters"]["query"]>;
export type BlobImport = RequestBody<paths["/api/users/{user_id}/blobs"]["post"]>;
export type MessageDeletion = RequestBody<paths["/api/users/{user_id}/sources/{source_id}/messages"]["delete"]>;
export type Blob = ResponseBody<paths["/api/users/{user_id}/blobs/{blob_id}"]["get"]>;
export type Profiles = ResponseBody<paths["/api/users/{user_id}/profiles"]["get"]>;
export type Sources = ResponseBody<paths["/api/users/{user_id}/sources"]["get"]>;
export type Source = ResponseBody<paths["/api/users/{user_id}/sources/{source_id}"]["get"]>;
export type History = ResponseBody<paths["/api/users/{user_id}/history"]["get"]>;
export type Search = ResponseBody<paths["/api/users/{user_id}/search"]["post"]>;
export type ContextInput = RequestBody<paths["/api/users/{user_id}/context"]["post"]>;
export type Context = ResponseBody<paths["/api/users/{user_id}/context"]["post"]>;
export type UserInput = RequestBody<paths["/api/users"]["post"]>;
export type UserId = ResponseBody<paths["/api/users"]["post"]>;
export type User = ResponseBody<paths["/api/users/{user_id}"]["get"]>;
export type Users = ResponseBody<paths["/api/users"]["get"]>;
export type UsersQuery = NonNullable<paths["/api/users"]["get"]["parameters"]["query"]>;
export type Events = ResponseBody<paths["/api/users/{user_id}/events"]["get"]>;
export type EventsQuery = NonNullable<paths["/api/users/{user_id}/events"]["get"]["parameters"]["query"]>;
export type ProfileInput = RequestBody<paths["/api/users/{user_id}/profiles"]["post"]>;
export type ProfileId = ResponseBody<paths["/api/users/{user_id}/profiles"]["post"]>;
export type ProfileConfig = ResponseBody<paths["/api/project/config"]["get"]>;
export type Usage = ResponseBody<paths["/api/project/usage"]["get"]>;
export type UsageQuery = NonNullable<paths["/api/project/usage"]["get"]["parameters"]["query"]>;
export type EventTime = components["schemas"]["EventTime"];
export type Evidence = components["schemas"]["Evidence"];
export type Projects = ResponseBody<paths["/api/projects"]["get"]>;
export type ManagedProject = ResponseBody<paths["/api/projects"]["post"]>;
export type ProjectCreate = RequestBody<paths["/api/projects"]["post"]>;
export type ProjectUpdate = RequestBody<paths["/api/projects/{project_id}"]["patch"]>;
type ProjectsQuery = NonNullable<paths["/api/projects"]["get"]["parameters"]["query"]>;
export type Keys = ResponseBody<paths["/api/projects/{project_id}/keys"]["get"]>;
type KeysQuery = NonNullable<paths["/api/projects/{project_id}/keys"]["get"]["parameters"]["query"]>;
export type KeyCreate = RequestBody<paths["/api/projects/{project_id}/keys"]["post"]>;
export type IssuedKey = ResponseBody<paths["/api/projects/{project_id}/keys"]["post"]>;
export type LegacyToken = ResponseBody<paths["/api/projects/{project_id}/legacy-token/rotate"]["post"]>;

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

  importBlob(userId: string, input: BlobImport, options?: RequestOptions): Promise<Operation> {
    if (!validators.validateImport(input)) throw new MemoiaError("INVALID_INPUT", null, false);
    return this.request("POST", `${this.userPath(userId)}/blobs`,
      (value) => operationValidator(value) && (value as Operation).blob_id !== null &&
        (value as Operation).source_id === input.source_id, options, input);
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

  getSource(userId: string, sourceId: string, options?: RequestOptions, page?: SourceQuery): Promise<Source> {
    if (!validators.validateSourceQuery(page ?? {})) throw new MemoiaError("INVALID_INPUT", null, false);
    const query = new URLSearchParams(Object.entries(page ?? {}).filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]));
    const path = `${this.userPath(userId)}/sources/${segment(sourceId)}`;
    return this.request("GET", query.size ? `${path}?${query}` : path,
      (value) => validators.validateSource(value) && (value as Source).source_id === sourceId, options);
  }

  getBlob(userId: string, blobId: string, options?: RequestOptions): Promise<Blob> {
    return this.request("GET", `${this.userPath(userId)}/blobs/${segment(blobId)}`,
      (value) => validators.validateBlob(value) && (value as Blob).blob_id.toLowerCase() === blobId.toLowerCase(), options);
  }

  deleteMessages(userId: string, sourceId: string, input: MessageDeletion, options?: RequestOptions): Promise<Operation> {
    if (!validators.validateMessageDeletion(input)) throw new MemoiaError("INVALID_INPUT", null, false);
    return this.request("DELETE", `${this.userPath(userId)}/sources/${segment(sourceId)}/messages`,
      (value) => operationValidator(value) && (value as Operation).source_id === sourceId, options, input);
  }

  /** 永久遗忘只接受同一 UUID 的提交回执；未知结果由调用方显式再次确认。 */
  forgetUser(userId: string, options?: RequestOptions): Promise<ForgottenUser> {
    if (!validators.validateForgetUserPath({ user_id: userId })) throw new MemoiaError("INVALID_INPUT", null, false);
    const validate: Validator = (value) => validators.validateForgottenUser(value) && (value as ForgottenUser).user_id.toLowerCase() === userId.toLowerCase();
    return this.request("DELETE", this.userPath(userId), validate, options, undefined, 200);
  }

  getProfiles(userId: string, options?: RequestOptions): Promise<Profiles> {
    return this.request("GET", `${this.userPath(userId)}/profiles`, validators.validateProfiles, options);
  }

  getHistory(userId: string, options?: RequestOptions & HistoryQuery): Promise<History> {
    return this.request("GET", this.page(`${this.userPath(userId)}/history`, options, validators.validateHistoryQuery), validators.validateHistory, options);
  }

  search(userId: string, query: string, limit = 10, options?: RequestOptions): Promise<Search> {
    const input = { query, limit };
    if (!validators.validateSearchInput(input)) throw new MemoiaError("INVALID_INPUT", null, false);
    // 查询是私密正文；只读 POST 沿用读取超时和重试分类，不进入 URL。
    return this.request("POST", `${this.userPath(userId)}/search`, validators.validateSearch, options, input, undefined, true);
  }

  getContext(userId: string, input: ContextInput, options?: RequestOptions): Promise<Context> {
    if (!validators.validateContextInput(input)) throw new MemoiaError("INVALID_INPUT", null, false);
    return this.request("POST", `${this.userPath(userId)}/context`,
      (value) => validators.validateContext(value) && (value as Context).context === (value as Context).entries.join("\n\n"),
      options, input, undefined, true);
  }

  createUser(input: UserInput = {}, options?: RequestOptions): Promise<UserId> {
    if (!validators.validateUserInput(input)) throw new MemoiaError("INVALID_INPUT", null, false);
    return this.request("POST", "/api/users", validators.validateUserId, options, input, 201);
  }

  getUser(userId: string, options?: RequestOptions): Promise<User> {
    return this.request("GET", this.userPath(userId), validators.validateUser, options);
  }

  listUsers(options?: RequestOptions & UsersQuery): Promise<Users> {
    return this.request("GET", this.page("/api/users", options, validators.validateUsersQuery), validators.validateUsers, options);
  }

  getEvents(userId: string, options?: RequestOptions & EventsQuery): Promise<Events> {
    return this.request("GET", this.page(`${this.userPath(userId)}/events`, options, validators.validateEventsQuery), validators.validateEvents, options);
  }

  addProfile(userId: string, input: ProfileInput, options?: RequestOptions): Promise<ProfileId> {
    if (!validators.validateProfileInput(input)) throw new MemoiaError("INVALID_INPUT", null, false);
    return this.request("POST", `${this.userPath(userId)}/profiles`, validators.validateProfileId, options, input, 201);
  }

  updateProfile(userId: string, profileId: string, input: ProfileInput, options?: RequestOptions): Promise<void> {
    if (!validators.validateProfileInput(input)) throw new MemoiaError("INVALID_INPUT", null, false);
    return this.request("PATCH", `${this.userPath(userId)}/profiles/${segment(profileId)}`, (value) => value === undefined, options, input);
  }

  deleteProfile(userId: string, profileId: string, options?: RequestOptions): Promise<void> {
    return this.request("DELETE", `${this.userPath(userId)}/profiles/${segment(profileId)}`, (value) => value === undefined, options);
  }

  deleteEvent(userId: string, eventId: string, options?: RequestOptions): Promise<void> {
    return this.request("DELETE", `${this.userPath(userId)}/events/${segment(eventId)}`, (value) => value === undefined, options);
  }

  getConfig(options?: RequestOptions): Promise<ProfileConfig> {
    return this.request("GET", "/api/project/config", validators.validateConfig, options);
  }

  updateConfig(input: ProfileConfig, options?: RequestOptions): Promise<void> {
    if (!validators.validateConfig(input)) throw new MemoiaError("INVALID_INPUT", null, false);
    return this.request("PATCH", "/api/project/config", (value) => value === undefined, options, input);
  }

  getUsage(lastDays = 7, options?: RequestOptions): Promise<Usage> {
    if (!validators.validateUsageQuery({ last_days: lastDays })) throw new MemoiaError("INVALID_INPUT", null, false);
    return this.request("GET", `/api/project/usage?last_days=${lastDays}`, validators.validateUsage, options);
  }

  listProjects(options?: RequestOptions & ProjectsQuery): Promise<Projects> {
    return this.request("GET", this.page("/api/projects", options, validators.validateProjectsQuery), validators.validateProjects, options);
  }

  createProject(input: ProjectCreate, options?: RequestOptions): Promise<ManagedProject> {
    if (!validators.validateProjectCreate(input)) throw new MemoiaError("INVALID_INPUT", null, false);
    return this.request("POST", "/api/projects", validators.validateProject, options, input);
  }

  updateProject(projectId: string, input: ProjectUpdate, options?: RequestOptions): Promise<ManagedProject> {
    if (!validators.validateProjectUpdate(input)) throw new MemoiaError("INVALID_INPUT", null, false);
    return this.request("PATCH", `/api/projects/${segment(projectId)}`, validators.validateProject, options, input);
  }

  listKeys(projectId: string, options?: RequestOptions & KeysQuery): Promise<Keys> {
    return this.request("GET", this.page(`/api/projects/${segment(projectId)}/keys`, options, validators.validateKeysQuery), validators.validateKeys, options);
  }

  createKey(projectId: string, input: KeyCreate, options?: RequestOptions): Promise<IssuedKey> {
    if (!validators.validateKeyCreate(input)) throw new MemoiaError("INVALID_INPUT", null, false);
    return this.request("POST", `/api/projects/${segment(projectId)}/keys`, validators.validateIssuedKey, options, input);
  }

  revokeKey(projectId: string, keyId: string, options?: RequestOptions): Promise<void> {
    return this.request("DELETE", `/api/projects/${segment(projectId)}/keys/${segment(keyId)}`, (value) => value === undefined, options);
  }

  /** Explicit credential replacement; existing clients immediately lose access. */
  rotateLegacyToken(projectId: string, options?: RequestOptions): Promise<LegacyToken> {
    return this.request("POST", `/api/projects/${segment(projectId)}/legacy-token/rotate`, validators.validateLegacyToken, options);
  }

  private userPath(userId: string): string {
    return `/api/users/${segment(userId)}`;
  }

  private page(path: string, options: object | undefined, validate: Validator): string {
    const query = Object.fromEntries(Object.entries(options ?? {}).filter(([key, value]) => !["deadline", "signal"].includes(key) && value !== undefined));
    if (!validate(query)) throw new MemoiaError("INVALID_INPUT", null, false);
    const encoded = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)])).toString();
    return encoded ? `${path}?${encoded}` : path;
  }

  private async request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, validate: Validator, options: RequestOptions = {}, body?: unknown, successStatus?: number, readOnly = method === "GET"): Promise<T> {
    const limit = readOnly ? this.readTimeout : this.writeTimeout;
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
        // Runtime fetch requires its global receiver, not a MemoiaClient instance.
        // A standalone call also preserves explicitly bound custom transports.
        const transport = this.transport;
        const response = await transport(`${this.origin}${path}`, {
          method, redirect: "manual", cache: "no-store", signal: controller.signal,
          headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        // Never follow a redirect with project credentials. A mutation may
        // already have executed before its redirect response, so query its key.
        if (response.status >= 300 && response.status < 400) {
          throw new MemoiaError("REDIRECT_REJECTED", response.status, false, readOnly ? "rejected" : "unknown");
        }
        if (response.status === 204) {
          if (!validate(undefined)) throw new MemoiaError("INVALID_RESPONSE", response.status, false, readOnly ? "rejected" : "unknown");
          return undefined as T;
        }
        let payload: unknown;
        try { payload = await response.json(); } catch {
          throw new MemoiaError("INVALID_RESPONSE", response.status, false, readOnly ? "rejected" : "unknown");
        }
        if (response.ok) {
          if (successStatus !== undefined && response.status !== successStatus) throw new MemoiaError("INVALID_RESPONSE", response.status, false, readOnly ? "rejected" : "unknown");
          if (!validate(payload)) throw new MemoiaError("INVALID_RESPONSE", response.status, false, readOnly ? "rejected" : "unknown");
          return payload as T;
        }
        // SDK 只自动重试读取；写入恢复由业务 owner 查询原回执后显式决定。
        // 服务端 retryable 表示故障可恢复，不能证明通用 5xx 未提交。
        const detail = this.errorDetail(payload);
        const unknownWriteFailure = !readOnly && response.status >= 500;
        const recoverableConflict = response.status === 409 && ["write_conflict", "lease_lost"].includes(detail.code);
        const retryable = detail.retryable && (recoverableConflict || [429, 500, 502, 503, 504].includes(response.status));
        error = new MemoiaError(detail.code, response.status, retryable, unknownWriteFailure ? "unknown" : "rejected");
      } catch (cause) {
        error = cause instanceof MemoiaError ? cause : new MemoiaError("TRANSPORT_ERROR", null, readOnly, readOnly ? "rejected" : "unknown");
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", cancel);
      }
      if (!readOnly || !error.retryable || options.signal?.aborted || attempt + 1 === this.attempts) throw error;
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
