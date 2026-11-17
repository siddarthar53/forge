#!/usr/bin/env node
// Deny-list eval: how much does src/safety.js catch, and what does it get wrong?
//
//   node evals/safety/run.js          # Markdown report
//   node evals/safety/run.js --json   # machine-readable
//
// No model and no API key needed. The deny list is a "seat belt", not a
// sandbox: a miss here is expected and documented, and is why every command
// still needs your approval and why the Docker sandbox exists. The point is
// to know exactly where the seat belt ends.
import { readFileSync } from "node:fs";
import { checkCommand } from "../../src/safety.js";
import { pct, table } from "../lib/report.js";

const corpus = JSON.parse(readFileSync(new URL("./commands.json", import.meta.url), "utf8"));
const settings = { allow: [], deny: [] };

const categories = Object.entries(corpus.mustBlock).map(([category, commands]) => {
  const results = commands.map((command) => ({ command, ...checkCommand(command, settings) }));
  return {
    category,
    total: results.length,
    blocked: results.filter((r) => r.verdict === "deny").length,
    missed: results.filter((r) => r.verdict !== "deny").map((r) => r.command),
  };
});
const falsePositives = corpus.mustNotBlock
  .map((command) => ({ command, ...checkCommand(command, settings) }))
  .filter((r) => r.verdict === "deny");

const total = categories.reduce((n, c) => n + c.total, 0);
const blocked = categories.reduce((n, c) => n + c.blocked, 0);
const summary = {
  mustBlock: total,
  blocked,
  blockRate: blocked / total,
  mustNotBlock: corpus.mustNotBlock.length,
  falsePositives: falsePositives.length,
  falsePositiveRate: falsePositives.length / corpus.mustNotBlock.length,
  categories,
  falsePositiveCommands: falsePositives.map((r) => ({ command: r.command, reason: r.reason })),
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`# Deny-list eval\n`);
  console.log(`Blocked ${blocked} of ${total} dangerous commands (${pct(summary.blockRate)}). ` +
    `Wrongly blocked ${falsePositives.length} of ${corpus.mustNotBlock.length} everyday commands (${pct(summary.falsePositiveRate)}).\n`);
  console.log(table(["Category", "Blocked", "Missed"], categories.map((c) => [c.category, `${c.blocked}/${c.total}`, c.missed.map((m) => `\`${m}\``).join(", ") || "–"])));
  if (falsePositives.length) {
    console.log(`\n## Wrongly blocked\n`);
    console.log(table(["Command", "Reason given"], falsePositives.map((r) => [`\`${r.command}\``, r.reason])));
  }
}
