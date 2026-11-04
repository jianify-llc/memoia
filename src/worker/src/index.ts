/** HTTP, Queue and Cron invoke the same domain functions with invocation-owned resources. */
import { createApp } from "./http.js";
import { closeRuntime, type Wakeup } from "./runtime.js";
import {
  createCloudflareRuntime,
  type CloudflareRuntimeEnv,
} from "./cloudflare-runtime.js";
import { consume, reconcile } from "./maintenance.js";
import { purgeExpiredInputs } from "./facts.js";
import { inSpan } from "./observability.js";
import { InactiveUserError } from "./db.js";

const app = createApp(createCloudflareRuntime);
export default {
  fetch(request: Request, env: CloudflareRuntimeEnv, ctx: ExecutionContext) {
    const scopedEnv = Object.assign(Object.create(env), {
      tracing: ctx.tracing,
    });
    const method = ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(
      request.method,
    )
      ? request.method
      : "other";
    return inSpan(ctx.tracing, "memoia.http", { method }, async () => {
      const response = await app.fetch(request, scopedEnv, ctx);
      return response;
    });
  },
  async queue(
    batch: MessageBatch<Wakeup>,
    env: CloudflareRuntimeEnv,
    ctx?: ExecutionContext,
  ) {
    for (const message of batch.messages) {
      const runtime = createCloudflareRuntime(
        Object.assign(Object.create(env), { tracing: ctx?.tracing }),
      );
      try {
        const kind =
          message.body.kind === "user" || message.body.kind === "flush"
            ? message.body.kind
            : "unknown";
        await inSpan(runtime.tracing, "memoia.queue", { kind }, () =>
          consume(runtime, message.body),
        );
        message.ack();
      } catch (error) {
        let forgotten = false;
        if (error instanceof InactiveUserError) {
          try {
            forgotten = Boolean(
              (
                await runtime.db.query(
                  "SELECT 1 FROM memoia.memory_user_tombstones WHERE user_id=$1 AND project_id=$2",
                  [message.body.user_id, message.body.project_id],
                )
              ).rowCount,
            );
          } catch {}
        }
        if (forgotten) {
          try {
            console.info(
              JSON.stringify({
                event: "maintenance_wakeup",
                status: "forgotten",
              }),
            );
          } catch {}
          message.ack();
          continue;
        }
        message.retry({ delaySeconds: 60 });
      } finally {
        await closeRuntime(runtime);
      }
    }
  },
  async scheduled(
    _event: ScheduledController,
    env: CloudflareRuntimeEnv,
    ctx?: ExecutionContext,
  ) {
    if (env.MEMOIA_WRITES_ENABLED === "false") return;
    const runtime = createCloudflareRuntime(
      Object.assign(Object.create(env), { tracing: ctx?.tracing }),
    );
    try {
      await inSpan(runtime.tracing, "memoia.cron", {}, async () => {
        await purgeExpiredInputs(runtime);
        await reconcile(runtime);
      });
    } finally {
      await closeRuntime(runtime);
    }
  },
} satisfies ExportedHandler<CloudflareRuntimeEnv, Wakeup>;
