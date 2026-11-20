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

/** The requested range was rejected before any append was assigned to a flush. */
export class ExpiredAppendInputs extends SourceError {
  constructor(readonly appendOperationIds: string[]) {
    super("expired_append_inputs", "Some append inputs expired before the Fact flush was accepted", 409);
  }
}
