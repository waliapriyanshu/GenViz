import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { type FollowUpContext, runAnalysis } from "@/lib/agent/orchestrator";
import type { QueryAudit } from "@/lib/agent/tools";
import type { ProviderFailure } from "@/lib/ai/model";
import type { HistoryTurn } from "@/lib/ai/prompts";
import { getAnalystModelChain, primaryProviderName } from "@/lib/ai/provider";
import { config } from "@/lib/config";
import { toRuntime } from "@/lib/data/sources";
import { ConfigError, UserError, toUserError } from "@/lib/errors";
import { errorResponse, ndjsonResponse } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import {
  claimQuerySlot,
  currentWait,
  postgresCooldownStore,
  recordProviderRateLimit,
} from "@/lib/security/rate-limit";
import { assertSameOrigin, getIdentity } from "@/lib/security/session";
import type { AssistantPayload, ChatStreamEvent } from "@/lib/viz/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  message: z.string().trim().min(1).max(1_000),
  sourceId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
});

const HISTORY_MESSAGES = 8;

function providerMessage(failure: ProviderFailure): {
  code: string;
  message: string;
} {
  switch (failure.kind) {
    case "auth":
      return {
        code: "ai_not_configured",
        message:
          "Genviz's AI service isn't configured correctly. Please contact the administrator.",
      };
    case "unavailable":
      return {
        code: "ai_unavailable",
        message:
          "The AI service is temporarily unavailable. Please try again in a moment.",
      };
    default:
      return {
        code: "ai_unavailable",
        message:
          "I had trouble working that out. Please try rephrasing your question.",
      };
  }
}

function toHistory(
  messages: Array<{ role: string; content: string; payload: Prisma.JsonValue }>,
): HistoryTurn[] {
  return messages.flatMap<HistoryTurn>((message) => {
    if (message.role === "user")
      return [{ role: "user", content: message.content }];
    const payload = (message.payload ?? {}) as Partial<AssistantPayload> & {
      followUp?: FollowUpContext;
    };
    if (payload.status === "error") return [];
    return [
      {
        role: "assistant",
        content: message.content,
        sql: payload.followUp?.sql,
        columns: payload.followUp?.columns,
        rowCount: payload.followUp?.rowCount,
      },
    ];
  });
}

export async function POST(request: Request) {
  let prepared: {
    identity: Awaited<ReturnType<typeof getIdentity>>;
    conversationId: string;
    question: string;
    source: NonNullable<Awaited<ReturnType<typeof prisma.source.findFirst>>>;
    history: HistoryTurn[];
    models: ReturnType<typeof getAnalystModelChain>;
    provider: string;
  };

  try {
    await assertSameOrigin();
    const identity = await getIdentity();
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
      throw new UserError(
        "bad_request",
        "Please type a question (up to 1,000 characters) and choose a data source.",
      );
    const { message, sourceId } = parsed.data;

    const source = await prisma.source.findFirst({
      where: { id: sourceId, ownerId: identity.sessionId },
    });
    if (!source)
      throw new UserError(
        "not_found",
        "That data source is no longer available. Please upload or connect your data again.",
        404,
      );

    let models: ReturnType<typeof getAnalystModelChain>;
    try {
      models = getAnalystModelChain();
    } catch (error) {
      if (error instanceof ConfigError) {
        console.error("[genviz]", error.message);
        throw new UserError(
          "ai_not_configured",
          "Genviz's AI model isn't configured yet (the server is missing its Groq API key).",
          503,
        );
      }
      throw error;
    }
    const provider = primaryProviderName();

    // Backend enforcement; the browser countdown is only UX.
    const wait = await claimQuerySlot(
      postgresCooldownStore,
      identity,
      provider,
      {
        sessionSeconds: config.queryCooldownSeconds(),
        ipSeconds: config.ipCooldownSeconds(),
      },
    );
    if (wait > 0) {
      throw new UserError(
        "rate_limited",
        `Genviz is taking a short pause because you've reached the current query limit. Next query available in ${wait} second${wait === 1 ? "" : "s"}.`,
        429,
        { retryAfterSeconds: wait },
      );
    }

    let conversation = parsed.data.conversationId
      ? await prisma.conversation.findFirst({
          where: {
            id: parsed.data.conversationId,
            ownerId: identity.sessionId,
          },
        })
      : null;
    if (conversation && conversation.sourceId !== source.id)
      conversation = null; // new source → new conversation
    const previous = conversation
      ? await prisma.message.findMany({
          where: { conversationId: conversation.id },
          orderBy: { createdAt: "desc" },
          take: HISTORY_MESSAGES,
        })
      : [];
    conversation ??= await prisma.conversation.create({
      data: {
        ownerId: identity.sessionId,
        sourceId: source.id,
        title: message.slice(0, 80),
      },
    });
    await prisma.message.create({
      data: { conversationId: conversation.id, role: "user", content: message },
    });

    prepared = {
      identity,
      conversationId: conversation.id,
      question: message,
      source,
      history: toHistory(previous.reverse()),
      models,
      provider,
    };
  } catch (error) {
    return errorResponse(error);
  }

  const {
    identity,
    conversationId,
    question,
    source,
    history,
    models,
    provider,
  } = prepared;

  return ndjsonResponse(
    async (sendRaw) => {
      const send = (event: ChatStreamEvent) => sendRaw(event);
      send({ type: "conversation", conversationId });

      const audits: QueryAudit[] = [];
      const outcome = await runAnalysis({
        question,
        source: toRuntime(source),
        history,
        models,
        emit: (stage) => send({ type: "stage", stage }),
        audit: (entry) => audits.push(entry),
        abortSignal: request.signal,
      });

      if (audits.length) {
        await prisma.queryRun
          .createMany({
            data: audits.map((a) => ({
              ownerId: identity.sessionId,
              sourceId: source.id,
              conversationId,
              sql: a.sql.slice(0, 20_000),
              status: a.status,
              rowCount: a.rowCount ?? null,
              durationMs: a.durationMs ?? null,
              error: a.error?.slice(0, 2_000) ?? null,
            })),
          })
          .catch((error) =>
            console.error("[genviz] failed to write query audit", error),
          );
      }

      if (outcome.kind === "provider_error") {
        if (outcome.failure.kind === "rate_limited") {
          const seconds =
            outcome.failure.retryAfterSeconds ??
            config.providerFallbackCooldownSeconds();
          await recordProviderRateLimit(
            postgresCooldownStore,
            identity,
            provider,
            seconds,
          );
          send({
            type: "rate_limited",
            retryAfterSeconds: seconds,
            message: `Genviz is taking a short pause because the AI query limit was reached. Next query available in ${seconds} second${seconds === 1 ? "" : "s"}.`,
          });
          return;
        }
        const { code, message } = providerMessage(outcome.failure);
        send({
          type: "error",
          code,
          message,
          nextQueryInSeconds: await currentWait(
            postgresCooldownStore,
            identity,
            provider,
          ),
        });
        return;
      }

      if (outcome.payload.visualization)
        send({ type: "stage", stage: "visualizing" });
      const stored = await prisma.message.create({
        data: {
          conversationId,
          role: "assistant",
          content: outcome.payload.answer,
          payload: {
            ...outcome.payload,
            ...(outcome.followUp ? { followUp: outcome.followUp } : {}),
          } as object,
        },
      });
      await prisma.conversation
        .update({
          where: { id: conversationId },
          data: { updatedAt: new Date() },
        })
        .catch(() => undefined);
      send({
        type: "result",
        messageId: stored.id,
        payload: outcome.payload,
        nextQueryInSeconds: await currentWait(
          postgresCooldownStore,
          identity,
          provider,
        ),
      });
    },
    (error) => {
      const userError = toUserError(error);
      return {
        type: "error",
        code: userError.code,
        message: userError.message,
      };
    },
  );
}
