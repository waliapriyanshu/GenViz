import "server-only";
import { PrismaClient } from "@prisma/client";

/**
 * Serverless Postgres (e.g. Neon) suspends when idle and can take several
 * seconds to wake up, longer than Prisma's 5s default connect timeout. Wait a
 * little longer, staying under Vercel's 10s default function limit.
 */
export function withConnectTimeout(url: string, seconds = 8): string {
  if (/[?&]connect_timeout=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}connect_timeout=${seconds}`;
}

// One client per server instance (and across dev hot reloads).
const globalForPrisma = globalThis as unknown as {
  genvizPrisma?: PrismaClient;
};

const databaseUrl = process.env.DATABASE_URL;

export const prisma =
  globalForPrisma.genvizPrisma ??
  new PrismaClient(
    databaseUrl
      ? { datasources: { db: { url: withConnectTimeout(databaseUrl) } } }
      : undefined,
  );

if (process.env.NODE_ENV !== "production")
  globalForPrisma.genvizPrisma = prisma;
