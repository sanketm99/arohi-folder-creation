/** An error whose message is safe to show to the user. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Maps a failed upstream response (FactSet, Microsoft) to a status the browser understands:
 * throttling and outages are retryable (429/503); anything else is a non-retryable 424.
 */
export function upstreamStatus(status: number): number {
  if (status === 429) return 429;
  if (status >= 500) return 503;
  return 424;
}
