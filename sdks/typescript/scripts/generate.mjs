import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";
import { build } from "esbuild";

const apiUrl = new URL("../../../src/server/api/openapi-v2.json", import.meta.url);
const apiText = await readFile(apiUrl, "utf8");
const api = JSON.parse(apiText);
const { version: sdkVersion } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const route = "/api/v2/users/{user_id}";
const targets = {
  validateOperation: ["post", `${route}/sources`, "response"],
  validateImport: ["post", `${route}/sources`, "request"],
  validateRetraction: ["post", `${route}/sources/{source_id}/retract`, "request"],
  validateSources: ["get", `${route}/sources`, "response"],
  validateSource: ["get", `${route}/sources/{source_id}`, "response"],
  validateProfiles: ["get", `${route}/profiles`, "response"],
  validateSearch: ["get", `${route}/search`, "response"],
  validateHistory: ["get", `${route}/history`, "response"],
  validateOperations: ["get", `${route}/operations`, "response"],
  validateSourcesQuery: ["get", `${route}/sources`, "query"],
  validateHistoryQuery: ["get", `${route}/history`, "query"],
  validateOperationsQuery: ["get", `${route}/operations`, "query"],
  validateProjects: ["get", "/api/v2/projects", "response"],
  validateProject: ["post", "/api/v2/projects", "response"],
  validateProjectCreate: ["post", "/api/v2/projects", "request"],
  validateProjectUpdate: ["patch", "/api/v2/projects/{project_id}", "request"],
  validateProjectsQuery: ["get", "/api/v2/projects", "query"],
  validateKeys: ["get", "/api/v2/projects/{project_id}/keys", "response"],
  validateKeysQuery: ["get", "/api/v2/projects/{project_id}/keys", "query"],
  validateKeyCreate: ["post", "/api/v2/projects/{project_id}/keys", "request"],
  validateIssuedKey: ["post", "/api/v2/projects/{project_id}/keys", "response"],
  validateLegacyToken: ["post", "/api/v2/projects/{project_id}/legacy-token/rotate", "response"],
};
const ajv = new Ajv2020({ strict: false, allErrors: true, code: { source: true, esm: true } });
addFormats(ajv);
const refs = {};
for (const [name, [method, path, kind]] of Object.entries(targets)) {
  const operation = api.paths[path]?.[method];
  const success = Object.entries(operation?.responses ?? {}).find(([status, response]) => /^2\d\d$/.test(status) && response.content?.["application/json"]);
  const body = kind === "request" ? operation?.requestBody : success?.[1];
  const queryParameters = operation?.parameters?.filter((parameter) => parameter.in === "query");
  const schema = kind === "query" ? {
    type: "object", additionalProperties: false,
    properties: Object.fromEntries(queryParameters.map((parameter) => [parameter.name, parameter.schema])),
    required: queryParameters.filter((parameter) => parameter.required).map((parameter) => parameter.name),
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
