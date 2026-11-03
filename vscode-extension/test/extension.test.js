"use strict";

const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const http = require("node:http");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createFakeVscode } = require("./fake-vscode");
const { resolveCliPath, AgentProcess } = require("../lib/agent-process");

const REPO_CLI = path.resolve(__dirname, "..", "..", "index.js");

// Load extension.js with our fake `vscode` module.
function loadExtension(fake) {
  const original = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "vscode") return fake.vscode;
    return original.call(this, request, ...rest);
  };
  try {
    for (const key of Object.keys(require.cache)) {
      if (key.includes(`${path.sep}vscode-extension${path.sep}`) && !key.includes(`${path.sep}test${path.sep}`)) delete require.cache[key];
    }
    return require("../extension");
  } finally {
    Module._load = original;
  }
}

// A scripted model behind a fake OpenRouter.
async function mockModel(script) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "mock/model", context_length: 50000 }] }));
      requests.push(JSON.parse(body));
      const next = script.shift() ?? { text: "(script empty)" };
      res.setHeader("content-type", "text/event-stream");
      const send = (o) => res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", ...o })}\n\n`);
      if (next.tool) send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `c${requests.length}`, type: "function", function: { name: next.tool[0], arguments: JSON.stringify(next.tool[1]) } }] } }] });
      else send({ choices: [{ index: 0, delta: { content: next.text } }] });
      send({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 20, cost: 0.001 } });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { requests, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const until = async (check, what, timeoutMs = 10000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};

test("resolveCliPath: setting, bundled copy, then the repository", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "devpilot-ext-"));
  assert.equal(resolveCliPath({ setting: "", extensionPath: path.join(dir, "ext") }), null);
  mkdirSync(path.join(dir, "ext", "agent"), { recursive: true });
  writeFileSync(path.join(dir, "index.js"), "");
  assert.equal(resolveCliPath({ setting: "", extensionPath: path.join(dir, "ext") }), path.join(dir, "index.js"));
  writeFileSync(path.join(dir, "ext", "agent", "index.js"), "");
  assert.equal(resolveCliPath({ setting: "", extensionPath: path.join(dir, "ext") }), path.join(dir, "ext", "agent", "index.js"));
  assert.equal(resolveCliPath({ setting: path.join(dir, "index.js"), extensionPath: path.join(dir, "ext") }), path.join(dir, "index.js"));
});

test("AgentProcess reports a fatal startup error", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "devpilot-ext-"));
  const agent = new AgentProcess({ cliPath: REPO_CLI, cwd, nodePath: process.execPath, env: { OPENROUTER_API_KEY: "", OPENROUTER_MODEL: "m", HOME: cwd } });
  const exit = new Promise((r) => agent.on("exit", r));
  agent.start();
  const info = await exit;
  assert.equal(info.fatal, "OPENROUTER_API_KEY is missing");
  assert.equal(info.code, 1);
});

test("extension: chat → editor context → diff approval accepted from the diff editor → file changed", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "devpilot-ws-"));
  writeFileSync(path.join(root, "app.js"), "const greeting = 'helo';\n");
  const model = await mockModel([
    { tool: ["read_file", { path: "app.js" }] },
    { tool: ["edit_file", { path: "app.js", old_string: "'helo'", new_string: "'hello'" }] },
    { text: "Fixed the typo in app.js." },
  ]);

  const fake = createFakeVscode({
    workspace: root,
    settings: { cliPath: REPO_CLI, nodePath: process.execPath, model: "mock/model", env: { OPENROUTER_BASE_URL: model.url, DEVPILOT_AUTO_BRANCH: "0", HOME: root } },
    secrets: { "devpilot.openrouterApiKey": "sk-test" },
  });
  // The user has app.js open with line 1 selected, and the editor reports a problem.
  const doc = { uri: fake.vscode.Uri.file(path.join(root, "app.js")), languageId: "javascript", getText: () => "const greeting = 'helo';", isDirty: false };
  fake.vscode.window.activeTextEditor = {
    document: doc,
    selection: { isEmpty: false, start: { line: 0 }, end: { line: 0 }, active: { line: 0 } },
  };
  fake.vscode.languages.diagnostics = [{ severity: 1, range: { start: { line: 0 } }, message: "Unknown word 'helo'", source: "cSpell" }];

  const extension = loadExtension(fake);
  const controller = extension.activate(fake.context);
  for (const name of ["devpilot.focus", "devpilot.acceptChange", "devpilot.rejectChange", "devpilot.newChat", "devpilot.explainSelection"]) {
    assert.ok(fake.log.commands.has(name), `${name} is registered`);
  }
  assert.equal(fake.providers.webview.id, "devpilot.chat");

  try {
    // Opening the view starts DevPilot.
    const view = fake.createView();
    fake.providers.webview.provider.resolveWebviewView(view);
    assert.match(view.webview.html, /Content-Security-Policy[^>]*script-src 'nonce-/);
    await until(() => controller.processState.state === "running", "DevPilot to be ready");

    await view.fromWebview({ type: "ready" });
    const init = fake.log.webviewMessages.find((m) => m.type === "init");
    assert.equal(init.process.state, "running");
    assert.equal(fake.log.webviewMessages.find((m) => m.type === "context").context.label, "app.js:1 · 1 problem");

    // Send a message from the chat.
    await view.fromWebview({ type: "send", text: "fix the typo", includeContext: true });
    const approval = await until(() => controller.approvals.size && [...controller.approvals.values()][0].after, "the diff to open");

    // The diff view shows the old and new text through the content provider.
    const diffCall = fake.log.executed.find(([name]) => name === "vscode.diff");
    const provider = fake.providers.content.get("devpilot-diff");
    assert.equal(provider.provideTextDocumentContent(diffCall[1]), "const greeting = 'helo';\n");
    assert.equal(provider.provideTextDocumentContent(diffCall[2]), "const greeting = 'hello';\n");
    assert.match(diffCall[3], /^app\.js ↔ DevPilot's change/);

    // Accept from the diff editor's title button (the diff is the active editor).
    fake.vscode.window.activeTextEditor = { document: { uri: approval } };
    await fake.vscode.commands.executeCommand("devpilot.acceptChange");
    assert.deepEqual(fake.log.closedTabs, [approval.toString()]);

    await until(() => fake.log.webviewMessages.some((m) => m.type === "event" && m.event.type === "turn_end"), "the turn to end");
    assert.equal(readFileSync(path.join(root, "app.js"), "utf8"), "const greeting = 'hello';\n");

    // The model got the editor context; the API key came from secret storage.
    const firstUser = model.requests[0].messages.find((m) => m.role === "user").content;
    assert.match(firstUser, /^fix the typo\n\n<editor-context>/);
    assert.match(firstUser, /Selected lines 1-1 of app\.js/);
    assert.match(firstUser, /app\.js:1 warning: Unknown word 'helo' \(cSpell\)/);

    const types = fake.log.webviewMessages.filter((m) => m.type === "event").map((m) => m.event.type);
    for (const t of ["ready", "turn_start", "tool_call", "approval_request", "tool_result", "text", "turn_end", "status"]) assert.ok(types.includes(t), `webview got ${t}`);
    assert.equal(fake.log.webviewMessages.find((m) => m.type === "approvalAnswered").answer, "y");

    // A view re-created later replays the transcript.
    const before = fake.log.webviewMessages.length;
    await view.fromWebview({ type: "ready" });
    const replay = fake.log.webviewMessages.slice(before).find((m) => m.type === "init");
    assert.ok(replay.transcript.some((e) => e.type === "approval_request"));
  } finally {
    await controller.dispose();
    model.close();
  }
});

test("extension: a missing API key shows a 'Set API key' banner instead of crashing", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "devpilot-ws-"));
  const fake = createFakeVscode({ workspace: root, settings: { cliPath: REPO_CLI, nodePath: process.execPath, model: "m", env: { OPENROUTER_API_KEY: "", HOME: root } } });
  const extension = loadExtension(fake);
  const controller = extension.activate(fake.context);
  const view = fake.createView();
  fake.providers.webview.provider.resolveWebviewView(view);
  const exited = await until(() => fake.log.webviewMessages.find((m) => m.type === "process" && m.state === "exited"), "the process to exit");
  assert.equal(exited.needs, "apiKey");
  assert.match(exited.message, /OPENROUTER_API_KEY is missing/);
  await controller.dispose();
});
