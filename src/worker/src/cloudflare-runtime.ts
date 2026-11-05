import { createRuntime, type RuntimeEnv } from "./runtime.js";
import { SourceError } from "./errors.js";

export interface CloudflareRuntimeEnv extends RuntimeEnv {
  HYPERDRIVE?: { connectionString: string };
  MAINTENANCE_QUEUE?: Pick<CloudflareBindings["MAINTENANCE_QUEUE"], "send">;
  OPENAI_TRANSPORT?: string;
  OPENAI_RELAY?: Pick<CloudflareBindings["OPENAI_RELAY"], "fetch">;
}

/** Cloudflare owns queue and relay bindings; the model client receives a fetch function. */
export function createCloudflareRuntime(
  env: CloudflareRuntimeEnv,
  signal?: AbortSignal,
) {
  const relay = env.OPENAI_RELAY;
  const usesRelay = env.OPENAI_TRANSPORT === "vpc";
  if (env.OPENAI_TRANSPORT !== undefined && (!usesRelay || !relay))
    throw new SourceError(
      "model_configuration_rejected",
      "OpenAI relay binding is invalid",
      503,
    );
  if (
    usesRelay &&
    env.OPENAI_BASE_URL !== undefined &&
    !/^https:\/\/api\.openai\.com(?::443)?\/v1\/?$/.test(env.OPENAI_BASE_URL)
  )
    throw new SourceError(
      "model_configuration_rejected",
      "OpenAI relay requires the OpenAI API base URL",
      503,
    );
  const runtime = createRuntime(
    Object.assign(Object.create(env), {
      DATABASE_URL: env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL,
    }),
    signal,
  );
  if (usesRelay && relay) {
    runtime.modelFetch = async (input, init) => {
      const request = new Request(input instanceof URL ? input.href : input, {
        ...init,
        redirect: "manual",
      });
      const url = new URL(request.url);
      if (
        url.origin !== "https://api.openai.com" ||
        url.username ||
        url.password ||
        url.pathname !== "/v1/responses" ||
        request.method !== "POST"
      )
        throw new SourceError(
          "model_configuration_rejected",
          "OpenAI relay request is not allowed",
          503,
        );
      // The VPC binding selects the destination. Preserve the request stream and signal.
      return relay.fetch(
        new Request(
          `http://openai-relay.internal${url.pathname}${url.search}`,
          request,
        ),
      );
    };
  }
  const queue = env.MAINTENANCE_QUEUE;
  if (queue)
    runtime.maintenanceWakeup = {
      async send(message, delaySeconds) {
        await queue.send(message, { delaySeconds });
      },
    };
  return runtime;
}
