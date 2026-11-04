import { serve } from "@hono/node-server";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { createApp } from "./http.js";
import { createNodeDatabase, readNodeEnv } from "./node-env.js";
import { createRuntime } from "./runtime.js";

type Handler = (request: Request) => Response | Promise<Response>;

export function startNodeApi(
  handler: Handler,
  port: number,
  hostname = "0.0.0.0",
) {
  const pending = new Set<Promise<Response>>();
  const server = serve({
    hostname,
    port,
    fetch(request) {
      const task = Promise.resolve().then(() => handler(request));
      pending.add(task);
      void task.finally(() => pending.delete(task)).catch(() => {});
      return task;
    },
  }) as Server;
  let shutdown: Promise<boolean> | undefined;
  return {
    server,
    stop(timeoutMs = 15 * 60_000): Promise<boolean> {
      return (shutdown ??= (async () => {
        const closed = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        });
        try {
          const drained = (async () => {
            await closed;
            await Promise.allSettled([...pending]);
            return true as const;
          })();
          const ok = await Promise.race([drained, timedOut]);
          if (!ok) server.closeAllConnections();
          return ok;
        } finally {
          if (timer) clearTimeout(timer);
        }
      })());
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  const env = readNodeEnv();
  const database = createNodeDatabase(env);
  createRuntime(env, undefined, database);
  const app = createApp((bindings, signal) =>
    createRuntime(bindings, signal, database),
  );
  const api = startNodeApi((request) => app.fetch(request, env), port);
  let stopping = false;
  api.server.once("error", () => {
    if (stopping) return;
    stopping = true;
    process.stderr.write("HTTP server failed\n");
    process.exitCode = 1;
    void (async () => {
      if (api.server.listening && !(await api.stop())) process.exit(1);
      await database.close();
    })().catch(() => process.exit(1));
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      void api
        .stop()
        .then(async (ok) => {
          if (!ok) {
            process.stderr.write(
              "HTTP shutdown timed out; in-flight work may be incomplete or committed\n",
            );
            process.exit(1);
          }
          await database.close();
        })
        .catch(() => {
          process.stderr.write("HTTP shutdown failed\n");
          process.exit(1);
        });
    });
}
