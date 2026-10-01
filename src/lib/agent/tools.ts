import { tool } from "ai";
import { z } from "zod";
import {
  type AnalysisOperation,
  type Facts,
  analyzeResult,
  autoAnalyze,
} from "@/lib/analysis/analyze";
import { round } from "@/lib/analysis/shape";
import type { QueryResult } from "@/lib/data/executor";
import type { DataSourceRuntime } from "@/lib/data/sources";
import { type VizHint, buildVisualization } from "@/lib/viz/build";
import type { ProgressStage } from "@/lib/viz/types";

export interface StoredResult {
  id: string;
  sql: string;
  result: QueryResult;
  facts: Facts;
}

export interface QueryAudit {
  sql: string;
  status: "ok" | "rejected" | "error";
  rowCount?: number;
  durationMs?: number;
  error?: string;
}

export const VIZ_TYPES = [
  "auto",
  "line",
  "area",
  "bar",
  "pie",
  "scatter",
  "histogram",
  "kpi",
  "table",
] as const;

const chartSchema = z.object({
  type: z
    .enum(VIZ_TYPES)
    .optional()
    .describe(
      "Preferred chart; 'auto' lets Genviz decide from the result shape",
    ),
  x: z
    .string()
    .optional()
    .describe("Result column for the x axis / categories"),
  y: z
    .array(z.string())
    .max(6)
    .optional()
    .describe("Numeric result column(s) to plot"),
  series: z
    .string()
    .optional()
    .describe("Result column that splits the data into series (e.g. year)"),
  title: z.string().max(120).optional(),
});

export const finalAnswerSchema = z.object({
  status: z.enum(["answered", "no_data", "unsupported", "needs_clarification"]),
  answer: z
    .string()
    .min(1)
    .max(1500)
    .describe("1-3 sentences, grounded only in tool results"),
  result_id: z
    .string()
    .optional()
    .describe("The run_query result to visualize"),
  chart: chartSchema.optional(),
  suggestions: z
    .array(z.string().max(140))
    .max(4)
    .optional()
    .describe("Follow-up questions the data can answer"),
});

export type FinalAnswer = z.infer<typeof finalAnswerSchema>;

export interface AgentState {
  results: Map<string, StoredResult>;
  lastResultId?: string;
  extraFacts: Facts[];
  vizPrefs: Map<string, VizHint>;
  final?: FinalAnswer;
  failures: Array<{ code: string; message: string }>;
  fatal?: "database_unavailable";
  steps: string[];
  queryAttempts: number;
}

export function createAgentState(): AgentState {
  return {
    results: new Map(),
    extraFacts: [],
    vizPrefs: new Map(),
    failures: [],
    steps: [],
    queryAttempts: 0,
  };
}

const MAX_QUERY_ATTEMPTS = 5;
const PREVIEW_ROWS = 20;

function previewValue(value: unknown): unknown {
  if (typeof value === "number")
    return Number.isFinite(value) ? round(value, 4) : null;
  if (typeof value === "string")
    return value.length > 80 ? `${value.slice(0, 77)}…` : value;
  return value ?? null;
}

function capJson(value: unknown, maxChars = 12_000): unknown {
  const text = JSON.stringify(value);
  if (text.length <= maxChars) return value;
  return { truncated: true, preview: text.slice(0, maxChars) };
}

export interface ToolDeps {
  source: DataSourceRuntime;
  state: AgentState;
  emit: (stage: ProgressStage) => void;
  audit?: (entry: QueryAudit) => void;
}

export function createTools({ source, state, emit, audit }: ToolDeps) {
  return {
    get_schema: tool({
      description:
        "Get detailed schema (columns, types, keys, value profiles) for the data source or specific tables.",
      inputSchema: z.object({
        tables: z
          .array(z.string())
          .max(20)
          .optional()
          .describe("Table names; omit for the whole source"),
      }),
      execute: async ({ tables }) => {
        emit("inspecting");
        state.steps.push(
          tables?.length
            ? `Inspected the schema of ${tables.join(", ")}`
            : "Inspected the data schema",
        );
        return capJson(source.schemaDetail(tables));
      },
    }),

    profile_column: tool({
      description:
        "Profile one column: distinct values, most common values, min/max, empty values. Use it to learn exact category spellings before filtering.",
      inputSchema: z.object({
        table: z
          .string()
          .optional()
          .describe("Table name (omit for an uploaded CSV)"),
        column: z.string(),
      }),
      execute: async ({ table, column }) => {
        emit("inspecting");
        state.steps.push(`Profiled the column ${column}`);
        return capJson(await source.profileColumn(table, column));
      },
    }),

    run_query: tool({
      description:
        "Run ONE read-only PostgreSQL SELECT against the data source. Returns a result_id, columns, a row preview and computed facts.",
      inputSchema: z.object({
        sql: z.string().min(1).max(20_000),
        purpose: z
          .string()
          .max(200)
          .optional()
          .describe("Short description of what this query computes"),
      }),
      execute: async ({ sql, purpose }) => {
        state.queryAttempts++;
        if (state.queryAttempts > MAX_QUERY_ATTEMPTS) {
          return {
            error: "query_budget_exceeded",
            message:
              "Too many queries for one question. Call final_answer now.",
          };
        }
        emit("querying");
        const outcome = await source.run(sql);
        if (!outcome.ok) {
          state.failures.push({ code: outcome.code, message: outcome.message });
          audit?.({
            sql: outcome.sql,
            status: outcome.kind === "rejected" ? "rejected" : "error",
            error: `${outcome.code}: ${outcome.message}`,
          });
          if (outcome.kind === "failed" && outcome.code === "unavailable") {
            state.fatal = "database_unavailable";
            state.steps.push("The database could not be reached");
            return {
              error: "database_unavailable",
              message:
                "The database is unreachable. Call final_answer and tell the user.",
            };
          }
          state.steps.push(
            outcome.kind === "rejected"
              ? `A query was blocked by the safety check (${outcome.code})`
              : `A query failed (${outcome.code}) and was retried`,
          );
          return {
            error: outcome.code,
            message: outcome.message,
            hint:
              outcome.kind === "rejected"
                ? "Rewrite it as a single read-only SELECT on the listed tables."
                : "Fix the SQL (check column names/types) and try again.",
          };
        }
        emit("analyzing");
        const id = `r${state.results.size + 1}`;
        const facts = autoAnalyze(outcome.result);
        state.results.set(id, {
          id,
          sql: outcome.sql,
          result: outcome.result,
          facts,
        });
        state.lastResultId = id;
        audit?.({
          sql: outcome.sql,
          status: "ok",
          rowCount: outcome.result.rowCount,
          durationMs: outcome.result.executionTimeMs,
        });
        state.steps.push(
          `${purpose ? `${purpose.replace(/\.$/, "")}: ` : "Ran a query: "}${outcome.result.rowCount.toLocaleString()} row${outcome.result.rowCount === 1 ? "" : "s"}${outcome.result.truncated ? " (truncated)" : ""} in ${outcome.result.executionTimeMs} ms`,
        );
        return {
          result_id: id,
          row_count: outcome.result.rowCount,
          truncated: outcome.result.truncated,
          columns: outcome.result.columns.map((c) => ({
            name: c.name,
            type: c.kind,
          })),
          rows: outcome.result.rows
            .slice(0, PREVIEW_ROWS)
            .map((row) => row.map(previewValue)),
          ...(outcome.result.rowCount > PREVIEW_ROWS
            ? {
                rows_note: `Showing ${PREVIEW_ROWS} of ${outcome.result.rowCount} rows`,
              }
            : {}),
          facts,
        };
      },
    }),

    analyze_data: tool({
      description:
        "Compute statistics on a query result deterministically (trend change, top/bottom with shares, comparisons, distribution, anomalies).",
      inputSchema: z.object({
        result_id: z.string(),
        operation: z.enum([
          "summary",
          "trend",
          "top",
          "compare",
          "distribution",
          "anomalies",
        ]),
        measure: z.string().optional(),
        dimension: z.string().optional(),
        time: z.string().optional(),
      }),
      execute: async ({ result_id, operation, measure, dimension, time }) => {
        const stored = state.results.get(result_id);
        if (!stored)
          return {
            error: "unknown_result_id",
            available: [...state.results.keys()],
          };
        emit("analyzing");
        const facts = analyzeResult(
          stored.result,
          operation as AnalysisOperation,
          { measure, dimension, time },
        );
        state.extraFacts.push(facts);
        state.steps.push(`Computed ${operation} statistics`);
        return facts;
      },
    }),

    make_visualization: tool({
      description:
        "Choose how a result should be charted. Fields must be columns of that result; Genviz validates them against the data.",
      inputSchema: chartSchema.extend({ result_id: z.string() }),
      execute: async ({ result_id, ...hint }) => {
        const stored = state.results.get(result_id);
        if (!stored)
          return {
            error: "unknown_result_id",
            available: [...state.results.keys()],
          };
        emit("visualizing");
        const viz = buildVisualization(stored.result, hint as VizHint);
        const unknown = viz.notes.filter((note) =>
          note.startsWith("Ignored unknown column"),
        );
        if (unknown.length) {
          return {
            ok: false,
            message: unknown.join(" "),
            available_columns: stored.result.columns.map((c) => c.name),
          };
        }
        state.vizPrefs.set(result_id, hint as VizHint);
        return {
          ok: true,
          chart: viz.type,
          x: viz.config.x,
          y: viz.config.y,
          series: viz.config.series,
          notes: viz.notes,
        };
      },
    }),

    final_answer: tool({
      description:
        "Deliver the final answer to the user. Call exactly once, last.",
      inputSchema: finalAnswerSchema,
      execute: async (input) => {
        state.final = input;
        return { ok: true };
      },
    }),
  };
}
