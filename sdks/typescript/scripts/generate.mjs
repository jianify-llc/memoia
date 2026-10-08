import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";
import { build } from "esbuild";

const apiUrl = new URL("../../../src/server/api/openapi.json", import.meta.url);
const apiText = await readFile(apiUrl, "utf8");
const api = JSON.parse(apiText);
const { version: sdkVersion } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const route = "/api/users/{user_id}";
const targets = {
  validateSearchInput: ["post", `${route}/search`, "request"],
  validateContextInput: ["post", `${route}/context`, "request"],
  validateContext: ["post", `${route}/context`, "response"],
  validateUserInput: ["post", "/api/users", "request"],
  validateUserId: ["post", "/api/users", "response"],
  validateUser: ["get", route, "response"],
  validateUsers: ["get", "/api/users", "response"],
  validateUsersQuery: ["get", "/api/users", "query"],
  validateEvents: ["get", `${route}/events`, "response"],
  validateEventsQuery: ["get", `${route}/events`, "query"],
  validateProfileInput: ["post", `${route}/profiles`, "request"],
  validateProfileId: ["post", `${route}/profiles`, "response"],
  validateConfig: ["get", "/api/project/config", "response"],
  validateUsage: ["get", "/api/project/usage", "response"],
  validateUsageQuery: ["get", "/api/project/usage", "query"],
  validateForgetUserPath: ["delete", route, "path"],
  validateForgottenUser: ["delete", route, "response"],
  validateOperation: ["post", `${route}/blobs`, "response"],
  validateImport: ["post", `${route}/blobs`, "request"],
  validateBlob: ["get", `${route}/blobs/{blob_id}`, "response"],
  validateMessageDeletion: ["delete", `${route}/sources/{source_id}/messages`, "request"],
  validateSources: ["get", `${route}/sources`, "response"],
  validateSource: ["get", `${route}/sources/{source_id}`, "response"],
  validateSourceQuery: ["get", `${route}/sources/{source_id}`, "query"],
  validateProfiles: ["get", `${route}/profiles`, "response"],
  validateSearch: ["post", `${route}/search`, "response"],
  validateHistory: ["get", `${route}/history`, "response"],
  validateOperations: ["get", `${route}/operations`, "response"],
  validateSourcesQuery: ["get", `${route}/sources`, "query"],
  validateHistoryQuery: ["get", `${route}/history`, "query"],
  validateOperationsQuery: ["get", `${route}/operations`, "query"],
  validateMaintenance: ["get", `${route}/maintenance`, "response"],
  validateFlushInput: ["post", `${route}/flush`, "request"],
  validateProjects: ["get", "/api/projects", "response"],
  validateProject: ["post", "/api/projects", "response"],
  validateProjectCreate: ["post", "/api/projects", "request"],
  validateProjectUpdate: ["patch", "/api/projects/{project_id}", "request"],
  validateProjectsQuery: ["get", "/api/projects", "query"],
  validateKeys: ["get", "/api/projects/{project_id}/keys", "response"],
  validateKeysQuery: ["get", "/api/projects/{project_id}/keys", "query"],
  validateKeyCreate: ["post", "/api/projects/{project_id}/keys", "request"],
  validateIssuedKey: ["post", "/api/projects/{project_id}/keys", "response"],
  validateLegacyToken: ["post", "/api/projects/{project_id}/legacy-token/rotate", "response"],
};
const ajv = new Ajv2020({ strict: false, allErrors: true, code: { source: true, esm: true } });
addFormats(ajv);
ajv.addFormat("uuid4", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
ajv.addFormat("uuid5", /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const refs = {};
for (const [name, [method, path, kind]] of Object.entries(targets)) {
  const operation = api.paths[path]?.[method];
  const success = Object.entries(operation?.responses ?? {}).find(([status, response]) => /^2\d\d$/.test(status) && response.content?.["application/json"]);
  const body = kind === "request" ? operation?.requestBody : success?.[1];
  const parameters = operation?.parameters?.filter((parameter) => parameter.in === kind);
  const schema = kind === "query" || kind === "path" ? {
    type: "object", additionalProperties: false,
    properties: Object.fromEntries(parameters.map((parameter) => [parameter.name, parameter.schema])),
    required: parameters.filter((parameter) => parameter.required).map((parameter) => parameter.name),
  } : body?.content?.["application/json"]?.schema;
  if (!schema) throw new Error(`OpenAPI lacks ${kind} schema for ${method} ${path}`);
  const id = `https://memoia.jianify.dev/sdk/${name}`;
  ajv.addSchema({ $id: id, components: api.components, allOf: [schema] });
  refs[name] = id;
}
const standalone = standaloneCode(ajv, refs);
// Bundle generated helpers at build time: Workers must never evaluate schemas
// through new Function, and package consumers need no Ajv runtime dependency.
const bundled = await build({
  stdin: { contents: standalone, resolveDir: fileURLToPath(new URL("..", import.meta.url)), sourcefile: "validators.js" },
  bundle: true, platform: "neutral", format: "esm", target: "es2022", write: false,
});
const generated = {
  "openapi.ts": astToString(await openapiTS(api)),
  "validators.js": `// Generated from server OpenAPI; do not edit.\n${bundled.outputFiles[0].text}`,
  "manifest.json": `${JSON.stringify({ sdkVersion, openapiSha256: createHash("sha256").update(apiText).digest("hex") }, null, 2)}\n`,
};
const checking = process.argv.includes("--check");
for (const [name, content] of Object.entries(generated)) {
  const url = new URL(`../src/generated/${name}`, import.meta.url);
  if (checking) {
    if (await readFile(url, "utf8") !== content) throw new Error(`Generated SDK ${name} is stale; pnpm generate`);
    continue;
  }
  await mkdir(new URL("../src/generated/", import.meta.url), { recursive: true });
  await writeFile(url, content);
}

const docsUrl = new URL("../../../docs/site/openapi.json", import.meta.url);
if (checking) {
  if (await readFile(docsUrl, "utf8") !== apiText) throw new Error("Generated documentation OpenAPI is stale; pnpm generate");
} else await writeFile(docsUrl, apiText);
