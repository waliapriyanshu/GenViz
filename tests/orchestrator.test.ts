import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  cleanModelText,
  parseTextualFinalAnswer,
  runAnalysis,
} from "@/lib/agent/orchestrator";
import type { QueryAudit } from "@/lib/agent/tools";
import type { ModelCandidate } from "@/lib/ai/provider";
import type { QueryResult } from "@/lib/data/executor";
import type { DataSourceRuntime, RunOutcome } from "@/lib/data/sources";
import { guardSql } from "@/lib/data/sql-guard";
import type { ProgressStage } from "@/lib/viz/types";

// ---------- fakes ----------

const usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

let callCounter = 0;
function toolCall(toolName: string, input: unknown) {
  return {
    content: [
      {
        type: "tool-call" as const,
        toolCallId: `call-${++callCounter}`,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: "tool-calls" as const, raw: undefined },
    usage,
    warnings: [],
  };
}

function textReply(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage,
    warnings: [],
  };
}

type Step = ReturnType<typeof toolCall> | ReturnType<typeof textReply> | Error;

function scriptedModel(steps: Step[]) {
  let i = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      const step = steps[Math.min(i++, steps.length - 1)]!;
      if (step instanceof Error) throw step;
      return step;
    },
  });
  return model;
}

function candidate(
  model: MockLanguageModelV4,
  modelId = "mock-model",
): ModelCandidate {
  return { provider: "mock", modelId, model, providerOptions: {} };
}

const monthly: QueryResult = {
  columns: [
    { name: "month", kind: "date" },
    { name: "total_revenue", kind: "number" },
  ],
  rows: [
    ["2026-01-01", 100],
    ["2026-02-01", 120],
    ["2026-03-01", 150],
  ],
  rowCount: 3,
  truncated: false,
  executionTimeMs: 4,
};

function fakeSource(
  overrides: Partial<DataSourceRuntime> = {},
): DataSourceRuntime & { ran: string[] } {
  const ran: string[] = [];
  const allowed = [{ schema: null, name: "dataset" }];
  return {
    id: "src-1",
    kind: "csv",
    name: "sales",
    label: "Uploaded CSV: sales.csv",
    allowed,
    ran,
    schemaOverview: () =>
      'Table: dataset (3 rows)\nColumns:\n- order_date: date\n- revenue: number; measure\n- region: text; values: "North", "South"',
    schemaDetail: () => ({
      table: "dataset",
      columns: ["order_date", "revenue", "region"],
    }),
    topicHints: () => ["revenue", "region"],
    profileColumn: async () => ({ topValues: ["North", "South"] }),
    async run(sql: string): Promise<RunOutcome> {
      const guarded = await guardSql(sql, allowed);
      if (!guarded.ok)
        return {
          ok: false,
          kind: "rejected",
          code: guarded.code,
          message: guarded.message,
          sql,
        };
      ran.push(guarded.sql);
      if (/1\s*=\s*0/.test(sql))
        return {
          ok: true,
          sql: guarded.sql,
          result: { ...monthly, rows: [], rowCount: 0 },
        };
      return { ok: true, sql: guarded.sql, result: monthly };
    },
    ...overrides,
  };
}

const GOOD_SQL =
  "SELECT date_trunc('month', order_date)::date AS month, sum(revenue) AS total_revenue FROM dataset GROUP BY 1 ORDER BY 1";

async function run(
  steps: Step[],
  opts: {
    source?: DataSourceRuntime;
    history?: Parameters<typeof runAnalysis>[0]["history"];
    models?: ModelCandidate[];
  } = {},
) {
  const model = scriptedModel(steps);
  const stages: ProgressStage[] = [];
  const audits: QueryAudit[] = [];
  const outcome = await runAnalysis({
    question: "Show revenue by month",
    source: opts.source ?? fakeSource(),
    history: opts.history ?? [],
    models: opts.models ?? [candidate(model)],
    emit: (s) => stages.push(s),
    audit: (a) => audits.push(a),
    now: new Date("2026-09-25T00:00:00Z"),
  });
  return { outcome, stages, audits, model };
}

// ---------- tests ----------

describe("orchestrator — happy path", () => {
  it("queries, analyzes, visualizes and answers from real results", async () => {
    const { outcome, stages, audits, model } = await run([
      toolCall("run_query", { sql: GOOD_SQL, purpose: "Monthly revenue" }),
      toolCall("final_answer", {
        status: "answered",
        answer: "Revenue grew 50% from 100 in January to 150 in March.",
        result_id: "r1",
      }),
    ]);
    expect(outcome.kind).toBe("answer");
    if (outcome.kind !== "answer") return;
    expect(outcome.payload.status).toBe("answered");
    expect(outcome.payload.answer).toBe(
      "Revenue grew 50% from 100 in January to 150 in March.",
    );
    expect(outcome.payload.visualization?.type).toBe("line");
    expect(outcome.payload.table?.rows).toHaveLength(3);
    expect(outcome.payload.metadata).toMatchObject({
      source: "Uploaded CSV: sales.csv",
      rowCount: 3,
      queries: [GOOD_SQL],
    });
    expect(outcome.followUp?.sql).toEqual([GOOD_SQL]);
    expect(stages).toEqual(
      expect.arrayContaining(["understanding", "querying", "analyzing"]),
    );
    expect(audits).toEqual([
      expect.objectContaining({ status: "ok", rowCount: 3 }),
    ]);
    expect(model.doGenerateCalls).toHaveLength(2);
    // tools are required on every step (the model can't answer without them)
    expect(model.doGenerateCalls[0]!.toolChoice).toEqual({ type: "required" });
  });
});

describe("orchestrator — safety and repair", () => {
  it("blocks unsafe SQL from the model and lets it repair the query", async () => {
    const { outcome, audits } = await run([
      toolCall("run_query", { sql: "DELETE FROM dataset" }),
      toolCall("run_query", { sql: "SELECT 1; DROP TABLE dataset" }),
      toolCall("run_query", { sql: GOOD_SQL }),
      toolCall("final_answer", {
        status: "answered",
        answer: "Revenue went from 100 to 150.",
        result_id: "r1",
      }),
    ]);
    expect(audits.map((a) => a.status)).toEqual(["rejected", "rejected", "ok"]);
    expect(audits[0]!.error).toMatch(/not_select/);
    expect(audits[1]!.error).toMatch(/multiple_statements/);
    expect(outcome.kind === "answer" && outcome.payload.status).toBe(
      "answered",
    );
    if (outcome.kind === "answer")
      expect(outcome.payload.metadata?.steps.join(" ")).toMatch(
        /blocked by the safety check/,
      );
  });

  it("gives up gracefully when the model never produces safe SQL", async () => {
    const { outcome } = await run([
      toolCall("run_query", { sql: "UPDATE dataset SET revenue = 0" }),
      toolCall("final_answer", { status: "answered", answer: "Done." }),
    ]);
    expect(outcome.kind).toBe("answer");
    if (outcome.kind !== "answer") return;
    expect(outcome.payload.status).toBe("error");
    expect(outcome.payload.answer).toMatch(
      /couldn't answer that from the available data/,
    );
    expect(outcome.payload.answer).toMatch(/Try asking about: revenue, region/);
  });

  it("replaces an answer containing invented numbers with a grounded summary", async () => {
    const { outcome } = await run([
      toolCall("run_query", { sql: GOOD_SQL }),
      toolCall("final_answer", {
        status: "answered",
        answer: "Revenue exploded by 312% to $98,765.",
        result_id: "r1",
      }),
    ]);
    if (outcome.kind !== "answer") throw new Error("expected answer");
    expect(outcome.payload.answer).not.toMatch(/98,765|312/);
    expect(outcome.payload.answer).toMatch(
      /went from 100 in January 2026 to 150 in March 2026 \(\+50%\)/,
    );
  });

  it("ignores hallucinated chart columns from the model", async () => {
    const { outcome } = await run([
      toolCall("run_query", { sql: GOOD_SQL }),
      toolCall("final_answer", {
        status: "answered",
        answer: "Here is the trend.",
        result_id: "r1",
        chart: { type: "bar", x: "country", y: ["profit"] },
      }),
    ]);
    if (outcome.kind !== "answer") throw new Error("expected answer");
    const viz = outcome.payload.visualization!;
    expect(viz.config.x).toBe("month");
    expect(viz.config.y).toEqual(["total_revenue"]);
    expect(viz.notes.join(" ")).toMatch(/Ignored unknown column "country"/);
  });

  it("recovers from a malformed tool call", async () => {
    const { outcome } = await run([
      toolCall("run_query", { sql: GOOD_SQL }),
      toolCall("final_answer", { answer: 42 }),
      toolCall("final_answer", {
        status: "answered",
        answer: "Revenue rose to 150.",
        result_id: "r1",
      }),
    ]);
    if (outcome.kind !== "answer") throw new Error("expected answer");
    expect(outcome.payload.status).toBe("answered");
    expect(outcome.payload.visualization?.type).toBe("line");
  });

  it("only forces a tool call on the first step (gpt-oss may then answer in text)", async () => {
    const { model } = await run([
      toolCall("run_query", { sql: GOOD_SQL }),
      textReply("Revenue rose from 100 to 150."),
    ]);
    expect(model.doGenerateCalls[0]!.toolChoice).toEqual({ type: "required" });
    expect(model.doGenerateCalls[1]!.toolChoice).toEqual({ type: "auto" });
  });

  it("uses a grounded plain-text reply as the answer (markdown stripped)", async () => {
    const { outcome } = await run([
      toolCall("run_query", { sql: GOOD_SQL }),
      textReply(
        "**Revenue rose 50%**, from 100 in January to 150 in March.\n\n| month | revenue |\n|---|---|\n| Jan | 100 |",
      ),
    ]);
    if (outcome.kind !== "answer") throw new Error("expected answer");
    expect(outcome.payload.answer).toBe(
      "Revenue rose 50%, from 100 in January to 150 in March.",
    );
    expect(outcome.payload.visualization?.type).toBe("line");
  });

  it("recovers a final_answer the model wrote as JSON text (gpt-oss quirk)", async () => {
    const json = JSON.stringify({
      answer: "Monthly revenue grew from $100 in January to $150 in March.",
      chart: { type: "bar", x: "month", y: ["total_revenue"] },
      result_id: "r1",
      status: "answered",
    });
    for (const text of [
      json,
      "```json\n" + json + "\n```",
      JSON.stringify({ name: "final_answer", arguments: JSON.parse(json) }),
    ]) {
      const { outcome } = await run([
        toolCall("run_query", { sql: GOOD_SQL }),
        textReply(text),
      ]);
      if (outcome.kind !== "answer") throw new Error("expected answer");
      expect(outcome.payload.answer).toBe(
        "Monthly revenue grew from $100 in January to $150 in March.",
      );
      expect(outcome.payload.visualization?.type).toBe("bar");
    }
  });

  it("replaces a plain-text reply that invents numbers", async () => {
    const { outcome } = await run([
      toolCall("run_query", { sql: GOOD_SQL }),
      textReply("Revenue hit 4,321 in March."),
    ]);
    if (outcome.kind !== "answer") throw new Error("expected answer");
    expect(outcome.payload.answer).toMatch(/went from 100/);
  });

  it("still answers (deterministically) if the model stops without any answer", async () => {
    const { outcome } = await run([
      toolCall("run_query", { sql: GOOD_SQL }),
      textReply(""),
    ]);
    if (outcome.kind !== "answer") throw new Error("expected answer");
    expect(outcome.payload.answer).toMatch(/went from 100/);
    expect(outcome.payload.metadata?.steps.join(" ")).toMatch(/did not finish/);
  });
});

describe("orchestrator — empty / unsupported / unavailable", () => {
  it("reports empty results clearly", async () => {
    const { outcome } = await run([
      toolCall("run_query", {
        sql: `${GOOD_SQL.replace("GROUP BY", "WHERE 1=0 GROUP BY")}`,
      }),
      toolCall("final_answer", {
        status: "no_data",
        answer: "No rows.",
        result_id: "r1",
      }),
    ]);
    if (outcome.kind !== "answer") throw new Error("expected answer");
    expect(outcome.payload.status).toBe("no_data");
    expect(outcome.payload.answer).toBe(
      "I couldn't find any records matching that question.",
    );
    expect(outcome.payload.visualization).toBeUndefined();
  });

  it("passes through an unsupported answer (no invented data)", async () => {
    const { outcome } = await run([
      toolCall("final_answer", {
        status: "unsupported",
        answer: "This dataset has no customer satisfaction data.",
        suggestions: ["Show revenue by region"],
      }),
    ]);
    if (outcome.kind !== "answer") throw new Error("expected answer");
    expect(outcome.payload.status).toBe("unsupported");
    expect(outcome.payload.suggestions).toEqual(["Show revenue by region"]);
  });

  it("maps a database outage to a reconnect message", async () => {
    const source = fakeSource({
      run: async (sql) => ({
        ok: false,
        kind: "failed",
        code: "unavailable",
        message: "The database is unavailable.",
        sql,
      }),
    });
    const { outcome } = await run(
      [
        toolCall("run_query", { sql: GOOD_SQL }),
        toolCall("final_answer", { status: "answered", answer: "Sorry." }),
      ],
      { source },
    );
    if (outcome.kind !== "answer") throw new Error("expected answer");
    expect(outcome.payload.status).toBe("error");
    expect(outcome.payload.answer).toBe(
      "Your database connection is currently unavailable. Please reconnect and try again.",
    );
  });
});

describe("orchestrator — provider errors", () => {
  const apiError = (status: number, headers: Record<string, string> = {}) =>
    new APICallError({
      message: `status ${status}`,
      url: "https://api.groq.com/openai/v1/chat/completions",
      requestBodyValues: {},
      statusCode: status,
      responseHeaders: headers,
      isRetryable: false,
    });

  it("returns rate_limited with the provider's Retry-After", async () => {
    const { outcome } = await run([apiError(429, { "retry-after": "37" })]);
    expect(outcome).toEqual({
      kind: "provider_error",
      failure: { kind: "rate_limited", retryAfterSeconds: 37 },
    });
  });

  it("falls back to the next model on an outage", async () => {
    const broken = scriptedModel([apiError(503)]);
    const healthy = scriptedModel([
      toolCall("run_query", { sql: GOOD_SQL }),
      toolCall("final_answer", {
        status: "answered",
        answer: "Revenue reached 150.",
        result_id: "r1",
      }),
    ]);
    const { outcome } = await run([], {
      models: [candidate(broken, "primary"), candidate(healthy, "fallback")],
    });
    if (outcome.kind !== "answer") throw new Error("expected answer");
    expect(outcome.model).toBe("fallback");
    expect(outcome.payload.metadata?.model).toBe("fallback");
  });

  it("re-asks without tools when the model declines to call one (non-data questions)", async () => {
    const declined = new APICallError({
      message: "Tool choice is required, but model did not call a tool",
      url: "https://api.groq.com/openai/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 400,
      responseHeaders: {},
      isRetryable: false,
    });
    const { outcome, model } = await run([
      declined,
      textReply(
        "Genviz is read-only, so I can't delete data — but I can analyze it.",
      ),
    ]);
    if (outcome.kind !== "answer") throw new Error("expected answer");
    // em dashes from the model are converted to natural punctuation
    expect(outcome.payload.answer).toBe(
      "Genviz is read-only, so I can't delete data, but I can analyze it.",
    );
    expect(outcome.payload.metadata?.steps.join(" ")).toMatch(
      /without querying/,
    );
    expect(model.doGenerateCalls[1]!.tools ?? []).toHaveLength(0);
  });

  it("re-asks once when Groq rejects a malformed tool call, then answers normally", async () => {
    const malformed = new APICallError({
      message: "Failed to parse tool call arguments as JSON",
      url: "https://api.groq.com/openai/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 400,
      responseHeaders: {},
      isRetryable: false,
    });
    const { outcome } = await run([
      malformed,
      toolCall("run_query", { sql: GOOD_SQL }),
      toolCall("final_answer", {
        status: "answered",
        answer: "Revenue reached 150.",
        result_id: "r1",
      }),
    ]);
    if (outcome.kind !== "answer") throw new Error("expected answer");
    expect(outcome.payload.status).toBe("answered");
    expect(outcome.payload.answer).toBe("Revenue reached 150.");
  });

  it("does not fall back on auth errors", async () => {
    const { outcome } = await run([apiError(401)]);
    expect(outcome).toEqual({
      kind: "provider_error",
      failure: { kind: "auth" },
    });
  });

  it("answers from already-fetched data if the provider fails mid-conversation", async () => {
    const { outcome } = await run([
      toolCall("run_query", { sql: GOOD_SQL }),
      apiError(429, { "retry-after": "10" }),
    ]);
    if (outcome.kind !== "answer") throw new Error("expected answer");
    expect(outcome.payload.status).toBe("answered");
    expect(outcome.payload.visualization?.type).toBe("line");
  });
});

describe("orchestrator — conversation memory", () => {
  it("sends bounded history including the previous SQL for follow-ups", async () => {
    const history = [
      { role: "user" as const, content: "Show revenue by month" },
      {
        role: "assistant" as const,
        content: "Revenue went from 100 to 150.",
        sql: [GOOD_SQL],
        columns: ["month", "total_revenue"],
        rowCount: 3,
      },
      { role: "user" as const, content: "x".repeat(5_000) },
      {
        role: "assistant" as const,
        content: "Filtered.",
        sql: ["SELECT 1 FROM dataset"],
        columns: ["a"],
        rowCount: 1,
      },
    ];
    const { model } = await run(
      [
        toolCall("run_query", { sql: GOOD_SQL }),
        toolCall("final_answer", {
          status: "answered",
          answer: "Only 2026: 150.",
          result_id: "r1",
        }),
      ],
      { history },
    );
    const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    expect(prompt).toContain("SQL used: SELECT 1 FROM dataset");
    expect(prompt).toContain("Show revenue by month");
    expect(prompt).not.toContain("x".repeat(1_300)); // long turns are clipped
    expect(prompt).toContain("Today's date is 2026-09-25");
  });
});

describe("cleanModelText", () => {
  it("drops tool-style lines the model echoes into the answer", () => {
    const raw = [
      "The West region generated the highest revenue, totaling $395,041.",
      "",
      "Chart: bar chart showing total revenue by region.",
      "",
      "Result ID: r1, x = region, y = total_revenue.",
    ].join("\n");
    expect(cleanModelText(raw)).toBe(
      "The West region generated the highest revenue, totaling $395,041.",
    );
  });

  it("keeps ordinary sentences that merely mention a chart", () => {
    expect(cleanModelText("The chart below shows West leading.")).toBe(
      "The chart below shows West leading.",
    );
  });

  it("tightens a space before a percent sign", () => {
    expect(cleanModelText("About 25.8 % of overall sales.")).toBe(
      "About 25.8% of overall sales.",
    );
  });

  it("replaces em dashes with natural punctuation", () => {
    expect(cleanModelText("West leads — followed by South.")).toBe(
      "West leads, followed by South.",
    );
  });
});

describe("model text that mixes a summary with a JSON final answer", () => {
  // Shapes captured from real gpt-oss responses.
  const summary =
    "Retail generated the highest revenue at $525,836.40 (34.3\u202f% of total).  ";
  const jsonWithoutAnswer = `{
  "result_id": "r1",
  "chart": { "type": "bar", "x": "month", "y": ["total_revenue"], "title": "Revenue by Month" },
  "status": "answered"
}`;

  it("strips bold tool-style labels and the trailing JSON from the answer", () => {
    const raw = `${summary}\n\n**Chart:** a histogram of the \`revenue\` column.  \n\n${jsonWithoutAnswer}`;
    expect(cleanModelText(raw)).toBe(
      "Retail generated the highest revenue at $525,836.40 (34.3% of total).",
    );
  });

  it("handles a colon outside the bold label and list markers", () => {
    expect(
      cleanModelText(
        "Revenue rose.\n\n**Chart**: bar chart by month.\n- Result ID: r1",
      ),
    ).toBe("Revenue rose.");
  });

  it("normalizes narrow no-break spaces and non-breaking hyphens", () => {
    expect(cleanModelText("Spans $40.85\u2011$4,273.17 (12.5\u202f%)")).toBe(
      "Spans $40.85-$4,273.17 (12.5%)",
    );
  });

  it("uses the summary as the answer when the JSON has none", () => {
    const parsed = parseTextualFinalAnswer(
      `${summary}\n\n**Chart:** bar chart.\n\n${jsonWithoutAnswer}`,
    );
    expect(parsed?.answer).toContain("Retail generated the highest revenue");
    expect(parsed?.chart?.type).toBe("bar");
    expect(parsed?.result_id).toBe("r1");
  });

  it("prefers the JSON answer when present", () => {
    const parsed = parseTextualFinalAnswer(
      `A long summary.\n\n{"answer": "Short answer.", "status": "answered"}`,
    );
    expect(parsed?.answer).toBe("Short answer.");
  });

  it("still parses pure and fenced JSON", () => {
    expect(
      parseTextualFinalAnswer('{"answer": "Pure.", "status": "answered"}')
        ?.answer,
    ).toBe("Pure.");
    expect(
      parseTextualFinalAnswer('```json\n{"answer": "Fenced."}\n```')?.answer,
    ).toBe("Fenced.");
    expect(
      parseTextualFinalAnswer(
        '{"name": "final_answer", "arguments": {"answer": "Wrapped."}}',
      )?.answer,
    ).toBe("Wrapped.");
  });

  it("returns nothing for ordinary text", () => {
    expect(parseTextualFinalAnswer("Just a sentence.")).toBeUndefined();
    expect(parseTextualFinalAnswer("{not json")).toBeUndefined();
  });

  it("never shows the JSON to the user in a full run", async () => {
    const { outcome } = await run([
      toolCall("run_query", { sql: GOOD_SQL, purpose: "Monthly revenue" }),
      textReply(
        `Revenue grew from $100 to $150.  \n\n**Chart:** line chart by month.  \n\n${jsonWithoutAnswer}`,
      ),
    ]);
    if (outcome.kind !== "answer") throw new Error("expected answer");
    expect(outcome.payload.answer).toBe("Revenue grew from $100 to $150.");
    expect(outcome.payload.visualization?.type).toBe("bar");
    expect(outcome.payload.answer).not.toMatch(/[{}]|Chart|result_id/);
  });

  it("falls back to a computed summary when only JSON without an answer is returned", async () => {
    const { outcome } = await run([
      toolCall("run_query", { sql: GOOD_SQL, purpose: "Monthly revenue" }),
      textReply(jsonWithoutAnswer),
    ]);
    if (outcome.kind !== "answer") throw new Error("expected answer");
    expect(outcome.payload.answer.length).toBeGreaterThan(0);
    expect(outcome.payload.answer).not.toMatch(/[{}]|result_id/);
  });
});
