#!/usr/bin/env node
// Compare two eval runs, e.g. an ablation:
//
//   node evals/run.js --label baseline
//   node evals/run.js --label no-explorers --env DEVPILOT_SUBAGENTS=0
//   node evals/compare.js baseline no-explorers
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fmt, pct, table } from "./lib/report.js";

const RESULTS_DIR = fileURLToPath(new URL("./results", import.meta.url));
const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error("Usage: node evals/compare.js <label A> <label B>");
  process.exit(1);
}
const load = (label) => JSON.parse(readFileSync(path.join(RESULTS_DIR, label, "summary.json"), "utf8"));
const A = load(a);
const B = load(b);

const money = (x) => (Number.isFinite(x) ? `$${x.toFixed(4)}` : "–");
const delta = (x, y, format) => {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return "–";
  const d = y - x;
  const sign = d > 0 ? "+" : d < 0 ? "−" : "±";
  return `${sign}${format(Math.abs(d))}`;
};
const rows = [
  ["pass@1", A.passAt1, B.passAt1, pct],
  ["pass^k", A.passAllK, B.passAllK, pct],
  ["API calls / run", A.efficiency.apiCalls, B.efficiency.apiCalls, fmt],
  ["Tokens / run", A.efficiency.tokens, B.efficiency.tokens, fmt],
  ["Cost / run", A.efficiency.cost, B.efficiency.cost, money],
  ["Cost per pass", A.efficiency.costPerPass, B.efficiency.costPerPass, money],
  ["Seconds / run", A.efficiency.seconds, B.efficiency.seconds, (x) => fmt(x, 0)],
  ["Cache hit rate", A.efficiency.cacheHitRate, B.efficiency.cacheHitRate, pct],
  ["Tool error rate", A.behaviour.toolErrorRate, B.behaviour.toolErrorRate, pct],
  ["Tested after last edit", A.behaviour.verificationRate, B.behaviour.verificationRate, pct],
  ["Compactions", A.behaviour.compactions, B.behaviour.compactions, fmt],
  ["Sub-agent runs", A.behaviour.subagents, B.behaviour.subagents, fmt],
].map(([name, x, y, f]) => [name, f(x), f(y), delta(x, y, f)]);

console.log(`# ${a} vs ${b}\n`);
console.log(`${a}: ${A.model}${Object.keys(A.env).length ? ` (${Object.entries(A.env).map(([k, v]) => `${k}=${v}`).join(" ")})` : ""}`);
console.log(`${b}: ${B.model}${Object.keys(B.env).length ? ` (${Object.entries(B.env).map(([k, v]) => `${k}=${v}`).join(" ")})` : ""}\n`);
console.log(table(["Metric", a, b, "Change"], rows));
