import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";
import {
  classifyProviderError,
  parseDurationSeconds,
  retryAfterFromHeaders,
} from "@/lib/ai/model";
import {
  claimQuerySlot,
  createMemoryCooldownStore,
  currentWait,
  recordProviderRateLimit,
} from "@/lib/security/rate-limit";

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (seconds: number) => (now += seconds * 1000),
  };
}

const identity = { sessionId: "s1", ipKey: "ip1" };
const limits = { sessionSeconds: 60, ipSeconds: 10 };

describe("backend query cooldown", () => {
  it("allows the first query and blocks the next one until the cooldown expires", async () => {
    const time = clock();
    const store = createMemoryCooldownStore(time.now);
    expect(await claimQuerySlot(store, identity, "groq", limits)).toBe(0);
    expect(await claimQuerySlot(store, identity, "groq", limits)).toBe(60);
    time.advance(45);
    expect(await claimQuerySlot(store, identity, "groq", limits)).toBe(15);
    time.advance(15);
    expect(await claimQuerySlot(store, identity, "groq", limits)).toBe(0);
  });

  it("a new session from the same IP is still throttled per IP", async () => {
    const time = clock();
    const store = createMemoryCooldownStore(time.now);
    expect(await claimQuerySlot(store, identity, "groq", limits)).toBe(0);
    expect(
      await claimQuerySlot(
        store,
        { sessionId: "cleared-cookies", ipKey: "ip1" },
        "groq",
        limits,
      ),
    ).toBe(10);
  });

  it("disabled cooldown (0s) never blocks", async () => {
    const store = createMemoryCooldownStore(clock().now);
    for (let i = 0; i < 5; i++) {
      expect(
        await claimQuerySlot(store, identity, "groq", {
          sessionSeconds: 0,
          ipSeconds: 0,
        }),
      ).toBe(0);
    }
  });

  it("a provider 429 pauses every session for the provider's Retry-After", async () => {
    const time = clock();
    const store = createMemoryCooldownStore(time.now);
    await recordProviderRateLimit(store, identity, "groq", 42);
    expect(await currentWait(store, identity, "groq")).toBe(42);
    expect(
      await claimQuerySlot(
        store,
        { sessionId: "other", ipKey: "ip2" },
        "groq",
        limits,
      ),
    ).toBe(42);
    time.advance(42);
    expect(
      await claimQuerySlot(
        store,
        { sessionId: "other", ipKey: "ip2" },
        "groq",
        limits,
      ),
    ).toBe(0);
  });
});

describe("provider error classification", () => {
  const apiError = (
    status: number,
    headers: Record<string, string> = {},
    message = "error",
  ) =>
    new APICallError({
      message,
      url: "https://api.groq.com",
      requestBodyValues: {},
      statusCode: status,
      responseHeaders: headers,
      isRetryable: status === 429,
    });

  it("parses Groq duration formats", () => {
    expect(parseDurationSeconds("7.66s")).toBe(8);
    expect(parseDurationSeconds("2m59.56s")).toBe(180);
    expect(parseDurationSeconds("350ms")).toBe(1);
    expect(parseDurationSeconds("12")).toBe(12);
    expect(parseDurationSeconds("garbage")).toBeNull();
  });

  it("uses Retry-After first, then x-ratelimit-reset headers", () => {
    expect(retryAfterFromHeaders({ "retry-after": "32" })).toBe(32);
    expect(
      retryAfterFromHeaders({
        "x-ratelimit-reset-tokens": "7.66s",
        "x-ratelimit-reset-requests": "2m59.56s",
      }),
    ).toBe(8);
    expect(
      retryAfterFromHeaders({
        "x-ratelimit-reset-tokens": "7.66s",
        "x-ratelimit-reset-requests": "2m59.56s",
        "x-ratelimit-remaining-requests": "0",
      }),
    ).toBe(180);
    expect(retryAfterFromHeaders({})).toBeNull();
  });

  it("classifies 429 (also when wrapped in a RetryError) with the retry delay", () => {
    expect(
      classifyProviderError(apiError(429, { "retry-after": "21" })),
    ).toEqual({ kind: "rate_limited", retryAfterSeconds: 21 });
    const wrapped = new RetryError({
      message: "failed after retries",
      reason: "maxRetriesExceeded",
      errors: [apiError(429, { "retry-after": "5" })],
    });
    expect(classifyProviderError(wrapped)).toEqual({
      kind: "rate_limited",
      retryAfterSeconds: 5,
    });
  });

  it("classifies auth, outage and network failures", () => {
    expect(classifyProviderError(apiError(401))).toEqual({ kind: "auth" });
    expect(classifyProviderError(apiError(503))).toEqual({
      kind: "unavailable",
    });
    expect(classifyProviderError(new Error("fetch failed"))).toEqual({
      kind: "unavailable",
    });
  });
});
