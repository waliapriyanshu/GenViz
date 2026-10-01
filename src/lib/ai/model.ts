import { APICallError, RetryError } from "ai";

/** Classification of AI-provider failures into user-safe categories. */
export type ProviderFailure =
  | { kind: "rate_limited"; retryAfterSeconds: number | null }
  | { kind: "auth" }
  | { kind: "unavailable" }
  | { kind: "bad_request"; message: string }
  | { kind: "unknown" };

/** Parses Groq/OpenAI-style durations such as "7.66s", "2m59.56s", "1h2m", "350ms". */
export function parseDurationSeconds(
  value: string | null | undefined,
): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed));
  const date = Date.parse(trimmed);
  if (!/[hms]$/.test(trimmed) && !Number.isNaN(date))
    return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  const match = trimmed.match(
    /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/,
  );
  if (!match || match[0] === "") return null;
  const [, h, m, s, ms] = match;
  const seconds =
    Number(h ?? 0) * 3600 +
    Number(m ?? 0) * 60 +
    Number(s ?? 0) +
    Number(ms ?? 0) / 1000;
  return Number.isFinite(seconds) ? Math.ceil(seconds) : null;
}

function header(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

export function retryAfterFromHeaders(
  headers: Record<string, string> | undefined,
): number | null {
  const direct = parseDurationSeconds(header(headers, "retry-after"));
  if (direct !== null) return Math.max(1, direct);
  const candidates = [
    parseDurationSeconds(header(headers, "x-ratelimit-reset-tokens")),
    parseDurationSeconds(header(headers, "x-ratelimit-reset-requests")),
  ].filter((v): v is number => v !== null);
  // If tokens reset in 7s but requests in 3m, the request limit is the one that bit.
  const remainingRequests = Number(
    header(headers, "x-ratelimit-remaining-requests"),
  );
  if (candidates.length === 0) return null;
  if (remainingRequests === 0) return Math.max(1, ...candidates);
  return Math.max(1, Math.min(...candidates));
}

function unwrap(error: unknown): unknown {
  if (RetryError.isInstance(error)) return error.lastError;
  return error;
}

export function classifyProviderError(error: unknown): ProviderFailure {
  const err = unwrap(error);
  if (APICallError.isInstance(err)) {
    const status = err.statusCode ?? 0;
    if (
      status === 429 ||
      /rate limit|RESOURCE_EXHAUSTED|too many requests/i.test(err.message)
    ) {
      return {
        kind: "rate_limited",
        retryAfterSeconds: retryAfterFromHeaders(err.responseHeaders),
      };
    }
    if (status === 401 || status === 403) return { kind: "auth" };
    if (status >= 500 || status === 408 || status === 0)
      return { kind: "unavailable" };
    if (status === 400 || status === 404 || status === 413 || status === 422)
      return { kind: "bad_request", message: err.message };
    return { kind: "unknown" };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (
    /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|network|socket hang up|aborted|timeout/i.test(
      message,
    )
  ) {
    return { kind: "unavailable" };
  }
  return { kind: "unknown" };
}

/** Errors worth retrying on the next model in the chain. */
export function shouldFallback(failure: ProviderFailure): boolean {
  return failure.kind === "rate_limited" || failure.kind === "unavailable";
}
