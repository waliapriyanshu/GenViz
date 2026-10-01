import { parse } from "libpg-query";

/**
 * Query Guard: parses model-written SQL with the real PostgreSQL parser
 * (libpg-query) and only lets through a single read-only SELECT that touches
 * the tables of the active data source. It is the first of two layers; the
 * executor additionally runs everything in a READ ONLY transaction with a
 * statement timeout (and a SELECT-only role for uploaded datasets).
 */

export interface AllowedRelation {
  /** null = referenced without a schema (e.g. the `dataset` alias for CSVs) */
  schema: string | null;
  name: string;
}

export type GuardErrorCode =
  | "empty"
  | "too_long"
  | "syntax_error"
  | "multiple_statements"
  | "not_select"
  | "forbidden_clause"
  | "forbidden_function"
  | "table_not_allowed"
  | "parameters_not_allowed";

export type GuardResult =
  | { ok: true; sql: string; relations: string[] }
  | { ok: false; code: GuardErrorCode; message: string };

const MAX_SQL_LENGTH = 20_000;

/** Statement node types that must never appear anywhere in the tree (e.g. inside CTEs). */
const FORBIDDEN_NODES = new Set([
  "InsertStmt",
  "UpdateStmt",
  "DeleteStmt",
  "MergeStmt",
  "CopyStmt",
  "CreateStmt",
  "CreateTableAsStmt",
  "DropStmt",
  "AlterTableStmt",
  "TruncateStmt",
  "GrantStmt",
  "VariableSetStmt",
  "DoStmt",
  "CallStmt",
  "ExplainStmt",
  "LockStmt",
  "ListenStmt",
  "NotifyStmt",
  "TransactionStmt",
]);

/** Exact function names that can read files, run dynamic SQL, change state or leak server info. */
const FORBIDDEN_FUNCTIONS = new Set([
  "set_config",
  "current_setting",
  "query_to_xml",
  "query_to_xml_and_xmlschema",
  "query_to_xmlschema",
  "table_to_xml",
  "table_to_xml_and_xmlschema",
  "table_to_xmlschema",
  "cursor_to_xml",
  "cursor_to_xmlschema",
  "schema_to_xml",
  "schema_to_xml_and_xmlschema",
  "schema_to_xmlschema",
  "database_to_xml",
  "database_to_xml_and_xmlschema",
  "database_to_xmlschema",
  "ts_stat",
  "ts_debug",
  "nextval",
  "setval",
  "currval",
  "lastval",
  "version",
  "inet_server_addr",
  "inet_server_port",
  "inet_client_addr",
  "inet_client_port",
  "has_table_privilege",
  "has_database_privilege",
  "has_schema_privilege",
]);

const FORBIDDEN_FUNCTION_PREFIXES = ["pg_", "dblink", "lo_", "txid_"];

function isForbiddenFunction(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    FORBIDDEN_FUNCTIONS.has(lower) ||
    FORBIDDEN_FUNCTION_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
}

type Node = Record<string, unknown>;

function walk(value: unknown, visit: (key: string, node: Node) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Node)) {
    if (child && typeof child === "object" && !Array.isArray(child))
      visit(key, child as Node);
    walk(child, visit);
  }
}

function funcName(node: Node): { schema: string | null; name: string } {
  const parts = ((node.funcname as Node[] | undefined) ?? [])
    .map((part) => (part.String as { sval?: string } | undefined)?.sval)
    .filter((part): part is string => typeof part === "string");
  const name = parts[parts.length - 1] ?? "";
  return {
    schema: parts.length > 1 ? (parts[parts.length - 2] ?? null) : null,
    name,
  };
}

export function relationLabel(relation: AllowedRelation): string {
  return relation.schema
    ? `${relation.schema}.${relation.name}`
    : relation.name;
}

/** Strips trailing semicolons/whitespace so the statement can be safely wrapped. */
function extractStatementText(
  sql: string,
  stmt: { stmt_location?: number; stmt_len?: number },
): string {
  const start = stmt.stmt_location ?? 0;
  const text = stmt.stmt_len
    ? sql.slice(start, start + stmt.stmt_len)
    : sql.slice(start);
  return text
    .trim()
    .replace(/;+\s*$/, "")
    .trim();
}

export async function guardSql(
  sql: string,
  allowed: AllowedRelation[],
): Promise<GuardResult> {
  const trimmed = sql.trim();
  if (!trimmed)
    return { ok: false, code: "empty", message: "The query is empty." };
  if (trimmed.length > MAX_SQL_LENGTH) {
    return { ok: false, code: "too_long", message: "The query is too long." };
  }

  let tree: {
    stmts?: Array<{ stmt?: Node; stmt_location?: number; stmt_len?: number }>;
  };
  try {
    tree = (await parse(trimmed)) as typeof tree;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not parse the query.";
    return {
      ok: false,
      code: "syntax_error",
      message: `SQL syntax error: ${message}`,
    };
  }

  const statements = tree.stmts ?? [];
  if (statements.length !== 1) {
    return {
      ok: false,
      code: "multiple_statements",
      message: "Exactly one SQL statement is allowed.",
    };
  }
  const statement = statements[0]!;
  const root = statement.stmt ?? {};
  if (!("SelectStmt" in root)) {
    return {
      ok: false,
      code: "not_select",
      message:
        "Only read-only SELECT queries (optionally with WITH) are allowed.",
    };
  }

  const cteNames = new Set<string>();
  walk(root, (key, node) => {
    if (key === "CommonTableExpr" && typeof node.ctename === "string")
      cteNames.add(node.ctename);
  });

  const allowedKeys = new Map<string, AllowedRelation>();
  for (const relation of allowed) {
    allowedKeys.set(`${relation.schema ?? ""}.${relation.name}`, relation);
  }
  const unqualifiedNames = new Set(allowed.map((relation) => relation.name));

  const state: { failure: GuardResult | null } = { failure: null };
  const touched = new Set<string>();
  const fail = (code: GuardErrorCode, message: string) => {
    state.failure ??= { ok: false, code, message };
  };

  walk(root, (key, node) => {
    if (state.failure) return;
    if (FORBIDDEN_NODES.has(key)) {
      fail(
        "forbidden_clause",
        "Data-modifying or administrative statements are not allowed.",
      );
      return;
    }
    if (key === "SelectStmt") {
      if (node.intoClause)
        fail(
          "forbidden_clause",
          "SELECT INTO is not allowed (it creates a table).",
        );
      if (Array.isArray(node.lockingClause) && node.lockingClause.length > 0) {
        fail(
          "forbidden_clause",
          "Row-locking clauses (FOR UPDATE/SHARE) are not allowed.",
        );
      }
      return;
    }
    if (key === "ParamRef") {
      fail(
        "parameters_not_allowed",
        "Query parameters ($1, $2, …) are not allowed; inline the values.",
      );
      return;
    }
    if (key === "FuncCall") {
      const { name } = funcName(node);
      if (isForbiddenFunction(name)) {
        fail("forbidden_function", `The function ${name}() is not allowed.`);
      }
      return;
    }
    if (key === "RangeVar") {
      const relname = node.relname as string;
      const schemaname = (node.schemaname as string | undefined) ?? null;
      if (node.catalogname) {
        fail("table_not_allowed", "Cross-database references are not allowed.");
        return;
      }
      if (!schemaname && cteNames.has(relname)) return;
      const ok = schemaname
        ? allowedKeys.has(`${schemaname}.${relname}`)
        : unqualifiedNames.has(relname);
      if (!ok) {
        const label = schemaname ? `${schemaname}.${relname}` : relname;
        fail(
          "table_not_allowed",
          `The table "${label}" is not available. Allowed tables: ${allowed.slice(0, 40).map(relationLabel).join(", ")}.`,
        );
        return;
      }
      touched.add(schemaname ? `${schemaname}.${relname}` : relname);
    }
  });

  if (state.failure) return state.failure;
  return {
    ok: true,
    sql: extractStatementText(trimmed, statement),
    relations: [...touched],
  };
}

/** Wraps a guarded statement with a server-side row cap (fetch one extra row to detect truncation). */
export function withRowLimit(
  sql: string,
  maxRows: number,
  prefix = "",
): string {
  // The newline before ")" matters: a trailing "-- comment" must not swallow it.
  return `${prefix}SELECT * FROM (\n${sql}\n) AS genviz_result LIMIT ${Math.floor(maxRows) + 1}`;
}

export function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
