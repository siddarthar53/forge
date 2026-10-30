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

// Shorten long strings for one-line display (tool arguments, results).
export function truncate(text, max = 120) {
  const oneLine = String(text).replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
