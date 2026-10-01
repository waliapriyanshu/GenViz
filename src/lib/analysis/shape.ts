import type { ColumnKind } from "@/lib/data/pg-types";

/** Minimal result shape shared by analysis, visualization and tests. */
export interface TabularResult {
  columns: Array<{ name: string; kind: ColumnKind }>;
  rows: unknown[][];
}

export type FieldRole = "time" | "measure" | "category" | "ordinal";

export interface FieldInfo {
  index: number;
  name: string;
  kind: ColumnKind;
  role: FieldRole;
  distinct: number;
  /** all non-null values are finite numbers */
  numeric: boolean;
}

const DATE_TEXT =
  /^(\d{4})(-\d{2}(-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?)?|-Q[1-4]|-W\d{1,2})$/;
const ID_NAME = /(^|_)(id|code|zip|zipcode|key|sku)$/i;
const BUCKET_NAME =
  /(^|_)(bucket|bin|band|bracket|range|tier)(_start|_end|_min|_max|_from|_to|_floor|_lower|_upper)?$/i;
const ORDINAL_NAME =
  /(^|_)(year|yr|quarter|qtr|month|mon|week|wk|day|dow|hour|hr)(_num|_number|_no)?$/i;

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function toNumber(value: unknown): number | null {
  if (isFiniteNumber(value)) return value;
  if (
    typeof value === "string" &&
    value.trim() !== "" &&
    /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value.trim())
  ) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function describeFields(result: TabularResult): FieldInfo[] {
  return result.columns.map((column, index) => {
    // NaN/Infinity (e.g. Postgres 'NaN'::float) count as missing values, not as text.
    const values = result.rows
      .map((row) => row[index])
      .filter(
        (v) =>
          v !== null &&
          v !== undefined &&
          !(typeof v === "number" && !Number.isFinite(v)),
      );
    const distinct = new Set(values.map((v) => String(v))).size;
    const numeric =
      values.length > 0 && values.every((v) => toNumber(v) !== null);
    let role: FieldRole = "category";
    if (column.kind === "date" || column.kind === "timestamp") role = "time";
    else if (
      column.kind === "text" &&
      values.length > 0 &&
      values.every((v) => DATE_TEXT.test(String(v)))
    )
      role = "time";
    else if (
      numeric &&
      ORDINAL_NAME.test(column.name) &&
      values.every((v) => Number.isInteger(toNumber(v)))
    )
      role = "ordinal";
    else if (
      numeric &&
      (ID_NAME.test(column.name) || BUCKET_NAME.test(column.name))
    )
      role = "category";
    else if (numeric && column.kind === "number") role = "measure";
    else if (numeric && column.kind === "text") role = "measure";
    return {
      index,
      name: column.name,
      kind: column.kind,
      role,
      distinct,
      numeric,
    };
  });
}

export function fieldByName(
  fields: FieldInfo[],
  name: string | undefined,
): FieldInfo | undefined {
  if (!name) return undefined;
  return (
    fields.find((f) => f.name === name) ??
    fields.find((f) => f.name.toLowerCase() === name.toLowerCase())
  );
}

export function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Year buckets: a `year` column, 4-digit year numbers, or dates truncated to Jan 1. */
export function isYearLike(result: TabularResult, field: FieldInfo): boolean {
  if (/(^|_)(year|yr)$/i.test(field.name)) return true;
  const values = result.rows
    .map((row) => row[field.index])
    .filter((v) => v !== null && v !== undefined);
  if (values.length === 0) return false;
  return values.every((v) => {
    if (typeof v === "string") return /^\d{4}-01-01([ T]00:00(:00)?)?/.test(v);
    const n = toNumber(v);
    return n !== null && Number.isInteger(n) && n >= 1900 && n <= 2100;
  });
}
