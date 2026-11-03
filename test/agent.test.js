import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runAgent } from "../src/agent.js";
import { createSession } from "../src/session.js";
import { terminal } from "../src/ui.js";

// Keep the agent's printing out of the test runner's output channel.
terminal.write = () => true;
terminal.log = () => {};

// A recorded-conversation replay: a fake client returns scripted streams, so
// the whole loop (streaming, tool-call stitching, tool execution, usage,
// compaction) runs without a network or an API key.

function streamOf(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}

function textReply(text, usage) {
  return streamOf([
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { choices: [], usage },
  ]);
}

// Tool-call arguments split across chunks, the way real streams send them.
function toolReply(name, args, usage) {
  const json = JSON.stringify(args);
  const mid = Math.floor(json.length / 2);
  return streamOf([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: "" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: json.slice(0, mid) } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: json.slice(mid) } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage },
  ]);
}

function fakeClient(script) {
  const requests = [];
  return {
    requests,
    chat: {
      completions: {
        async create(body) {
          requests.push(body);
          const next = script.shift();
          if (!next) throw new Error("the script ran out of replies");
          return next(body);
        },
      },
    },
  };
}

function setup(cwd, client, modelInfo = { contextLength: 100_000, pricing: null }) {
  const session = createSession({ cwd, model: "test/model", systemPrompt: "You are a test." });
  const state = { model: "test/model", mode: "default", modelInfo };
  const toolContext = {
    cwd,
    signal: new AbortController().signal,
    readFiles: new Map(),
    approve: async () => ({ allowed: true }),
    settings: { allow: [], deny: [] },
    state,
    session,
  };
  return { client, session, state, toolContext, maxSteps: 10, compactAt: 0.8 };
}

test("read, edit, answer: a full turn with streamed tool calls", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "devpilot-"));
  writeFileSync(path.join(cwd, "greet.js"), 'console.log("helo");\n');

  const client = fakeClient([
    () => toolReply("read_file", { path: "greet.js" }, { prompt_tokens: 500, completion_tokens: 10, cost: 0.001 }),
    () =>
      toolReply("edit_file", { path: "greet.js", old_string: "helo", new_string: "hello" }, {
        prompt_tokens: 600,
        completion_tokens: 20,
        cost: 0.002,
        prompt_tokens_details: { cached_tokens: 500 },
      }),
    () => textReply("Fixed the typo.", { prompt_tokens: 700, completion_tokens: 5, cost: 0.003 }),
  ]);
  const ctx = setup(cwd, client);
  ctx.session.addMessage({ role: "user", content: "fix the typo" });

  const result = await runAgent(ctx);

  assert.equal(result.status, "done");
  assert.equal(readFileSync(path.join(cwd, "greet.js"), "utf8"), 'console.log("hello");\n');
  assert.deepEqual(
    ctx.session.messages.map((m) => m.role),
    ["system", "user", "assistant", "tool", "assistant", "tool", "assistant"]
  );
  assert.equal(ctx.session.usage.calls, 3);
  assert.equal(ctx.session.usage.cachedTokens, 500);
  assert.ok(Math.abs(ctx.session.usage.cost - 0.006) < 1e-9);
  assert.equal(client.requests[0].stream_options.include_usage, true);
  assert.equal(ctx.session.estimateContextTokens(0), 705);
});

test("auto-compaction kicks in when the context is nearly full", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "devpilot-"));
  let summaryRequest = null;
  const client = fakeClient([
    (body) => {
      summaryRequest = body;
      return { choices: [{ message: { content: "SUMMARY: user wants X." } }], usage: { prompt_tokens: 900, completion_tokens: 30 } };
    },
    () => textReply("Continuing.", { prompt_tokens: 120, completion_tokens: 5 }),
  ]);
  // A 1,000-token window and ~1,500 tokens of history: well over 80%.
  const ctx = setup(cwd, client, { contextLength: 1000, pricing: null });
  ctx.session.addMessage({ role: "user", content: "x".repeat(6000) });

  let compacted = 0;
  await runAgent({ ...ctx, onCompact: () => compacted++ });

  assert.equal(compacted, 1);
  assert.equal(summaryRequest.tool_choice, "none");
  assert.equal(ctx.session.messages[1].role, "user");
  assert.match(ctx.session.messages[1].content, /SUMMARY: user wants X\.[\s\S]*Continue the task/);
  assert.equal(ctx.session.messages.at(-1).content, "Continuing.");
});

test("loop detection nudges after the third identical failing call", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "devpilot-"));
  const missing = () => toolReply("read_file", { path: "nope.txt" }, { prompt_tokens: 10, completion_tokens: 1 });
  const client = fakeClient([missing, missing, missing, () => textReply("I give up.", { prompt_tokens: 10, completion_tokens: 1 })]);
  const ctx = setup(cwd, client);
  ctx.session.addMessage({ role: "user", content: "read nope.txt" });

  await runAgent(ctx);
  const toolResults = ctx.session.messages.filter((m) => m.role === "tool").map((m) => m.content);
  assert.doesNotMatch(toolResults[1], /exact call/);
  assert.match(toolResults[2], /made this exact call 3 times/);
});
