// Small helpers for printing results as Markdown.

export const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "–");

export function mean(values) {
  const v = values.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}

export function fmt(x, digits = 1) {
  if (!Number.isFinite(x)) return "–";
  if (Math.abs(x) >= 1000) return `${(x / 1000).toFixed(1)}k`;
  return Number.isInteger(x) ? String(x) : x.toFixed(digits);
}

export function table(headers, rows) {
  const line = (cells) => `| ${cells.map((c) => String(c).replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}
