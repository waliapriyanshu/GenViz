import Papa from "papaparse";

/**
 * Pure CSV → typed table inference. Fixes the failure modes found in the audit:
 * `id` columns, "$1,234,567" values, colliding/blank headers, dirty values after
 * row 50 (types are inferred from ALL rows), dates stored as text, leading-zero
 * codes, and partial loads (nothing is written until the whole file is valid).
 */

export type InferredKind =
  | "integer"
  | "number"
  | "boolean"
  | "date"
  | "timestamp"
  | "text";
export type ColumnRole =
  | "time"
  | "measure"
  | "dimension"
  | "identifier"
  | "text";

export interface ColumnProfile {
  /** SQL column name (snake_case, unique, safe unquoted) */
  name: string;
  /** Original header as shown to the user */
  label: string;
  kind: InferredKind;
  role: ColumnRole;
  nullCount: number;
  distinctCount: number;
  /** true when distinctCount hit the tracking cap */
  distinctCapped: boolean;
  min?: number | string;
  max?: number | string;
  mean?: number;
  topValues?: Array<{ value: string; count: number }>;
  currency?: string;
  percent?: boolean;
  dateOrder?: "ymd" | "mdy" | "dmy" | "ym";
}

export interface InferredTable {
  columns: ColumnProfile[];
  /** Converted values ready for insertion, aligned with `columns`. */
  rows: Array<Array<string | number | boolean | null>>;
  rowCount: number;
  warnings: string[];
}

export class CsvError extends Error {}

const NULL_TOKENS = new Set([
  "",
  "na",
  "n/a",
  "null",
  "none",
  "nan",
  "-",
  "--",
  "#n/a",
  "nil",
  "undefined",
]);
const TRUE_TOKENS = new Set(["true", "yes", "y", "t"]);
const FALSE_TOKENS = new Set(["false", "no", "n", "f"]);
const RESERVED = new Set(
  (
    "all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create " +
    "current_catalog current_date current_role current_time current_timestamp current_user default deferrable desc " +
    "distinct do else end except false fetch for foreign from grant group having in initially intersect into lateral " +
    "leading limit localtime localtimestamp not null offset on only or order placing primary references returning " +
    "select session_user some symmetric table then to trailing true union unique user using variadic when where " +
    "window with dataset"
  ).split(" "),
);
const DISTINCT_CAP = 10_000;

export function isNullToken(raw: string): boolean {
  return NULL_TOKENS.has(raw.trim().toLowerCase());
}

export interface ParsedNumber {
  value: number;
  currency?: string;
  percent?: boolean;
}

/** Accepts 1234, -12.5, 1,234,567.89, $1,234, (1,234.50), 12%, ₹ 1,20,000 (Indian grouping), 1e5. */
export function parseNumberLoose(raw: string): ParsedNumber | null {
  let text = raw.trim();
  if (!text) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  let currency: string | undefined;
  const currencyMatch =
    text.match(/^([-+]?)\s*([$€£¥₹])\s*(.*)$/) ??
    text.match(/^([-+]?)(.*?)\s*([$€£¥₹])$/);
  if (currencyMatch) {
    if (/^[$€£¥₹]$/.test(currencyMatch[2] ?? "")) {
      currency = currencyMatch[2];
      text = `${currencyMatch[1]}${currencyMatch[3]}`;
    } else {
      currency = currencyMatch[3];
      text = `${currencyMatch[1]}${currencyMatch[2]}`;
    }
    text = text.trim();
  }
  let percent = false;
  if (text.endsWith("%")) {
    percent = true;
    text = text.slice(0, -1).trim();
  }
  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }
  let normalized: string | null = null;
  if (/^\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text) || /^\.\d+$/.test(text))
    normalized = text;
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text))
    normalized = text.replace(/,/g, "");
  else if (/^\d{1,2}(,\d{2})*,\d{3}(\.\d+)?$/.test(text))
    normalized = text.replace(/,/g, ""); // 1,20,000
  if (normalized === null) return null;
  const value = Number(normalized) * (negative ? -1 : 1);
  if (!Number.isFinite(value)) return null;
  return {
    value,
    ...(currency ? { currency } : {}),
    ...(percent ? { percent } : {}),
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validDate(year: number, month: number, day: number): boolean {
  return (
    year >= 1000 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

type DateShape =
  | { type: "ymd"; y: number; m: number; d: number }
  | { type: "ym"; y: number; m: number }
  | { type: "ambiguous"; a: number; b: number; y: number }
  | { type: "timestamp"; iso: string };

function dateShape(raw: string): DateShape | null {
  const text = raw.trim();
  let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match)
    return { type: "ymd", y: +match[1]!, m: +match[2]!, d: +match[3]! };
  match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/,
  );
  if (match) {
    if (!validDate(+match[1]!, +match[2]!, +match[3]!)) return null;
    if (+match[4]! > 23 || +match[5]! > 59 || +(match[6] ?? 0) > 59)
      return null;
    const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? "00"}${match[7] ?? ""}${match[8] ?? ""}`;
    return { type: "timestamp", iso };
  }
  match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (match)
    return { type: "ambiguous", a: +match[1]!, b: +match[2]!, y: +match[3]! };
  match = text.match(/^(\d{4})-(\d{2})$/);
  if (match) return { type: "ym", y: +match[1]!, m: +match[2]! };
  match = text.match(/^([A-Za-z]{3,9})[\s-](\d{4})$/);
  if (match) {
    const month =
      MONTHS[
        match[1]!.toLowerCase().slice(0, 4) === "sept"
          ? "sept"
          : match[1]!.toLowerCase().slice(0, 3)
      ];
    if (month) return { type: "ym", y: +match[2]!, m: month };
  }
  return null;
}

export function sanitizeHeaders(
  headers: string[],
): Array<{ name: string; label: string }> {
  const used = new Set<string>();
  return headers.map((header, index) => {
    const label = header.replace(/^\uFEFF/, "").trim() || `Column ${index + 1}`;
    let name = label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 50);
    if (!name) name = `column_${index + 1}`;
    if (/^\d/.test(name)) name = `c_${name}`;
    if (RESERVED.has(name)) name = `${name}_value`;
    let unique = name;
    for (let n = 2; used.has(unique); n++) unique = `${name}_${n}`;
    used.add(unique);
    return { name: unique, label };
  });
}

interface ColumnScan {
  numeric: boolean;
  integer: boolean;
  leadingZero: boolean;
  boolean: boolean;
  date: boolean;
  timestamp: boolean;
  firstOver12: boolean;
  secondOver12: boolean;
  ambiguousCount: number;
  ymdCount: number;
  ymCount: number;
  currencies: Set<string>;
  percent: boolean;
  nonNull: number;
}

function scanColumn(values: string[]): ColumnScan {
  const scan: ColumnScan = {
    numeric: true,
    integer: true,
    leadingZero: false,
    boolean: true,
    date: true,
    timestamp: true,
    firstOver12: false,
    secondOver12: false,
    ambiguousCount: 0,
    ymdCount: 0,
    ymCount: 0,
    currencies: new Set(),
    percent: false,
    nonNull: 0,
  };
  for (const raw of values) {
    if (isNullToken(raw)) continue;
    scan.nonNull++;
    const text = raw.trim();
    if (scan.numeric) {
      const parsed = parseNumberLoose(text);
      if (!parsed) scan.numeric = false;
      else {
        if (!Number.isSafeInteger(parsed.value) || /[.eE]/.test(text))
          scan.integer = false;
        if (/^0\d/.test(text)) scan.leadingZero = true;
        if (parsed.currency) scan.currencies.add(parsed.currency);
        if (parsed.percent) scan.percent = true;
      }
    }
    if (scan.boolean) {
      const lower = text.toLowerCase();
      if (!TRUE_TOKENS.has(lower) && !FALSE_TOKENS.has(lower))
        scan.boolean = false;
    }
    if (scan.date || scan.timestamp) {
      const shape = dateShape(text);
      if (!shape) {
        scan.date = false;
        scan.timestamp = false;
      } else if (shape.type === "timestamp") {
        scan.date = false;
      } else {
        scan.timestamp = false;
        if (shape.type === "ymd") {
          scan.ymdCount++;
          if (!validDate(shape.y, shape.m, shape.d)) scan.date = false;
        } else if (shape.type === "ym") {
          scan.ymCount++;
          if (shape.m < 1 || shape.m > 12) scan.date = false;
        } else {
          scan.ambiguousCount++;
          if (shape.a > 12) scan.firstOver12 = true;
          if (shape.b > 12) scan.secondOver12 = true;
          if (shape.a > 31 || shape.b > 31) scan.date = false;
        }
      }
    }
  }
  const mixedDateShapes =
    [scan.ymdCount, scan.ymCount, scan.ambiguousCount].filter((c) => c > 0)
      .length > 1;
  if (mixedDateShapes || (scan.firstOver12 && scan.secondOver12))
    scan.date = false;
  return scan;
}

function toDateValue(
  raw: string,
  order: "ymd" | "mdy" | "dmy" | "ym",
): string | null {
  const shape = dateShape(raw);
  if (!shape) return null;
  if (shape.type === "ymd")
    return validDate(shape.y, shape.m, shape.d)
      ? `${shape.y}-${pad(shape.m)}-${pad(shape.d)}`
      : null;
  if (shape.type === "ym") return `${shape.y}-${pad(shape.m)}-01`;
  if (shape.type === "ambiguous") {
    const [m, d] = order === "dmy" ? [shape.b, shape.a] : [shape.a, shape.b];
    return validDate(shape.y, m, d) ? `${shape.y}-${pad(m)}-${pad(d)}` : null;
  }
  return null;
}

function decideRole(profile: ColumnProfile, rowCount: number): ColumnRole {
  const idLike =
    /(^|_)(id|uuid|key|code|zip|zipcode|postcode|phone|sku|email)$/.test(
      profile.name,
    );
  if (profile.kind === "date" || profile.kind === "timestamp") return "time";
  if (profile.kind === "integer" || profile.kind === "number") {
    if (idLike) return "identifier";
    const uniqueInts =
      profile.kind === "integer" &&
      rowCount > 20 &&
      profile.distinctCount === rowCount - profile.nullCount;
    if (uniqueInts && /(^|_)(no|num|number|index|idx)$/.test(profile.name))
      return "identifier";
    return "measure";
  }
  if (profile.kind === "boolean") return "dimension";
  if (idLike) return "identifier";
  const nonNull = rowCount - profile.nullCount;
  if (profile.distinctCount <= 60 || profile.distinctCount <= nonNull * 0.2)
    return "dimension";
  return "identifier";
}

export interface InferOptions {
  maxRows: number;
}

export function inferCsv(text: string, options: InferOptions): InferredTable {
  const parsed = Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), {
    header: false,
    skipEmptyLines: "greedy",
    dynamicTyping: false,
  });
  const records = parsed.data.filter((row) => Array.isArray(row));
  if (records.length === 0) throw new CsvError("The file is empty.");
  const header = records[0]!.map((cell) => String(cell ?? ""));
  if (header.every((cell) => !cell.trim()))
    throw new CsvError("The first row must contain column names.");
  const body = records.slice(1);
  if (body.length === 0)
    throw new CsvError("The file has a header row but no data rows.");
  if (body.length > options.maxRows) {
    throw new CsvError(
      `The file has ${body.length.toLocaleString()} rows; the limit is ${options.maxRows.toLocaleString()}.`,
    );
  }
  if (header.length > 200)
    throw new CsvError("The file has more than 200 columns.");

  const warnings: string[] = [];
  let ragged = 0;
  const width = header.length;
  const cells: string[][] = body.map((row) => {
    if (row.length !== width) ragged++;
    const out = new Array<string>(width);
    for (let i = 0; i < width; i++)
      out[i] = row[i] === undefined || row[i] === null ? "" : String(row[i]);
    return out;
  });
  if (ragged > 0)
    warnings.push(
      `${ragged.toLocaleString()} rows had a different number of fields than the header and were padded/trimmed.`,
    );

  const names = sanitizeHeaders(header);
  const rowCount = cells.length;
  const columns: ColumnProfile[] = [];
  const converters: Array<(raw: string) => string | number | boolean | null> =
    [];

  for (let c = 0; c < width; c++) {
    const values = cells.map((row) => row[c]!);
    const scan = scanColumn(values);
    const { name, label } = names[c]!;
    let kind: InferredKind = "text";
    let dateOrder: ColumnProfile["dateOrder"];
    if (scan.nonNull === 0) kind = "text";
    else if (scan.numeric && !scan.leadingZero)
      kind = scan.integer && !scan.percent ? "integer" : "number";
    else if (scan.boolean) kind = "boolean";
    else if (scan.timestamp) kind = "timestamp";
    else if (scan.date) {
      kind = "date";
      if (scan.ymCount > 0) dateOrder = "ym";
      else if (scan.ambiguousCount > 0) {
        dateOrder = scan.firstOver12 ? "dmy" : "mdy";
        if (!scan.firstOver12 && !scan.secondOver12) {
          warnings.push(
            `"${label}" dates were read as month/day/year (the day/month order was ambiguous).`,
          );
        }
      } else dateOrder = "ymd";
    }

    let convert: (raw: string) => string | number | boolean | null;
    if (kind === "integer" || kind === "number")
      convert = (raw) =>
        isNullToken(raw) ? null : (parseNumberLoose(raw)?.value ?? null);
    else if (kind === "boolean")
      convert = (raw) =>
        isNullToken(raw) ? null : TRUE_TOKENS.has(raw.trim().toLowerCase());
    else if (kind === "date")
      convert = (raw) =>
        isNullToken(raw) ? null : toDateValue(raw, dateOrder!);
    else if (kind === "timestamp")
      convert = (raw) => {
        if (isNullToken(raw)) return null;
        const shape = dateShape(raw);
        return shape?.type === "timestamp" ? shape.iso : null;
      };
    else convert = (raw) => (isNullToken(raw) ? null : raw.trim());
    converters.push(convert);

    const profile: ColumnProfile = {
      name,
      label,
      kind,
      role: "text",
      nullCount: 0,
      distinctCount: 0,
      distinctCapped: false,
      ...(kind === "date" ? { dateOrder } : {}),
      ...(scan.currencies.size === 1 &&
      (kind === "number" || kind === "integer")
        ? { currency: [...scan.currencies][0] }
        : {}),
      ...(scan.percent ? { percent: true } : {}),
    };
    columns.push(profile);
  }

  const rows = cells.map((row) => row.map((raw, c) => converters[c]!(raw)));

  columns.forEach((profile, c) => {
    const counts = new Map<string, number>();
    let nulls = 0;
    let sum = 0;
    let numericCount = 0;
    let min: number | string | undefined;
    let max: number | string | undefined;
    for (const row of rows) {
      const value = row[c];
      if (value === null || value === undefined) {
        nulls++;
        continue;
      }
      if (counts.size < DISTINCT_CAP || counts.has(String(value))) {
        counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
      } else profile.distinctCapped = true;
      if (typeof value === "number") {
        sum += value;
        numericCount++;
        if (min === undefined || value < (min as number)) min = value;
        if (max === undefined || value > (max as number)) max = value;
      } else if (profile.kind === "date" || profile.kind === "timestamp") {
        const text = String(value);
        if (min === undefined || text < (min as string)) min = text;
        if (max === undefined || text > (max as string)) max = text;
      }
    }
    profile.nullCount = nulls;
    profile.distinctCount = counts.size;
    if (min !== undefined) profile.min = min;
    if (max !== undefined) profile.max = max;
    if (numericCount > 0) profile.mean = sum / numericCount;
    if (profile.kind === "text" || profile.kind === "boolean") {
      profile.topValues = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([value, count]) => ({
          value: value.length > 60 ? `${value.slice(0, 57)}…` : value,
          count,
        }));
    }
    profile.role = decideRole(profile, rowCount);
  });

  return { columns, rows, rowCount, warnings };
}

export function pgTypeFor(kind: InferredKind): string {
  switch (kind) {
    case "integer":
      return "bigint";
    case "number":
      return "double precision";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    case "timestamp":
      return "timestamptz";
    default:
      return "text";
  }
}

/** Measure names in priority order: money first, then volumes, then anything numeric. */
const MEASURE_PRIORITY = [
  /revenue|sales|income/,
  /amount|total|profit|spend|value/,
  /price|cost|margin/,
  /qty|quantity|units|count|score/,
];

function preferredMeasure(
  measures: ColumnProfile[],
): ColumnProfile | undefined {
  for (const pattern of MEASURE_PRIORITY) {
    const match = measures.find((c) => pattern.test(c.name));
    if (match) return match;
  }
  return measures[0];
}

/** Deterministic, schema-driven example questions (no LLM call needed). */
export function suggestQuestions(columns: ColumnProfile[]): string[] {
  const measures = columns.filter((c) => c.role === "measure");
  const measure = preferredMeasure(measures);
  const time = columns.find((c) => c.role === "time");
  const dimensions = columns.filter(
    (c) => c.role === "dimension" && c.kind !== "boolean",
  );
  const identifier = columns.find(
    (c) => c.role === "identifier" && c.kind === "text",
  );
  const label = (c: ColumnProfile) => c.label.toLowerCase();
  const suggestions: string[] = [];
  if (measure && time) suggestions.push(`Show ${label(measure)} by month`);
  if (measure && dimensions[0])
    suggestions.push(
      `Which ${label(dimensions[0])} has the highest ${label(measure)}?`,
    );
  if (measure && dimensions[1])
    suggestions.push(
      `Compare ${label(measure)} across ${label(dimensions[1])}`,
    );
  if (measure && identifier)
    suggestions.push(
      `Show the top 10 ${label(identifier)} by ${label(measure)}`,
    );
  if (measure) suggestions.push(`Show the distribution of ${label(measure)}`);
  if (!measure && dimensions[0])
    suggestions.push(
      `How many rows are there for each ${label(dimensions[0])}?`,
    );
  if (!measure && time) suggestions.push(`How many records per month?`);
  suggestions.push("Give me a summary of this data");
  return [...new Set(suggestions)].slice(0, 5);
}
