import { NextResponse } from "next/server";
import "server-only";
import { type UserError, toUserError } from "@/lib/errors";

export function errorResponse(error: unknown): NextResponse {
  const userError: UserError = toUserError(error);
  return NextResponse.json(
    {
      error: {
        code: userError.code,
        message: userError.message,
        ...(userError.details ?? {}),
      },
    },
    {
      status: userError.status,
      headers:
        userError.code === "rate_limited" &&
        typeof userError.details?.retryAfterSeconds === "number"
          ? { "Retry-After": String(userError.details.retryAfterSeconds) }
          : undefined,
    },
  );
}

/** Newline-delimited JSON stream for real progress events. */
export function ndjsonResponse(
  run: (send: (event: unknown) => void) => Promise<void>,
  onError: (error: unknown) => unknown,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // client went away
        }
      };
      try {
        await run(send);
      } catch (error) {
        send(onError(error));
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
