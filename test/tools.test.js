import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createCheckpoints } from "../src/checkpoints.js";
import { parsePorcelain } from "../src/git.js";
import { withCacheBreakpoints } from "../src/caching.js";
import { detectTestCommand } from "../src/testloop.js";
import { executeToolCall, tools, validateArgs } from "../src/tools/index.js";

const todoSchema = tools.find((t) => t.name === "todo_write").parameters;

test("validator: nested arrays, enums, unknown and missing fields", () => {
  assert.equal(validateArgs(todoSchema, { todos: [{ content: "a", status: "pending" }] }), null);
  assert.equal(validateArgs(todoSchema, { todos: "nope" }), 'argument "todos" must be of type array');
  assert.equal(
    validateArgs(todoSchema, { todos: [{ content: "a", status: "doing" }] }),
    'argument "todos[0].status" must be one of: pending, in_progress, completed'
  );
  assert.equal(validateArgs(todoSchema, { todos: [{ content: "a" }] }), 'missing required argument "todos[0].status"');
  assert.equal(validateArgs(todoSchema, { todos: [], extra: 1 }), 'unknown argument "extra"');
  assert.equal(validateArgs(todoSchema, []), "arguments must be a JSON object");
});

function fakeContext(cwd, overrides = {}) {
  const todos = [];
  return {
    cwd,
    signal: new AbortController().signal,
    readFiles: new Map(),
    approve: async () => ({ allowed: true }),
    settings: { allow: [], deny: [] },
    state: { mode: "default" },
    session: { todos, setTodos: (list) => todos.splice(0, todos.length, ...list), logEvent() {} },
    ...overrides,
  };
}

const call = (name, args) => ({ id: "c1", function: { name, arguments: JSON.stringify(args) } });

test("plan mode blocks tools that change things, allows read-only ones", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "devpilot-"));
  writeFileSync(path.join(cwd, "a.txt"), "hello\n");
  const ctx = fakeContext(cwd, { state: { mode: "plan" } });

  const write = await executeToolCall(call("write_file", { path: "b.txt", content: "x" }), ctx);
  assert.match(write, /plan mode is on/);
  assert.equal(existsSync(path.join(cwd, "b.txt")), false);

  const read = await executeToolCall(call("read_file", { path: "a.txt" }), ctx);
  assert.match(read, /1\thello/);

  const todo = await executeToolCall(call("todo_write", { todos: [{ content: "Step", status: "in_progress" }] }), ctx);
  assert.match(todo, /0\/1 completed/);
});

test("file tools refuse .devpilot and .git, and call beforeWrite", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "devpilot-"));
  const written = [];
  const ctx = fakeContext(cwd, { beforeWrite: async (abs) => (written.push(abs), "note!") });

  const blocked = await executeToolCall(call("write_file", { path: ".devpilot/settings.json", content: "{}" }), ctx);
  assert.match(blocked, /Refusing to write inside/);

  const ok = await executeToolCall(call("write_file", { path: "new.txt", content: "x" }), ctx);
  assert.equal(ok, "Wrote new.txt.\nnote!");
  assert.deepEqual(written, [path.join(cwd, "new.txt")]);
});

test("run_shell refuses denied commands without asking", async () => {
  // approve() declines, so even a broken deny list could never run it.
  let asked = false;
  const ctx = fakeContext(process.cwd(), { approve: async () => ((asked = true), { allowed: false, message: "no" }) });
  const result = await executeToolCall(call("run_shell", { command: "rm -rf /" }), ctx);
  assert.match(result, /^Blocked/);
  assert.equal(asked, false);
});

test("checkpoints restore changed files and delete created ones", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "devpilot-"));
  const existing = path.join(cwd, "a.txt");
  const created = path.join(cwd, "b.txt");
  writeFileSync(existing, "original");

  const checkpoints = createCheckpoints();
  checkpoints.begin({ messageIndex: 3, prompt: "change stuff" });
  await checkpoints.record(existing);
  writeFileSync(existing, "changed once");
  await checkpoints.record(existing); // second record keeps the oldest version
  writeFileSync(existing, "changed twice");
  await checkpoints.record(created);
  writeFileSync(created, "new");

  const turn = await checkpoints.undoLast();
  assert.equal(turn.messageIndex, 3);
  assert.equal(readFileSync(existing, "utf8"), "original");
  assert.equal(existsSync(created), false);
  assert.equal(await checkpoints.undoLast(), null);
});

test("git porcelain parsing handles renames", () => {
  const out = " M src/a.js\0R  new.js\0old.js\0?? notes.md\0";
  assert.deepEqual(parsePorcelain(out), [
    { status: " M", path: "src/a.js" },
    { status: "R ", path: "new.js" },
    { status: "??", path: "notes.md" },
  ]);
});

test("cache breakpoints only for Claude models, on system and last user message", () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "one" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "two" },
    { role: "assistant", content: null, tool_calls: [] },
    { role: "tool", tool_call_id: "x", content: "result" },
  ];
  assert.equal(withCacheBreakpoints(messages, "openai/gpt-5"), messages);

  const marked = withCacheBreakpoints(messages, "anthropic/claude-sonnet-4.5");
  const isMarked = (m) => Array.isArray(m.content) && m.content[0].cache_control?.type === "ephemeral";
  assert.deepEqual(marked.map(isMarked), [true, false, false, true, false, false]);
  assert.equal(typeof messages[3].content, "string", "the stored history is not modified");
});

test("test command detection", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "devpilot-"));
  assert.equal(detectTestCommand(cwd), null);
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.equal(detectTestCommand(cwd), null);
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  assert.equal(detectTestCommand(cwd), "npm test");
  assert.equal(detectTestCommand(cwd, { testCommand: "make check" }), "make check");
});
