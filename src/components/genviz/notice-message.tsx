"use client";

import { AlertCircle, Hourglass } from "lucide-react";
import { useCountdown } from "@/hooks/use-countdown";
import { formatDuration } from "@/lib/client/format";

export function NoticeMessage({
  tone,
  message,
  until,
}: {
  tone: "rate_limit" | "error";
  message: string;
  until?: number;
}) {
  const remaining = useCountdown(until);
  if (tone === "rate_limit") {
    return (
      <div
        className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm"
        role="status"
      >
        <Hourglass
          className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden
        />
        <div className="space-y-1">
          <div className="font-medium">
            {remaining > 0
              ? "Rate limit reached"
              : "Ready for your next question"}
          </div>
          <div className="text-muted-foreground">
            {remaining > 0 ? (
              <>
                Genviz is taking a short pause because the current query limit
                was reached. You can ask another question in{" "}
                <span className="font-semibold tabular-nums text-foreground">
                  {formatDuration(remaining)}
                </span>
                .
              </>
            ) : (
              "The pause is over. Go ahead and ask again."
            )}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div
      className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm"
      role="alert"
    >
      <AlertCircle
        className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
        aria-hidden
      />
      <div className="whitespace-pre-line">{message}</div>
    </div>
  );
}
