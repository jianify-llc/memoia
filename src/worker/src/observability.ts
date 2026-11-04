import { SourceError } from "./errors.js";

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
