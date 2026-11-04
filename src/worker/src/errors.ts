/** Public failures contain protocol identities, never model bodies or source material. */
export class SourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "SourceError";
  }
}
