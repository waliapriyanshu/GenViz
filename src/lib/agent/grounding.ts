import { toNumber } from "@/lib/analysis/shape";

/**
 * Grounding check: every significant number in the model's answer must match a
 * number that actually appears in the query results or computed facts (allowing
 * for display rounding, e.g. "1.2M" for 1,234,567 or "18.4%" for 18.43).
 */

export interface NumberMention {
  text: string;
  value: number;
  /** half of the smallest displayed unit, e.g. 0.05M for "1.2M" */
  tolerance: number;
  isPercent: boolean;
  isPlainSmallInt: boolean;
}

const SCALE: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mn: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
  l: 1e5,
  lakh: 1e5,
  lakhs: 1e5,
  cr: 1e7,
  crore: 1e7,
  crores: 1e7,
};

const NUMBER_PATTERN =
  /([$€£¥₹])?\s?(-?\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)(\s?(?:%|k|K|M|mn|B|bn|L|Cr|thousand|million|billion|lakhs?|crores?)\b|%)?/g;

export function extractNumbers(text: string): NumberMention[] {
  const mentions: NumberMention[] = [];
  // Ignore ISO-like dates and times entirely.
  const cleaned = text
    .replace(/\b\d{4}-\d{2}(-\d{2})?(T[\d:.]+Z?)?\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}\b/g, " ");
  for (const match of cleaned.matchAll(NUMBER_PATTERN)) {
    const [, currency, digits, suffixRaw] = match;
    if (!digits) continue;
    const suffix = (suffixRaw ?? "").trim();
    const base = Number(digits.replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    const decimals = digits.includes(".") ? digits.split(".")[1]!.length : 0;
    const scale =
      suffix && suffix !== "%" ? (SCALE[suffix.toLowerCase()] ?? 1) : 1;
    const value = base * scale;
    const unit = 10 ** -decimals * scale;
    const isPercent = suffix === "%";
    const isPlainSmallInt =
      !currency && !suffix && decimals === 0 && Math.abs(base) <= 31;
    const isYear =
      !currency && !suffix && decimals === 0 && base >= 1900 && base <= 2100;
    if (isPlainSmallInt || isYear) continue;
    mentions.push({
      text: match[0].trim(),
      value,
      tolerance: unit / 2,
      isPercent,
      isPlainSmallInt,
    });
  }
  return mentions;
}

export function collectNumbers(
  value: unknown,
  into: number[] = [],
  limit = 20_000,
): number[] {
  if (into.length >= limit) return into;
  const n = toNumber(value);
  if (n !== null) {
    into.push(n);
    return into;
  }
  if (typeof value === "string") {
    // Numbers embedded in text: schema summaries, labels, and the executed SQL
    // (thresholds, bucket sizes, date ranges the query itself used).
    for (const match of value.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
      const embedded = Number(match[0].replace(/,/g, ""));
      if (Number.isFinite(embedded)) into.push(embedded);
      if (into.length >= limit) break;
    }
    return into;
  }
  if (Array.isArray(value))
    for (const item of value) collectNumbers(item, into, limit);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) collectNumbers(item, into, limit);
  return into;
}

function matches(mention: NumberMention, candidate: number): boolean {
  const diff = Math.abs(mention.value - candidate);
  if (diff <= mention.tolerance + 1e-9) return true;
  // allow normal rounding in prose (e.g. "about 1,235" for 1234.6)
  return diff <= Math.abs(candidate) * 0.005;
}

export interface GroundingReport {
  grounded: boolean;
  ungrounded: string[];
}

export function checkGrounding(
  answer: string,
  sources: unknown[],
): GroundingReport {
  const numbers = sources.flatMap((s) => collectNumbers(s));
  const ungrounded: string[] = [];
  for (const mention of extractNumbers(answer)) {
    const ok = numbers.some((n) => matches(mention, n) || matches(mention, -n));
    if (!ok) ungrounded.push(mention.text);
  }
  return { grounded: ungrounded.length === 0, ungrounded };
}
