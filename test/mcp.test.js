import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { HttpTransport, McpClient } from "../src/mcp/client.js";
import { expandEnv, loadMcpServers } from "../src/mcp/config.js";
import { connectMcpServers, formatToolResult, matchesPattern, toolNameFor } from "../src/mcp/index.js";
import { executeToolCall } from "../src/tools/index.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-server.js", import.meta.url));

// Every test gets its own fake home folder, so ~/.devpilot is never touched.
const realHome = process.env.HOME;
let home;
before(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "devpilot-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});
after(() => {
  process.env.HOME = realHome;
});

function userConfig(servers) {
  mkdirSync(path.join(home, ".devpilot"), { recursive: true });
  writeFileSync(path.join(home, ".devpilot", "mcp.json"), JSON.stringify({ mcpServers: servers }));
}

const fixtureServer = (extra = {}) => ({ command: process.execPath, args: [FIXTURE], ...extra });
const call = (name, args) => ({ id: "c1", function: { name, arguments: JSON.stringify(args) } });

function ctx(overrides = {}) {
  return {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    readFiles: new Map(),
    approve: async () => ({ allowed: true }),
    settings: { allow: [], deny: [] },
    state: { mode: "default" },
    ...overrides,
  };
}

test("names, allow-lists and result formatting", () => {
  assert.equal(toolNameFor("github", "create_issue"), "mcp__github__create_issue");
  assert.equal(toolNameFor("my.server", "do thing"), "mcp__my_server__do_thing");
  const long = toolNameFor("server", "x".repeat(100));
  assert.equal(long.length, 64);
  assert.notEqual(long, toolNameFor("server", "x".repeat(99)));

  assert.equal(matchesPattern("get_issue", ["get_*"]), true);
  assert.equal(matchesPattern("create_issue", ["get_*", "search"]), false);
  assert.equal(matchesPattern("anything", null), true);

  assert.equal(
    formatToolResult({ content: [{ type: "text", text: "hi" }, { type: "image", data: "AAAA", mimeType: "image/png" }] }),
    "hi\n[image image/png, 3 bytes, not shown]"
  );
  assert.equal(formatToolResult({ isError: true, content: [{ type: "text", text: "nope" }] }), "Error from the MCP tool: nope");
  assert.equal(formatToolResult({ content: [], structuredContent: { a: 1 } }), '{\n  "a": 1\n}');
});

test("config: ${VAR} expansion and validation", () => {
  const missing = new Set();
  assert.deepEqual(expandEnv({ h: "Bearer ${TOKEN}", list: ["${NOPE}x"] }, { TOKEN: "abc" }, missing), { h: "Bearer abc", list: ["x"] });
  assert.deepEqual([...missing], ["NOPE"]);

  userConfig({ broken: { command: "a", url: "http://x" } });
  return assert.rejects(loadMcpServers(process.cwd()), /needs either "command"/);
});

test("project .mcp.json servers need trust, and trust is remembered until the config changes", async () => {
  userConfig({});
  const cwd = mkdtempSync(path.join(os.tmpdir(), "devpilot-"));
  writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { proj: { command: "node", args: ["s.js"] } } }));

  const questions = [];
  const answer = (reply) => async (q) => (questions.push(q), reply);

  let result = await loadMcpServers(cwd, { ask: answer("n") });
  assert.deepEqual(result.skipped, [{ name: "proj", reason: "not trusted" }]);

  result = await loadMcpServers(cwd, { ask: answer("y") });
  assert.equal(result.servers[0].name, "proj");

  result = await loadMcpServers(cwd, { ask: answer("n") }); // remembered: no question
  assert.equal(result.servers.length, 1);
  assert.equal(questions.length, 2);

  writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { proj: { command: "node", args: ["evil.js"] } } }));
  result = await loadMcpServers(cwd, { ask: answer("n") }); // changed: asks again
  assert.equal(result.servers.length, 0);
  assert.equal(questions.length, 3);

  result = await loadMcpServers(cwd); // non-interactive: never trusted silently
  assert.equal(result.servers.length, 0);
});

test("stdio server: tools become DevPilot tools with permissions, plan mode and allow-lists", async () => {
  userConfig({ fx: fixtureServer({ env: { FIXTURE_INSTRUCTIONS: "Fixture rules." } }), off: { command: "x", disabled: true } });
  const mcp = await connectMcpServers({ cwd: process.cwd() });
  try {
    const [server] = mcp.servers;
    assert.equal(server.status, "connected", server.error);
    assert.deepEqual(mcp.skipped, [{ name: "off", reason: "disabled" }]);

    // Both pages of tools/list, plus the two resource tools.
    const names = mcp.tools.map((t) => t.name);
    assert.deepEqual(names, ["mcp__fx__echo", "mcp__fx__add", "mcp__fx__fail", "mcp__fx__slow", "mcp_list_resources", "mcp_read_resource"]);
    assert.match(mcp.promptSection(), /## fx \(fixture\)[\s\S]*Fixture rules\./);

    const { registerTools } = await import("../src/tools/index.js");
    registerTools(mcp.tools);

    // A normal call asks first; the server's ping was answered.
    const asked = [];
    const result = await executeToolCall(call("mcp__fx__echo", { message: null }), ctx({ approve: async (r) => (asked.push(r.title), { allowed: true }) }));
    assert.equal(result, "echo: null (ping answered: true)");
    assert.deepEqual(asked, ["MCP fx · echo"]);

    assert.equal(await executeToolCall(call("mcp__fx__add", { a: 2, b: 3 }), ctx()), '{\n  "sum": 5\n}');
    assert.equal(await executeToolCall(call("mcp__fx__fail", {}), ctx()), "Error from the MCP tool: something broke");

    // Declined, denied, allowed.
    const declined = await executeToolCall(call("mcp__fx__add", { a: 1, b: 1 }), ctx({ approve: async () => ({ allowed: false, message: "The user declined." }) }));
    assert.equal(declined, "The user declined.");
    const denied = await executeToolCall(call("mcp__fx__add", { a: 1, b: 1 }), ctx({ settings: { allow: [], deny: ["mcp__fx__*"] } }));
    assert.match(denied, /^Blocked: "mcp__fx__\*" is on the deny list/);
    let prompted = false;
    await executeToolCall(call("mcp__fx__add", { a: 1, b: 1 }), ctx({ settings: { allow: ["mcp__fx__add"], deny: [] }, approve: async () => ((prompted = true), { allowed: true }) }));
    assert.equal(prompted, false);

    // Plan mode: only tools the server marks read-only.
    const plan = ctx({ state: { mode: "plan" } });
    assert.match(await executeToolCall(call("mcp__fx__add", { a: 1, b: 2 }), plan), /plan mode is on/);
    assert.match(await executeToolCall(call("mcp__fx__echo", { message: "x" }), plan), /^echo: x/);

    // Resources.
    assert.match(await executeToolCall(call("mcp_list_resources", {}), ctx()), /fixture:\/\/readme · README/);
    assert.equal(await executeToolCall(call("mcp_read_resource", { server: "fx", uri: "fixture://readme" }), ctx()), "Fixture readme text.");

    // Ctrl+C during a slow call.
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    assert.equal(await executeToolCall(call("mcp__fx__slow", {}), ctx({ signal: controller.signal })), "Cancelled by the user.");
    assert.ok(Date.now() - started < 2000);
  } finally {
    await mcp.close();
  }
});

test("a broken server is reported, not fatal", async () => {
  userConfig({ good: fixtureServer({ tools: ["echo"] }), bad: { command: process.execPath, args: ["-e", "console.error('no token'); process.exit(1)"] } });
  const mcp = await connectMcpServers({ cwd: process.cwd() });
  try {
    const bad = mcp.servers.find((s) => s.name === "bad");
    const good = mcp.servers.find((s) => s.name === "good");
    assert.equal(bad.status, "failed");
    assert.match(bad.error, /exited \(code 1\)[\s\S]*no token/);
    assert.equal(good.status, "connected");
    assert.deepEqual(good.tools.map((t) => t.name), ["mcp__good__echo"]);
    assert.equal(good.hiddenTools, 3);
  } finally {
    await mcp.close();
  }
});

test("Streamable HTTP: JSON and SSE replies, session id, headers, DELETE on close", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, session: req.headers["mcp-session-id"], auth: req.headers.authorization, version: req.headers["mcp-protocol-version"] });
      if (req.method === "DELETE") return res.end();
      const msg = JSON.parse(body);
      if (msg.id === undefined) {
        res.statusCode = 202;
        return res.end();
      }
      if (msg.method === "initialize") {
        res.setHeader("Mcp-Session-Id", "sess-1");
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "h" } } }));
      }
      // Reply as an event stream, split oddly, with a notification first.
      res.setHeader("Content-Type", "text/event-stream");
      res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n');
      const reply = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "t", inputSchema: { type: "object" } }] } });
      res.write(`data: ${reply.slice(0, 10)}`);
      setTimeout(() => res.end(`${reply.slice(10)}\n\n`), 20);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;

  const client = new McpClient("h", new HttpTransport({ url, headers: { Authorization: "Bearer t0k" } }));
  try {
    await client.connect();
    assert.equal(client.protocolVersion, "2025-06-18");
    assert.deepEqual((await client.listTools()).map((t) => t.name), ["t"]);
    await client.close();
  } finally {
    server.close();
  }

  assert.equal(seen[0].session, undefined);
  assert.ok(seen.slice(1).every((s) => s.session === "sess-1" && s.auth === "Bearer t0k"));
  assert.equal(seen[2].version, "2025-06-18");
  assert.equal(seen.at(-1).method, "DELETE");
  assert.equal(existsSync(path.join(home, ".devpilot", "mcp-trust.json")), true); // from the earlier trust test
});
