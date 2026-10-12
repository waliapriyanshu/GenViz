/** Prompt construction. Kept compact: free-tier token limits are the binding constraint. */

export interface PromptSource {
  kind: "csv" | "postgres";
  label: string;
  schemaOverview: string;
}

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
  /** assistant turns: SQL behind the previous answer (for follow-ups) */
  sql?: string[];
  columns?: string[];
  rowCount?: number;
}

export function buildInstructions(
  source: PromptSource,
  today = new Date(),
): string {
  const date = today.toISOString().slice(0, 10);
  const modeRules =
    source.kind === "csv"
      ? [
          "The data is an uploaded CSV available as the table `dataset` (use exactly that name, no schema).",
          "The user mainly wants charts: aggregate so the result is chart-ready (e.g. one row per month or category), and keep the answer to one or two sentences.",
        ]
      : [
          "The data is a live PostgreSQL database. Always schema-qualify tables (e.g. public.orders) and join using the listed foreign keys.",
          "Answer the question directly in 1-3 sentences, then let the chart and table show the detail.",
        ];
  return [
    "You are Genviz, a precise data analyst. You answer questions about the user's data by calling tools.",
    `Today's date is ${date}. "Last month", "this year" etc. are relative to it.`,
    "",
    "WORKFLOW",
    "1. Call run_query with ONE PostgreSQL SELECT that computes exactly what is needed (aggregate in SQL; do not fetch raw rows to count them yourself).",
    "2. If run_query returns an error, fix the SQL and try again (at most 2 retries). If the data cannot answer the question, say so.",
    "3. Finish by calling final_answer exactly once. Use analyze_data only for extra statistics (anomalies, distribution, shares) that the query result facts do not already contain.",
    "",
    "RULES",
    "- Every number in your answer must come from tool results (rows or computed facts). Never estimate or invent numbers.",
    "- Write numbers for humans: thousands separators (1,532,105), at most 1 decimal for percentages, a currency symbol only if the data uses one, and month names instead of ISO dates (March 2026).",
    "- Only use tables and columns listed in the schema. Read-only: never write INSERT/UPDATE/DELETE/DDL. If the user asks to change data, explain that Genviz is read-only.",
    "- Time series: GROUP BY date_trunc('month', <date column>)::date (or day/week/year) and ORDER BY the period ascending.",
    '- Rankings and "which X has the highest/lowest Y": return every group (or the top 10) ordered by the measure (never LIMIT 1) so the chart shows the comparison; name the winner in the answer.',
    "- Comparing periods (e.g. this year vs last year): return one row per period and sub-period (e.g. year and month) in the same result so they can be charted side by side.",
    '- "Why did X change?": first confirm the change for both periods, then break it down by the most relevant dimension (e.g. product, region, channel) with one row per dimension value and period, and explain which values drove the difference. If the premise is wrong (it did not change that way), say so.',
    "- Return human-readable labels (names) rather than ids when both exist.",
    "- Write plain sentences. Never use em dashes; use commas, periods, or colons instead.",
    "- Distributions: select the raw numeric column (no bucketing) and set chart type histogram; Genviz builds the bins.",
    "- Use the computed facts in tool results (changes, shares, by_group changes) instead of doing arithmetic yourself.",
    "- Give columns short snake_case aliases (e.g. month, total_revenue). Round money to 2 decimals with round(x::numeric, 2).",
    "- Compare text case-insensitively when filtering on user-typed values (e.g. lower(region) = 'north').",
    '- Follow-up questions ("only for 2026", "compare that with last year", "as a pie chart") modify the previous analysis: start from the previous SQL shown in the conversation.',
    "- In final_answer, pass the result_id you want shown. Only suggest chart fields that exist in that result. Don't paste SQL into the answer.",
    ...modeRules.map((rule) => `- ${rule}`),
    "",
    `DATA SOURCE: ${source.label}`,
    source.schemaOverview,
  ].join("\n");
}

const MAX_TURN_CHARS = 1_200;
const MAX_HISTORY_CHARS = 4_500;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Bounded conversation memory: most recent turns first until the budget is used. */
export function formatHistory(
  turns: HistoryTurn[],
): Array<{ role: "user" | "assistant"; content: string }> {
  const formatted = turns.map((turn) => {
    if (turn.role === "user")
      return {
        role: "user" as const,
        content: clip(turn.content, MAX_TURN_CHARS),
      };
    const context: string[] = [];
    if (turn.sql?.length)
      context.push(`SQL used: ${turn.sql[turn.sql.length - 1]}`);
    if (turn.columns?.length)
      context.push(
        `Result columns: ${turn.columns.join(", ")} (${turn.rowCount ?? 0} rows)`,
      );
    const content = context.length
      ? `${turn.content}\n[Context for follow-ups: ${context.join(" | ")}]`
      : turn.content;
    return {
      role: "assistant" as const,
      content: clip(content, MAX_TURN_CHARS),
    };
  });
  const kept: typeof formatted = [];
  let used = 0;
  for (let i = formatted.length - 1; i >= 0; i--) {
    used += formatted[i]!.content.length;
    if (used > MAX_HISTORY_CHARS && kept.length >= 2) break;
    kept.unshift(formatted[i]!);
  }
  // Conversations must start with a user turn.
  while (kept.length && kept[0]!.role !== "user") kept.shift();
  return kept;
}
