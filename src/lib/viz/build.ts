import { histogramBins } from "@/lib/analysis/analyze";
import {
  type FieldInfo,
  type TabularResult,
  describeFields,
  fieldByName,
  isFiniteNumber,
  isYearLike,
  round,
  toNumber,
} from "@/lib/analysis/shape";
import type { ResultTable, Visualization, VizType } from "@/lib/viz/types";

/**
 * Deterministic visualization layer. The model may *suggest* a chart type and
 * fields, but every field is validated against the actual result columns and
 * the chart type is checked against the result's shape. Output never contains
 * undefined/NaN values or columns that do not exist in the result.
 */

export interface VizHint {
  type?: VizType | "auto";
  x?: string;
  y?: string[];
  series?: string;
  title?: string;
  currency?: string;
}

const MONEY_NAME =
  /(revenue|sales|amount|price|cost|profit|income|spend|spent|value|total|margin|fee|payment|salary|budget|gmv|arr|mrr)/i;
const NOT_MONEY_NAME =
  /(unit|count|qty|quantity|orders|customers|number|num_|pct|percent|rate|share|ratio|days|items)/i;

/** True for measure names that hold money, e.g. total_revenue (but not total_units). */
export function isMoneyName(name: string): boolean {
  return MONEY_NAME.test(name) && !NOT_MONEY_NAME.test(name);
}

const MAX_BAR_CATEGORIES = 30;
const MAX_PIE_SLICES = 8;
const MAX_SERIES = 12;
const MAX_LINE_POINTS = 2_000;
const MAX_SCATTER_POINTS = 3_000;

export function humanize(name: string): string {
  const spaced = name
    .replace(/[_\s]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function xValue(value: unknown): string | number {
  if (value === null || value === undefined || value === "") return "(blank)";
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function compareX(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function tableViz(title: string, notes: string[]): Visualization {
  return { type: "table", title, data: [], config: {}, notes };
}

export function buildTable(result: TabularResult, maxRows = 200): ResultTable {
  return {
    columns: result.columns.map((c) => c.name),
    rows: result.rows
      .slice(0, maxRows)
      .map((row) =>
        row.map((v) =>
          typeof v === "number" && !Number.isFinite(v) ? null : (v ?? null),
        ),
      ),
    totalRows: result.rows.length,
    truncated: result.rows.length > maxRows,
  };
}

export function buildVisualization(
  result: TabularResult,
  hint: VizHint = {},
): Visualization {
  const notes: string[] = [];
  const fields = describeFields(result);
  const title = (hint.title ?? "").trim();

  if (result.rows.length === 0) return tableViz(title || "No results", notes);

  // --- validate hinted fields against the real result columns ---
  const check = (name: string | undefined): FieldInfo | undefined => {
    if (!name) return undefined;
    const field = fieldByName(fields, name);
    if (!field) notes.push(`Ignored unknown column "${name}".`);
    return field;
  };
  const hintX = check(hint.x);
  const hintY = (hint.y ?? [])
    .map(check)
    .filter((f): f is FieldInfo => !!f && f.numeric);
  const hintSeries = check(hint.series);
  const requested = hint.type && hint.type !== "auto" ? hint.type : undefined;

  if (requested === "table") return tableViz(title || "Results", notes);

  const measures = hintY.length
    ? hintY
    : fields.filter((f) => f.role === "measure" && f !== hintX);

  // --- KPI: a single row of numbers ---
  if (
    result.rows.length === 1 &&
    measures.length > 0 &&
    (!requested || requested === "kpi")
  ) {
    const row = result.rows[0]!;
    const kpis = measures.slice(0, 4).flatMap((m) => {
      const value = toNumber(row[m.index]);
      return value === null
        ? []
        : [
            {
              label: humanize(m.name),
              value: round(value, 4),
              ...(/pct|percent|rate|share/i.test(m.name)
                ? { unit: "percent" as const }
                : hint.currency && isMoneyName(m.name)
                  ? { unit: "currency" as const }
                  : {}),
            },
          ];
    });
    if (kpis.length > 0) {
      const context = fields.find(
        (f) =>
          !f.numeric && row[f.index] !== null && row[f.index] !== undefined,
      );
      return {
        type: "kpi",
        title: title || (context ? String(row[context.index]) : kpis[0]!.label),
        data: [],
        config: { kpis, ...(hint.currency ? { currency: hint.currency } : {}) },
        notes,
      };
    }
  }

  // --- histogram of raw numeric values (requested, or a lone numeric column with many rows) ---
  const onlyOneRawMeasure =
    !requested &&
    fields.length === 1 &&
    measures.length === 1 &&
    result.rows.length >= 20;
  const wantsHistogram = requested === "histogram" || onlyOneRawMeasure;
  if (wantsHistogram) {
    const measure = measures[0] ?? fields.find((f) => f.numeric);
    if (measure && result.rows.length >= 5) {
      const values = result.rows
        .map((r) => toNumber(r[measure.index]))
        .filter((v): v is number => v !== null);
      const bins = histogramBins(values);
      return {
        type: "histogram",
        title: title || `Distribution of ${humanize(measure.name)}`,
        data: bins.map((b) => ({ bin: b.label, count: b.count })),
        config: {
          x: "bin",
          y: ["count"],
          xLabel: humanize(measure.name),
          yLabel: "Count",
        },
        notes,
      };
    }
    notes.push("Not enough numeric values for a histogram.");
  }

  if (measures.length === 0) return tableViz(title || "Results", notes);

  // --- scatter: numeric vs numeric (explicitly requested, or nothing else to plot against) ---
  const categoryLike = fields.find(
    (f) => f.role === "time" || f.role === "ordinal" || f.role === "category",
  );
  if ((requested === "scatter" || !categoryLike) && measures.length >= 2) {
    const sx = hintX?.numeric ? hintX : measures[0]!;
    const sy = measures.find((m) => m !== sx)!;
    const label = fields.find((f) => !f.numeric || f.role === "category");
    const data: Array<Record<string, string | number>> = [];
    for (const row of result.rows) {
      const xv = toNumber(row[sx.index]);
      const yv = toNumber(row[sy.index]);
      if (xv === null || yv === null) continue;
      data.push({
        [sx.name]: xv,
        [sy.name]: yv,
        ...(label ? { [label.name]: xValue(row[label.index]) } : {}),
      });
      if (data.length >= MAX_SCATTER_POINTS) break;
    }
    if (data.length >= 2) {
      return {
        type: "scatter",
        title: title || `${humanize(sy.name)} vs ${humanize(sx.name)}`,
        data,
        config: {
          x: sx.name,
          y: [sy.name],
          xLabel: humanize(sx.name),
          yLabel: humanize(sy.name),
        },
        notes,
      };
    }
  }

  // --- choose the x axis ---
  // Finest-grained time column first (e.g. month rather than year), then categories.
  const finestTime = fields
    .filter((f) => f.role === "time" || f.role === "ordinal")
    .sort((a, b) => b.distinct - a.distinct)[0];
  const x =
    (hintX && !measures.includes(hintX) ? hintX : undefined) ??
    finestTime ??
    // Prefer readable labels (product_name) over id-like codes (product_id).
    fields.find((f) => f.role === "category" && !f.numeric) ??
    fields.find((f) => f.role === "category");
  if (!x) return tableViz(title || "Results", notes);

  const yFields = measures.filter((m) => m !== x);
  if (yFields.length === 0) return tableViz(title || "Results", notes);

  // --- series (second dimension) ---
  let series =
    hintSeries && hintSeries !== x && !hintSeries.numeric
      ? hintSeries
      : hintSeries && hintSeries.role === "ordinal" && hintSeries !== x
        ? hintSeries
        : undefined;
  if (!series && yFields.length === 1) {
    series = fields.find(
      (f) =>
        f !== x &&
        !yFields.includes(f) &&
        (f.role === "category" || f.role === "ordinal" || f.role === "time") &&
        f.distinct > 1 &&
        f.distinct <= MAX_SERIES &&
        // A column that is one-to-one with x (e.g. product_id next to product_name)
        // adds no grouping, so it is not a series.
        !(f.distinct === x.distinct && x.distinct === result.rows.length),
    );
  }
  if (series && series.distinct > MAX_SERIES) {
    notes.push(
      `Too many groups in "${series.name}" to chart as separate series.`,
    );
    series = undefined;
  }

  const xIsTimeLike = x.role === "time" || x.role === "ordinal";
  let type: VizType;
  if (requested === "pie") {
    const pieOk =
      !series &&
      yFields.length === 1 &&
      !xIsTimeLike &&
      x.distinct <= MAX_PIE_SLICES;
    type = pieOk ? "pie" : "bar";
    if (!pieOk)
      notes.push(
        "A pie chart didn't fit this data, so a bar chart is shown instead.",
      );
  } else if (
    requested === "line" ||
    requested === "area" ||
    requested === "bar"
  )
    type = requested;
  else if (requested === "scatter") {
    notes.push(
      "A scatter plot needs two numeric columns; showing a better fit instead.",
    );
    type = xIsTimeLike ? "line" : "bar";
  } else type = xIsTimeLike ? "line" : "bar";

  // --- year-over-year: monthly dates split by year are aligned on month of year ---
  const alignByMonth =
    !!series &&
    x.role === "time" &&
    isYearLike(result, series) &&
    result.rows.every((row) => /^\d{4}-\d{2}-01/.test(String(row[x.index])));
  const xKey = alignByMonth ? "month_of_year" : x.name;
  const seriesLabel = (value: unknown) =>
    typeof value === "string" && /^\d{4}-01-01/.test(value)
      ? value.slice(0, 4)
      : String(xValue(value));

  // --- build flat data ---
  let dropped = 0;
  let data: Array<Record<string, string | number>> = [];
  if (yFields.length > 1 && !series) {
    const peaks = yFields.map((m) =>
      Math.max(
        ...result.rows.map((row) => Math.abs(toNumber(row[m.index]) ?? 0)),
      ),
    );
    const ratio = Math.max(...peaks) / Math.max(1e-9, Math.min(...peaks));
    if (ratio > 20) {
      const primary = yFields.find((m) => isMoneyName(m.name)) ?? yFields[0]!;
      notes.push(
        `Charting ${humanize(primary.name).toLowerCase()}; the other columns are in the data table.`,
      );
      yFields.splice(0, yFields.length, primary);
    }
  }
  const multiMeasure = yFields.length > 1 && !series;
  const yNames = multiMeasure ? yFields.slice(0, 6) : [yFields[0]!];
  for (const row of result.rows) {
    const xv = alignByMonth
      ? Number(String(row[x.index]).slice(5, 7))
      : xValue(row[x.index]);
    if (multiMeasure) {
      for (const m of yNames) {
        const yv = toNumber(row[m.index]);
        if (yv === null) {
          dropped++;
          continue;
        }
        data.push({ [xKey]: xv, series: humanize(m.name), value: yv });
      }
    } else {
      const yv = toNumber(row[yNames[0]!.index]);
      if (yv === null) {
        dropped++;
        continue;
      }
      const point: Record<string, string | number> = {
        [xKey]: xv,
        [yNames[0]!.name]: yv,
      };
      if (series) point[series.name] = seriesLabel(row[series.index]);
      data.push(point);
    }
  }
  if (dropped > 0)
    notes.push(
      `${dropped} row(s) without a numeric value were left out of the chart.`,
    );
  if (data.length === 0) return tableViz(title || "Results", notes);

  if (xIsTimeLike) data.sort((a, b) => compareX(a[xKey]!, b[xKey]!));
  if (type === "line" || type === "area") data = data.slice(0, MAX_LINE_POINTS);

  const yKey = multiMeasure ? "value" : yNames[0]!.name;
  if (
    (type === "bar" || type === "pie") &&
    !xIsTimeLike &&
    !series &&
    !multiMeasure
  ) {
    const categories = new Set(data.map((d) => d[xKey]));
    if (categories.size > MAX_BAR_CATEGORIES) {
      data = [...data]
        .sort((a, b) => (b[yKey] as number) - (a[yKey] as number))
        .slice(0, MAX_BAR_CATEGORIES);
      notes.push(
        `Showing the top ${MAX_BAR_CATEGORIES} of ${categories.size} ${humanize(x.name).toLowerCase()} values.`,
      );
    }
  }
  if (type === "pie" && data.some((d) => (d[yKey] as number) < 0)) {
    type = "bar";
    notes.push(
      "Negative values can't be shown in a pie chart, so a bar chart is shown instead.",
    );
  }

  const labels = data.map((d) => String(d[xKey]));
  const horizontal =
    type === "bar" &&
    !xIsTimeLike &&
    (labels.some((l) => l.length > 14) || new Set(labels).size > 12);

  const yLabel = multiMeasure ? "Value" : humanize(yNames[0]!.name);
  return {
    type,
    title:
      title ||
      `${yLabel} by ${humanize(x.name).toLowerCase()}${series ? ` and ${humanize(series.name).toLowerCase()}` : ""}`,
    data,
    config: {
      x: xKey,
      y: [yKey],
      ...(multiMeasure
        ? { series: "series" }
        : series
          ? { series: series.name }
          : {}),
      xLabel: alignByMonth ? "Month" : humanize(x.name),
      yLabel,
      ...(horizontal ? { horizontal: true } : {}),
      ...(hint.currency && yNames.every((m) => isMoneyName(m.name))
        ? { currency: hint.currency }
        : {}),
    },
    notes,
  };
}

/** Final safety net: guarantees the renderer never receives undefined/NaN or unknown fields. */
export function sanitizeVisualization(viz: Visualization): Visualization {
  if (viz.type === "table" || viz.type === "kpi") {
    if (viz.type === "kpi") {
      const kpis = (viz.config.kpis ?? []).filter((k) =>
        isFiniteNumber(k.value),
      );
      return kpis.length
        ? { ...viz, config: { ...viz.config, kpis } }
        : { ...viz, type: "table", config: {} };
    }
    return viz;
  }
  const { x, y, series } = viz.config;
  if (!x || !y?.length) return { ...viz, type: "table", data: [], config: {} };
  const data = viz.data.filter(
    (row) =>
      (typeof row[x] === "string" || isFiniteNumber(row[x])) &&
      y.every((key) => isFiniteNumber(row[key])) &&
      (!series ||
        typeof row[series] === "string" ||
        isFiniteNumber(row[series])),
  );
  if (data.length === 0) return { ...viz, type: "table", data: [], config: {} };
  return { ...viz, data };
}
