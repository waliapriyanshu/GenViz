import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import pg from "pg";
import { parse as parseConnectionString } from "pg-connection-string";
import "server-only";
import { config } from "@/lib/config";
import { classifyPgError } from "@/lib/data/executor";
import { genvizTypes } from "@/lib/data/pg-types";
import { UserError } from "@/lib/errors";
import { isBlockedAddress } from "@/lib/security/ssrf";

export interface PgColumn {
  name: string;
  type: string;
}

export interface PgTable {
  schema: string;
  name: string;
  kind: "table" | "view";
  estimatedRows: number | null;
  columns: PgColumn[];
  primaryKey: string[];
  foreignKeys: Array<{ columns: string[]; references: string }>;
}

export interface PgSchemaSnapshot {
  database: string;
  user: string;
  serverVersion: string;
  tables: PgTable[];
  truncated: boolean;
}

export interface ConnectionTestResult {
  snapshot: PgSchemaSnapshot;
  host: string;
  warnings: string[];
}

const MAX_TABLES = 300;
const MAX_COLUMNS_PER_TABLE = 80;

/** Validates the string and resolves the host, refusing private/internal addresses. */
export async function resolveConnection(
  connectionString: string,
): Promise<{ config: pg.ClientConfig; host: string }> {
  const trimmed = connectionString.trim();
  if (!/^postgres(ql)?:\/\//i.test(trimmed)) {
    throw new UserError(
      "invalid_connection",
      "Enter a PostgreSQL connection string that starts with postgresql:// (or postgres://).",
    );
  }
  let parsed: ReturnType<typeof parseConnectionString>;
  try {
    parsed = parseConnectionString(trimmed);
  } catch {
    throw new UserError(
      "invalid_connection",
      "That connection string couldn't be parsed.",
    );
  }
  // IPv6 literals arrive bracketed ("[::1]"); unwrap them before resolving/checking.
  const host = (parsed.host ?? "").replace(/^\[(.*)\]$/, "$1");
  if (!host || host.startsWith("/")) {
    throw new UserError(
      "invalid_connection",
      "The connection string must include a network host name.",
    );
  }
  if (!parsed.database) {
    throw new UserError(
      "invalid_connection",
      "The connection string must include a database name.",
    );
  }
  const port = parsed.port ? Number(parsed.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UserError(
      "invalid_connection",
      "The connection string has an invalid port.",
    );
  }

  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await lookup(host, { all: true })).map(
        (entry) => entry.address,
      );
    } catch {
      throw new UserError(
        "database_unavailable",
        `The host "${host}" could not be found.`,
        400,
      );
    }
  }
  if (
    !config.allowPrivateDbHosts() &&
    (addresses.length === 0 || addresses.some(isBlockedAddress))
  ) {
    throw new UserError(
      "connection_blocked",
      "For security, Genviz can only connect to publicly reachable database hosts.",
      400,
    );
  }

  const ssl = parsed.ssl as pg.ClientConfig["ssl"];
  const verifiesCertificate =
    ssl !== undefined &&
    ssl !== false &&
    !(typeof ssl === "object" && ssl.rejectUnauthorized === false);
  // Pin the vetted IP to prevent DNS rebinding. With verified TLS we keep the
  // hostname (SNI + certificate checks already bind the connection to it).
  const pinnedHost = verifiesCertificate || isIP(host) ? host : addresses[0]!;

  return {
    host,
    config: {
      host: pinnedHost,
      port,
      database: parsed.database ?? undefined,
      user: parsed.user ?? undefined,
      password: parsed.password ?? undefined,
      ssl,
    },
  };
}

async function withClient<T>(
  clientConfig: pg.ClientConfig,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    ...clientConfig,
    connectionTimeoutMillis: config.connectTimeoutMs(),
    query_timeout: 15_000,
    application_name: "genviz",
    types: genvizTypes,
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    const classified = classifyPgError(error);
    const code = (error as { code?: string }).code;
    if (code === "28P01" || code === "28000") {
      throw new UserError(
        "invalid_connection",
        "The database rejected the username or password.",
      );
    }
    if (code === "3D000")
      throw new UserError(
        "invalid_connection",
        "That database does not exist on the server.",
      );
    if (classified.code === "unavailable") {
      throw new UserError(
        "database_unavailable",
        "Couldn't reach the database. Check the host, port and network access.",
      );
    }
    throw new UserError(
      "invalid_connection",
      "Couldn't connect to the database with that connection string.",
    );
  }
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = 10000");
    const result = await fn(client);
    await client.query("ROLLBACK");
    return result;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function introspect(client: pg.Client): Promise<PgSchemaSnapshot> {
  const info = await client.query<{
    database: string;
    user: string;
    version: string;
  }>(
    "SELECT current_database() AS database, current_user AS user, current_setting('server_version') AS version",
  );
  const tables = await client.query<{
    schema: string;
    name: string;
    kind: string;
    estimated_rows: number | null;
  }>(`
    SELECT n.nspname AS schema, c.relname AS name,
           CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END AS kind,
           CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint END AS estimated_rows
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p','v','m')
      AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
      AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast%'
      AND has_table_privilege(c.oid, 'SELECT')
    ORDER BY (n.nspname = 'public') DESC, n.nspname, c.relname
    LIMIT ${MAX_TABLES + 1}`);
  const truncated = tables.rows.length > MAX_TABLES;
  const tableRows = tables.rows.slice(0, MAX_TABLES);
  const columns = await client.query<{
    schema: string;
    table: string;
    name: string;
    type: string;
  }>(`
    SELECT table_schema AS schema, table_name AS "table", column_name AS name, data_type AS type
    FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog','information_schema')
    ORDER BY table_schema, table_name, ordinal_position`);
  const constraints = await client.query<{
    schema: string;
    table: string;
    type: string;
    columns: string[];
    ref_schema: string | null;
    ref_table: string | null;
  }>(`
    SELECT n.nspname AS schema, c.relname AS "table", con.contype AS type,
           ARRAY(SELECT a.attname FROM unnest(con.conkey) k JOIN pg_attribute a
                 ON a.attrelid = con.conrelid AND a.attnum = k)::text[] AS columns,
           rn.nspname AS ref_schema, rc.relname AS ref_table
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_class rc ON rc.oid = con.confrelid
    LEFT JOIN pg_namespace rn ON rn.oid = rc.relnamespace
    WHERE con.contype IN ('p','f') AND n.nspname NOT IN ('pg_catalog','information_schema')`);

  const byKey = new Map<string, PgTable>();
  for (const row of tableRows) {
    byKey.set(`${row.schema}.${row.name}`, {
      schema: row.schema,
      name: row.name,
      kind: row.kind === "view" ? "view" : "table",
      estimatedRows:
        row.estimated_rows === null ? null : Number(row.estimated_rows),
      columns: [],
      primaryKey: [],
      foreignKeys: [],
    });
  }
  for (const column of columns.rows) {
    const table = byKey.get(`${column.schema}.${column.table}`);
    if (table && table.columns.length < MAX_COLUMNS_PER_TABLE)
      table.columns.push({ name: column.name, type: column.type });
  }
  for (const constraint of constraints.rows) {
    const table = byKey.get(`${constraint.schema}.${constraint.table}`);
    if (!table) continue;
    if (constraint.type === "p") table.primaryKey = constraint.columns;
    else if (constraint.ref_table) {
      table.foreignKeys.push({
        columns: constraint.columns,
        references: `${constraint.ref_schema}.${constraint.ref_table}`,
      });
    }
  }
  return {
    database: info.rows[0]?.database ?? "",
    user: info.rows[0]?.user ?? "",
    serverVersion: info.rows[0]?.version ?? "",
    tables: [...byKey.values()],
    truncated,
  };
}

async function writeCapabilityWarnings(client: pg.Client): Promise<string[]> {
  const warnings: string[] = [];
  const role = await client.query<{ rolsuper: boolean }>(
    "SELECT rolsuper FROM pg_roles WHERE rolname = current_user",
  );
  if (role.rows[0]?.rolsuper) {
    warnings.push(
      "This user is a superuser. Genviz only runs read-only queries, but a dedicated read-only user is strongly recommended.",
    );
    return warnings;
  }
  const writes = await client.query<{ n: number }>(`
    SELECT count(*)::int AS n FROM information_schema.table_privileges
    WHERE grantee = current_user AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')`);
  if ((writes.rows[0]?.n ?? 0) > 0) {
    warnings.push(
      "This user can modify data. Genviz only runs read-only queries, but a read-only user is recommended.",
    );
  }
  return warnings;
}

export async function testConnection(
  connectionString: string,
): Promise<ConnectionTestResult> {
  const resolved = await resolveConnection(connectionString);
  return withClient(resolved.config, async (client) => {
    const snapshot = await introspect(client);
    const warnings: string[] = await writeCapabilityWarnings(client).catch(
      () => [],
    );
    if (snapshot.tables.length === 0) {
      warnings.push("No readable tables were found for this user.");
    }
    if (snapshot.truncated)
      warnings.push(`Only the first ${MAX_TABLES} tables are used.`);
    return { snapshot, host: resolved.host, warnings };
  });
}
