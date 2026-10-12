"use client";

import {
  AlertTriangle,
  Database,
  FileSpreadsheet,
  Info,
  Table2,
  Workflow,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";
import { DataTable } from "@/components/genviz/data-table";
import { KpiCards } from "@/components/genviz/kpi-cards";
import { stripEmDashes } from "@/lib/text";
import type { AssistantPayload } from "@/lib/viz/types";

// VChart is large: load it only when the first chart is rendered.
const ChartView = dynamic(
  () => import("@/components/genviz/chart-view").then((m) => m.ChartView),
  {
    ssr: false,
    loading: () => (
      <div className="h-[340px] w-full animate-pulse rounded-md bg-muted" />
    ),
  },
);

export function AssistantMessage({
  payload,
  onAsk,
  disabled,
}: {
  payload: AssistantPayload;
  onAsk: (question: string) => void;
  disabled: boolean;
}) {
  const [showData, setShowData] = useState(false);
  const [showHow, setShowHow] = useState(false);
  const viz = payload.visualization;
  const hasChart = viz && viz.type !== "table";
  const isProblem =
    payload.status === "error" || payload.status === "unsupported";
  const meta = payload.metadata;

  return (
    <div className="min-w-0">
      <div className="space-y-4">
        <div
          className={`flex items-start gap-2 whitespace-pre-line text-[17px] leading-relaxed ${isProblem ? "text-foreground/90" : ""}`}
        >
          {isProblem && (
            <AlertTriangle
              className="mt-1 h-4 w-4 shrink-0 text-amber-500"
              aria-hidden
            />
          )}
          <p>{stripEmDashes(payload.answer)}</p>
        </div>

        {hasChart && (
          <div className="rounded-md border bg-card p-4">
            {viz.title && (
              <div className="mb-3 text-lg font-medium leading-snug">
                {stripEmDashes(viz.title)}
              </div>
            )}
            {viz.type === "kpi" ? (
              <KpiCards viz={viz} />
            ) : (
              <ChartView viz={viz} />
            )}
            {viz.notes.length > 0 && (
              <div className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>{stripEmDashes(viz.notes.join(" "))}</span>
              </div>
            )}
          </div>
        )}

        {payload.table && (!hasChart || showData) && (
          <DataTable table={payload.table} />
        )}

        {(payload.table || meta) && (
          <div className="flex flex-wrap gap-2">
            {hasChart && payload.table && (
              <button
                type="button"
                onClick={() => setShowData((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent"
                aria-expanded={showData}
              >
                <Table2 className="h-3.5 w-3.5" aria-hidden />{" "}
                {showData ? "Hide data" : "View data"}
              </button>
            )}
            {meta && (
              <button
                type="button"
                onClick={() => setShowHow((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent"
                aria-expanded={showHow}
              >
                <Workflow className="h-3.5 w-3.5" aria-hidden /> How I got this
              </button>
            )}
          </div>
        )}

        {showHow && meta && (
          <div className="space-y-3 rounded-md border bg-muted/40 p-4 text-sm">
            <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                {meta.sourceKind === "csv" ? (
                  <FileSpreadsheet className="h-3.5 w-3.5" />
                ) : (
                  <Database className="h-3.5 w-3.5" />
                )}
                {stripEmDashes(meta.source)}
              </span>
              <span>
                {meta.rowCount.toLocaleString()} result row
                {meta.rowCount === 1 ? "" : "s"}
              </span>
              <span>{meta.executionTimeMs} ms in the database</span>
              <span>Model: {meta.model}</span>
            </div>
            {meta.steps.length > 0 && (
              <ol className="list-decimal space-y-0.5 pl-5">
                {meta.steps.map((step, i) => (
                  <li key={i}>{stripEmDashes(step)}</li>
                ))}
              </ol>
            )}
            {meta.queries.map((sql, i) => (
              <div key={i}>
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  Read-only query{meta.queries.length > 1 ? ` ${i + 1}` : ""}
                </div>
                <pre className="overflow-x-auto rounded-md border bg-background p-3 font-mono text-xs leading-relaxed">
                  {sql.trim()}
                </pre>
              </div>
            ))}
          </div>
        )}

        {payload.suggestions && payload.suggestions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {payload.suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                disabled={disabled}
                onClick={() => onAsk(stripEmDashes(suggestion))}
                className="rounded-md border bg-card px-2.5 py-1 text-[13px] hover:border-foreground/50 hover:shadow-[inset_0_-6px_0_hsl(var(--highlight)/0.55)] disabled:opacity-50"
              >
                {stripEmDashes(suggestion)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
