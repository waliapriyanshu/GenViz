import pg from "pg";
import "server-only";
import { type ColumnMeta, genvizTypes, kindFromOid } from "@/lib/data/pg-types";

export interface QueryResult {
  columns: ColumnMeta[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  executionTimeMs: number;
}

export type ExecutionErrorCode =
  | "timeout"
  | "unavailable"
  | "query_error"
  | "permission"
  | "too_large";

export class ExecutionError extends Error {
  constructor(
    public readonly code: ExecutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExecutionError";
  }
}

export interface ExecuteOptions {
  /** Final SQL, already guarded and wrapped with the row limit. */
  sql: string;
  maxRows: number;
  statementTimeoutMs: number;
  /** Role to switch to for the duration of the transaction (uploaded datasets). */
  role?: string;
}

const MAX_RESULT_BYTES = 3_000_000;

const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

export function classifyPgError(error: unknown): ExecutionError {
  if (error instanceof ExecutionError) return error;
  const err = error as { code?: string; message?: string };
  const message = err?.message ?? String(error);
  if (err?.code === "57014")
    return new ExecutionError(
      "timeout",
      "The query took too long and was cancelled.",
    );
  if (
    (err?.code && CONNECTION_ERROR_CODES.has(err.code)) ||
    err?.code === "28P01" || // invalid password
    err?.code === "28000" ||
    err?.code === "3D000" || // database does not exist
    err?.code === "57P01" ||
    err?.code === "53300" || // too many connections
    /timeout expired|Connection terminated|connect ETIMEDOUT|getaddrinfo/i.test(
      message,
    )
  ) {
    return new ExecutionError("unavailable", "The database is unavailable.");
  }
  if (err?.code === "42501" || err?.code === "25006") {
    return new ExecutionError("permission", message);
  }
  return new ExecutionError("query_error", message);
}

async function runInReadOnlyTransaction(
  client: pg.ClientBase,
  options: ExecuteOptions,
): Promise<QueryResult> {
  const started = performance.now();
  await client.query("BEGIN TRANSACTION READ ONLY");
  try {
    await client.query(
      `SET LOCAL statement_timeout = ${Math.floor(options.statementTimeoutMs)}`,
    );
    await client.query("SET LOCAL lock_timeout = 2000");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = 30000");
    if (options.role) await client.query(`SET LOCAL ROLE ${options.role}`);
    // Extended protocol: the server rejects multiple statements even if the guard were bypassed.
    const queryConfig: pg.QueryArrayConfig & { queryMode: "extended" } = {
      text: options.sql,
      rowMode: "array",
      queryMode: "extended",
    };
    const result = await client.query(queryConfig);
    const columns: ColumnMeta[] = result.fields.map((field) => ({
      name: field.name,
      kind: kindFromOid(field.dataTypeID),
    }));
    let rows = result.rows as unknown[][];
    let truncated = false;
    if (rows.length > options.maxRows) {
      rows = rows.slice(0, options.maxRows);
      truncated = true;
    }
    let size = JSON.stringify(rows).length;
    while (size > MAX_RESULT_BYTES && rows.length > 10) {
      rows = rows.slice(0, Math.floor(rows.length / 2));
      truncated = true;
      size = JSON.stringify(rows).length;
    }
    return {
      columns,
      rows,
      rowCount: rows.length,
      truncated,
      executionTimeMs: Math.round(performance.now() - started),
    };
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
  }
}

/** Runs a guarded query on a pooled connection to Genviz's own database. */
export async function executeOnPool(
  pool: pg.Pool,
  options: ExecuteOptions,
): Promise<QueryResult> {
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    throw classifyPgError(error);
  }
  let broken = false;
  try {
    return await runInReadOnlyTransaction(client, options);
  } catch (error) {
    broken = true;
    throw classifyPgError(error);
  } finally {
    client.release(broken);
  }
}

/** Runs a guarded query on a user-connected database using a short-lived client. */
export async function executeOnConnection(
  connection: pg.ClientConfig,
  options: ExecuteOptions,
  connectTimeoutMs: number,
): Promise<QueryResult> {
  const client = new pg.Client({
    ...connection,
    connectionTimeoutMillis: connectTimeoutMs,
    query_timeout: options.statementTimeoutMs + 5_000,
    application_name: "genviz",
    types: genvizTypes,
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw classifyPgError(error);
  }
  try {
    return await runInReadOnlyTransaction(client, options);
  } catch (error) {
    throw classifyPgError(error);
  } finally {
    await client.end().catch(() => undefined);
  }
}
