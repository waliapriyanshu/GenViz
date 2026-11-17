import { NextResponse } from "next/server";
import { z } from "zod";
import { testConnection } from "@/lib/data/postgres-source";
import {
  type PostgresDetails,
  assertSourceQuota,
  suggestPostgresQuestions,
  toPublicSource,
} from "@/lib/data/sources";
import { UserError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/security/crypto";
import { enforceCooldown } from "@/lib/security/rate-limit";
import { assertSameOrigin, getIdentity } from "@/lib/security/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const bodySchema = z.object({
  connectionString: z.string().min(10).max(2_000),
  name: z.string().max(80).optional(),
});

export async function POST(request: Request) {
  try {
    await assertSameOrigin();
    const identity = await getIdentity();
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
      throw new UserError(
        "invalid_connection",
        "Enter a PostgreSQL connection string.",
      );
    await enforceCooldown(`conn-save:${identity.ipKey}`, 3, "and try again");
    await assertSourceQuota(identity.sessionId);

    const result = await testConnection(parsed.data.connectionString);
    const details: PostgresDetails = {
      database: result.snapshot.database,
      host: result.host,
      user: result.snapshot.user,
      serverVersion: result.snapshot.serverVersion,
      tableCount: result.snapshot.tables.length,
      snapshot: result.snapshot,
      warnings: result.warnings,
      suggestions: suggestPostgresQuestions(result.snapshot),
    };
    const source = await prisma.source.create({
      data: {
        ownerId: identity.sessionId,
        kind: "postgres",
        name: (parsed.data.name?.trim() || result.snapshot.database).slice(
          0,
          80,
        ),
        // The raw connection string is encrypted at rest and never returned to the browser.
        encryptedUrl: encryptSecret(parsed.data.connectionString.trim()),
        details: details as object,
      },
    });
    return NextResponse.json({ source: toPublicSource(source) });
  } catch (error) {
    return errorResponse(error);
  }
}
