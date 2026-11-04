import { createRuntime, type RuntimeEnv } from "./runtime.js";

export interface CloudflareRuntimeEnv extends RuntimeEnv {
  HYPERDRIVE?: { connectionString: string };
  MAINTENANCE_QUEUE?: Pick<CloudflareBindings["MAINTENANCE_QUEUE"], "send">;
}

/** Only this adapter translates maintenance wakeups into Cloudflare Queue calls. */
export function createCloudflareRuntime(
  env: CloudflareRuntimeEnv,
  signal?: AbortSignal,
) {
  const runtime = createRuntime(
    Object.assign(Object.create(env), {
      DATABASE_URL: env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL,
    }),
    signal,
  );
  const queue = env.MAINTENANCE_QUEUE;
  if (queue)
    runtime.maintenanceWakeup = {
      async send(message, delaySeconds) {
        await queue.send(message, { delaySeconds });
      },
    };
  return runtime;
}
