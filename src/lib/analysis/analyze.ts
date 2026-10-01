import {
  type FieldInfo,
  type TabularResult,
  describeFields,
  fieldByName,
  isYearLike,
  round,
  toNumber,
} from "@/lib/analysis/shape";

/**
 * Deterministic analysis over query results. The model never does arithmetic:
 * it reads these computed facts and explains them.
 */

export type AnalysisOperation =
  | "summary"
  | "trend"
  | "top"
  | "compare"
  | "distribution"
  | "anomalies";

export interface AnalysisParams {
  measure?: string;
  dimension?: string;
  time?: string;
  limit?: number;
}

export type Facts = Record<string, unknown>;

function measureValues(result: TabularResult, field: FieldInfo): number[] {
  return result.rows
    .map((row) => toNumber(row[field.index]))
    .filter((v): v is number => v !== null);
}

function stats(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  const quantile = (q: number) => {
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
  };
  const mean = sum / values.length;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return {
    count: values.length,
    sum: round(sum),
    mean: round(mean),
    median: round(quantile(0.5)),
    min: round(sorted[0]!),
    max: round(sorted[sorted.length - 1]!),
    p25: round(quantile(0.25)),
    p75: round(quantile(0.75)),
    stddev: round(Math.sqrt(variance)),
  };
}

function pctChange(from: number, to: number): number | null {
  if (from === 0) return null;
  return round(((to - from) / Math.abs(from)) * 100, 1);
}

function pickMeasure(
  fields: FieldInfo[],
  name?: string,
): FieldInfo | undefined {
  const named = fieldByName(fields, name);
  if (named?.numeric) return named;
  return (
    fields.find((f) => f.role === "measure") ??
    fields.find((f) => f.numeric && f.role !== "ordinal")
  );
}

function pickDimension(
  fields: FieldInfo[],
  name?: string,
  exclude?: FieldInfo,
): FieldInfo | undefined {
  const named = fieldByName(fields, name);
  if (named && named !== exclude) return named;
  const candidates = fields.filter(
    (f) =>
      f !== exclude &&
      (f.role === "category" || f.role === "ordinal" || f.role === "time"),
  );
  // Prefer readable labels (product_name) over id-like codes (product_id).
  return candidates.find((f) => !f.numeric) ?? candidates[0];
}

function label(
  result: TabularResult,
  row: unknown[],
  field: FieldInfo | undefined,
): string {
  if (!field) return "";
  const value = row[field.index];
  return value === null || value === undefined ? "(blank)" : String(value);
}

function trend(
  result: TabularResult,
  fields: FieldInfo[],
  params: AnalysisParams,
): Facts {
  const measure = pickMeasure(fields, params.measure);
  const time = fieldByName(fields, params.time) ?? finestTimeField(fields);
  if (!measure || !time)
    return { error: "trend needs a time column and a numeric column" };
  // Sum rows that share a period (e.g. several series per month).
  const byPeriod = new Map<string, number>();
  for (const row of result.rows) {
    const t = row[time.index];
    const v = toNumber(row[measure.index]);
    if (v === null || t === null || t === undefined) continue;
    byPeriod.set(String(t), (byPeriod.get(String(t)) ?? 0) + v);
  }
  const points = [...byPeriod.entries()]
    .map(([t, v]) => ({ t, v }))
    .sort((a, b) =>
      String(a.t) < String(b.t) ? -1 : String(a.t) > String(b.t) ? 1 : 0,
    );
  if (points.length === 0) return { error: "no numeric values to analyze" };
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const peak = points.reduce((a, b) => (b.v > a.v ? b : a));
  const trough = points.reduce((a, b) => (b.v < a.v ? b : a));
  const total = points.reduce((acc, p) => acc + p.v, 0);
  return {
    operation: "trend",
    measure: measure.name,
    time: time.name,
    periods: points.length,
    first: { period: String(first.t), value: round(first.v) },
    last: { period: String(last.t), value: round(last.v) },
    change: round(last.v - first.v),
    change_pct: pctChange(first.v, last.v),
    peak: { period: String(peak.t), value: round(peak.v) },
    lowest: { period: String(trough.t), value: round(trough.v) },
    total: round(total),
    average_per_period: round(total / points.length),
  };
}

function top(
  result: TabularResult,
  fields: FieldInfo[],
  params: AnalysisParams,
): Facts {
  const measure = pickMeasure(fields, params.measure);
  const dimension = pickDimension(fields, params.dimension, measure);
  if (!measure || !dimension)
    return { error: "top needs a category column and a numeric column" };
  // Sum rows that share a group, so un-aggregated results still rank correctly.
  const totals = new Map<string, number>();
  for (const row of result.rows) {
    const value = toNumber(row[measure.index]);
    if (value === null) continue;
    const name = label(result, row, dimension);
    totals.set(name, (totals.get(name) ?? 0) + value);
  }
  const items = [...totals.entries()].map(([name, value]) => ({ name, value }));
  if (items.length === 0) return { error: "no numeric values to analyze" };
  const total = items.reduce((acc, i) => acc + i.value, 0);
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const n = Math.min(params.limit ?? 5, 10);
  const share = (v: number) =>
    total !== 0 ? round((v / total) * 100, 1) : null;
  return {
    operation: "top",
    measure: measure.name,
    dimension: dimension.name,
    groups: items.length,
    total: round(total),
    top: sorted.slice(0, n).map((i) => ({
      name: i.name,
      value: round(i.value),
      share_pct: share(i.value),
    })),
    bottom:
      sorted.length > n
        ? sorted.slice(-Math.min(3, sorted.length - n)).map((i) => ({
            name: i.name,
            value: round(i.value),
            share_pct: share(i.value),
          }))
        : [],
    top_vs_second_pct:
      sorted.length > 1 ? pctChange(sorted[1]!.value, sorted[0]!.value) : null,
  };
}

function compare(
  result: TabularResult,
  fields: FieldInfo[],
  params: AnalysisParams,
): Facts {
  const base = top(result, fields, { ...params, limit: 10 });
  if ("error" in base) return base;
  const groups = base.top as Array<{ name: string; value: number }>;
  const pairs =
    groups.length >= 2
      ? {
          first: groups[0],
          second: groups[1],
          difference: round(groups[0]!.value - groups[1]!.value),
          difference_pct: pctChange(groups[1]!.value, groups[0]!.value),
        }
      : null;
  return { ...base, operation: "compare", highest_vs_next: pairs };
}

function distribution(
  result: TabularResult,
  fields: FieldInfo[],
  params: AnalysisParams,
): Facts {
  const measure = pickMeasure(fields, params.measure);
  if (!measure) return { error: "distribution needs a numeric column" };
  const values = measureValues(result, measure);
  const summary = stats(values);
  if (!summary) return { error: "no numeric values to analyze" };
  return {
    operation: "distribution",
    measure: measure.name,
    ...summary,
    bins: histogramBins(values).map((b) => ({
      range: b.label,
      count: b.count,
    })),
  };
}

function anomalies(
  result: TabularResult,
  fields: FieldInfo[],
  params: AnalysisParams,
): Facts {
  const measure = pickMeasure(fields, params.measure);
  if (!measure) return { error: "anomalies needs a numeric column" };
  const labelField =
    fieldByName(fields, params.time ?? params.dimension) ??
    fields.find((f) => f !== measure && !f.numeric) ??
    fields.find((f) => f !== measure);
  const values = measureValues(result, measure);
  const summary = stats(values);
  if (!summary || values.length < 4)
    return { error: "need at least 4 values to look for anomalies" };
  const iqr = summary.p75 - summary.p25;
  const low = summary.p25 - 1.5 * iqr;
  const high = summary.p75 + 1.5 * iqr;
  const outliers = result.rows
    .map((row) => ({
      label: label(result, row, labelField),
      value: toNumber(row[measure.index]),
    }))
    .filter(
      (o): o is { label: string; value: number } =>
        o.value !== null && (o.value < low || o.value > high),
    )
    .map((o) => ({
      label: o.label,
      value: round(o.value),
      direction: o.value > high ? "unusually high" : "unusually low",
      z_score:
        summary.stddev > 0
          ? round((o.value - summary.mean) / summary.stddev, 2)
          : null,
    }))
    .slice(0, 10);
  return {
    operation: "anomalies",
    measure: measure.name,
    method: "IQR (1.5×)",
    normal_range: [round(low), round(high)],
    mean: summary.mean,
    outliers,
  };
}

function summary(result: TabularResult, fields: FieldInfo[]): Facts {
  const measures = fields
    .filter((f) => f.numeric && f.role !== "ordinal")
    .slice(0, 4);
  return {
    operation: "summary",
    rows: result.rows.length,
    measures: Object.fromEntries(
      measures.map((m) => [m.name, stats(measureValues(result, m))]),
    ),
    categories: Object.fromEntries(
      fields
        .filter((f) => !f.numeric)
        .slice(0, 3)
        .map((f) => [f.name, { distinct: f.distinct }]),
    ),
  };
}

export function analyzeResult(
  result: TabularResult,
  operation: AnalysisOperation,
  params: AnalysisParams = {},
): Facts {
  const fields = describeFields(result);
  if (result.rows.length === 0)
    return { operation, error: "the result is empty" };
  switch (operation) {
    case "trend":
      return trend(result, fields, params);
    case "top":
      return top(result, fields, params);
    case "compare":
      return compare(result, fields, params);
    case "distribution":
      return distribution(result, fields, params);
    case "anomalies":
      return anomalies(result, fields, params);
    default:
      return summary(result, fields);
  }
}

function finestTimeField(fields: FieldInfo[]): FieldInfo | undefined {
  return fields
    .filter((f) => f.role === "time" || f.role === "ordinal")
    .sort((a, b) => b.distinct - a.distinct)[0];
}

const periodLabel = (value: unknown) =>
  typeof value === "string" && /^\d{4}-01-01/.test(value)
    ? value.slice(0, 4)
    : String(value);

/** Year-over-year style results (a year column plus a finer period): totals per year. */
function comparePeriods(
  result: TabularResult,
  fields: FieldInfo[],
): Facts | null {
  const timeLike = fields.filter(
    (f) => f.role === "time" || f.role === "ordinal",
  );
  if (timeLike.length < 2) return null;
  const yearField = timeLike.find(
    (f) => f.distinct >= 2 && f.distinct <= 12 && isYearLike(result, f),
  );
  const measure = pickMeasure(fields);
  if (!yearField || !measure) return null;
  const groups = new Map<string, { total: number; rows: number }>();
  for (const row of result.rows) {
    const value = toNumber(row[measure.index]);
    if (value === null) continue;
    const key = periodLabel(row[yearField.index]);
    const group = groups.get(key) ?? { total: 0, rows: 0 };
    group.total += value;
    group.rows += 1;
    groups.set(key, group);
  }
  const periods = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([period, g]) => ({
      period,
      total: round(g.total),
      sub_periods: g.rows,
    }));
  if (periods.length < 2) return null;
  const latest = periods[periods.length - 1]!;
  const previous = periods[periods.length - 2]!;
  return {
    operation: "compare_periods",
    measure: measure.name,
    period_field: yearField.name,
    periods,
    latest,
    previous,
    change: round(latest.total - previous.total),
    change_pct: pctChange(previous.total, latest.total),
    uneven_coverage: latest.sub_periods !== previous.sub_periods,
  };
}

/**
 * Driver analysis for time × category results (e.g. revenue by month and category):
 * how much each group changed between the first and last period.
 */
function groupChanges(
  result: TabularResult,
  fields: FieldInfo[],
): Facts[] | null {
  const time = finestTimeField(fields);
  const measure = pickMeasure(fields);
  const group = fields.find(
    (f) => f.role === "category" && f !== time && f !== measure && !f.numeric,
  );
  if (!time || !measure || !group || group.distinct > 50) return null;
  const periods = [
    ...new Set(result.rows.map((row) => String(row[time.index]))),
  ].sort();
  if (periods.length < 2) return null;
  const first = periods[0]!;
  const last = periods[periods.length - 1]!;
  const values = new Map<string, { first: number; last: number }>();
  for (const row of result.rows) {
    const value = toNumber(row[measure.index]);
    if (value === null) continue;
    const period = String(row[time.index]);
    if (period !== first && period !== last) continue;
    const name = label(result, row, group);
    const entry = values.get(name) ?? { first: 0, last: 0 };
    if (period === first) entry.first += value;
    else entry.last += value;
    values.set(name, entry);
  }
  return [...values.entries()]
    .map(([name, v]) => ({
      [group.name]: name,
      from_period: first,
      to_period: last,
      from: round(v.first),
      to: round(v.last),
      change: round(v.last - v.first),
      change_pct: pctChange(v.first, v.last),
    }))
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
    .slice(0, 8);
}

/** Picks the most useful analysis for a result's shape (run automatically after every query). */
export function autoAnalyze(result: TabularResult): Facts {
  const fields = describeFields(result);
  if (result.rows.length === 0) return { rows: 0 };
  if (result.rows.length === 1) {
    return {
      rows: 1,
      values: Object.fromEntries(
        result.columns.map((c, i) => {
          const v = result.rows[0]![i];
          const n = toNumber(v);
          return [c.name, n !== null ? round(n) : v];
        }),
      ),
    };
  }
  const periodFacts = comparePeriods(result, fields);
  if (periodFacts) return periodFacts;
  const hasTime = fields.some((f) => f.role === "time");
  const hasMeasure = fields.some(
    (f) => f.role === "measure" || (f.numeric && f.role !== "ordinal"),
  );
  const hasCategory = fields.some((f) => f.role === "category");
  if (hasTime && hasMeasure) {
    const facts = trend(result, fields, {});
    const byGroup = groupChanges(result, fields);
    return byGroup ? { ...facts, by_group: byGroup } : facts;
  }
  if (hasCategory && hasMeasure && result.rows.length <= 200)
    return top(result, fields, {});
  return summary(result, fields);
}

export interface HistogramBin {
  label: string;
  from: number;
  to: number;
  count: number;
}

export function histogramBins(values: number[], maxBins = 20): HistogramBin[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max)
    return [
      { label: formatBinEdge(min), from: min, to: max, count: values.length },
    ];
  const binCount = Math.max(
    1,
    Math.min(maxBins, Math.ceil(Math.sqrt(values.length))),
  );
  const rawWidth = (max - min) / binCount;
  const magnitude = 10 ** Math.floor(Math.log10(rawWidth));
  const width =
    [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((w) => w >= rawWidth) ??
    rawWidth;
  const start = Math.floor(min / width) * width;
  const bins: HistogramBin[] = [];
  for (let from = start; from <= max; from += width) {
    const to = from + width;
    bins.push({
      label: `${formatBinEdge(from)}–${formatBinEdge(to)}`,
      from: round(from, 6),
      to: round(to, 6),
      count: 0,
    });
    if (bins.length > maxBins * 2) break;
  }
  for (const v of values) {
    const idx = Math.min(bins.length - 1, Math.floor((v - start) / width));
    bins[Math.max(0, idx)]!.count++;
  }
  return bins;
}

function formatBinEdge(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${round(value / 1_000_000, 1)}M`;
  if (abs >= 1_000) return `${round(value / 1_000, 1)}K`;
  return String(round(value, 2));
}
