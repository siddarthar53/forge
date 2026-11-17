#!/usr/bin/env node
// Usage: node cli.js <file>   prints line, word and character counts.
import { readFileSync } from "node:fs";
import { stats } from "./src/stats.js";

const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: node cli.js <file>");
  process.exit(1);
}
const s = stats(readFileSync(file, "utf8"));
console.log(`lines: ${s.lines}\nwords: ${s.words}\nchars: ${s.chars}`);
