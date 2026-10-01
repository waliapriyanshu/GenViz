import pg from "pg";

export type ColumnKind = "number" | "date" | "timestamp" | "boolean" | "text";

export interface ColumnMeta {
  name: string;
  kind: ColumnKind;
}

const NUMERIC_OIDS = new Set([20, 21, 23, 26, 700, 701, 1700, 790]);

export function kindFromOid(oid: number): ColumnKind {
  if (NUMERIC_OIDS.has(oid)) return "number";
  if (oid === 1082) return "date";
  if (oid === 1114 || oid === 1184) return "timestamp";
  if (oid === 16) return "boolean";
  return "text";
}

const toNumberOrString = (value: string) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
};

/**
 * JSON-friendly type parsing: bigint/numeric become JS numbers (instead of the
 * pg default of strings), dates stay as "YYYY-MM-DD" (no timezone shifting) and
 * timestamps become ISO strings.
 */
const PARSERS: Record<number, (value: string) => unknown> = {
  20: (value) => {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value;
  },
  1700: toNumberOrString,
  790: (value) => toNumberOrString(value.replace(/[^0-9.-]/g, "")),
  1082: (value) => value,
  1114: (value) => value.replace(" ", "T"),
  1184: (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  },
};

export const genvizTypes = {
  getTypeParser(oid: number, format?: string) {
    const parser = PARSERS[oid];
    if (parser && format !== "binary") return parser;
    return pg.types.getTypeParser(oid, format as "text");
  },
};
