import { createPatch } from "diff";

// ANSI escape codes color text in the terminal. Skip them when output is
// piped to a file or the user sets NO_COLOR, so logs stay readable.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (text) =>
  useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text);

export const color = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  cyan: wrap("36"),
};

// Build a unified diff (the format `git diff` prints) and color it:
// removed lines red, added lines green, hunk headers cyan.
export function renderDiff(fileName, oldText, newText) {
  const patch = createPatch(fileName, oldText, newText, "", "", { context: 3 });

  return patch
    .split("\n")
    .slice(2) // drop the "Index:" and "=====" lines createPatch adds
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) return color.bold(line);
      if (line.startsWith("+")) return color.green(line);
      if (line.startsWith("-")) return color.red(line);
      if (line.startsWith("@@")) return color.cyan(line);
      return color.dim(line);
    })
    .join("\n");
}

// The agent loop prints through this object instead of process.stdout and
// console directly, so tests (or a future UI) can replace where output goes.
export const terminal = {
  write: (text) => process.stdout.write(text),
  log: (...args) => console.log(...args),
};

// 1234 -> "1.2k", 1234567 -> "1.2M"
export function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatCost(dollars) {
  return dollars < 0.01 && dollars > 0 ? `$${dollars.toFixed(4)}` : `$${dollars.toFixed(2)}`;
}

// [██████░░░░░░░░░░░░░░] for a 0..1 fraction
export function progressBar(fraction, width = 20) {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const paint = fraction >= 0.8 ? color.red : fraction >= 0.6 ? color.yellow : color.green;
  return paint(bar);
}

// Shorten long strings for one-line display (tool arguments, results).
export function truncate(text, max = 120) {
  const oneLine = String(text).replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
