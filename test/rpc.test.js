import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { formatEditorContext } from "../src/rpc.js";

const CLI = fileURLToPath(new URL("../index.js", import.meta.url));

// A mock OpenRouter that plays a script of replies.
async function mockModel(script) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      if (req.url.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "mock/model", context_length: 50_000 }] }));
      const json = JSON.parse(body);
      requests.push(json);
      const next = script.shift() ?? { text: "(script empty)" };
      res.setHeader("content-type", "text/event-stream");
      const send = (o) => res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", ...o })}\n\n`);
      if (next.slow) {
        send({ choices: [{ index: 0, delta: { content: "thinking" } }] });
        await new Promise((r) => setTimeout(r, 5000));
        if (res.destroyed) return;
      }
      if (next.tool) {
        send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: next.tool[0], arguments: JSON.stringify(next.tool[1]) } }] } }] });
      } else {
        send({ choices: [{ index: 0, delta: { content: next.text } }] });
      }
      send({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 30, cost: 0.002 } });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { requests, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

// Start `devpilot --rpc` and collect its events.
function startDevPilot(cwd, baseURL) {
  const child = spawn(process.execPath, [CLI, "--rpc"], {
    cwd,
    env: { ...process.env, OPENROUTER_API_KEY: "k", OPENROUTER_MODEL: "mock/model", OPENROUTER_BASE_URL: baseURL, DEVPILOT_AUTO_BRANCH: "0", HOME: cwd },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  const waiters = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const event = JSON.parse(line); // every stdout line must be JSON
    events.push(event);
    for (const w of [...waiters]) if (w.match(event)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(event));
  });
  return {
    events,
    send: (message) => child.stdin.write(JSON.stringify(message) + "\n"),
    next(match, timeoutMs = 8000) {
      const found = events.find((e) => !e.__used && match(e));
      if (found) return Promise.resolve(((found.__used = true), found));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out; events so far: ${events.map((e) => e.type).join(",")}`)), timeoutMs);
        waiters.push({ match, resolve: (e) => (clearTimeout(timer), (e.__used = true), resolve(e)) });
      });
    },
    stop: () => new Promise((r) => (child.on("exit", r), child.stdin.end())),
  };
}

const type = (t) => (e) => e.type === t;

test("editor context is formatted for the model", () => {
  const text = formatEditorContext({
    activeFile: { path: "src/a.js", language: "javascript", cursorLine: 3 },
    selection: { startLine: 2, endLine: 3, text: "let x = 1;\nx++;" },
    diagnostics: [{ line: 3, severity: "error", message: "x is not defined", source: "eslint" }],
    openFiles: ["b.js"],
  });
  assert.match(text, /^<editor-context>/);
  assert.match(text, /Active file: src\/a\.js \(javascript\), cursor at line 3/);
  assert.match(text, /Selected lines 2-3 of src\/a\.js:\n```javascript\nlet x = 1;\nx\+\+;\n```/);
  assert.match(text, /- src\/a\.js:3 error: x is not defined \(eslint\)/);
  assert.match(text, /Other open files: b\.js\n<\/editor-context>$/);
  assert.equal(formatEditorContext({}), null);
});

test("rpc: a full turn with editor context, a diff approval, commands, cancel and /clear", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "devpilot-rpc-"));
  writeFileSync(path.join(cwd, "a.js"), "let x = 1;\n");
  const model = await mockModel([
    { tool: ["read_file", { path: "a.js" }] },
    { tool: ["edit_file", { path: "a.js", old_string: "let x = 1;", new_string: "let x = 2;" }] },
    { tool: ["todo_write", { todos: [{ content: "Bump x", status: "completed" }] }] },
    { text: "Changed x to 2." },
    { slow: true },
  ]);
  const dp = startDevPilot(cwd, model.url);
  try {
    const ready = await dp.next(type("ready"));
    assert.equal(ready.model, "mock/model");
    assert.equal(ready.contextWindow, 50_000);
    assert.deepEqual(ready.agents.map((a) => a.name), ["explorer", "reviewer", "general"]);
    await dp.next(type("status"));

    dp.send({ type: "prompt", text: "bump x", context: { activeFile: { path: "a.js", language: "javascript" }, selection: { startLine: 1, endLine: 1, text: "let x = 1;" } } });
    assert.equal((await dp.next(type("turn_start"))).text, "bump x");
    assert.equal((await dp.next(type("tool_call"))).name, "read_file");

    const approval = await dp.next(type("approval_request"));
    assert.equal(approval.title, "Edit a.js");
    assert.equal(approval.canAlways, true);
    assert.deepEqual([approval.diff.path, approval.diff.oldText, approval.diff.newText], ["a.js", "let x = 1;\n", "let x = 2;\n"]);
    dp.send({ type: "approval", id: approval.id, answer: "y" });

    assert.equal((await dp.next((e) => e.type === "tool_result" && e.name === "edit_file")).result, "Wrote a.js.");
    assert.deepEqual((await dp.next(type("todos"))).todos, [{ content: "Bump x", status: "completed" }]);
    assert.ok(!dp.events.some((e) => e.type === "log" && e.text.includes("Bump x")), "todos are not repeated as log lines");
    const deltas = [];
    while (true) {
      const e = await dp.next((x) => x.type === "text" || x.type === "turn_end");
      if (e.type === "turn_end") {
        assert.equal(e.status, "done");
        break;
      }
      deltas.push(e.delta);
    }
    assert.equal(deltas.join(""), "Changed x to 2.");
    const status = await dp.next(type("status"));
    assert.ok(status.tokens > 0 && status.cost > 0);
    assert.equal(readFileSync(path.join(cwd, "a.js"), "utf8"), "let x = 2;\n");

    // The model saw the editor context; the session title did not.
    const userMessage = model.requests[0].messages.find((m) => m.role === "user").content;
    assert.match(userMessage, /^bump x\n\n<editor-context>[\s\S]*Selected lines 1-1 of a\.js/);

    // Slash commands: output arrives as log events; status follows.
    dp.send({ type: "prompt", text: "/plan" });
    assert.match((await dp.next((e) => e.type === "log" && /Plan mode/.test(e.text))).text, /Plan mode on/);
    await dp.next(type("turn_end"));
    assert.equal((await dp.next(type("status"))).mode, "plan");
    dp.send({ type: "prompt", text: "/plan" });
    await dp.next(type("turn_end"));

    // Cancel a slow reply.
    dp.send({ type: "prompt", text: "think hard" });
    await dp.next((e) => e.type === "text" && e.delta === "thinking");
    dp.send({ type: "cancel" });
    assert.equal((await dp.next(type("turn_end"))).status, "done");

    // /clear sends an empty history.
    dp.send({ type: "prompt", text: "/clear" });
    const history = await dp.next(type("history"));
    assert.deepEqual(history.items, []);
  } finally {
    await dp.stop();
    model.close();
  }
  // Nothing but JSON ever reached stdout (the parser above would have thrown).
});

test("rpc: a declined approval with feedback, and approval cancelled by Stop", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "devpilot-rpc-"));
  const model = await mockModel([
    { tool: ["write_file", { path: "b.txt", content: "hi" }] },
    { text: "OK, I won't." },
    { tool: ["run_shell", { command: "echo hi" }] },
  ]);
  const dp = startDevPilot(cwd, model.url);
  try {
    await dp.next(type("ready"));
    dp.send({ type: "prompt", text: "write b" });
    const approval = await dp.next(type("approval_request"));
    assert.equal(approval.diff.oldText, "");
    dp.send({ type: "approval", id: approval.id, answer: "use c.txt instead" });
    assert.match((await dp.next(type("tool_result"))).result, /declined this action and said: "use c\.txt instead"/);
    await dp.next(type("turn_end"));

    dp.send({ type: "prompt", text: "run it" });
    const shell = await dp.next(type("approval_request"));
    assert.equal(shell.title, "Run: echo hi");
    dp.send({ type: "cancel" });
    assert.equal((await dp.next(type("request_cancelled"))).id, shell.id);
    assert.equal((await dp.next(type("tool_result"))).result, "Cancelled by the user.");
    assert.equal((await dp.next(type("turn_end"))).status, "done");
  } finally {
    await dp.stop();
    model.close();
  }
});
