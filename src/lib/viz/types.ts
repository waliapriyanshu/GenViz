/** Shared (client + server) result contract for one Genviz answer. */

export type VizType =
  | "line"
  | "area"
  | "bar"
  | "pie"
  | "scatter"
  | "histogram"
  | "kpi"
  | "table";

export interface KpiItem {
  label: string;
  value: number;
  unit?: "percent" | "currency";
}

export interface Visualization {
  type: VizType;
  title: string;
  /** Flat rows; every field referenced in `config` exists and every y value is a finite number. */
  data: Array<Record<string, string | number>>;
  config: {
    x?: string;
    y?: string[];
    series?: string;
    xLabel?: string;
    yLabel?: string;
    horizontal?: boolean;
    kpis?: KpiItem[];
    currency?: string;
  };
  notes: string[];
}

export interface ResultTable {
  columns: string[];
  rows: unknown[][];
  totalRows: number;
  truncated: boolean;
}

export interface AnswerMetadata {
  source: string;
  sourceKind: "csv" | "postgres";
  rowCount: number;
  executionTimeMs: number;
  queries: string[];
  steps: string[];
  model: string;
}

export interface AssistantPayload {
  status:
    | "answered"
    | "no_data"
    | "unsupported"
    | "needs_clarification"
    | "error";
  answer: string;
  visualization?: Visualization;
  table?: ResultTable;
  metadata?: AnswerMetadata;
  suggestions?: string[];
}

export type ProgressStage =
  | "understanding"
  | "inspecting"
  | "querying"
  | "analyzing"
  | "visualizing";

export type ChatStreamEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "stage"; stage: ProgressStage }
  | {
      type: "result";
      messageId: string;
      payload: AssistantPayload;
      nextQueryInSeconds: number;
    }
  | { type: "rate_limited"; retryAfterSeconds: number; message: string }
  | {
      type: "error";
      code: string;
      message: string;
      nextQueryInSeconds?: number;
    };
