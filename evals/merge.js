#!/usr/bin/env node
// Merge several eval runs into one report, e.g. when a free model's daily
// quota means the tasks have to run in batches.
//
//   node evals/merge.js <new-label> <label> <label> ...
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSummary, summarize } from "./run.js";

const resultsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "results");
const [label, ...sources] = process.argv.slice(2);
if (!label || sources.length < 2) {
  console.error("Usage: node evals/merge.js <new-label> <label> <label> ...");
  process.exit(1);
}

const outDir = path.join(resultsDir, label);
mkdirSync(path.join(outDir, "logs"), { recursive: true });
const runs = [];
const metas = [];
for (const source of sources) {
  const dir = path.join(resultsDir, source);
  metas.push(JSON.parse(readFileSync(path.join(dir, "summary.json"), "utf8")));
  for (const line of readFileSync(path.join(dir, "runs.jsonl"), "utf8").split("\n")) {
    if (line.trim()) runs.push(JSON.parse(line));
  }
  const logs = path.join(dir, "logs");
  if (existsSync(logs)) for (const f of readdirSync(logs)) copyFileSync(path.join(logs, f), path.join(outDir, "logs", f));
}

runs.sort((a, b) => a.task.localeCompare(b.task) || a.run - b.run);
const models = [...new Set(metas.map((m) => m.model))];
const summary = summarize(runs, {
  label,
  date: metas.map((m) => m.date).sort().at(-1),
  model: models.join(", "),
  stoppedEarly: metas.some((m) => m.stoppedEarly),
  env: metas[0].env ?? {},
  approve: metas[0].approve,
});
summary.mergedFrom = sources;
writeFileSync(path.join(outDir, "runs.jsonl"), runs.map((r) => JSON.stringify(r)).join("\n") + "\n");
writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
const markdown = renderSummary(summary) + `\n<sub>Merged from: ${sources.join(", ")}.</sub>\n`;
writeFileSync(path.join(outDir, "summary.md"), markdown);
console.log(markdown);
