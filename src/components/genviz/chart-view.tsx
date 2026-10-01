"use client";

import { useEffect, useMemo, useState } from "react";
import { VChart } from "@visactor/react-vchart";
import { formatNumber, humanizeKey } from "@/lib/client/format";
import type { Visualization } from "@/lib/viz/types";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "2026-03-01" → "Mar 2026" (monthly data) or "Mar 5, 2026"; month numbers 1-12 → "Mar". */
export function axisLabelFormatter(
  field: string,
  values: unknown[],
): ((value: unknown) => string) | undefined {
  const strings = values.map((v) => String(v));
  if (
    strings.length &&
    strings.every((v) => /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(v))
  ) {
    const monthly = strings.every((v) => v.slice(8, 10) === "01");
    return (value) => {
      const text = String(value);
      const month = MONTHS[Number(text.slice(5, 7)) - 1];
      if (!month) return text;
      return monthly
        ? `${month} ${text.slice(0, 4)}`
        : `${month} ${Number(text.slice(8, 10))}, ${text.slice(0, 4)}`;
    };
  }
  if (
    /(^|_)month(_num|_number|_no|_of_year)?$/i.test(field) &&
    values.every(
      (v) => Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 12,
    )
  ) {
    return (value) => MONTHS[Number(value) - 1] ?? String(value);
  }
  return undefined;
}

/** Maps Genviz's validated visualization contract to a VChart spec. */
export function toVChartSpec(viz: Visualization): Record<string, any> | null {
  const { x, y, series, horizontal, currency, xLabel, yLabel } = viz.config;
  const yKey = y?.[0];
  if (!x || !yKey || viz.data.length === 0) return null;
  const fmt = (v: unknown) =>
    typeof v === "number"
      ? formatNumber(v, { currency, compact: true })
      : String(v ?? "");
  const fmtFull = (v: unknown) =>
    typeof v === "number" ? formatNumber(v, { currency }) : String(v ?? "");
  const valueLabel = yLabel ?? humanizeKey(yKey);
  const tooltipLine = {
    key: (d: any) =>
      series && d?.[series] !== undefined ? String(d[series]) : valueLabel,
    value: (d: any) => fmtFull(d?.[yKey]),
  };
  const tooltipTitle = (d: any) => {
    const raw = d?.[x];
    const format = axisLabelFormatter(
      x,
      viz.data.map((row) => row[x]),
    );
    return format ? format(raw) : String(raw ?? "");
  };
  const tooltip = {
    mark: { title: { value: tooltipTitle }, content: [tooltipLine] },
    dimension: { content: [tooltipLine] },
  };
  const data = [{ id: "data", values: viz.data }];
  const legends = series ? [{ visible: true, orient: "bottom" }] : undefined;
  const linearAxis = (orient: "left" | "bottom", title?: string) => ({
    orient,
    type: "linear",
    label: { formatMethod: (text: string | string[]) => fmt(Number(text)) },
    ...(title ? { title: { visible: true, text: title } } : {}),
  });
  const xFormat = axisLabelFormatter(
    x,
    viz.data.map((d) => d[x]),
  );
  const bandAxis = (orient: "left" | "bottom", title?: string) => ({
    orient,
    type: "band",
    ...(xFormat
      ? {
          label: {
            formatMethod: (text: string | string[]) =>
              xFormat(Array.isArray(text) ? text[0] : text),
          },
        }
      : {}),
    ...(title ? { title: { visible: true, text: title } } : {}),
  });

  const xField: string = x;
  const yField: string = yKey;
  const buildSpec = (): Record<string, any> | null => {
    const x = xField;
    const yKey = yField;
    switch (viz.type) {
      case "line":
      case "area":
        return {
          type: viz.type,
          data,
          xField: x,
          yField: yKey,
          ...(series ? { seriesField: series } : {}),
          point: { visible: viz.data.length <= 36 },
          ...(viz.type === "area"
            ? { area: { style: { fillOpacity: 0.25 } } }
            : {}),
          axes: [bandAxis("bottom"), linearAxis("left")],
          legends,
          tooltip,
          crosshair: { xField: { visible: true } },
        };
      case "bar":
      case "histogram": {
        const xFields = series ? [x, series] : [x];
        if (horizontal) {
          return {
            type: "bar",
            data,
            direction: "horizontal",
            xField: yKey,
            yField: xFields,
            ...(series ? { seriesField: series } : {}),
            axes: [linearAxis("bottom"), bandAxis("left")],
            legends,
            tooltip,
          };
        }
        return {
          type: "bar",
          data,
          xField: xFields,
          yField: yKey,
          ...(series ? { seriesField: series } : {}),
          ...(viz.type === "histogram"
            ? { barGapInGroup: 0, bar: { style: { cornerRadius: 0 } } }
            : { bar: { style: { cornerRadius: [4, 4, 0, 0] } } }),
          axes: [
            bandAxis("bottom", viz.type === "histogram" ? xLabel : undefined),
            linearAxis("left", viz.type === "histogram" ? "Count" : undefined),
          ],
          legends,
          tooltip,
        };
      }
      case "pie":
        return {
          type: "pie",
          data,
          categoryField: x,
          valueField: yKey,
          innerRadius: 0.6,
          outerRadius: 0.85,
          padAngle: 0.6,
          pie: { style: { cornerRadius: 6 } },
          label: { visible: true, position: "outside" },
          legends: [{ visible: true, orient: "right" }],
          tooltip: {
            mark: {
              content: [
                {
                  key: (d: any) => String(d?.[x] ?? ""),
                  value: (d: any) => fmtFull(d?.[yKey]),
                },
              ],
            },
          },
        };
      case "scatter":
        return {
          type: "scatter",
          data,
          xField: x,
          yField: yKey,
          size: 8,
          axes: [linearAxis("bottom", xLabel), linearAxis("left", yLabel)],
          tooltip: {
            mark: {
              content: [
                { key: xLabel ?? x, value: (d: any) => fmtFull(d?.[x]) },
                { key: yLabel ?? yKey, value: (d: any) => fmtFull(d?.[yKey]) },
              ],
            },
          },
        };
      default:
        return null;
    }
  };
  const spec = buildSpec();
  return spec ? { background: "transparent", ...spec } : null;
}

export function ChartView({ viz }: { viz: Visualization }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const spec = useMemo(() => toVChartSpec(viz), [viz]);
  if (!spec) return null;
  const height = viz.config.horizontal
    ? Math.min(640, Math.max(280, viz.data.length * 26 + 80))
    : 340;
  if (!mounted)
    return (
      <div
        className="w-full animate-pulse rounded-lg bg-muted"
        style={{ height }}
      />
    );
  return (
    <div
      className="w-full"
      style={{ height }}
      role="img"
      aria-label={viz.title}
    >
      <VChart spec={spec as any} className="h-full w-full" />
    </div>
  );
}
