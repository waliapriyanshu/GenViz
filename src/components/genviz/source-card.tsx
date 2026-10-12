"use client";

import {
  AlertTriangle,
  CalendarDays,
  Database,
  FileSpreadsheet,
  Hash,
  ToggleLeft,
  Type,
} from "lucide-react";
import type { ClientSource } from "@/lib/client/types";

const KIND_ICON = {
  integer: Hash,
  number: Hash,
  boolean: ToggleLeft,
  date: CalendarDays,
  timestamp: CalendarDays,
  text: Type,
} as const;

export function sourceLabel(source: ClientSource): string {
  return source.kind === "csv"
    ? `Uploaded CSV: ${source.fileName}`
    : `PostgreSQL: ${source.database}`;
}

/** Summary of the active data source plus schema-based example questions. */
export function SourceCard({
  source,
  onAsk,
  disabled,
}: {
  source: ClientSource;
  onAsk: (question: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="rounded-md border bg-card p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border bg-secondary text-foreground">
          {source.kind === "csv" ? (
            <FileSpreadsheet className="h-5 w-5" />
          ) : (
            <Database className="h-5 w-5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-serif text-lg font-medium leading-tight">
            {source.kind === "csv" ? source.fileName : source.database}
          </div>
          <div className="text-sm text-muted-foreground">
            {source.kind === "csv" ? (
              <>
                Uploaded CSV · {source.rowCount.toLocaleString()} rows ·{" "}
                {source.columnCount} columns
              </>
            ) : (
              <>
                PostgreSQL ·{" "}
                <span className="text-emerald-600 dark:text-emerald-400">
                  Connected
                </span>{" "}
                · {source.tableCount} table
                {source.tableCount === 1 ? "" : "s"}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          {source.kind === "csv" ? "Detected columns" : "Tables"}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {source.kind === "csv"
            ? source.columns.slice(0, 18).map((column) => {
                const Icon = KIND_ICON[column.kind] ?? Type;
                return (
                  <span
                    key={column.name}
                    className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 font-mono text-[11px]"
                    title={`${column.kind}, ${column.role}`}
                  >
                    <Icon
                      className="h-3 w-3 text-muted-foreground"
                      aria-hidden
                    />{" "}
                    {column.label}
                  </span>
                );
              })
            : source.tables.slice(0, 18).map((table) => (
                <span
                  key={table}
                  className="rounded-md bg-muted px-2 py-0.5 font-mono text-[11px]"
                >
                  {table}
                </span>
              ))}
          {source.kind === "csv" && source.columns.length > 18 && (
            <span className="px-1 text-xs text-muted-foreground">
              +{source.columns.length - 18} more
            </span>
          )}
          {source.kind === "postgres" && source.tableCount > 18 && (
            <span className="px-1 text-xs text-muted-foreground">
              +{source.tableCount - 18} more
            </span>
          )}
        </div>
      </div>

      {source.warnings.length > 0 && (
        <div className="mt-4 space-y-1">
          {source.warnings.map((warning) => (
            <div
              key={warning}
              className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400"
            >
              <AlertTriangle
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
                aria-hidden
              />{" "}
              {warning}
            </div>
          ))}
        </div>
      )}

      {source.suggestions.length > 0 && (
        <div className="mt-5">
          <div className="mb-2 text-sm font-medium">Try asking:</div>
          <div className="flex flex-wrap gap-2">
            {source.suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                disabled={disabled}
                onClick={() => onAsk(suggestion)}
                className="rounded-md border bg-background px-3 py-1.5 text-sm hover:border-primary/60 hover:text-primary disabled:opacity-50"
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
