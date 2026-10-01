import "server-only";
import type { Source } from "@prisma/client";
import { config } from "@/lib/config";
import {
  DATA_SCHEMA,
  READER_ROLE,
  appPool,
  ensureDataSchema,
} from "@/lib/data/app-db";
import type { ColumnProfile } from "@/lib/data/csv-infer";
import {
  ExecutionError,
  type ExecutionErrorCode,
  type QueryResult,
  executeOnConnection,
  executeOnPool,
} from "@/lib/data/executor";
import {
  type PgSchemaSnapshot,
  type PgTable,
  resolveConnection,
} from "@/lib/data/postgres-source";
import {
  type AllowedRelation,
  type GuardErrorCode,
  guardSql,
  quoteIdent,
  withRowLimit,
} from "@/lib/data/sql-guard";
import { UserError } from "@/lib/errors";
import { decryptSecret } from "@/lib/security/crypto";

export interface CsvDetails {
  fileName: string;
  sizeBytes: number;
  rowCount: number;
  columnCount: number;
  columns: ColumnProfile[];
  warnings: string[];
  suggestions: string[];
}

export interface PostgresDetails {
  database: string;
  host: string;
  user: string;
  serverVersion: string;
  tableCount: number;
  snapshot: PgSchemaSnapshot;
  warnings: string[];
  suggestions: string[];
}

export type RunOutcome =
  | { ok: true; result: QueryResult; sql: string }
  | {
      ok: false;
      kind: "rejected";
      code: GuardErrorCode;
      message: string;
      sql: string;
    }
  | {
      ok: false;
      kind: "failed";
      code: ExecutionErrorCode;
      message: string;
      sql: string;
    };

export interface DataSourceRuntime {
  id: string;
  kind: "csv" | "postgres";
  name: string;
  /** Human label, e.g. "Uploaded CSV — sales.csv" */
  label: string;
  /** Currency symbol when an uploaded dataset uses exactly one (for formatting). */
  currency?: string;
  allowed: AllowedRelation[];
  /** Compact schema description for the system prompt. */
  schemaOverview(): string;
  /** Detailed schema for the get_schema tool. */
  schemaDetail(tables?: string[]): unknown;
  /** Column names users can ask about (for "try asking about" hints). */
  topicHints(): string[];
  profileColumn(table: string | undefined, column: string): Promise<unknown>;
  run(sql: string): Promise<RunOutcome>;
}

/** Public, secret-free view of a source for the browser. */
export function toPublicSource(source: Source) {
  if (source.kind === "csv") {
    const details = source.details as unknown as CsvDetails;
    return {
      id: source.id,
      kind: "csv" as const,
      name: source.name,
      createdAt: source.createdAt.toISOString(),
      fileName: details.fileName,
      rowCount: details.rowCount,
      columnCount: details.columnCount,
      columns: details.columns.map((c) => ({
        name: c.name,
        label: c.label,
        kind: c.kind,
        role: c.role,
      })),
      warnings: details.warnings,
      suggestions: details.suggestions,
    };
  }
  const details = source.details as unknown as PostgresDetails;
  return {
    id: source.id,
    kind: "postgres" as const,
    name: source.name,
    createdAt: source.createdAt.toISOString(),
    database: details.database,
    host: details.host,
    tableCount: details.tableCount,
    tables: details.snapshot.tables
      .slice(0, 50)
      .map((t) => `${t.schema === "public" ? "" : `${t.schema}.`}${t.name}`),
    warnings: details.warnings,
    suggestions: details.suggestions,
  };
}

export type PublicSource = ReturnType<typeof toPublicSource>;

function formatNumber(value: unknown): string {
  if (typeof value !== "number") return String(value);
  return Math.abs(value) >= 1000
    ? Math.round(value).toLocaleString("en-US")
    : String(Math.round(value * 100) / 100);
}

function describeCsvColumn(column: ColumnProfile, rowCount: number): string {
  const parts: string[] = [column.kind];
  if (column.role === "measure" || column.role === "identifier")
    parts.push(column.role);
  if (column.currency) parts.push(`currency ${column.currency}`);
  if (column.percent) parts.push("percent values");
  if (column.min !== undefined && column.max !== undefined)
    parts.push(
      `range ${formatNumber(column.min)} → ${formatNumber(column.max)}`,
    );
  if (column.topValues && column.distinctCount <= 12) {
    parts.push(
      `values: ${column.topValues.map((v) => JSON.stringify(v.value)).join(", ")}`,
    );
  } else if (column.topValues) {
    parts.push(
      `${column.distinctCount.toLocaleString()}${column.distinctCapped ? "+" : ""} distinct, e.g. ${column.topValues
        .slice(0, 3)
        .map((v) => JSON.stringify(v.value))
        .join(", ")}`,
    );
  }
  if (column.nullCount > 0)
    parts.push(`${Math.round((column.nullCount / rowCount) * 100)}% empty`);
  const label =
    column.label !== column.name ? ` (header "${column.label}")` : "";
  return `- ${column.name}${label}: ${parts.join("; ")}`;
}

function csvRuntime(source: Source): DataSourceRuntime {
  const details = source.details as unknown as CsvDetails;
  const tableName = source.tableName!;
  const allowed: AllowedRelation[] = [{ schema: null, name: "dataset" }];
  return {
    id: source.id,
    kind: "csv",
    name: source.name,
    label: `Uploaded CSV — ${details.fileName}`,
    currency: (() => {
      const symbols = new Set(
        details.columns.map((c) => c.currency).filter(Boolean),
      );
      return symbols.size === 1 ? [...symbols][0] : undefined;
    })(),
    allowed,
    schemaOverview() {
      return [
        `Table: dataset (${details.rowCount.toLocaleString()} rows, uploaded from "${details.fileName}")`,
        "Columns:",
        ...details.columns.map((column) =>
          describeCsvColumn(column, details.rowCount),
        ),
      ].join("\n");
    },
    schemaDetail() {
      return {
        table: "dataset",
        rowCount: details.rowCount,
        columns: details.columns,
      };
    },
    topicHints() {
      return details.columns
        .filter(
          (c) =>
            c.role === "measure" || c.role === "dimension" || c.role === "time",
        )
        .map((c) => c.label)
        .slice(0, 5);
    },
    async profileColumn(_table, column) {
      const found = details.columns.find(
        (c) => c.name === column || c.label === column,
      );
      if (!found)
        return {
          error: `Unknown column "${column}". Columns: ${details.columns.map((c) => c.name).join(", ")}`,
        };
      return found;
    },
    async run(sql) {
      const guarded = await guardSql(sql, allowed);
      if (!guarded.ok)
        return {
          ok: false,
          kind: "rejected",
          code: guarded.code,
          message: guarded.message,
          sql,
        };
      const { readerRole } = await ensureDataSchema();
      const finalSql = withRowLimit(
        guarded.sql,
        config.maxResultRows(),
        `WITH dataset AS (SELECT * FROM ${DATA_SCHEMA}.${quoteIdent(tableName)}) `,
      );
      try {
        const result = await executeOnPool(appPool(), {
          sql: finalSql,
          maxRows: config.maxResultRows(),
          statementTimeoutMs: config.statementTimeoutMs(),
          role: readerRole ? READER_ROLE : undefined,
        });
        return { ok: true, result, sql: guarded.sql };
      } catch (error) {
        const err =
          error instanceof ExecutionError
            ? error
            : new ExecutionError("query_error", String(error));
        return {
          ok: false,
          kind: "failed",
          code: err.code,
          message: err.message,
          sql: guarded.sql,
        };
      }
    },
  };
}

function describePgTable(table: PgTable): string {
  const name = `${table.schema}.${table.name}`;
  const rows =
    table.estimatedRows !== null && table.estimatedRows >= 0
      ? ` (~${table.estimatedRows.toLocaleString()} rows)`
      : "";
  const columns = table.columns.map((c) => `${c.name} ${c.type}`).join(", ");
  const keys = [
    table.primaryKey.length ? `PK(${table.primaryKey.join(", ")})` : "",
    ...table.foreignKeys.map(
      (fk) => `FK ${fk.columns.join(", ")} → ${fk.references}`,
    ),
  ].filter(Boolean);
  return `- ${name}${table.kind === "view" ? " [view]" : ""}${rows}: ${columns}${keys.length ? ` | ${keys.join("; ")}` : ""}`;
}

const OVERVIEW_BUDGET = 7_000;

function postgresRuntime(source: Source): DataSourceRuntime {
  const details = source.details as unknown as PostgresDetails;
  const tables = details.snapshot.tables;
  const allowed: AllowedRelation[] = tables.map((t) => ({
    schema: t.schema,
    name: t.name,
  }));

  const runtime: DataSourceRuntime = {
    id: source.id,
    kind: "postgres",
    name: source.name,
    label: `PostgreSQL — ${details.database}`,
    allowed,
    schemaOverview() {
      const lines: string[] = [
        `Database: ${details.database} (${tables.length} tables/views)`,
      ];
      let used = lines[0]!.length;
      const omitted: string[] = [];
      for (const table of tables) {
        const line = describePgTable(table);
        if (used + line.length > OVERVIEW_BUDGET)
          omitted.push(`${table.schema}.${table.name}`);
        else {
          lines.push(line);
          used += line.length;
        }
      }
      if (omitted.length) {
        lines.push(
          `Other tables (call get_schema for their columns): ${omitted.slice(0, 150).join(", ")}`,
        );
      }
      return lines.join("\n");
    },
    schemaDetail(requested) {
      const wanted = requested?.length
        ? tables.filter((t) =>
            requested.some(
              (r) => r === t.name || r === `${t.schema}.${t.name}`,
            ),
          )
        : tables.slice(0, 40);
      return { database: details.database, tables: wanted };
    },
    topicHints() {
      return tables.slice(0, 5).map((t) => t.name);
    },
    async profileColumn(tableName, column) {
      const table = tables.find(
        (t) => t.name === tableName || `${t.schema}.${t.name}` === tableName,
      );
      if (!table) return { error: `Unknown table "${tableName}".` };
      if (!table.columns.some((c) => c.name === column)) {
        return {
          error: `Unknown column "${column}" in ${table.schema}.${table.name}.`,
        };
      }
      const qualified = `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`;
      const col = quoteIdent(column);
      const stats = await runtime.run(
        `SELECT count(*) AS total, count(${col}) AS non_null, count(DISTINCT ${col}) AS distinct_values, min(${col}::text) AS min_text, max(${col}::text) AS max_text FROM ${qualified}`,
      );
      const top = await runtime.run(
        `SELECT ${col}::text AS value, count(*) AS count FROM ${qualified} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
      );
      return {
        table: `${table.schema}.${table.name}`,
        column,
        stats: stats.ok
          ? Object.fromEntries(
              stats.result.columns.map((c, i) => [
                c.name,
                stats.result.rows[0]?.[i],
              ]),
            )
          : stats.message,
        topValues: top.ok
          ? top.result.rows.map((r) => ({ value: r[0], count: r[1] }))
          : top.message,
      };
    },
    async run(sql) {
      const guarded = await guardSql(sql, allowed);
      if (!guarded.ok)
        return {
          ok: false,
          kind: "rejected",
          code: guarded.code,
          message: guarded.message,
          sql,
        };
      let connectionString: string;
      try {
        connectionString = decryptSecret(source.encryptedUrl!);
      } catch {
        return {
          ok: false,
          kind: "failed",
          code: "unavailable",
          message: "Stored credentials could not be decrypted.",
          sql,
        };
      }
      try {
        const resolved = await resolveConnection(connectionString);
        const result = await executeOnConnection(
          resolved.config,
          {
            sql: withRowLimit(guarded.sql, config.maxResultRows()),
            maxRows: config.maxResultRows(),
            statementTimeoutMs: config.statementTimeoutMs(),
          },
          config.connectTimeoutMs(),
        );
        return { ok: true, result, sql: guarded.sql };
      } catch (error) {
        if (error instanceof UserError) {
          return {
            ok: false,
            kind: "failed",
            code: "unavailable",
            message: error.message,
            sql: guarded.sql,
          };
        }
        const err =
          error instanceof ExecutionError
            ? error
            : new ExecutionError("query_error", String(error));
        return {
          ok: false,
          kind: "failed",
          code: err.code,
          message: err.message,
          sql: guarded.sql,
        };
      }
    },
  };
  return runtime;
}

export function toRuntime(source: Source): DataSourceRuntime {
  if (source.kind === "csv") return csvRuntime(source);
  if (source.kind === "postgres") return postgresRuntime(source);
  throw new UserError("bad_request", "Unknown data source type.");
}

/** Deterministic example questions for a connected database (no LLM call). */
export function suggestPostgresQuestions(snapshot: PgSchemaSnapshot): string[] {
  const isTime = (type: string) => /date|timestamp/.test(type);
  const isMoney = (name: string) =>
    /amount|total|revenue|sales|price|cost|value/.test(name);
  const words = (name: string) => name.replace(/_/g, " ");
  const suggestions: string[] = [];
  // A money column that lives next to a date column can be trended directly.
  for (const table of snapshot.tables) {
    const money = table.columns.find(
      (c) =>
        isMoney(c.name) &&
        /numeric|double|real|integer|bigint|money/.test(c.type),
    );
    const time = table.columns.find((c) => isTime(c.type));
    if (money && time) {
      suggestions.push(`What is the total ${words(money.name)} by month?`);
      break;
    }
  }
  const byLinks = [...snapshot.tables].sort(
    (a, b) => b.foreignKeys.length - a.foreignKeys.length,
  );
  const fact = byLinks[0];
  const timedFact = byLinks.find((t) => t.columns.some((c) => isTime(c.type)));
  if (timedFact)
    suggestions.push(`Show the number of ${words(timedFact.name)} per month`);
  const fk = fact?.foreignKeys[0];
  if (fact && fk)
    suggestions.push(
      `Which ${words(fk.references.split(".").pop()!)} have the most ${words(fact.name)}?`,
    );
  const categorical = snapshot.tables.find((t) =>
    t.columns.some((c) => /category|region|segment|status|type/.test(c.name)),
  );
  if (categorical) {
    const col = categorical.columns.find((c) =>
      /category|region|segment|status|type/.test(c.name),
    )!;
    suggestions.push(
      `Break down ${words(categorical.name)} by ${words(col.name)}`,
    );
  }
  suggestions.push("What data is in this database?");
  return [...new Set(suggestions)].slice(0, 5);
}
