/**
 * Integration tests against a real PostgreSQL server.
 * Requires TEST_DATABASE_URL (Genviz app DB, non-superuser owner with CREATEROLE)
 * and TEST_SALES_DB_URL / TEST_SALES_DB_RW_URL (a sample "customer" database).
 * Skipped automatically when they are not set.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Source } from "@prisma/client";

const APP_URL = process.env.TEST_DATABASE_URL;
const SALES_URL = process.env.TEST_SALES_DB_URL;
const SALES_RW_URL = process.env.TEST_SALES_DB_RW_URL;

describe.skipIf(!APP_URL)("database integration", () => {
  let mod: {
    appDb: typeof import("@/lib/data/app-db");
    ingest: typeof import("@/lib/data/csv-ingest");
    infer: typeof import("@/lib/data/csv-infer");
    exec: typeof import("@/lib/data/executor");
    sources: typeof import("@/lib/data/sources");
    pgSource: typeof import("@/lib/data/postgres-source");
    crypto: typeof import("@/lib/security/crypto");
    rate: typeof import("@/lib/security/rate-limit");
  };
  const createdTables: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = APP_URL;
    mod = {
      appDb: await import("@/lib/data/app-db"),
      ingest: await import("@/lib/data/csv-ingest"),
      infer: await import("@/lib/data/csv-infer"),
      exec: await import("@/lib/data/executor"),
      sources: await import("@/lib/data/sources"),
      pgSource: await import("@/lib/data/postgres-source"),
      crypto: await import("@/lib/security/crypto"),
      rate: await import("@/lib/security/rate-limit"),
    };
  });

  afterAll(async () => {
    for (const table of createdTables) await mod.ingest.dropDataset(table);
    await mod.appDb.appPool().end();
  });

  async function uploadCsv(text: string) {
    const table = mod.infer.inferCsv(text, { maxRows: 10_000 });
    const tableName = mod.ingest.newDatasetTableName();
    await mod.ingest.loadDataset(tableName, table);
    createdTables.push(tableName);
    const source = {
      id: "00000000-0000-0000-0000-000000000001",
      ownerId: "test",
      kind: "csv",
      name: "sales",
      tableName,
      encryptedUrl: null,
      details: {
        fileName: "sales.csv",
        sizeBytes: text.length,
        rowCount: table.rowCount,
        columnCount: table.columns.length,
        columns: table.columns,
        warnings: [],
        suggestions: [],
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Source;
    return { tableName, runtime: mod.sources.toRuntime(source), table };
  }

  const CSV = [
    "id,order_date,region,product,revenue",
    '1,2026-01-15,North,Laptop,"$1,200.50"',
    "2,2026-01-20,South,Phone,800",
    '3,2026-02-03,North,Phone,"$1,000"',
    "4,2026-02-18,East,Laptop,N/A",
    "5,2026-03-09,South,Laptop,1500",
  ].join("\n");

  it("sets up the dataset schema with a SELECT-only reader role", async () => {
    const state = await mod.appDb.ensureDataSchema();
    expect(state.readerRole).toBe(true);
  });

  it("loads a CSV (id column, currency, N/A) and answers a guarded aggregate query", async () => {
    const { runtime } = await uploadCsv(CSV);
    const outcome = await runtime.run(
      "SELECT region, sum(revenue) AS total FROM dataset GROUP BY region ORDER BY total DESC NULLS LAST",
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.rows).toEqual([
      ["South", 2300],
      ["North", 2200.5],
      ["East", null],
    ]);
    expect(outcome.result.columns.map((c) => c.kind)).toEqual([
      "text",
      "number",
    ]);
  });

  it("returns dates as plain YYYY-MM-DD strings and supports date_trunc", async () => {
    const { runtime } = await uploadCsv(CSV);
    const outcome = await runtime.run(
      "SELECT date_trunc('month', order_date)::date AS month, count(*) AS orders FROM dataset GROUP BY 1 ORDER BY 1",
    );
    expect(outcome.ok && outcome.result.rows).toEqual([
      ["2026-01-01", 2],
      ["2026-02-01", 2],
      ["2026-03-01", 1],
    ]);
  });

  it("the guard blocks writes and other tables before they reach the database", async () => {
    const { runtime } = await uploadCsv(CSV);
    expect(await runtime.run("DELETE FROM dataset")).toMatchObject({
      ok: false,
      kind: "rejected",
      code: "not_select",
    });
    expect(await runtime.run("SELECT * FROM genviz.sources")).toMatchObject({
      ok: false,
      kind: "rejected",
      code: "table_not_allowed",
    });
  });

  it("even if the guard were bypassed, the executor's READ ONLY transaction refuses writes", async () => {
    const { tableName } = await uploadCsv(CSV);
    await expect(
      mod.exec.executeOnPool(mod.appDb.appPool(), {
        sql: `DELETE FROM genviz_data."${tableName}"`,
        maxRows: 10,
        statementTimeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: "permission" });
    const count = await mod.appDb
      .appPool()
      .query(`SELECT count(*)::int AS n FROM genviz_data."${tableName}"`);
    expect(count.rows[0].n).toBe(5);
  });

  it("the reader role cannot read Genviz's metadata tables", async () => {
    await expect(
      mod.exec.executeOnPool(mod.appDb.appPool(), {
        sql: "SELECT * FROM genviz.sources",
        maxRows: 10,
        statementTimeoutMs: 5_000,
        role: mod.appDb.READER_ROLE,
      }),
    ).rejects.toMatchObject({ code: "permission" });
  });

  it("enforces the statement timeout", async () => {
    await expect(
      mod.exec.executeOnPool(mod.appDb.appPool(), {
        sql: "SELECT pg_sleep(3)",
        maxRows: 1,
        statementTimeoutMs: 300,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("the extended protocol rejects stacked statements even without the guard", async () => {
    await expect(
      mod.exec.executeOnPool(mod.appDb.appPool(), {
        sql: "SELECT 1; SELECT 2",
        maxRows: 1,
        statementTimeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "query_error" });
  });

  it("caps result size server-side and flags truncation", async () => {
    const { runtime } = await uploadCsv(CSV);
    process.env.MAX_RESULT_ROWS = "2";
    try {
      const outcome = await runtime.run("SELECT * FROM dataset");
      expect(outcome.ok && outcome.result).toMatchObject({
        rowCount: 2,
        truncated: true,
      });
    } finally {
      delete process.env.MAX_RESULT_ROWS;
    }
  });

  it("loads datasets atomically: a failing insert leaves no table behind", async () => {
    const table = mod.infer.inferCsv("n\n1\n2", { maxRows: 10 });
    table.rows[1] = ["not a number" as unknown as number];
    const tableName = mod.ingest.newDatasetTableName();
    await expect(mod.ingest.loadDataset(tableName, table)).rejects.toThrow();
    const exists = await mod.appDb
      .appPool()
      .query("SELECT to_regclass($1) AS t", [`genviz_data.${tableName}`]);
    expect(exists.rows[0].t).toBeNull();
  });

  it("Postgres-backed cooldown store claims atomically", async () => {
    const key = `test:${Date.now()}`;
    expect(await mod.rate.postgresCooldownStore.claim(key, 30)).toEqual({
      ok: true,
    });
    const second = await mod.rate.postgresCooldownStore.claim(key, 30);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.retryAfterSeconds).toBeGreaterThan(25);
    await mod.rate.postgresCooldownStore.extend(key, 90);
    expect(await mod.rate.postgresCooldownStore.remaining(key)).toBeGreaterThan(
      85,
    );
  });

  describe("SSRF protection", () => {
    it.each([
      "postgresql://u:p@127.0.0.1:5432/db",
      "postgresql://u:p@localhost:5432/db",
      "postgresql://u:p@169.254.169.254:5432/db",
      "postgresql://u:p@10.1.2.3/db",
      "postgresql://u:p@[::1]:5432/db",
    ])("blocks %s", async (url) => {
      const previous = process.env.ALLOW_PRIVATE_DB_HOSTS;
      delete process.env.ALLOW_PRIVATE_DB_HOSTS;
      try {
        await expect(mod.pgSource.resolveConnection(url)).rejects.toMatchObject(
          { code: "connection_blocked" },
        );
      } finally {
        if (previous !== undefined)
          process.env.ALLOW_PRIVATE_DB_HOSTS = previous;
      }
    });

    it("rejects malformed connection strings", async () => {
      await expect(
        mod.pgSource.resolveConnection("mysql://x@y/z"),
      ).rejects.toMatchObject({ code: "invalid_connection" });
      await expect(
        mod.pgSource.resolveConnection("postgresql://u:p@host"),
      ).rejects.toMatchObject({ code: "invalid_connection" });
    });
  });

  describe.skipIf(!SALES_URL || !SALES_RW_URL)(
    "connected PostgreSQL database",
    () => {
      beforeAll(() => {
        process.env.ALLOW_PRIVATE_DB_HOSTS = "true";
      });

      function pgSourceFor(
        url: string,
        snapshot: import("@/lib/data/postgres-source").PgSchemaSnapshot,
      ): Source {
        return {
          id: "00000000-0000-0000-0000-000000000002",
          ownerId: "test",
          kind: "postgres",
          name: "sales_demo",
          tableName: null,
          encryptedUrl: mod.crypto.encryptSecret(url),
          details: {
            database: snapshot.database,
            host: "localhost",
            user: snapshot.user,
            serverVersion: snapshot.serverVersion,
            tableCount: snapshot.tables.length,
            snapshot,
            warnings: [],
            suggestions: [],
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        } as unknown as Source;
      }

      it("tests the connection and introspects tables, keys and row estimates", async () => {
        const result = await mod.pgSource.testConnection(SALES_URL!);
        expect(result.snapshot.database).toBe("sales_demo");
        const names = result.snapshot.tables
          .map((t) => `${t.schema}.${t.name}`)
          .sort();
        expect(names).toEqual([
          "public.customers",
          "public.order_items",
          "public.orders",
          "public.products",
        ]);
        const orders = result.snapshot.tables.find((t) => t.name === "orders")!;
        expect(orders.primaryKey).toEqual(["id"]);
        expect(orders.foreignKeys).toEqual([
          { columns: ["customer_id"], references: "public.customers" },
        ]);
        expect(result.warnings).toEqual([]);
        expect(
          mod.sources.suggestPostgresQuestions(result.snapshot).length,
        ).toBeGreaterThan(2);
      });

      it("warns when the connecting user can modify data", async () => {
        const result = await mod.pgSource.testConnection(SALES_RW_URL!);
        expect(result.warnings.join(" ")).toMatch(/can modify data/);
      });

      it("rejects wrong credentials with a clear message", async () => {
        await expect(
          mod.pgSource.testConnection(SALES_URL!.replace("analyst@", "wrong@")),
        ).rejects.toMatchObject({
          code: "invalid_connection",
        });
      });

      it("reports an unreachable database as unavailable", async () => {
        await expect(
          mod.pgSource.testConnection("postgresql://u:p@127.0.0.1:1/db"),
        ).rejects.toMatchObject({
          code: "database_unavailable",
        });
      });

      it("runs guarded joins with aggregates and date transforms", async () => {
        const { snapshot } = await mod.pgSource.testConnection(SALES_URL!);
        const runtime = mod.sources.toRuntime(
          pgSourceFor(SALES_URL!, snapshot),
        );
        expect(runtime.schemaOverview()).toContain(
          "FK customer_id → public.customers",
        );
        const outcome = await runtime.run(`
        SELECT c.region, date_trunc('month', o.order_date)::date AS month,
               round(sum(oi.quantity * oi.unit_price)::numeric, 2) AS revenue
        FROM public.orders o
        JOIN public.customers c ON c.id = o.customer_id
        JOIN public.order_items oi ON oi.order_id = o.id
        WHERE o.status = 'completed' AND o.order_date >= date '2026-01-01'
        GROUP BY 1, 2 ORDER BY 2, 1`);
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.result.rowCount).toBeGreaterThan(8);
        expect(typeof outcome.result.rows[0]![2]).toBe("number");
        expect(outcome.result.rows[0]![1]).toMatch(/^2026-\d{2}-01$/);
      });

      it("a read-write user still cannot write through Genviz", async () => {
        const { snapshot } = await mod.pgSource.testConnection(SALES_RW_URL!);
        const runtime = mod.sources.toRuntime(
          pgSourceFor(SALES_RW_URL!, snapshot),
        );
        expect(await runtime.run("DELETE FROM public.orders")).toMatchObject({
          ok: false,
          kind: "rejected",
        });
        const resolved = await mod.pgSource.resolveConnection(SALES_RW_URL!);
        await expect(
          mod.exec.executeOnConnection(
            resolved.config,
            {
              sql: "DELETE FROM public.order_items",
              maxRows: 1,
              statementTimeoutMs: 2_000,
            },
            3_000,
          ),
        ).rejects.toMatchObject({ code: "permission" });
        const check = await runtime.run(
          "SELECT count(*) AS n FROM public.order_items",
        );
        expect(
          check.ok && (check.result.rows[0]![0] as number),
        ).toBeGreaterThan(0);
      });

      it("profiles a column with generated, guarded SQL", async () => {
        const { snapshot } = await mod.pgSource.testConnection(SALES_URL!);
        const runtime = mod.sources.toRuntime(
          pgSourceFor(SALES_URL!, snapshot),
        );
        const profile = (await runtime.profileColumn(
          "customers",
          "region",
        )) as { topValues: Array<{ value: string }> };
        expect(profile.topValues.map((v) => v.value).sort()).toEqual([
          "East",
          "North",
          "South",
          "West",
        ]);
      });
    },
  );
});
