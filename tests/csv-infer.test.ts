import { describe, expect, it } from "vitest";
import {
  CsvError,
  inferCsv,
  parseNumberLoose,
  sanitizeHeaders,
  suggestQuestions,
} from "@/lib/data/csv-infer";

const infer = (text: string) => inferCsv(text, { maxRows: 10_000 });
const col = (table: ReturnType<typeof infer>, name: string) => {
  const found = table.columns.find((c) => c.name === name);
  if (!found)
    throw new Error(
      `missing column ${name}: ${table.columns.map((c) => c.name).join(",")}`,
    );
  return found;
};

describe("number parsing", () => {
  it.each([
    ["1234", 1234],
    ["-12.5", -12.5],
    ["1,234,567.89", 1234567.89],
    ["$1,234,567", 1234567],
    ["$89,000", 89000],
    ["(1,234.50)", -1234.5],
    ["₹1,20,000", 120000],
    ["12%", 12],
    ["1e3", 1000],
    ["-$5", -5],
    ["5 €", 5],
  ])("parses %s", (raw, expected) => {
    expect(parseNumberLoose(raw)?.value).toBe(expected);
  });

  it.each(["abc", "1.234,56", "12-34", "$", "1,23"])("rejects %s", (raw) => {
    expect(parseNumberLoose(raw)).toBeNull();
  });
});

describe("CSV inference (audit failure cases)", () => {
  it("keeps a user `id` column (no collision with an injected primary key)", () => {
    const table = infer("id,name,amount\n1,Alice,10\n2,Bob,20");
    expect(table.columns.map((c) => c.name)).toEqual(["id", "name", "amount"]);
    expect(col(table, "id").role).toBe("identifier");
  });

  it("loads currency values with thousands separators as numbers", () => {
    const table = infer(
      'product,revenue\nLaptop,"$1,234,567"\nPhone,"$89,000"',
    );
    expect(col(table, "revenue").kind).toBe("integer");
    expect(col(table, "revenue").currency).toBe("$");
    expect(table.rows.map((r) => r[1])).toEqual([1234567, 89000]);
  });

  it("de-duplicates headers that collide after sanitising, and names blank headers", () => {
    const names = sanitizeHeaders([
      "Sales ($)",
      "Sales (€)",
      "",
      "select",
      "2024 total",
    ]).map((h) => h.name);
    expect(names).toEqual([
      "sales",
      "sales_2",
      "column_3",
      "select_value",
      "c_2024_total",
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("infers types from ALL rows: a text value after row 50 makes the column text", () => {
    const rows = [
      "a,v",
      ...Array.from(
        { length: 60 },
        (_, i) => `r${i},${i < 55 ? i : "unknown"}`,
      ),
    ];
    const table = infer(rows.join("\n"));
    expect(col(table, "v").kind).toBe("text");
  });

  it("treats N/A, empty and null tokens as nulls instead of failing", () => {
    const table = infer("k,v\na,1\nb,N/A\nc,\nd,null\ne,5");
    expect(col(table, "v").kind).toBe("integer");
    expect(col(table, "v").nullCount).toBe(3);
    expect(table.rows.map((r) => r[1])).toEqual([1, null, null, null, 5]);
  });

  it("detects dates, percentages and keeps leading-zero codes as text", () => {
    const table = infer(
      "order_date,margin,zip\n2026-01-05,12%,02134\n2026-02-10,8.5%,10001",
    );
    expect(col(table, "order_date").kind).toBe("date");
    expect(col(table, "margin").kind).toBe("number");
    expect(col(table, "margin").percent).toBe(true);
    expect(col(table, "zip").kind).toBe("text");
    expect(table.rows[0]).toEqual(["2026-01-05", 12, "02134"]);
  });

  it("resolves day/month order from the data", () => {
    const dmy = infer("d\n25/12/2025\n01/02/2026");
    expect(col(dmy, "d").dateOrder).toBe("dmy");
    expect(dmy.rows.map((r) => r[0])).toEqual(["2025-12-25", "2026-02-01"]);
    const mdy = infer("d\n12/25/2025\n02/01/2026");
    expect(col(mdy, "d").dateOrder).toBe("mdy");
    expect(mdy.rows.map((r) => r[0])).toEqual(["2025-12-25", "2026-02-01"]);
  });

  it("reads year-month values as the first of the month", () => {
    const table = infer("month,sales\n2026-01,10\n2026-02,12\nMar 2026,9");
    expect(col(table, "month").kind).toBe("date");
    expect(table.rows.map((r) => r[0])).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
    ]);
  });

  it("parses timestamps and booleans", () => {
    const table = infer(
      "at,active\n2026-01-05 10:30:00,yes\n2026-01-06T11:00:00Z,no",
    );
    expect(col(table, "at").kind).toBe("timestamp");
    expect(col(table, "active").kind).toBe("boolean");
    expect(table.rows.map((r) => r[1])).toEqual([true, false]);
  });

  it("handles a UTF-8 BOM and ragged rows", () => {
    const table = infer("\uFEFFcustomer,total\nX,1\nY");
    expect(table.columns[0]!.name).toBe("customer");
    expect(table.rows[1]).toEqual(["Y", null]);
    expect(table.warnings.join(" ")).toMatch(/different number of fields/);
  });

  it("rejects empty files and header-only files", () => {
    expect(() => infer("")).toThrow(CsvError);
    expect(() => infer("a,b\n")).toThrow(CsvError);
  });

  it("enforces the row limit", () => {
    expect(() => inferCsv("a\n1\n2\n3", { maxRows: 2 })).toThrow(/limit/);
  });

  it("profiles columns and suggests schema-based questions", () => {
    const lines = ["order_date,region,product,revenue"];
    for (let i = 0; i < 40; i++)
      lines.push(
        `2026-0${(i % 6) + 1}-01,${["North", "South"][i % 2]},P${i % 5},${100 + i}`,
      );
    const table = infer(lines.join("\n"));
    expect(col(table, "region").role).toBe("dimension");
    expect(
      col(table, "region")
        .topValues?.map((v) => v.value)
        .sort(),
    ).toEqual(["North", "South"]);
    expect(col(table, "revenue").role).toBe("measure");
    expect(col(table, "revenue").min).toBe(100);
    expect(col(table, "revenue").max).toBe(139);
    const suggestions = suggestQuestions(table.columns);
    expect(suggestions).toContain("Show revenue by month");
    expect(
      suggestions.some((s) =>
        s.startsWith("Which region has the highest revenue"),
      ),
    ).toBe(true);
  });
});
