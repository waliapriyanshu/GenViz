import { describe, expect, it } from "vitest";
import { stripEmDashes } from "@/lib/text";

describe("stripEmDashes", () => {
  it("turns a spaced em dash into a comma", () => {
    expect(stripEmDashes("Sales grew — driven by the North region.")).toBe(
      "Sales grew, driven by the North region.",
    );
  });

  it("handles unspaced em dashes", () => {
    expect(stripEmDashes("Revenue rose—again.")).toBe("Revenue rose, again.");
  });

  it("does not leave a stray comma after sentence punctuation", () => {
    expect(stripEmDashes("It dropped. — Then it recovered.")).toBe(
      "It dropped. Then it recovered.",
    );
  });

  it("drops a leading or trailing em dash", () => {
    expect(stripEmDashes("— Top region is North")).toBe("Top region is North");
    expect(stripEmDashes("Top region is North —")).toBe("Top region is North");
  });

  it("treats a spaced en dash like an em dash", () => {
    expect(stripEmDashes("Revenue – up 4% on last year")).toBe(
      "Revenue, up 4% on last year",
    );
  });

  it("leaves numeric ranges and ordinary punctuation alone", () => {
    expect(stripEmDashes("Orders in 2025–2026, e.g., Q1-Q2")).toBe(
      "Orders in 2025–2026, e.g., Q1-Q2",
    );
  });

  it("is a no-op without dashes", () => {
    expect(stripEmDashes("Total revenue was 1,532,105.")).toBe(
      "Total revenue was 1,532,105.",
    );
  });
});
