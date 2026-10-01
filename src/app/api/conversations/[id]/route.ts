import { NextResponse } from "next/server";
import { UserError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { getIdentity } from "@/lib/security/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { sessionId } = await getIdentity();
    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new UserError("not_found", "Conversation not found.", 404);
    const conversation = await prisma.conversation.findFirst({
      where: { id, ownerId: sessionId },
      include: { messages: { orderBy: { createdAt: "asc" }, take: 100 } },
    });
    if (!conversation)
      throw new UserError("not_found", "Conversation not found.", 404);
    return NextResponse.json({
      conversation: {
        id: conversation.id,
        sourceId: conversation.sourceId,
        title: conversation.title,
      },
      messages: conversation.messages.map((m) => {
        // The follow-up context is internal (fed back to the model); the client gets the rest.
        const payload = { ...((m.payload ?? {}) as Record<string, unknown>) };
        delete payload.followUp;
        return {
          id: m.id,
          role: m.role,
          content: m.content,
          payload: m.payload ? payload : null,
          createdAt: m.createdAt.toISOString(),
        };
      }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
