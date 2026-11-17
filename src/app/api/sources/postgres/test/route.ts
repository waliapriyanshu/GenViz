import { NextResponse } from "next/server";
import { z } from "zod";
import { testConnection } from "@/lib/data/postgres-source";
import { UserError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { enforceCooldown } from "@/lib/security/rate-limit";
import { assertSameOrigin, getIdentity } from "@/lib/security/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const bodySchema = z.object({
  connectionString: z.string().min(10).max(2_000),
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
    // Connection tests open outbound sockets: throttle per IP to stop network probing.
    await enforceCooldown(
      `conn-test:${identity.ipKey}`,
      3,
      "before testing again",
    );
    const result = await testConnection(parsed.data.connectionString);
    return NextResponse.json({
      ok: true,
      database: result.snapshot.database,
      host: result.host,
      tableCount: result.snapshot.tables.length,
      tables: result.snapshot.tables
        .slice(0, 30)
        .map((t) => (t.schema === "public" ? t.name : `${t.schema}.${t.name}`)),
      warnings: result.warnings,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
