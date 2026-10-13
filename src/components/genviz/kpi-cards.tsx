"use client";

import { formatNumber } from "@/lib/client/format";
import type { Visualization } from "@/lib/viz/types";

export function KpiCards({ viz }: { viz: Visualization }) {
  const items = viz.config.kpis ?? [];
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label} className="rounded-3xl border bg-muted/40 p-5">
          <div className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            {item.label}
          </div>
          <div className="mt-1 text-4xl font-medium tabular-nums tracking-tight">
            {formatNumber(item.value, {
              currency:
                item.unit === "currency" ? viz.config.currency : undefined,
              percent: item.unit === "percent",
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
