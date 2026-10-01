import { NextResponse } from "next/server";
import { toPublicSource } from "@/lib/data/sources";
import { errorResponse } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { getIdentity } from "@/lib/security/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { sessionId } = await getIdentity();
    const sources = await prisma.source.findMany({
      where: { ownerId: sessionId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return NextResponse.json({ sources: sources.map(toPublicSource) });
  } catch (error) {
    return errorResponse(error);
  }
}
