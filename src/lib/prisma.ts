import "server-only";
import { PrismaClient } from "@prisma/client";

// One client per server instance (and across dev hot reloads).
const globalForPrisma = globalThis as unknown as {
  genvizPrisma?: PrismaClient;
};

export const prisma = globalForPrisma.genvizPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production")
  globalForPrisma.genvizPrisma = prisma;
