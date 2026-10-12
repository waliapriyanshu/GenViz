/**
 * Replaces em dashes (and spaced en dashes used the same way) with natural
 * punctuation. Used for text Genviz does not author itself: model answers and
 * previously saved conversations. En dashes inside numeric ranges (no
 * surrounding spaces) are left alone.
 */
export function stripEmDashes(text: string): string {
  return text
    .replace(/^\s*\u2014\s*|\s*\u2014\s*$/g, "")
    .replace(/([.!?:;,])\s*\u2014\s*/g, "$1 ")
    .replace(/\s*\u2014\s*|\s+\u2013\s+/g, ", ");
}
