import { describe, expect, it } from "vitest";
import {
  type AllowedRelation,
  guardSql,
  withRowLimit,
} from "@/lib/data/sql-guard";

const csv: AllowedRelation[] = [{ schema: null, name: "dataset" }];
const db: AllowedRelation[] = [
  { schema: "public", name: "orders" },
  { schema: "public", name: "customers" },
  { schema: "sales", name: "targets" },
];

describe("Query Guard — allowed queries", () => {
  it.each([
    "SELECT region, sum(revenue) AS total FROM dataset GROUP BY 1 ORDER BY 2 DESC",
    "select * from dataset limit 5;",
    "WITH m AS (SELECT date_trunc('month', order_date)::date AS month, sum(revenue) r FROM dataset GROUP BY 1) SELECT * FROM m ORDER BY month",
    "-- revenue by region\nSELECT region FROM dataset",
    "(SELECT 1 AS a FROM dataset) UNION ALL (SELECT 2 FROM dataset)",
    "SELECT count(*) FROM dataset WHERE lower(status) = 'deleted'",
    'SELECT "update" FROM dataset',
    "SELECT generate_series(1, 3) AS n",
  ])("allows %s", async (sql) => {
    const result = await guardSql(sql, csv);
    expect(result.ok).toBe(true);
  });

  it("allows schema-qualified joins on listed tables", async () => {
    const result = await guardSql(
      "SELECT c.region, count(*) FROM public.orders o JOIN public.customers c ON c.id = o.customer_id JOIN sales.targets t ON true GROUP BY 1",
      db,
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.relations.sort()).toEqual([
        "public.customers",
        "public.orders",
        "sales.targets",
      ]);
  });

  it("strips trailing semicolons so the statement can be wrapped", async () => {
    const result = await guardSql("SELECT 1 FROM dataset;;  ", csv);
    expect(result.ok && result.sql).toBe("SELECT 1 FROM dataset");
  });
});

describe("Query Guard — blocked queries (audit bypass list)", () => {
  it.each([
    ["SELECT 1; CREATE TABLE pwn(x int)", "multiple_statements"],
    [
      "SELECT 1 FROM dataset; GRANT ALL ON ALL TABLES IN SCHEMA public TO PUBLIC",
      "multiple_statements",
    ],
    ["SELECT * INTO stolen_copy FROM dataset", "forbidden_clause"],
    ["SELECT pg_sleep(3600)", "forbidden_function"],
    [
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity",
      "forbidden_function",
    ],
    ["SELECT pg_read_file('/etc/passwd')", "forbidden_function"],
    [
      "SELECT set_config('statement_timeout', '0', false)",
      "forbidden_function",
    ],
    [
      "SELECT query_to_xml('select * from secrets', true, true, '')",
      "forbidden_function",
    ],
    [
      "SELECT * FROM dblink('host=10.0.0.1', 'select 1') AS t(x int)",
      "forbidden_function",
    ],
    ["SELECT lo_import('/etc/passwd')", "forbidden_function"],
    ["SELECT nextval('orders_id_seq')", "forbidden_function"],
    ["SELECT rolname FROM pg_roles", "table_not_allowed"],
    ["SELECT * FROM information_schema.tables", "table_not_allowed"],
    ["SELECT * FROM other_table", "table_not_allowed"],
    ["SELECT * FROM dataset FOR UPDATE", "forbidden_clause"],
    [
      "WITH d AS (DELETE FROM dataset RETURNING *) SELECT * FROM d",
      "forbidden_clause",
    ],
    ["INSERT INTO dataset VALUES (1)", "not_select"],
    ["UPDATE dataset SET x = 1", "not_select"],
    ["DROP TABLE dataset", "not_select"],
    ["EXPLAIN ANALYZE SELECT * FROM dataset", "not_select"],
    ["COPY dataset TO '/tmp/x'", "not_select"],
    ["SELECT * FROM dataset WHERE id = $1", "parameters_not_allowed"],
    ["SELEC oops", "syntax_error"],
    ["", "empty"],
  ])("blocks %s", async (sql, code) => {
    const result = await guardSql(sql, csv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(code);
  });

  it("rejects tables from another schema even with the same name", async () => {
    const result = await guardSql("SELECT * FROM private.orders", db);
    expect(result).toMatchObject({ ok: false, code: "table_not_allowed" });
  });

  it("rejects cross-database references", async () => {
    const result = await guardSql("SELECT * FROM otherdb.public.orders", db);
    expect(result).toMatchObject({ ok: false, code: "table_not_allowed" });
  });

  it("does not let a CTE name smuggle in a real table", async () => {
    const result = await guardSql(
      "WITH x AS (SELECT * FROM secrets) SELECT * FROM x",
      csv,
    );
    expect(result).toMatchObject({ ok: false, code: "table_not_allowed" });
  });
});

describe("row limit wrapper", () => {
  it("wraps with LIMIT max+1 and survives a trailing line comment", () => {
    const sql = withRowLimit("SELECT 1 -- note", 100);
    expect(sql).toContain("LIMIT 101");
    expect(sql).toMatch(/-- note\n\) AS genviz_result/);
  });
});
