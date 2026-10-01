import { cookies, headers } from "next/headers";
import "server-only";
import { isProduction } from "@/lib/config";
import { UserError } from "@/lib/errors";
import {
  hashIdentifier,
  randomId,
  sign,
  verifySignature,
} from "@/lib/security/crypto";

const COOKIE_NAME = "gv_sid";
const ONE_YEAR = 60 * 60 * 24 * 365;

export interface RequestIdentity {
  /** Owner key for all data created by this browser (anonymous session). */
  sessionId: string;
  /** Hashed client IP (never stored raw). */
  ipKey: string;
}

/**
 * Anonymous, HMAC-signed session cookie. Every source, conversation and query is
 * scoped to this id, which gives per-browser isolation until real auth is added.
 */
export async function getIdentity(): Promise<RequestIdentity> {
  const store = await cookies();
  const raw = store.get(COOKIE_NAME)?.value;
  let sessionId: string | null = null;
  if (raw) {
    const [id, signature] = raw.split(".");
    if (id && signature && verifySignature(id, signature)) sessionId = id;
  }
  if (!sessionId) {
    sessionId = randomId();
    store.set(COOKIE_NAME, `${sessionId}.${sign(sessionId)}`, {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction(),
      path: "/",
      maxAge: ONE_YEAR,
    });
  }
  const headerStore = await headers();
  const ip =
    headerStore.get("x-real-ip") ??
    headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  return { sessionId, ipKey: hashIdentifier(ip) };
}

/** Rejects cross-site state-changing requests (defence in depth on top of SameSite=Lax). */
export async function assertSameOrigin(): Promise<void> {
  const headerStore = await headers();
  const origin = headerStore.get("origin");
  if (!origin) return; // same-origin fetches from older browsers / server-side callers
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  try {
    if (host && new URL(origin).host === host) return;
  } catch {
    // fall through
  }
  throw new UserError("forbidden", "Cross-site requests are not allowed.", 403);
}
