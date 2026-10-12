export function formatNumber(
  value: number,
  options: { currency?: string; compact?: boolean; percent?: boolean } = {},
): string {
  if (!Number.isFinite(value)) return "N/A";
  const abs = Math.abs(value);
  const formatted =
    options.compact && abs >= 10_000
      ? new Intl.NumberFormat("en-US", {
          notation: "compact",
          maximumFractionDigits: 1,
        }).format(value)
      : value.toLocaleString("en-US", {
          maximumFractionDigits: abs >= 100 ? 0 : abs >= 1 ? 2 : 4,
        });
  if (options.percent) return `${formatted}%`;
  return options.currency
    ? `${value < 0 ? "-" : ""}${options.currency}${formatted.replace(/^-/, "")}`
    : formatted;
}

export function formatCell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "N/A";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

export function humanizeKey(name: string): string {
  const spaced = name.replace(/[_\s]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(s / 60);
  return `${String(minutes).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
