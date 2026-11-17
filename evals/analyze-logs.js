#!/usr/bin/env node
// Metrics for real DevPilot sessions.
//
//   node evals/analyze-logs.js                      # .devpilot/sessions in this folder
//   node evals/analyze-logs.js path/to/folder ...   # any folders or .jsonl files
//   node evals/analyze-logs.js --json               # machine-readable output
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { analyzeFile } from "./lib/analyze.js";
import { pct, table } from "./lib/report.js";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const targets = args.filter((a) => a !== "--json");
if (targets.length === 0) targets.push(path.join(process.cwd(), ".devpilot", "sessions"));

function collect(target) {
  if (!existsSync(target)) {
    console.error(`Not found: ${target}`);
    return [];
  }
  if (statSync(target).isFile()) return [target];
  return readdirSync(target)
    .filter((n) => n.endsWith(".jsonl"))
    .sort()
    .map((n) => path.join(target, n));
}

const files = targets.flatMap(collect);
if (files.length === 0) {
  console.error("No session logs found.");
  process.exit(1);
}

const results = files.map(analyzeFile);
if (asJson) {
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

const rows = results.map((r) => [
  path.basename(r.file).replace(/\.jsonl$/, ""),
  r.model ?? "?",
  r.userMessages,
  r.apiCalls,
  r.usageLogged ? r.promptTokens + r.completionTokens : "not logged",
  r.usageLogged ? pct(r.cacheHitRate) : "not logged",
  r.usageLogged ? `$${r.cost.toFixed(4)}` : "not logged",
  r.toolCalls,
  `${r.toolErrors} (${pct(r.toolErrorRate)})`,
  r.failedCommands,
  r.nudges,
  r.compactions,
  r.subagents,
  r.verifiedAfterLastEdit === null ? "no edits" : r.verifiedAfterLastEdit ? "yes" : "no",
]);
console.log(
  table(
    ["Session", "Model", "Msgs", "API calls", "Tokens", "Cache hit", "Cost", "Tool calls", "Tool errors", "Failed commands", "Loop nudges", "Compactions", "Sub-agents", "Ran tests after last edit"],
    rows
  )
);

const kinds = {};
for (const r of results) for (const [k, n] of Object.entries(r.resultKinds)) kinds[k] = (kinds[k] ?? 0) + n;
console.log(`\nTool results by kind: ${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
const blocked = results.flatMap((r) => r.blockedCommands);
if (blocked.length) console.log(`Blocked commands: ${blocked.map((c) => JSON.stringify(c)).join(", ")}`);
