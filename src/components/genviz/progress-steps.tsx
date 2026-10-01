"use client";

import { Check, Loader2 } from "lucide-react";
import type { ProgressStage } from "@/lib/viz/types";

const LABELS: Record<ProgressStage, string> = {
  understanding: "Understanding your question",
  inspecting: "Inspecting your data",
  querying: "Querying your data",
  analyzing: "Analyzing results",
  visualizing: "Creating visualization",
};

/**
 * Shows only stages the server actually reported (no fake timers). Earlier
 * stages are marked done as soon as a later one starts.
 */
export function ProgressSteps({ stages }: { stages: ProgressStage[] }) {
  const unique = stages.filter((stage, i) => stages.indexOf(stage) === i);
  const current = stages[stages.length - 1];
  return (
    <div className="flex flex-col gap-1.5 py-1" aria-live="polite">
      {unique.map((stage) => {
        const active = stage === current;
        return (
          <div
            key={stage}
            className={`flex items-center gap-2 text-sm ${active ? "text-foreground" : "text-muted-foreground"}`}
          >
            {active ? (
              <Loader2
                className="h-4 w-4 animate-spin text-primary"
                aria-hidden
              />
            ) : (
              <Check
                className="h-4 w-4 text-emerald-600 dark:text-emerald-400"
                aria-hidden
              />
            )}
            <span>
              {LABELS[stage]}
              {active ? "…" : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}
