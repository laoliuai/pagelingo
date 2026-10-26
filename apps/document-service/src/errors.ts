/** Only explicitly controlled errors may expose their message at the API boundary. */
export class ServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) { super(message); }
}
