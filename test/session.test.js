import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createSession, listSessions, repairHistory } from "../src/session.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "devpilot-"));

test("a resumed session sees exactly what the model last saw", () => {
  const cwd = tmp();
  const a = createSession({ cwd, model: "m", systemPrompt: "old prompt" });
  a.addMessage({ role: "user", content: "first" });
  a.addMessage({ role: "assistant", content: "reply" });
  a.replaceMessages([a.messages[0], { role: "user", content: "summary" }], "compact");
  a.addMessage({ role: "assistant", content: "after compaction" });
  a.setTodos([{ content: "do it", status: "pending" }]);
  a.recordUsage({ prompt_tokens: 100, completion_tokens: 20, cost: 0.5 });

  const b = createSession({ cwd, model: "m", systemPrompt: "new prompt", resumeFile: a.logFile });
  assert.deepEqual(b.messages, [
    { role: "system", content: "new prompt" },
    { role: "user", content: "summary" },
    { role: "assistant", content: "after compaction" },
  ]);
  assert.deepEqual(b.todos, [{ content: "do it", status: "pending" }]);
  assert.equal(b.usage.cost, 0.5);
  assert.equal(b.usage.promptTokens, 100);

  // Resuming the resumed log again gives the same result.
  const c = createSession({ cwd, model: "m", systemPrompt: "newest", resumeFile: a.logFile });
  assert.equal(c.messages.length, 3);
  assert.equal(c.messages[0].content, "newest");
});

test("resume survives a half-written last line and missing tool results", () => {
  const cwd = tmp();
  const a = createSession({ cwd, model: "m", systemPrompt: "p" });
  a.addMessage({ role: "user", content: "go" });
  a.addMessage({
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "1", type: "function", function: { name: "read_file", arguments: "{}" } },
      { id: "2", type: "function", function: { name: "grep", arguments: "{}" } },
    ],
  });
  a.addMessage({ role: "tool", tool_call_id: "1", content: "ok" });
  appendFileSync(a.logFile, '{"type":"message","mess'); // crash mid-write

  const b = createSession({ cwd, model: "m", systemPrompt: "p", resumeFile: a.logFile });
  assert.deepEqual(
    b.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
    ["1", "2"]
  );
});

test("repairHistory returns the same array when nothing is missing", () => {
  const messages = [
    { role: "assistant", content: null, tool_calls: [{ id: "a" }] },
    { role: "tool", tool_call_id: "a", content: "x" },
  ];
  assert.equal(repairHistory(messages), messages);
});

test("context estimate uses the last API count plus new messages", () => {
  const s = createSession({ cwd: tmp(), model: "m", systemPrompt: "p" });
  s.addMessage({ role: "assistant", content: "hi" });
  s.recordUsage({ prompt_tokens: 1000, completion_tokens: 50 });
  assert.equal(s.estimateContextTokens(0), 1050);
  s.addMessage({ role: "tool", tool_call_id: "x", content: "y".repeat(400) });
  assert.ok(s.estimateContextTokens(0) > 1100);
  s.replaceMessages([s.messages[0]], "clear");
  assert.ok(s.estimateContextTokens(0) < 50);
});

test("listSessions skips empty sessions and shows the first prompt", () => {
  const cwd = tmp();
  createSession({ cwd, model: "m", systemPrompt: "p" }); // empty
  const s = createSession({ cwd, model: "m", systemPrompt: "p" });
  s.addMessage({ role: "user", content: "fix the login bug\n\n<system-reminder>\nPlan mode is on.\n</system-reminder>" });
  const list = listSessions(cwd);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "fix the login bug");
});
