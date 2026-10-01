import { NextResponse } from "next/server";
import { dropDataset } from "@/lib/data/csv-ingest";
import { UserError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin, getIdentity } from "@/lib/security/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await assertSameOrigin();
    const { sessionId } = await getIdentity();
    const { id } = await context.params;
    const source = await prisma.source
      .findFirst({ where: { id, ownerId: sessionId } })
      .catch(() => null);
    if (!source)
      throw new UserError("not_found", "That data source doesn't exist.", 404);
    if (source.kind === "csv" && source.tableName)
      await dropDataset(source.tableName);
    await prisma.source.delete({ where: { id: source.id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
