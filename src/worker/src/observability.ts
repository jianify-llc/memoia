import { APIError } from "openai";
import { SourceError } from "./errors.js";

function upstreamModelError(error: APIError): Record<string, string | number> {
  const attributes: Record<string, string | number> = {};
  const { status, code, type, requestID } = error;
  if (
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 400 &&
    status <= 599
  )
    attributes["upstream.status"] = status;
  // SDK fields still come from the provider. Record bounded identifiers only.
  const label = /^(?!(?:sk|rk|pk|sess|req|bearer)_)[a-z][a-z0-9_]{0,63}$/;
  if (typeof code === "string" && code === code.trim() && label.test(code))
    attributes["upstream.error.code"] = code;
  if (typeof type === "string" && type === type.trim() && label.test(type))
    attributes["upstream.error.type"] = type;
  if (
    typeof requestID === "string" &&
    requestID === requestID.trim() &&
    /^req_[a-zA-Z0-9]{1,64}$/.test(requestID)
  )
    attributes["upstream.request_id"] = requestID;
  return attributes;
}

export async function inSpan<T>(
  tracing: Tracing | undefined,
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  work: () => Promise<T>,
): Promise<T> {
  if (!tracing) return work();
  let result: Promise<T> | undefined;
  try {
    return await tracing.enterSpan(name, (span) => {
      try {
        span.setAttributes(attributes);
      } catch {}
      result = (async () => {
        try {
          return await work();
        } catch (error) {
          try {
            span.setStatus({ code: "error" });
            span.setAttribute(
              "error.code",
              error instanceof SourceError ? error.code : "internal_error",
            );
            if (name === "memoia.model" && error instanceof APIError)
              span.setAttributes(upstreamModelError(error));
          } catch {}
          throw error;
        }
      })();
      return result;
    });
  } catch (error) {
    if (result) return result;
    return work();
  }
}
