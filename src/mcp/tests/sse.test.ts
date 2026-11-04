import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

test("the localhost SSE server accepts a real initialize POST and rejects foreign Host", { timeout: 15_000 }, async () => {
  const reservation = createServer().listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = (reservation.address() as import("node:net").AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, TRANSPORT: "sse", PORT: String(port), MEMOIA_API_URL: "https://example.invalid", MEMOIA_PROJECT_TOKEN: "fixture", MEMOIA_USER_ID: "10000000-0000-4000-8000-000000000001" },
  });
  const exited = once(child, "exit"); let stderr = ""; child.stderr.on("data", data => { stderr += data; });
  const client = new Client({ name: "sse-local", version: "1.0.0" });
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null) throw new Error(stderr);
      try { if ((await fetch(`http://127.0.0.1:${port}/not-found`)).status === 404) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, stderr);
    const transport = new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`));
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 3);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/sse", headers: { Host: "foreign.invalid" } }, response => {
        response.resume(); resolve(response.statusCode);
      });
      req.once("error", reject); req.end();
    });
    assert.equal(status, 403);
  } finally {
    await client.close(); child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 1000);
    await exited; clearTimeout(force);
  }
});
