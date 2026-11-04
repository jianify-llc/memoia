import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { startNodeApi } from "../src/node-api.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("shutdown waits for handler even after the client disconnects", async () => {
  const started = gate(),
    finish = gate();
  const api = startNodeApi(
    async () => {
      started.release();
      await finish.promise;
      return new Response("ok");
    },
    0,
    "127.0.0.1",
  );
  await once(api.server, "listening");
  const address = api.server.address();
  assert.ok(address && typeof address !== "string");
  const req = request({ host: "127.0.0.1", port: address.port });
  req.on("error", () => {});
  req.end();
  await started.promise;
  req.destroy();
  let stopped = false;
  const stop = api.stop(1000).then((ok) => {
    stopped = true;
    return ok;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(stopped, false);
  finish.release();
  assert.equal(await stop, true);
});

test("shutdown times out when a handler does not finish", async () => {
  const started = gate(),
    finish = gate();
  const api = startNodeApi(
    async () => {
      started.release();
      await finish.promise;
      return new Response("ok");
    },
    0,
    "127.0.0.1",
  );
  await once(api.server, "listening");
  const address = api.server.address();
  assert.ok(address && typeof address !== "string");
  const req = request({ host: "127.0.0.1", port: address.port });
  req.on("error", () => {});
  req.end();
  await started.promise;
  assert.equal(await api.stop(30), false);
  finish.release();
});

test("Node environment requires credentials without exposing their values", async () => {
  const { readNodeEnv } = await import("../src/node-env.js");
  const values = {
    DATABASE_URL: "postgres://example",
    ACCESS_TOKEN: "example-token",
    OPENAI_API_KEY: "example-key",
  };
  assert.throws(
    () => readNodeEnv({ ...values, ACCESS_TOKEN: "" }),
    /ACCESS_TOKEN is required/,
  );
  const env = readNodeEnv(values);
  assert.equal(env.MAINTENANCE_ENABLED, "true");
  assert.equal(env.MEMOIA_WRITES_ENABLED, "true");
  assert.equal(
    readNodeEnv({ ...values, MEMOIA_WRITES_ENABLED: "false" })
      .MEMOIA_WRITES_ENABLED,
    "false",
  );
});

test("Node adapter serves the existing API and keeps authentication", async () => {
  const { createApp } = await import("../src/http.js");
  const { createRuntime } = await import("../src/runtime.js");
  const { createNodeDatabase, readNodeEnv } = await import(
    "../src/node-env.js"
  );
  const env = readNodeEnv({
    DATABASE_URL: "postgres://unused",
    ACCESS_TOKEN: "test-token",
    OPENAI_API_KEY: "test-key",
  });
  const database = createNodeDatabase(env);
  const app = createApp((bindings, signal) =>
    createRuntime(bindings, signal, database),
  );
  const api = startNodeApi((req) => app.fetch(req, env), 0, "127.0.0.1");
  try {
    await once(api.server, "listening");
    const address = api.server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/api/project/identity`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, {
      headers: { Authorization: "Bearer test-token" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { project_id: "__root__" });
  } finally {
    assert.equal(await api.stop(1000), true);
    await database.close();
  }
});

test("startup on an occupied port exits with an error", async () => {
  const { createServer } = await import("node:net");
  const { spawn } = await import("node:child_process");
  const listener = createServer();
  listener.listen(0, "0.0.0.0");
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  try {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/node-api.ts"],
      {
        env: {
          PATH: process.env.PATH,
          PORT: String(address.port),
          DATABASE_URL: "postgres://unused",
          ACCESS_TOKEN: "test-token",
          OPENAI_API_KEY: "test-key",
          MAINTENANCE_ENABLED: "true",
          MEMOIA_WRITES_ENABLED: "true",
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (part: string) => {
      stderr += part;
    });
    const [code] = await once(child, "exit");
    assert.equal(code, 1);
    assert.match(stderr, /HTTP server failed/);
    assert.doesNotMatch(stderr, /test-token|test-key/);
  } finally {
    listener.close();
    await once(listener, "close");
  }
});
