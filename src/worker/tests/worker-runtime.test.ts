import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { execFileSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import pg from "pg";

test(
  "built Worker serves the same API through a real service binding and local Hyperdrive",
  { skip: !process.env.MEMOIA_TEST_DATABASE_URL },
  async () => {
    const directory = path.resolve(`.cache/runtime-${crypto.randomUUID()}`);
    execFileSync(
      path.resolve("node_modules/.bin/tsx"),
      ["scripts/build.ts", "--outdir", directory],
      { stdio: "pipe" },
    );
    const modules = [
      { type: "ESModule" as const, path: path.join(directory, "index.js") },
      ...readdirSync(directory)
        .filter((f) => f.endsWith(".md") && f !== "README.md")
        .map((f) => ({ type: "Text" as const, path: path.join(directory, f) })),
    ];
    const db = new pg.Client({
      connectionString: process.env.MEMOIA_TEST_DATABASE_URL,
    });
    await db.connect();
    const project = `runtime_${crypto.randomUUID()}`;
    let externalCalls = 0;
    let relayCalls = 0;
    let embeddingCalls = 0;
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        workers: [
          {
            name: "memoia",
            modules,
            modulesRoot: directory,
            compatibilityDate: "2026-10-30",
            compatibilityFlags: ["nodejs_compat"],
            hyperdrives: { HYPERDRIVE: process.env.MEMOIA_TEST_DATABASE_URL! },
            bindings: {
              OPENAI_API_KEY: "unused",
              OPENAI_BASE_URL: "https://api.openai.com/v1",
              EMBEDDING_API_KEY: "embedding-fixture",
              EMBEDDING_BASE_URL: "https://API.OPENAI.COM/v1",
              OPENAI_TRANSPORT: "vpc",
              ACCESS_TOKEN: "local-root",
            },
            serviceBindings: {
              OPENAI_RELAY: async (request: Request) => {
                assert.equal(request.method, "POST");
                if (request.url === "http://openai-relay.internal/v1/embeddings") {
                  embeddingCalls++;
                  assert.equal(request.headers.get("authorization"), "Bearer embedding-fixture");
                  const payload = (await request.json()) as { model: string; dimensions: number };
                  assert.equal(payload.model, "text-embedding-3-large");
                  assert.equal(payload.dimensions, 1536);
                  return Response.json({
                    data: [{ index: 0, embedding: Array(1536).fill(0.01) }],
                  });
                }
                relayCalls++;
                assert.equal(
                  request.url,
                  "http://openai-relay.internal/v1/responses",
                );
                assert.equal(
                  request.headers.get("authorization"),
                  "Bearer unused",
                );
                return Response.json({
                  status: "completed",
                  model: "fake-model",
                  output: [
                    {
                      type: "message",
                      status: "completed",
                      content: [
                        {
                          type: "output_text",
                          text: JSON.stringify({
                            messages: [
                              {
                                message_id: "m1",
                                facts: [
                                  {
                                    content: "The user likes tea.",
                                    subject: "the user",
                                    reporter: "the user",
                                    certainty: "asserted",
                                    fact_time: null,
                                    any_of: [{ all_of: ["m1"] }],
                                  },
                                ],
                              },
                            ],
                          }),
                        },
                      ],
                    },
                  ],
                });
              },
            },
            outboundService: () => {
              externalCalls++;
              return Response.json(
                { error: "Unexpected provider call" },
                { status: 500 },
              );
            },
          },
          {
            name: "caller",
            modules: true,
            script:
              "export default {fetch(request,env){return env.MEMOIA.fetch(request)}}",
            serviceBindings: { MEMOIA: "memoia" },
            compatibilityDate: "2026-10-30",
            compatibilityFlags: ["nodejs_compat"],
          },
        ],
      }),
    );
    try {
      const caller = await mf.getWorker("caller");
      const api = async (
        method: string,
        url: string,
        token: string,
        body?: unknown,
        headers: Record<string, string> = {},
      ) =>
        caller.fetch(`https://memoia.internal${url}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      assert.equal(
        (await api("GET", "/api/healthcheck", "local-root")).status,
        200,
      );
      assert.equal(
        (await api("GET", "/api/project/identity", "bad-key")).status,
        401,
      );
      assert.equal(
        (
          await api("POST", "/api/projects", "local-root", {
            project_id: project,
          })
        ).status,
        201,
      );
      const key = await api(
        "POST",
        `/api/projects/${project}/keys`,
        "local-root",
        { name: "local", scopes: ["admin"] },
      );
      assert.equal(key.status, 201);
      const credential = await key.json();
      assert.ok(
        credential &&
          typeof credential === "object" &&
          "token" in credential &&
          typeof credential.token === "string",
      );
      const user = crypto.randomUUID();
      assert.equal(
        (await api("POST", "/api/users", credential.token, { id: user }))
          .status,
        201,
      );
      const scope = await api("GET", "/api/project/identity", credential.token);
      assert.deepEqual(await scope.json(), { project_id: project });
      const invalid = await api(
        "GET",
        "/api/project/identity",
        credential.token,
        undefined,
        { "X-Memoia-Deadline-Ms": "NaN" },
      );
      assert.equal(invalid.status, 422);
      for (const value of ["0", "-1", "0.5", "Infinity"]) {
        const rejected = await api(
          "GET",
          "/api/project/identity",
          credential.token,
          undefined,
          { "X-Memoia-Deadline-Ms": value },
        );
        assert.equal(rejected.status, 422);
      }
      const input = {
        idempotency_key: "deadline-fact",
        source_id: "deadline-source",
        messages: [
          {
            message_id: "m1",
            role: "user",
            content: "I like tea.",
            occurred_at: "2024-05-01T12:00:00Z",
          },
        ],
      };
      const imported = await api(
        "POST",
        `/api/users/${user}/blobs`,
        credential.token,
        input,
        { "X-Memoia-Deadline-Ms": "120000" },
      );
      assert.equal(imported.status, 200);
      const receipt = (await imported.json()) as {
        status: string;
        result: { fact_ids: string[] };
      };
      assert.equal(receipt.status, "completed");
      assert.equal(receipt.result.fact_ids.length, 1);
      assert.equal(relayCalls, 1);
      assert.equal(embeddingCalls, 1);
      const search = await api("POST", `/api/users/${user}/search`, credential.token, {
        query: "tea",
      });
      assert.equal(search.status, 200);
      const matches = (await search.json()) as { facts: { id: string }[] };
      assert.ok(matches.facts.some(({ id }) => id === receipt.result.fact_ids[0]));
      assert.equal(embeddingCalls, 2);
      const elapsed = await api(
        "POST",
        `/api/users/${user}/blobs`,
        credential.token,
        {
          ...input,
          idempotency_key: "deadline-expired",
          source_id: "deadline-expired",
        },
        { "X-Memoia-Deadline-Ms": "1" },
      );
      assert.equal(elapsed.status, 503);
      assert.equal(
        ((await elapsed.json()) as { detail: { code: string } }).detail.code,
        "execution_deadline",
      );
      assert.equal(relayCalls, 1);
      assert.equal(embeddingCalls, 2);
      assert.equal(
        (await api("DELETE", `/api/users/${user}`, credential.token)).status,
        200,
      );
      assert.equal(
        (
          await api("POST", "/api/users", credential.token, {
            id: user.toUpperCase(),
          })
        ).status,
        403,
      );
      assert.equal(relayCalls, 1);
      assert.equal(embeddingCalls, 2);
      assert.equal(externalCalls, 0);
    } finally {
      await mf.dispose();
      await db.query("DELETE FROM memoia.projects WHERE project_id=$1", [
        project,
      ]);
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
