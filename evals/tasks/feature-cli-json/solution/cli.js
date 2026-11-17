#!/usr/bin/env node
// Usage: node cli.js <file> [--json]   prints line, word and character counts.
import { readFileSync } from "node:fs";
import { stats } from "./src/stats.js";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: node cli.js <file> [--json]");
  process.exit(1);
}
const s = stats(readFileSync(file, "utf8"));
if (args.includes("--json")) console.log(JSON.stringify(s));
else console.log(`lines: ${s.lines}\nwords: ${s.words}\nchars: ${s.chars}`);
