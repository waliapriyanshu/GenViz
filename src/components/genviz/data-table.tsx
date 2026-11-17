"use client";

import { formatCell, humanizeKey } from "@/lib/client/format";
import type { ResultTable } from "@/lib/viz/types";

const RAW_NUMBER_COLUMN =
  /(^|_)(year|yr|id|code|zip|zipcode|key|sku|number|no)$/i;

export function DataTable({ table }: { table: ResultTable }) {
  const numericColumns = table.columns.map((_, i) =>
    table.rows.some((row) => typeof row[i] === "number"),
  );
  const rawColumns = table.columns.map((name) => RAW_NUMBER_COLUMN.test(name));
  return (
    <div className="overflow-hidden rounded-[1.75rem] border bg-card">
      <div className="max-h-80 overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 bg-muted">
            <tr>
              {table.columns.map((column, i) => (
                <th
                  key={`${column}-${i}`}
                  scope="col"
                  className={`whitespace-nowrap px-4 py-2.5 font-medium text-muted-foreground ${numericColumns[i] ? "text-right" : "text-left"}`}
                >
                  {humanizeKey(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, r) => (
              <tr key={r} className="border-t border-border/60 odd:bg-muted/20">
                {row.map((cell, c) => (
                  <td
                    key={c}
                    className={`whitespace-nowrap px-4 py-2 ${numericColumns[c] ? "text-right font-mono text-[13px] tabular-nums" : ""}`}
                  >
                    {rawColumns[c] && typeof cell === "number"
                      ? String(cell)
                      : formatCell(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
        {table.truncated
          ? `Showing ${table.rows.length.toLocaleString()} of ${table.totalRows.toLocaleString()} rows`
          : `${table.totalRows.toLocaleString()} row${table.totalRows === 1 ? "" : "s"}`}
      </div>
    </div>
  );
}
