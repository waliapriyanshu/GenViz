import { describe, expect, it } from "vitest";
import { describeFacts } from "@/lib/agent/describe";
import { checkGrounding, extractNumbers } from "@/lib/agent/grounding";
import {
  analyzeResult,
  autoAnalyze,
  histogramBins,
} from "@/lib/analysis/analyze";
import type { TabularResult } from "@/lib/analysis/shape";
import { buildVisualization, sanitizeVisualization } from "@/lib/viz/build";

const monthly: TabularResult = {
  columns: [
    { name: "month", kind: "date" },
    { name: "total_revenue", kind: "number" },
  ],
  rows: [
    ["2026-03-01", 150],
    ["2026-01-01", 100],
    ["2026-02-01", 120],
  ],
};

const byRegion: TabularResult = {
  columns: [
    { name: "region", kind: "text" },
    { name: "revenue", kind: "number" },
  ],
  rows: [
    ["North", 500],
    ["South", 300],
    ["East", 200],
  ],
};

describe("deterministic visualization", () => {
  it("date + numeric → line, sorted by time", () => {
    const viz = buildVisualization(monthly);
    expect(viz.type).toBe("line");
    expect(viz.config).toMatchObject({ x: "month", y: ["total_revenue"] });
    expect(viz.data.map((d) => d.month)).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
    ]);
  });

  it("category + numeric → bar", () => {
    const viz = buildVisualization(byRegion);
    expect(viz.type).toBe("bar");
    expect(viz.config).toMatchObject({ x: "region", y: ["revenue"] });
  });

  it("honours a valid pie request for a small categorical share", () => {
    expect(buildVisualization(byRegion, { type: "pie" }).type).toBe("pie");
  });

  it("falls back to bar when pie doesn't fit (time axis)", () => {
    const viz = buildVisualization(monthly, { type: "pie" });
    expect(viz.type).toBe("bar");
    expect(viz.notes.join(" ")).toMatch(/pie chart didn't fit/);
  });

  it("single row of numbers → KPI card", () => {
    const viz = buildVisualization({
      columns: [{ name: "total_revenue", kind: "number" }],
      rows: [[1234.5]],
    });
    expect(viz.type).toBe("kpi");
    expect(viz.config.kpis).toEqual([
      { label: "Total revenue", value: 1234.5 },
    ]);
  });

  it("two numeric columns → scatter", () => {
    const result: TabularResult = {
      columns: [
        { name: "price", kind: "number" },
        { name: "quantity", kind: "number" },
      ],
      rows: Array.from({ length: 10 }, (_, i) => [i * 10, 100 - i]),
    };
    expect(buildVisualization(result).type).toBe("scatter");
  });

  it("histogram request bins raw values", () => {
    const result: TabularResult = {
      columns: [{ name: "order_value", kind: "number" }],
      rows: Array.from({ length: 100 }, (_, i) => [i]),
    };
    const viz = buildVisualization(result, { type: "histogram" });
    expect(viz.type).toBe("histogram");
    expect(viz.data.reduce((acc, d) => acc + (d.count as number), 0)).toBe(100);
  });

  it("second small dimension becomes a series (grouped comparison)", () => {
    const result: TabularResult = {
      columns: [
        { name: "month", kind: "number" },
        { name: "year", kind: "number" },
        { name: "revenue", kind: "number" },
      ],
      rows: [
        [1, 2025, 10],
        [1, 2026, 12],
        [2, 2025, 11],
        [2, 2026, 15],
      ],
    };
    const viz = buildVisualization(result);
    expect(viz.type).toBe("line");
    expect(viz.config).toMatchObject({
      x: "month",
      y: ["revenue"],
      series: "year",
    });
    expect(viz.data.every((d) => typeof d.year === "string")).toBe(true);
  });

  it("ignores hallucinated columns and never emits undefined/NaN", () => {
    const result: TabularResult = {
      columns: [
        { name: "region", kind: "text" },
        { name: "revenue", kind: "number" },
      ],
      rows: [
        ["North", 10],
        [null, 5],
        ["South", null],
        ["West", Number.NaN],
      ],
    };
    const viz = buildVisualization(result, { x: "country", y: ["profit"] });
    expect(viz.notes.join(" ")).toMatch(/Ignored unknown column "country"/);
    expect(viz.config.x).toBe("region");
    for (const row of viz.data) {
      expect(Number.isFinite(row.revenue)).toBe(true);
      expect(row.region).not.toBeUndefined();
    }
    expect(viz.data.find((d) => d.region === "(blank)")).toBeTruthy();
    expect(viz.notes.join(" ")).toMatch(/left out/);
  });

  it("falls back to a table when there is nothing numeric to plot", () => {
    const viz = buildVisualization({
      columns: [{ name: "name", kind: "text" }],
      rows: [["a"], ["b"]],
    });
    expect(viz.type).toBe("table");
  });

  it("sanitize drops rows with non-finite values and degrades to table if nothing is left", () => {
    const viz = sanitizeVisualization({
      type: "bar",
      title: "t",
      data: [{ x: "a", y: Number.NaN }],
      config: { x: "x", y: ["y"] },
      notes: [],
    });
    expect(viz.type).toBe("table");
  });

  it("caps very long bar charts to the top categories", () => {
    const rows = Array.from({ length: 80 }, (_, i) => [`c${i}`, i]);
    const viz = buildVisualization({
      columns: [
        { name: "customer", kind: "text" },
        { name: "spend", kind: "number" },
      ],
      rows,
    });
    expect(viz.data).toHaveLength(30);
    expect(viz.data[0]!.spend).toBe(79);
    expect(viz.config.horizontal).toBe(true);
  });
});

describe("deterministic analysis", () => {
  it("auto-analyzes a time series as a trend", () => {
    const facts = autoAnalyze(monthly);
    expect(facts).toMatchObject({
      operation: "trend",
      first: { period: "2026-01-01", value: 100 },
      last: { period: "2026-03-01", value: 150 },
      change: 50,
      change_pct: 50,
      peak: { period: "2026-03-01", value: 150 },
    });
  });

  it("auto-analyzes categories as a ranking with shares", () => {
    const facts = autoAnalyze(byRegion);
    expect(facts).toMatchObject({ operation: "top", total: 1000 });
    expect(
      (facts.top as Array<{ name: string; share_pct: number }>)[0],
    ).toMatchObject({ name: "North", share_pct: 50 });
  });

  it("finds anomalies with IQR", () => {
    const result: TabularResult = {
      columns: [
        { name: "day", kind: "date" },
        { name: "orders", kind: "number" },
      ],
      rows: [
        ...Array.from({ length: 20 }, (_, i) => [
          `2026-01-${String(i + 1).padStart(2, "0")}`,
          100 + (i % 3),
        ]),
        ["2026-01-21", 400],
      ],
    };
    const facts = analyzeResult(result, "anomalies");
    expect(
      (facts.outliers as Array<{ label: string }>).map((o) => o.label),
    ).toEqual(["2026-01-21"]);
  });

  it("histogram bins cover every value", () => {
    const bins = histogramBins([1, 2, 2, 3, 10, 50]);
    expect(bins.reduce((acc, b) => acc + b.count, 0)).toBe(6);
  });

  it("describes facts without inventing numbers", () => {
    const facts = autoAnalyze(monthly);
    const text = describeFacts(facts, "$");
    expect(text).toContain("$100");
    expect(text).toContain("$150");
    expect(checkGrounding(text, [monthly.rows, facts]).grounded).toBe(true);
  });

  it("handles an empty result", () => {
    expect(autoAnalyze({ columns: monthly.columns, rows: [] })).toEqual({
      rows: 0,
    });
  });
});

describe("grounding check", () => {
  const facts = autoAnalyze(monthly);
  it("accepts numbers present in results or facts (with display rounding)", () => {
    expect(
      checkGrounding(
        "Revenue grew 50% from 100 to 150 between Jan and Mar 2026.",
        [monthly.rows, facts],
      ).grounded,
    ).toBe(true);
    expect(checkGrounding("Total was 1.2M.", [[[1_234_567]]]).grounded).toBe(
      true,
    );
  });

  it("flags invented numbers", () => {
    const report = checkGrounding("Revenue grew 63% to $9,999.", [
      monthly.rows,
      facts,
    ]);
    expect(report.grounded).toBe(false);
    expect(report.ungrounded).toEqual(["63%", "$9,999"]);
  });

  it("ignores years, dates and small counts", () => {
    expect(extractNumbers("In 2026-01-05 the top 3 regions of 2025 …")).toEqual(
      [],
    );
  });
});

describe("real-model result shapes (from live gpt-oss-120b runs)", () => {
  // "Now compare that with 2025" → year and month both returned as dates.
  const months = (year: number, count: number) =>
    Array.from({ length: count }, (_, i) => [
      `${year}-01-01`,
      `${year}-${String(i + 1).padStart(2, "0")}-01`,
      100 + i * 10 + (year - 2025) * 50,
    ]);
  const yearAndMonth: TabularResult = {
    columns: [
      { name: "year", kind: "date" },
      { name: "month", kind: "date" },
      { name: "total_revenue", kind: "number" },
    ],
    rows: [...months(2025, 12), ...months(2026, 8)],
  };

  it("uses the finest time column on x and aligns years by month", () => {
    const viz = buildVisualization(yearAndMonth);
    expect(viz.type).toBe("line");
    expect(viz.config).toMatchObject({
      x: "month_of_year",
      y: ["total_revenue"],
      series: "year",
      xLabel: "Month",
    });
    expect(new Set(viz.data.map((d) => d.year))).toEqual(
      new Set(["2025", "2026"]),
    );
    expect(viz.data.filter((d) => d.month_of_year === 1)).toHaveLength(2);
  });

  it("summarizes it as a period comparison, flagging uneven coverage", () => {
    const facts = autoAnalyze(yearAndMonth);
    expect(facts).toMatchObject({
      operation: "compare_periods",
      latest: { period: "2026", sub_periods: 8 },
      previous: { period: "2025", sub_periods: 12 },
      uneven_coverage: true,
    });
    const text = describeFacts(facts, "$");
    expect(text).toMatch(/in 2026 vs .* in 2025/);
    expect(text).toMatch(/2026 covers 8 periods vs 12 in 2025/);
    expect(checkGrounding(text, [yearAndMonth.rows, facts]).grounded).toBe(
      true,
    );
  });

  it("ranks correctly even when a group appears on several rows", () => {
    const facts = analyzeResult(
      {
        columns: [
          { name: "region", kind: "text" },
          { name: "revenue", kind: "number" },
        ],
        rows: [
          ["North", 10],
          ["South", 25],
          ["North", 30],
        ],
      },
      "top",
    );
    expect(
      (facts.top as Array<{ name: string; value: number }>)[0],
    ).toMatchObject({ name: "North", value: 40 });
  });
});

describe("live-run fixes: currency, histograms, mixed scales", () => {
  it("a lone raw numeric column becomes a histogram automatically", () => {
    const viz = buildVisualization({
      columns: [{ name: "revenue", kind: "number" }],
      rows: Array.from({ length: 40 }, (_, i) => [i * 3]),
    });
    expect(viz.type).toBe("histogram");
  });

  it("only money measures get the currency symbol", () => {
    const kpi = buildVisualization(
      {
        columns: [
          { name: "total_orders", kind: "number" },
          { name: "total_units", kind: "number" },
          { name: "total_revenue", kind: "number" },
        ],
        rows: [[1688, 5021, 1532105]],
      },
      { currency: "$" },
    );
    expect(kpi.config.kpis?.map((k) => k.unit ?? null)).toEqual([
      null,
      null,
      "currency",
    ]);
    const text = describeFacts(
      {
        operation: "top",
        measure: "units",
        top: [{ name: "Furniture", value: 1925, share_pct: 38.3 }],
      },
      "$",
    );
    expect(text).toBe(
      "Furniture has the highest units at 1,925, 38.3% of the total.",
    );
  });

  it("does not plot measures of very different scales together", () => {
    const viz = buildVisualization(
      {
        columns: [
          { name: "category", kind: "text" },
          { name: "units", kind: "number" },
          { name: "revenue", kind: "number" },
          { name: "revenue_pct", kind: "number" },
        ],
        rows: [
          ["Electronics", 1500, 826195, 53.9],
          ["Furniture", 1925, 480000, 31.3],
          ["Home", 1600, 225910, 14.8],
        ],
      },
      { currency: "$" },
    );
    expect(viz.config.y).toEqual(["revenue"]);
    expect(viz.config.currency).toBe("$");
    expect(viz.notes.join(" ")).toMatch(/other columns are in the data table/);
  });
});

describe("model-bucketed distributions", () => {
  it("charts SQL-side buckets as bars in bucket order", () => {
    const viz = buildVisualization({
      columns: [
        { name: "bucket_start", kind: "number" },
        { name: "orders", kind: "number" },
        { name: "total_revenue", kind: "number" },
      ],
      rows: [
        [0, 700, 150000],
        [500, 420, 260000],
        [1000, 300, 370000],
      ],
    });
    expect(viz.type).toBe("bar");
    expect(viz.config.x).toBe("bucket_start");
    expect(viz.data.map((d) => d.bucket_start)).toEqual([0, 500, 1000]);
  });
});

describe("id + name results (live: product_id, product_name)", () => {
  const products: TabularResult = {
    columns: [
      { name: "product_id", kind: "number" },
      { name: "product_name", kind: "text" },
      { name: "total_revenue", kind: "number" },
    ],
    rows: [
      [1, "Aurora Laptop", 2097885],
      [2, "Nimbus Phone", 1400000],
      [6, "Lift Desk", 800000],
    ],
  };

  it("uses the name, not the id, on the x axis and never as a pointless series", () => {
    const viz = buildVisualization(products);
    expect(viz.config.x).toBe("product_name");
    expect(viz.config.series).toBeUndefined();
  });

  it("ranks by name in the computed facts", () => {
    const facts = autoAnalyze(products);
    expect((facts.top as Array<{ name: string }>)[0]!.name).toBe(
      "Aurora Laptop",
    );
  });
});

describe("driver analysis and SQL-grounded numbers (live: why did revenue change?)", () => {
  const byCategory: TabularResult = {
    columns: [
      { name: "month", kind: "date" },
      { name: "category", kind: "text" },
      { name: "revenue", kind: "number" },
    ],
    rows: [
      ["2026-07-01", "Electronics", 150000],
      ["2026-07-01", "Furniture", 90000],
      ["2026-07-01", "Home", 28785],
      ["2026-08-01", "Electronics", 164916],
      ["2026-08-01", "Furniture", 105606],
      ["2026-08-01", "Home", 31444],
    ],
  };

  it("adds per-group changes between the first and last period", () => {
    const facts = autoAnalyze(byCategory);
    expect(facts.operation).toBe("trend");
    expect(facts.by_group).toEqual([
      expect.objectContaining({ category: "Furniture", change: 15606 }),
      expect.objectContaining({ category: "Electronics", change: 14916 }),
      expect.objectContaining({ category: "Home", change: 2659 }),
    ]);
    const answer =
      "Furniture (+$15,606) and Electronics (+$14,916) drove most of the increase; Home added $2,659.";
    expect(checkGrounding(answer, [byCategory.rows, facts]).grounded).toBe(
      true,
    );
  });

  it("accepts numbers that come from the executed SQL (e.g. bucket sizes)", () => {
    const sql =
      "SELECT width_bucket(revenue, 0, 5000, 10) AS bucket, count(*) FROM dataset GROUP BY 1";
    expect(
      checkGrounding("Orders are grouped into 10 buckets from $0 to $5,000.", [
        [[1, 874]],
        sql,
      ]).grounded,
    ).toBe(true);
    expect(
      checkGrounding("Orders are grouped into $750 buckets.", [[[1, 874]], sql])
        .grounded,
    ).toBe(false);
  });
});

describe("fallback text for a raw numeric column", () => {
  it("describes the distribution from computed statistics", () => {
    const result: TabularResult = {
      columns: [{ name: "revenue", kind: "number" }],
      rows: [[10], [20], [30], [40], [1000]],
    };
    const facts = autoAnalyze(result);
    const text = describeFacts(facts, "$");
    expect(text).toBe(
      "Revenue ranges from $10 to $1,000, with a median of $30 and an average of $220 across 5 rows.",
    );
    expect(checkGrounding(text, [result.rows, facts]).grounded).toBe(true);
  });
});
