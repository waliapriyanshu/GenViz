import "server-only";

/** Server configuration, read lazily so `next build` never needs runtime secrets. */

function intFromEnv(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

export const isProduction = () => process.env.NODE_ENV === "production";

export const config = {
  /**
   * Minimum seconds between two questions from the same session. Default 60s:
   * on Groq's free tier gpt-oss-120b allows 8K tokens/minute and one Genviz
   * question uses roughly 4–7K tokens. Set to 0 on a paid tier.
   */
  queryCooldownSeconds: () => intFromEnv("QUERY_RATE_LIMIT_SECONDS", 60),
  /** Per-IP cooldown so clearing cookies cannot bypass the session limit. */
  ipCooldownSeconds: () =>
    intFromEnv(
      "QUERY_IP_RATE_LIMIT_SECONDS",
      Math.min(config.queryCooldownSeconds(), 10),
    ),
  /** Cooldown used when the provider rate-limits us without a Retry-After hint. */
  providerFallbackCooldownSeconds: () =>
    intFromEnv("PROVIDER_RATE_LIMIT_FALLBACK_SECONDS", 30, 1),
  maxUploadBytes: () => intFromEnv("MAX_UPLOAD_BYTES", 4 * 1024 * 1024, 1024),
  maxCsvRows: () => intFromEnv("MAX_CSV_ROWS", 200_000, 1),
  maxResultRows: () => intFromEnv("MAX_RESULT_ROWS", 5_000, 1),
  statementTimeoutMs: () =>
    intFromEnv("QUERY_STATEMENT_TIMEOUT_MS", 10_000, 100),
  connectTimeoutMs: () => intFromEnv("DB_CONNECT_TIMEOUT_MS", 5_000, 100),
  allowPrivateDbHosts: () => process.env.ALLOW_PRIVATE_DB_HOSTS === "true",
};
