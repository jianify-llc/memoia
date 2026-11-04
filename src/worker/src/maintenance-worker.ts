import type { Database } from "./db.js";
import { purgeExpiredInputs } from "./facts.js";
import { consume, pollMaintenance } from "./maintenance.js";
import { createRuntime, type RuntimeEnv, type Wakeup } from "./runtime.js";

/** PostgreSQL owns execution state; this set only bounds work in the current process. */
export function startMaintenanceWorker(
  env: RuntimeEnv,
  database: Database,
  options: { concurrency?: number; pollIntervalMs?: number } = {},
) {
  const concurrency = options.concurrency ?? 4;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100)
    throw new Error("Invalid maintenance concurrency");
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1)
    throw new Error("Invalid maintenance poll interval");
  const active = new Set<Promise<void>>();
  let stopping = false;
  let wake: (() => void) | undefined;
  let nextCleanup = 0;
  const execute = async (message: Wakeup) => {
    try {
      await consume(createRuntime(env, undefined, database), message);
    } catch {
      // Preserve the original database state on an unknown result; the normal lease recovery owns retry.
      console.warn(
        JSON.stringify({
          event: "maintenance_execution_unconfirmed",
          operation_id:
            message.kind === "flush" ? message.operation_id : undefined,
        }),
      );
    }
  };
  const loop = (async () => {
    while (!stopping) {
      try {
        const runtime = createRuntime(env, undefined, database);
        if (
          env.MEMOIA_WRITES_ENABLED !== "false" &&
          Date.now() >= nextCleanup
        ) {
          nextCleanup = Date.now() + 60_000;
          try {
            await purgeExpiredInputs(runtime);
          } catch {
            console.warn(
              JSON.stringify({ event: "maintenance_input_cleanup_failed" }),
            );
          }
        }
        const ready = await pollMaintenance(runtime, concurrency - active.size);
        for (const message of ready) {
          if (stopping) break;
          const task = execute(message);
          active.add(task);
          void task.finally(() => active.delete(task));
        }
      } catch {
        console.warn(JSON.stringify({ event: "maintenance_poll_failed" }));
      }
      if (stopping) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, pollIntervalMs);
        function done() {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        }
        wake = done;
      });
    }
    await Promise.allSettled([...active]);
  })();
  return {
    stop(timeoutMs = 15 * 60_000): Promise<boolean> {
      stopping = true;
      wake?.();
      return new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        loop.then(
          () => {
            clearTimeout(timer);
            resolve(true);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    },
  };
}
