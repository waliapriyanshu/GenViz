import {
  InvalidToolInputError,
  NoSuchToolError,
  generateText,
  hasToolCall,
  isStepCount,
} from "ai";
import { describeFacts } from "@/lib/agent/describe";
import { checkGrounding } from "@/lib/agent/grounding";
import {
  type AgentState,
  type FinalAnswer,
  type QueryAudit,
  type StoredResult,
  createAgentState,
  createTools,
  finalAnswerSchema,
} from "@/lib/agent/tools";
import {
  type ProviderFailure,
  classifyProviderError,
  shouldFallback,
} from "@/lib/ai/model";
import {
  type HistoryTurn,
  buildInstructions,
  formatHistory,
} from "@/lib/ai/prompts";
import type { ModelCandidate } from "@/lib/ai/provider";
import type { Facts } from "@/lib/analysis/analyze";
import type { DataSourceRuntime } from "@/lib/data/sources";
import { stripEmDashes } from "@/lib/text";
import {
  buildTable,
  buildVisualization,
  sanitizeVisualization,
} from "@/lib/viz/build";
import type { AssistantPayload, ProgressStage } from "@/lib/viz/types";

export interface OrchestratorInput {
  question: string;
  source: DataSourceRuntime;
  history: HistoryTurn[];
  models: ModelCandidate[];
  emit?: (stage: ProgressStage) => void;
  audit?: (entry: QueryAudit) => void;
  abortSignal?: AbortSignal;
  now?: Date;
  /** CSV currency symbol, when the whole dataset uses one */
  currency?: string;
}

export interface FollowUpContext {
  sql: string[];
  columns: string[];
  rowCount: number;
}

export type OrchestratorOutcome =
  | {
      kind: "answer";
      payload: AssistantPayload;
      followUp?: FollowUpContext;
      model: string;
    }
  | { kind: "provider_error"; failure: ProviderFailure };

const MAX_STEPS = 8;

export async function runAnalysis(
  input: OrchestratorInput,
): Promise<OrchestratorOutcome> {
  const emit = input.emit ?? (() => undefined);
  const state = createAgentState();
  const tools = createTools({
    source: input.source,
    state,
    emit,
    audit: input.audit,
  });
  const instructions = buildInstructions(
    {
      kind: input.source.kind,
      label: input.source.label,
      schemaOverview: input.source.schemaOverview(),
    },
    input.now,
  );
  const messages = [
    ...formatHistory(input.history),
    { role: "user" as const, content: input.question },
  ];

  emit("understanding");
  let lastFailure: ProviderFailure = { kind: "unknown" };
  const describeFailure = (error: unknown): ProviderFailure => {
    if (
      NoSuchToolError.isInstance(error) ||
      InvalidToolInputError.isInstance(error)
    ) {
      console.warn(
        "[genviz] model produced an invalid tool call:",
        error.message,
      );
      return { kind: "bad_request", message: error.message };
    }
    const failure = classifyProviderError(error);
    console.warn(
      "[genviz] model call failed:",
      failure.kind,
      error instanceof Error ? error.message : error,
    );
    return failure;
  };
  const nothingFetched = () =>
    state.results.size === 0 && !state.final && !state.fatal;

  for (let i = 0; i < input.models.length; i++) {
    const candidate = input.models[i]!;
    // Up to two tool-using attempts: Groq sometimes rejects a malformed tool call with a 400
    // ("Failed to parse tool call arguments as JSON"), which usually succeeds when re-asked.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const generation = await generateText({
          model: candidate.model,
          instructions,
          messages,
          tools,
          // The first step must use a tool (look at the data before answering). Afterwards the
          // model may reply in plain text: gpt-oss often does, and a forced tool call would
          // make Groq reject the request ("Tool choice is required, but model did not call a tool").
          toolChoice: "required",
          prepareStep: ({ stepNumber }) =>
            stepNumber > 0 ? { toolChoice: "auto" } : undefined,
          stopWhen: [hasToolCall("final_answer"), isStepCount(MAX_STEPS)],
          maxRetries: 1,
          providerOptions: candidate.providerOptions,
          abortSignal: input.abortSignal,
        });
        return assemble(state, input, candidate.modelId, generation.text);
      } catch (error) {
        lastFailure = describeFailure(error);
        const retryable =
          lastFailure.kind === "bad_request" &&
          nothingFetched() &&
          !/did not call a tool/i.test(lastFailure.message);
        if (!retryable) break;
      }
    }
    // The model wants to reply without tools (e.g. "delete rows", "what's the weather") or
    // keeps producing unusable tool calls: ask once more with no tools. The text is still
    // checked against the schema before it is shown, so it cannot invent figures.
    if (lastFailure.kind === "bad_request" && nothingFetched()) {
      try {
        const plain = await generateText({
          model: candidate.model,
          instructions,
          messages,
          maxRetries: 1,
          providerOptions: candidate.providerOptions,
          abortSignal: input.abortSignal,
        });
        state.steps.push("Answered without querying (not a data question)");
        return assemble(state, input, candidate.modelId, plain.text);
      } catch (retryError) {
        lastFailure = describeFailure(retryError);
      }
    }
    // Data already fetched is still valid: answer deterministically instead of failing.
    if (state.results.size > 0 || state.fatal)
      return assemble(state, input, candidate.modelId);
    const hasNext = i < input.models.length - 1;
    if (!hasNext || !shouldFallback(lastFailure)) break;
  }
  if (lastFailure.kind === "bad_request") {
    return assemble(state, input, input.models[0]?.modelId ?? "unknown");
  }
  return { kind: "provider_error", failure: lastFailure };
}

/**
 * Recovers a final_answer that the model emitted as text (plain JSON, a ```json fence,
 * or a {"name": "final_answer", "arguments": {...}} wrapper). Validated with the same schema.
 */
export function parseTextualFinalAnswer(
  text: string | undefined,
): FinalAnswer | undefined {
  if (!text) return undefined;
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  if (!trimmed.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const candidate =
    (record.arguments as Record<string, unknown> | undefined) ??
    (record.parameters as Record<string, unknown> | undefined) ??
    record;
  const result = finalAnswerSchema.safeParse({
    status: "answered",
    ...candidate,
  });
  return result.success ? result.data : undefined;
}

/** Tool-style lines the model sometimes echoes into the answer ("Chart: ...", "Result ID: r1, x = ..."). */
const INTERNAL_LINE = /^\s*(chart|result[ _]?id|visualization)\s*[:=]/i;

/** Plain-text answer for the chat bubble: drops markdown tables/formatting (the UI shows the table). */
export function cleanModelText(text: string | undefined): string {
  if (!text) return "";
  const plain = text
    .split("\n")
    .filter(
      (line) =>
        !/^\s*\|.*\|\s*$/.test(line) &&
        !/^\s*\|?\s*:?-{3,}/.test(line) &&
        !INTERNAL_LINE.test(line),
    )
    .join("\n")
    .replace(/(\d) %/g, "$1%")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 1500);
  return stripEmDashes(plain);
}

function currencyFor(input: OrchestratorInput): string | undefined {
  return input.currency ?? input.source.currency;
}

function assemble(
  state: AgentState,
  input: OrchestratorInput,
  model: string,
  modelText?: string,
): OrchestratorOutcome {
  // gpt-oss sometimes writes the final_answer call as JSON text instead of calling the tool.
  const textual = state.final ? undefined : parseTextualFinalAnswer(modelText);
  if (textual) state.final = textual;
  const final = state.final
    ? {
        ...state.final,
        answer: cleanModelText(state.final.answer),
        suggestions: state.final.suggestions?.map(stripEmDashes),
        chart: state.final.chart?.title
          ? {
              ...state.final.chart,
              title: stripEmDashes(state.final.chart.title),
            }
          : state.final.chart,
      }
    : undefined;
  const text = textual ? "" : cleanModelText(modelText);
  const queries = [...state.results.values()].map((r) => r.sql);
  const executionTimeMs = [...state.results.values()].reduce(
    (acc, r) => acc + r.result.executionTimeMs,
    0,
  );
  const baseMetadata = {
    source: input.source.label,
    sourceKind: input.source.kind,
    executionTimeMs,
    queries,
    steps: state.steps,
    model,
  };

  if (state.fatal === "database_unavailable") {
    return {
      kind: "answer",
      model,
      payload: {
        status: "error",
        answer:
          "Your database connection is currently unavailable. Please reconnect and try again.",
        metadata: { ...baseMetadata, rowCount: 0 },
      },
    };
  }

  const chosenId =
    final?.result_id && state.results.has(final.result_id)
      ? final.result_id
      : state.lastResultId;
  const stored: StoredResult | undefined = chosenId
    ? state.results.get(chosenId)
    : undefined;
  const hints = input.source.topicHints();
  const tryAsking = hints.length
    ? `\n\nTry asking about: ${hints.join(", ")}.`
    : "";

  if (!stored) {
    if (final && final.status !== "answered") {
      // Unsupported / clarification: text only, checked against the schema so it can't invent figures.
      const grounded = checkGrounding(final.answer, [
        input.source.schemaOverview(),
      ]).grounded;
      return {
        kind: "answer",
        model,
        payload: {
          status: final.status,
          answer: grounded
            ? final.answer
            : "I can't answer that from this data yet.",
          suggestions: final.suggestions,
          metadata: { ...baseMetadata, rowCount: 0 },
        },
      };
    }
    const schemaAnswer =
      final?.status === "answered" ? final.answer : !final ? text : "";
    if (schemaAnswer && state.failures.length === 0) {
      // Answered from the schema alone (e.g. "what data is in here?").
      const grounded = checkGrounding(schemaAnswer, [
        input.source.schemaOverview(),
        input.source.schemaDetail(),
      ]).grounded;
      return {
        kind: "answer",
        model,
        payload: {
          status: grounded ? "answered" : "unsupported",
          answer: grounded
            ? schemaAnswer
            : `I can't answer that from this data yet.${tryAsking}`,
          suggestions: final?.suggestions,
          metadata: { ...baseMetadata, rowCount: 0 },
        },
      };
    }
    const queryFailed = state.failures.length > 0;
    return {
      kind: "answer",
      model,
      payload: {
        status: queryFailed ? "error" : "unsupported",
        answer: queryFailed
          ? `I couldn't answer that from the available data. The query could not be executed safely.${tryAsking}`
          : `I can't answer that from this data yet. Try asking something related to your data.${tryAsking}`,
        suggestions: final?.suggestions,
        metadata: { ...baseMetadata, rowCount: 0 },
      },
    };
  }

  const result = stored.result;
  const followUp: FollowUpContext = {
    sql: [stored.sql],
    columns: result.columns.map((c) => c.name),
    rowCount: result.rowCount,
  };
  const metadata = { ...baseMetadata, rowCount: result.rowCount };
  const table = buildTable(result);

  if (result.rowCount === 0) {
    return {
      kind: "answer",
      model,
      followUp,
      payload: {
        status: "no_data",
        answer: "I couldn't find any records matching that question.",
        table,
        metadata,
        suggestions: final?.suggestions,
      },
    };
  }

  const currency = currencyFor(input);
  const hint = {
    ...(final?.chart ?? {}),
    ...(state.vizPrefs.get(stored.id) ?? {}),
    ...(currency ? { currency } : {}),
  };
  const visualization = sanitizeVisualization(buildVisualization(result, hint));
  const allFacts: Facts[] = [stored.facts, ...state.extraFacts];

  let answer = final?.answer || text;
  if (answer) {
    const report = checkGrounding(answer, [
      result.rows,
      ...allFacts,
      ...queries,
    ]);
    if (!report.grounded) {
      console.warn(
        "[genviz] replaced ungrounded answer; numbers not found in results:",
        report.ungrounded,
      );
      state.steps.push(
        "Rewrote the summary from computed results (the model mentioned numbers not in the data)",
      );
      answer = describeFacts(stored.facts, currency);
    }
  } else {
    answer = describeFacts(stored.facts, currency);
  }
  if (!final && !text)
    state.steps.push(
      "Summarized the results directly (the AI model did not finish)",
    );
  state.steps.push(
    visualization.type === "table"
      ? "Showed the results as a table"
      : `Built a ${visualization.type === "kpi" ? "KPI card" : `${visualization.type} chart`} from the result`,
  );

  return {
    kind: "answer",
    model,
    followUp,
    payload: {
      status: final?.status === "no_data" ? "no_data" : "answered",
      answer,
      visualization,
      table,
      metadata,
      suggestions: final?.suggestions,
    },
  };
}
