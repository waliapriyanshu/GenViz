import "server-only";
import { prisma } from "@/lib/prisma";

/**
 * Cooldown store. `claim` atomically reserves the key for `seconds` if its
 * previous cooldown has expired; otherwise it reports how long to wait.
 */
export interface CooldownStore {
  claim(
    key: string,
    seconds: number,
  ): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }>;
  /** Pushes a key's cooldown out to at least `seconds` from now (never shortens it). */
  extend(key: string, seconds: number): Promise<void>;
  remaining(key: string): Promise<number>;
}

export const postgresCooldownStore: CooldownStore = {
  async claim(key, seconds) {
    if (seconds <= 0) return { ok: true };
    const claimed = await prisma.$queryRaw<{ key: string }[]>`
      INSERT INTO genviz.rate_limits (key, next_allowed_at, updated_at)
      VALUES (${key}, now() + make_interval(secs => ${seconds}), now())
      ON CONFLICT (key) DO UPDATE
        SET next_allowed_at = EXCLUDED.next_allowed_at, updated_at = now()
        WHERE genviz.rate_limits.next_allowed_at <= now()
      RETURNING key`;
    if (claimed.length > 0) return { ok: true };
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, await this.remaining(key)),
    };
  },
  async extend(key, seconds) {
    if (seconds <= 0) return;
    await prisma.$executeRaw`
      INSERT INTO genviz.rate_limits (key, next_allowed_at, updated_at)
      VALUES (${key}, now() + make_interval(secs => ${seconds}), now())
      ON CONFLICT (key) DO UPDATE
        SET next_allowed_at = GREATEST(genviz.rate_limits.next_allowed_at, EXCLUDED.next_allowed_at),
            updated_at = now()`;
  },
  async remaining(key) {
    const rows = await prisma.$queryRaw<{ seconds: number }[]>`
      SELECT CEIL(EXTRACT(EPOCH FROM (next_allowed_at - now())))::int AS seconds
      FROM genviz.rate_limits WHERE key = ${key}`;
    return Math.max(0, rows[0]?.seconds ?? 0);
  },
};

export function createMemoryCooldownStore(
  now: () => number = Date.now,
): CooldownStore {
  const until = new Map<string, number>();
  const remaining = (key: string) =>
    Math.max(0, Math.ceil(((until.get(key) ?? 0) - now()) / 1000));
  return {
    async claim(key, seconds) {
      if (seconds <= 0) return { ok: true };
      const wait = remaining(key);
      if (wait > 0) return { ok: false, retryAfterSeconds: wait };
      until.set(key, now() + seconds * 1000);
      return { ok: true };
    },
    async extend(key, seconds) {
      until.set(key, Math.max(until.get(key) ?? 0, now() + seconds * 1000));
    },
    async remaining(key) {
      return remaining(key);
    },
  };
}

export interface QueryLimiterConfig {
  sessionSeconds: number;
  ipSeconds: number;
}

export const providerKey = (provider: string) => `provider:${provider}`;

/**
 * Enforces, in order: an active provider-wide pause (after a 429 from the AI
 * provider), the per-IP cooldown and the per-session cooldown. Returns the
 * number of seconds the caller must wait, or 0 when the query may proceed.
 */
export async function claimQuerySlot(
  store: CooldownStore,
  identity: { sessionId: string; ipKey: string },
  provider: string,
  limits: QueryLimiterConfig,
): Promise<number> {
  const providerWait = await store.remaining(providerKey(provider));
  if (providerWait > 0) return providerWait;
  const sessionWait = await store.remaining(`session:${identity.sessionId}`);
  if (sessionWait > 0) return sessionWait;
  const ip = await store.claim(`ip:${identity.ipKey}`, limits.ipSeconds);
  if (!ip.ok) return ip.retryAfterSeconds;
  const session = await store.claim(
    `session:${identity.sessionId}`,
    limits.sessionSeconds,
  );
  if (!session.ok) return session.retryAfterSeconds;
  return 0;
}

/** Called when the AI provider itself returns 429: pause everyone, not just this user. */
export async function recordProviderRateLimit(
  store: CooldownStore,
  identity: { sessionId: string },
  provider: string,
  seconds: number,
): Promise<void> {
  await store.extend(providerKey(provider), seconds);
  await store.extend(`session:${identity.sessionId}`, seconds);
}

export async function currentWait(
  store: CooldownStore,
  identity: { sessionId: string },
  provider: string,
): Promise<number> {
  const [providerWait, sessionWait] = await Promise.all([
    store.remaining(providerKey(provider)),
    store.remaining(`session:${identity.sessionId}`),
  ]);
  return Math.max(providerWait, sessionWait);
}
