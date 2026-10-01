import { NextResponse } from "next/server";
import { primaryProviderName } from "@/lib/ai/provider";
import { config } from "@/lib/config";
import { errorResponse } from "@/lib/http";
import { currentWait, postgresCooldownStore } from "@/lib/security/rate-limit";
import { getIdentity } from "@/lib/security/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lets the UI restore an active countdown after a page reload. */
export async function GET() {
  try {
    const identity = await getIdentity();
    const retryAfterSeconds = await currentWait(
      postgresCooldownStore,
      identity,
      primaryProviderName(),
    );
    return NextResponse.json({
      retryAfterSeconds,
      cooldownSeconds: config.queryCooldownSeconds(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
