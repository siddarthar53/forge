import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = (...args) => execFileSync(process.execPath, ["cli.js", ...args], { cwd: root, encoding: "utf8" });

test("--json", () => assert.deepEqual(JSON.parse(run("sample.txt", "--json")), { lines: 3, words: 6, chars: 27 }));
test("flag first", () => assert.deepEqual(JSON.parse(run("--json", "sample.txt")), { lines: 3, words: 6, chars: 27 }));
test("text output unchanged", () => assert.equal(run("sample.txt"), "lines: 3\nwords: 6\nchars: 27\n"));
