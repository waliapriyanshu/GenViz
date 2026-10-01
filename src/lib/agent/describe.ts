import type { Facts } from "@/lib/analysis/analyze";
import { humanize, isMoneyName } from "@/lib/viz/build";

/** Deterministic, always-grounded answer text built only from computed facts. */

export function formatValue(value: unknown, currency?: string): string {
  if (typeof value !== "number" || !Number.isFinite(value))
    return String(value);
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 1 ? 2 : 4;
  const formatted = value.toLocaleString("en-US", {
    maximumFractionDigits: digits,
  });
  return currency ? `${currency}${formatted}` : formatted;
}

type Named = { name: string; value: number; share_pct?: number | null };
type Point = { period: string; value: number };

export function describeFacts(facts: Facts, currency?: string): string {
  const moneyMeasure =
    typeof facts.measure === "string" && isMoneyName(facts.measure);
  const fmt = (v: unknown) =>
    formatValue(v, moneyMeasure ? currency : undefined);
  if (facts.rows === 1 && facts.values && typeof facts.values === "object") {
    const parts = Object.entries(facts.values as Record<string, unknown>)
      .slice(0, 4)
      .map(
        ([key, value]) =>
          `${humanize(key)}: ${formatValue(value, isMoneyName(key) ? currency : undefined)}`,
      );
    return `${parts.join(" · ")}.`;
  }
  if (facts.operation === "compare_periods" && facts.latest && facts.previous) {
    type Period = { period: string; total: number; sub_periods: number };
    const latest = facts.latest as Period;
    const previous = facts.previous as Period;
    const change =
      typeof facts.change_pct === "number"
        ? ` (${facts.change_pct > 0 ? "+" : ""}${facts.change_pct}%)`
        : "";
    const coverage = facts.uneven_coverage
      ? ` Note: ${latest.period} covers ${latest.sub_periods} periods vs ${previous.sub_periods} in ${previous.period}.`
      : "";
    return `${humanize(String(facts.measure))}: ${fmt(latest.total)} in ${latest.period} vs ${fmt(previous.total)} in ${previous.period}${change}.${coverage}`;
  }
  if (facts.operation === "trend" && facts.first && facts.last) {
    const first = facts.first as Point;
    const last = facts.last as Point;
    const peak = facts.peak as Point | undefined;
    const change =
      typeof facts.change_pct === "number"
        ? ` (${facts.change_pct > 0 ? "+" : ""}${facts.change_pct}%)`
        : "";
    const measure = humanize(String(facts.measure));
    const peakText = peak
      ? ` The highest value was ${fmt(peak.value)} in ${peak.period}.`
      : "";
    return `${measure} went from ${fmt(first.value)} in ${first.period} to ${fmt(last.value)} in ${last.period}${change}.${peakText}`;
  }
  if (
    (facts.operation === "top" || facts.operation === "compare") &&
    Array.isArray(facts.top) &&
    facts.top.length
  ) {
    const leader = facts.top[0] as Named;
    const share =
      typeof leader.share_pct === "number"
        ? `, ${leader.share_pct}% of the total`
        : "";
    return `${leader.name} has the highest ${humanize(String(facts.measure)).toLowerCase()} at ${fmt(leader.value)}${share}.`;
  }
  if (
    facts.operation === "summary" &&
    facts.measures &&
    typeof facts.measures === "object"
  ) {
    const entries = Object.entries(
      facts.measures as Record<string, Record<string, number> | null>,
    ).filter((entry): entry is [string, Record<string, number>] => !!entry[1]);
    if (entries.length === 1) {
      const [name, st] = entries[0]!;
      const f = (v: number) =>
        formatValue(v, isMoneyName(name) ? currency : undefined);
      return `${humanize(name)} ranges from ${f(st.min!)} to ${f(st.max!)}, with a median of ${f(st.median!)} and an average of ${f(st.mean!)} across ${st.count!.toLocaleString("en-US")} rows.`;
    }
  }
  if (typeof facts.rows === "number") {
    return facts.rows === 0
      ? "I couldn't find any records matching that question."
      : `Here are the results (${facts.rows.toLocaleString()} rows).`;
  }
  return "Here are the results.";
}
