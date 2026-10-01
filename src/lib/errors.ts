/**
 * Errors whose `message` is safe to show to end users. Anything else is logged
 * server-side and replaced with a generic message.
 */
export type UserErrorCode =
  | "rate_limited"
  | "bad_request"
  | "not_found"
  | "forbidden"
  | "payload_too_large"
  | "invalid_csv"
  | "invalid_connection"
  | "connection_blocked"
  | "database_unavailable"
  | "query_failed"
  | "no_data"
  | "unsupported"
  | "ai_unavailable"
  | "ai_not_configured"
  | "server_misconfigured"
  | "internal";

export class UserError extends Error {
  constructor(
    public readonly code: UserErrorCode,
    message: string,
    public readonly status = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "UserError";
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function toUserError(error: unknown): UserError {
  if (error instanceof UserError) return error;
  if (error instanceof ConfigError) {
    console.error("[genviz] configuration error:", error.message);
    return new UserError(
      "server_misconfigured",
      "Genviz isn't fully configured on the server yet. Please contact the administrator.",
      500,
    );
  }
  console.error("[genviz] unexpected error:", error);
  return new UserError(
    "internal",
    "Something went wrong on our side. Please try again.",
    500,
  );
}
