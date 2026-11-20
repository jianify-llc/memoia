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
    await db.query("SET search_path TO memoia,extensions,public");
    const project = `runtime_${crypto.randomUUID()}`;
    let externalCalls = 0;
    let relayCalls = 0;
    let embeddingCalls = 0;
    let transientEmbeddingFailure = false;
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
            queueProducers: { MAINTENANCE_QUEUE: "memoia-runtime" },
            queueConsumers: {
              "memoia-runtime": { maxBatchSize: 1, maxBatchTimeout: 0 },
            },
            bindings: {
              MAINTENANCE_ENABLED: "true",
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
                if (
                  request.url === "http://openai-relay.internal/v1/embeddings"
                ) {
                  embeddingCalls++;
                  const payload = (await request.json()) as {
                    model: string;
                    dimensions: number;
                    input: string[];
                  };
                  if (
                    transientEmbeddingFailure &&
                    payload.input.some((item) =>
                      item.includes("morning coffee"),
                    )
                  ) {
                    transientEmbeddingFailure = false;
                    return Response.json(
                      { error: { message: "Unavailable" } },
                      { status: 503, headers: { "x-should-retry": "false" } },
                    );
                  }
                  assert.equal(
                    request.headers.get("authorization"),
                    "Bearer embedding-fixture",
                  );
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
                const payload = (await request.json()) as {
                  store: boolean;
                  service_tier: string;
                  tools: { name: string }[];
                  input: {
                    type: string;
                    content?: {
                      text: string;
                      prompt_cache_breakpoint?: { ttl: string };
                    }[];
                  }[];
                  instructions: string;
                  previous_response_id?: string;
                  prompt_cache_options?: { mode: string; ttl: string };
                };
                assert.equal(payload.store, false);
                assert.equal(
                  payload.service_tier,
                  relayCalls === 3 ? "default" : "flex",
                );
                assert.ok(payload.instructions.includes("Record useful facts"));
                assert.deepEqual(payload.prompt_cache_options, {
                  mode: "implicit",
                  ttl: "30m",
                });
                assert.equal(payload.input[0]?.content?.[0]?.text, "---");
                assert.equal(
                  payload.input[0]?.content?.[0]?.prompt_cache_breakpoint?.ttl,
                  "12h",
                );
                assert.equal(payload.previous_response_id, undefined);
                assert.ok(
                  payload.tools.some(({ name }) => name === "finish_facts"),
                );
                const candidate = {
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
                };
                const first = relayCalls === 1;
                if (relayCalls === 2 || relayCalls === 3)
                  assert.ok(
                    payload.input.some(
                      (item) => item.type === "function_call_output",
                    ),
                  );
                if (
                  JSON.stringify(payload.input).includes(
                    "Rejected memoia test input",
                  )
                )
                  return Response.json(
                    {
                      error: {
                        message: "Rejected input",
                        code: "context_length_exceeded",
                      },
                    },
                    { status: 400 },
                  );
                if (relayCalls > 3) {
                  const morning = JSON.stringify(payload.input).includes(
                    "morning coffee",
                  );
                  const id = morning ? "retry-m3" : "retry-m4";
                  candidate.messages[0]!.message_id = id;
                  candidate.messages[0]!.facts[0]!.content = morning
                    ? "The user likes morning coffee."
                    : "The user likes tea.";
                  candidate.messages[0]!.facts[0]!.any_of[0]!.all_of = [id];
                }
                if (relayCalls === 2)
                  return Response.json(
                    { error: { message: "Flex unavailable" } },
                    { status: 429, headers: { "retry-after": "900" } },
                  );
                return Response.json({
                  id: `resp_fact_${relayCalls}`,
                  status: "completed",
                  model: "fake-model",
                  output: [
                    {
                      id: `fc_fact_${relayCalls}`,
                      call_id: `call_fact_${relayCalls}`,
                      type: "function_call",
                      status: "completed",
                      name: first ? "stage_facts" : "finish_facts",
                      arguments: JSON.stringify(
                        first
                          ? candidate
                          : { candidate: relayCalls === 3 ? null : candidate },
                      ),
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
      const projectToken = credential.token;
      const user = crypto.randomUUID();
      assert.equal(
        (await api("POST", "/api/users", projectToken, { id: user })).status,
        201,
      );
      const scope = await api("GET", "/api/project/identity", projectToken);
      assert.deepEqual(await scope.json(), { project_id: project });
      const invalid = await api(
        "GET",
        "/api/project/identity",
        projectToken,
        undefined,
        { "X-Memoia-Deadline-Ms": "NaN" },
      );
      assert.equal(invalid.status, 422);
      for (const value of ["0", "-1", "0.5", "Infinity"]) {
        const rejected = await api(
          "GET",
          "/api/project/identity",
          projectToken,
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
        projectToken,
        input,
        { "X-Memoia-Deadline-Ms": "120000" },
      );
      assert.equal(imported.status, 202);
      const staged = (await imported.json()) as {
        status: string;
        blob_id: string;
        operation_id: string;
      };
      assert.equal(staged.status, "staged");
      assert.equal(relayCalls, 0);
      assert.equal(embeddingCalls, 0);
      const replay = await api(
        "POST",
        `/api/users/${user}/blobs`,
        projectToken,
        input,
      );
      assert.equal(
        ((await replay.json()) as { operation_id: string }).operation_id,
        staged.operation_id,
      );
      const wrongSource = await api(
        "POST",
        `/api/users/${user}/blobs/other/flush`,
        projectToken,
        {
          idempotency_key: "wrong-source",
          append_operation_ids: [staged.operation_id],
        },
      );
      assert.equal(wrongSource.status, 409);
      const flush = await api(
        "POST",
        `/api/users/${user}/blobs/deadline-source/flush`,
        projectToken,
        {
          idempotency_key: "fact-flush",
          append_operation_ids: [staged.operation_id],
        },
      );
      assert.equal(flush.status, 202);
      const flushId = ((await flush.json()) as { operation_id: string })
        .operation_id;
      let outcome:
        | {
            status: string;
            result?: { fact_ids: string[] };
            error?: unknown;
          }
        | undefined;
      for (let i = 0; i < 100; i++) {
        const read = await api(
          "GET",
          `/api/users/${user}/operations/${flushId}`,
          projectToken,
        );
        outcome = (await read.json()) as NonNullable<typeof outcome>;
        if (outcome.status !== "processing" || outcome.error) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(outcome?.status, "completed", JSON.stringify(outcome));
      assert.equal(outcome.result?.fact_ids.length, 1);
      const receipt = (await (
        await api(
          "GET",
          `/api/users/${user}/operations/${staged.operation_id}`,
          projectToken,
        )
      ).json()) as {
        status: string;
        result: { fact_ids: string[] };
      };
      assert.equal(receipt.result.fact_ids.length, 1);
      const stored = await db.query(
        "SELECT request, input_expires_at FROM memoia.memory_operations WHERE id=$1",
        [staged.operation_id],
      );
      assert.equal(stored.rows[0].request.messages, undefined);
      assert.equal(stored.rows[0].input_expires_at, null);
      assert.equal(relayCalls, 3);
      assert.equal(embeddingCalls, 1);
      const search = await api(
        "POST",
        `/api/users/${user}/search`,
        projectToken,
        {
          query: "tea",
        },
      );
      assert.equal(search.status, 200);
      const matches = (await search.json()) as { facts: { id: string }[] };
      assert.ok(
        matches.facts.some(({ id }) => id === receipt.result.fact_ids[0]),
      );
      assert.equal(embeddingCalls, 2);
      const tombstone = await api(
        "DELETE",
        `/api/users/${user}/sources/retracted-source/messages`,
        projectToken,
        { idempotency_key: "retract-before-stage", message_ids: ["m1"] },
      );
      assert.equal(tombstone.status, 200);
      const absent = await api(
        "POST",
        `/api/users/${user}/blobs`,
        projectToken,
        {
          ...input,
          idempotency_key: "retract-before-stage-input",
          source_id: "retracted-source",
        },
      );
      assert.equal(absent.status, 202);
      const absentId = ((await absent.json()) as { operation_id: string })
        .operation_id;
      const withdrawn = await db.query(
        "SELECT request->'messages' AS messages FROM memoia.memory_operations WHERE id=$1",
        [absentId],
      );
      assert.deepEqual(withdrawn.rows[0].messages, []);
      assert.equal(relayCalls, 3);
      assert.equal(embeddingCalls, 2);
      const retrySource = "retry-source";
      const stage = async (message_id: string, content: string) => {
        const response = await api(
          "POST",
          `/api/users/${user}/blobs`,
          projectToken,
          {
            source_id: retrySource,
            idempotency_key: message_id,
            messages: [{ ...input.messages[0]!, message_id, content }],
          },
        );
        assert.equal(response.status, 202);
        return (await response.json()) as {
          blob_id: string;
          operation_id: string;
        };
      };

      const retrying = await stage("retry-m3", "I like morning coffee.");
      const surviving = await stage("retry-m4", "I like tea.");
      await assert.rejects(
        db.query("UPDATE memoia.memory_operations SET attempts=1 WHERE id=$1", [
          retrying.operation_id,
        ]),
        { constraint: "ck_memory_flush_lease" },
      );
      const startRetryFlush = () =>
        api(
          "POST",
          `/api/users/${user}/blobs/${retrySource}/flush`,
          projectToken,
          {
            idempotency_key: "retry-flush",
            append_operation_ids: [
              retrying.operation_id,
              surviving.operation_id,
            ],
          },
        );
      transientEmbeddingFailure = true;
      const retryId = (
        (await (await startRetryFlush()).json()) as { operation_id: string }
      ).operation_id;
      const awaitState = async (check: () => Promise<boolean>) => {
        for (let i = 0; i < 100; i++) {
          if (await check()) return;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("Fact Task did not reach the expected checkpoint");
      };
      const taskState = async () =>
        (
          await db.query(
            "SELECT status,next_run_at,run_attempts,jsonb_array_length(fail_reasons) AS failure_count FROM memoia.queue_tasks WHERE id=$1",
            [retryId],
          )
        ).rows[0];
      await awaitState(
        async () =>
          (await taskState()).status === "pending" &&
          Number((await taskState()).run_attempts) === 1,
      );
      const checkpoints = await db.query(
        "SELECT id,status,request,attempts,available_at,error FROM memoia.memory_operations WHERE id=ANY($1::uuid[])",
        [[retrying.operation_id, surviving.operation_id]],
      );
      const rows = new Map(checkpoints.rows.map((row) => [row.id, row]));
      const retry = rows.get(retrying.operation_id)!;
      assert.equal(surviving.blob_id, retrying.blob_id);
      assert.equal(rows.get(surviving.operation_id)?.status, "processing");
      assert.ok(rows.get(surviving.operation_id)?.request.fact_prepared);
      const before = await db.query(
        "SELECT count(*)::int AS n FROM memoia.memory_facts f JOIN memoia.memory_blobs b ON b.id=f.blob_id WHERE b.user_id=$1 AND b.source_id=$2",
        [user, retrySource],
      );
      assert.equal(before.rows[0]?.n, 0);
      assert.equal(retry.status, "processing");
      assert.equal(retry.error.code, "embedding_unavailable");
      assert.equal(Number(retry.attempts), 1);
      assert.ok(retry.request.fact_review_candidate);
      assert.ok(retry.available_at.getTime() - Date.now() > 280_000);
      assert.equal(+retry.available_at, +(await taskState()).next_run_at);
      assert.equal((await taskState()).failure_count, 0);
      assert.equal(relayCalls, 5);
      await db.query(
        "UPDATE memoia.memory_operations SET available_at=clock_timestamp() WHERE id=$1",
        [retrying.operation_id],
      );
      await db.query(
        "UPDATE memoia.queue_tasks SET next_run_at=clock_timestamp(),next_dispatch_at=NULL WHERE id=$1 AND status='pending'",
        [retryId],
      );
      assert.equal(
        ((await (await startRetryFlush()).json()) as { operation_id: string })
          .operation_id,
        retryId,
      );
      await awaitState(async () => (await taskState()).status === "succeeded");
      const partial = (await (
        await api(
          "GET",
          `/api/users/${user}/operations/${retryId}`,
          projectToken,
        )
      ).json()) as NonNullable<typeof outcome>;
      assert.equal(partial.result?.fact_ids.length, 2);
      assert.equal(relayCalls, 5, "Embedding retries reuse all prepared work");
      assert.equal(embeddingCalls, 5);
      assert.equal(
        (await api("DELETE", `/api/users/${user}`, projectToken)).status,
        200,
      );
      assert.equal(
        (
          await api("POST", "/api/users", projectToken, {
            id: user.toUpperCase(),
          })
        ).status,
        403,
      );
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
