import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { groupForParallel, runAgent } from "../src/agent.js";
import { createPermissions } from "../src/permissions.js";
import { createSession } from "../src/session.js";
import { createTaskTool, loadAgents, parseAgentFile } from "../src/subagents.js";
import { builtinTools, createToolset } from "../src/tools/index.js";
import { terminal } from "../src/ui.js";

terminal.write = () => true;
terminal.log = () => {};
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "devpilot-home-"));

// ---------------------------------------------------------------- helpers

const stream = (chunks) => ({ async *[Symbol.asyncIterator]() { yield* chunks; } });
const usage = { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 };
const toolReply = (...calls) =>
  stream([
    { choices: [{ delta: { tool_calls: calls.map(([name, args], i) => ({ index: i, id: `call_${name}_${i}_${Math.random()}`, function: { name, arguments: JSON.stringify(args) } })) } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage },
  ]);
const textReply = (text) => stream([{ choices: [{ delta: { content: text }, finish_reason: "stop" }] }, { choices: [], usage }]);

// Which agent is calling? Sub-agent prompts start with `You are "<name>"`.
const who = (body) => body.messages[0].content.match(/^You are "([^"]+)"/)?.[1] ?? "main";

function workspace() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "devpilot-"));
  writeFileSync(path.join(cwd, "auth.js"), "export function login() {}\n");
  writeFileSync(path.join(cwd, "db.js"), "export function query() {}\n");
  return cwd;
}

function setup(cwd, client, { mode = "default", approve = async () => ({ allowed: true }) } = {}) {
  const { agents } = loadAgents(cwd, builtinTools);
  const toolset = createToolset([...builtinTools, createTaskTool(agents)]);
  const session = createSession({ cwd, model: "m", systemPrompt: "You are the main agent." });
  const state = { model: "m", mode, modelInfo: { contextLength: 100_000 } };
  const toolContext = {
    cwd,
    signal: new AbortController().signal,
    readFiles: new Map(),
    approve,
    settings: { allow: [], deny: [] },
    state,
    session,
    client,
    config: { subagentMaxSteps: 10, compactAt: 0.9 },
  };
  return { client, session, state, toolContext, toolset, maxSteps: 10, compactAt: 0.9 };
}

// ------------------------------------------------------------------ tests

test("agent files: inline and list tool syntax, errors", () => {
  const a = parseAgentFile("---\nname: tester\ndescription: Writes tests.\ntools: read_file, grep\nmodel: x/y\n---\nWrite tests.\n", "a.md");
  assert.deepEqual([a.name, a.tools, a.model, a.prompt], ["tester", ["read_file", "grep"], "x/y", "Write tests."]);

  const b = parseAgentFile("---\nname: b\ndescription: \"Quoted.\"\ntools:\n  - read_file\n  - mcp__gh__*\n---\nBody", "b.md");
  assert.deepEqual([b.description, b.tools], ["Quoted.", ["read_file", "mcp__gh__*"]]);

  const c = parseAgentFile("---\nname: c\ndescription: d\n---\nBody", "c.md");
  assert.deepEqual(c.tools, ["read_file", "list_files", "grep"]);

  assert.throws(() => parseAgentFile("no header", "x.md"), /must start with a --- header/);
  assert.throws(() => parseAgentFile("---\nname: x\n---\nbody", "x.md"), /"description" is missing/);
});

test("built-in and custom agents get only the tools they ask for", () => {
  const cwd = workspace();
  mkdirSync(path.join(cwd, ".devpilot", "agents"), { recursive: true });
  writeFileSync(path.join(cwd, ".devpilot", "agents", "explorer.md"), "---\nname: explorer\ndescription: Custom explorer.\ntools: grep\n---\nOnly grep.");
  writeFileSync(path.join(cwd, ".devpilot", "agents", "broken.md"), "oops");

  const mcpRead = { name: "mcp__gh__get_issue", readOnly: true, mcp: { server: "gh" } };
  const mcpWrite = { name: "mcp__gh__create_issue", readOnly: false, mcp: { server: "gh" } };
  const { agents, errors } = loadAgents(cwd, [...builtinTools, mcpRead, mcpWrite]);
  const byName = Object.fromEntries(agents.map((a) => [a.name, a]));

  assert.deepEqual(byName.explorer.toolList.map((t) => t.name), ["grep"]); // project file wins
  assert.equal(byName.explorer.description, "Custom explorer.");
  assert.deepEqual(byName.reviewer.toolList.map((t) => t.name), ["read_file", "list_files", "grep", "run_shell", "mcp__gh__get_issue"]);
  assert.equal(byName.reviewer.readOnly, false); // run_shell
  assert.ok(byName.general.toolList.some((t) => t.name === "mcp__gh__create_issue"));
  assert.ok(!byName.general.toolList.some((t) => t.name === "task" || t.name === "todo_write"));
  assert.match(errors[0], /broken\.md: must start/);
});

test("parallel groups: neighbouring safe calls together, others alone and in order", () => {
  const toolset = createToolset([...builtinTools, createTaskTool(loadAgents(workspace(), builtinTools).agents)]);
  const c = (name, args = {}) => ({ function: { name, arguments: JSON.stringify(args) } });
  const groups = groupForParallel(
    [c("read_file"), c("grep"), c("edit_file"), c("read_file"), c("task", { agent: "explorer" }), c("task", { agent: "general" })],
    toolset
  );
  assert.deepEqual(
    groups.map((g) => [g.safe, g.calls.map((x) => x.function.name)]),
    [[true, ["read_file", "grep"]], [false, ["edit_file"]], [true, ["read_file", "task"]], [false, ["task"]]]
  );
});

test("an explorer works in its own context and only its report comes back", async () => {
  const cwd = workspace();
  const client = {
    chat: {
      completions: {
        create: async (body) => {
          const agent = who(body);
          const last = body.messages.at(-1);
          if (agent === "main") {
            if (last.role === "user") return toolReply(["task", { agent: "explorer", description: "Find login", prompt: "Where is login defined?" }]);
            return textReply(`Main got: ${last.content.split("\n")[0]}`);
          }
          // the explorer: try to write (not in its toolset), read, then report
          if (last.role === "user") return toolReply(["write_file", { path: "x.txt", content: "no" }], ["read_file", { path: "auth.js" }]);
          return textReply("login is defined in auth.js:1");
        },
      },
    },
  };
  const ctx = setup(cwd, client);
  ctx.session.addMessage({ role: "user", content: "where is login?" });
  const result = await runAgent(ctx);

  assert.equal(result.status, "done");
  assert.equal(result.text, "Main got: login is defined in auth.js:1");
  assert.equal(existsSync(path.join(cwd, "x.txt")), false);

  // The main history has the report, not the file contents.
  const mainTool = ctx.session.messages.find((m) => m.role === "tool");
  assert.match(mainTool.content, /^login is defined in auth\.js:1\n\n\[explorer#\d+: done, 2 steps/);
  assert.ok(!ctx.session.messages.some((m) => String(m.content).includes("export function login")));

  // The sub-agent's own log shows the refused write and the read.
  const log = readFileSync(mainTool.content && ctx.session.logFile, "utf8");
  const subLog = JSON.parse(log.split("\n").filter(Boolean).find((l) => l.includes('"type":"subagent"'))).log;
  assert.ok(subLog.includes(path.join(".devpilot", "subagents")));
  const subText = readFileSync(subLog, "utf8");
  assert.match(subText, /unknown tool \\"write_file\\"/);
  assert.match(subText, /export function login/);

  // Usage: 2 main calls + 2 explorer calls, all counted in the main /cost.
  assert.equal(ctx.session.usage.calls, 4);
  assert.ok(Math.abs(ctx.session.usage.cost - 0.04) < 1e-9);
});

test("two explorers in one reply run at the same time", async () => {
  const cwd = workspace();
  let running = 0;
  let maxRunning = 0;
  const client = {
    chat: {
      completions: {
        create: async (body) => {
          const agent = who(body);
          const last = body.messages.at(-1);
          if (agent === "main") {
            if (last.role === "user")
              return toolReply(
                ["task", { agent: "explorer", description: "auth", prompt: "Look at auth." }],
                ["task", { agent: "explorer", description: "db", prompt: "Look at db." }]
              );
            return textReply("both done");
          }
          running++;
          maxRunning = Math.max(maxRunning, running);
          await new Promise((r) => setTimeout(r, 50));
          running--;
          return textReply(`report about ${last.content}`);
        },
      },
    },
  };
  const ctx = setup(cwd, client);
  ctx.session.addMessage({ role: "user", content: "explore" });
  await runAgent(ctx);

  assert.equal(maxRunning, 2);
  const results = ctx.session.messages.filter((m) => m.role === "tool").map((m) => m.content.split("\n")[0]);
  assert.deepEqual(results, ["report about Look at auth.", "report about Look at db."]); // original order kept
});

test("plan mode allows read-only agents only; sub-agent prompts are labelled", async () => {
  const cwd = workspace();
  const titles = [];
  const client = {
    chat: {
      completions: {
        create: async (body) => {
          const agent = who(body);
          const last = body.messages.at(-1);
          if (agent === "main") {
            if (body.messages.filter((m) => m.role === "tool").length === 0)
              return toolReply(["task", { agent: "general", description: "edit", prompt: "Edit things." }]);
            return textReply("ok");
          }
          if (last.role === "user") return toolReply(["write_file", { path: "new.txt", content: "hi" }]);
          return textReply("wrote it");
        },
      },
    },
  };

  const planCtx = setup(cwd, client, { mode: "plan" });
  planCtx.session.addMessage({ role: "user", content: "go" });
  await runAgent(planCtx);
  assert.match(planCtx.session.messages.find((m) => m.role === "tool").content, /plan mode is on, so task is not available with these arguments/);

  const ctx = setup(cwd, client, { approve: async (r) => (titles.push(r.title), { allowed: true }) });
  ctx.session.addMessage({ role: "user", content: "go" });
  await runAgent(ctx);
  assert.deepEqual(titles, [`[general#${titles[0].match(/#(\d+)/)[1]}] Create new.txt`]);
  assert.equal(readFileSync(path.join(cwd, "new.txt"), "utf8"), "hi");
});

test("permission prompts from parallel agents are asked one at a time", async () => {
  let open = 0;
  let maxOpen = 0;
  const approve = createPermissions({
    ask: async () => {
      open++;
      maxOpen = Math.max(maxOpen, open);
      await new Promise((r) => setTimeout(r, 20));
      open--;
      return "y";
    },
  });
  const log = console.log;
  console.log = () => {};
  try {
    const answers = await Promise.all([1, 2, 3].map((i) => approve({ title: `q${i}` })));
    assert.deepEqual(answers.map((a) => a.allowed), [true, true, true]);
  } finally {
    console.log = log;
  }
  assert.equal(maxOpen, 1);
});
