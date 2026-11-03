// A tiny MCP server for tests, speaking newline-delimited JSON-RPC on stdio.
// Tools: echo (read-only), add, fail, slow; one resource; paginated tools/list.
// Right after initialization it sends the client a ping, like real servers may.
import readline from "node:readline";

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

const TOOLS = [
  {
    name: "echo",
    description: "Echo the message back.",
    inputSchema: { type: "object", properties: { message: { type: ["string", "null"] } }, required: ["message"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "add",
    description: "Add two numbers.",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
  },
  { name: "fail", description: "Always fails.", inputSchema: { type: "object" } },
  { name: "slow", description: "Takes 5 seconds.", inputSchema: { type: "object" } },
];

let pingAnswered = false;

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method, params } = message;

  if (method === undefined) {
    if (id === "server-ping" && message.result) pingAnswered = true;
    return;
  }
  if (method === "notifications/initialized") {
    send({ id: "server-ping", method: "ping" });
    return;
  }
  if (method.startsWith("notifications/")) return;

  if (method === "initialize") {
    send({
      id,
      result: {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "fixture", version: "1.0.0" },
        instructions: process.env.FIXTURE_INSTRUCTIONS ?? "Use echo to test things.",
      },
    });
  } else if (method === "tools/list") {
    // Two pages, to exercise cursors.
    if (!params?.cursor) send({ id, result: { tools: TOOLS.slice(0, 2), nextCursor: "page2" } });
    else send({ id, result: { tools: TOOLS.slice(2) } });
  } else if (method === "tools/call") {
    const args = params.arguments ?? {};
    if (params.name === "echo") send({ id, result: { content: [{ type: "text", text: `echo: ${args.message} (ping answered: ${pingAnswered})` }] } });
    else if (params.name === "add") send({ id, result: { content: [], structuredContent: { sum: args.a + args.b } } });
    else if (params.name === "fail") send({ id, result: { isError: true, content: [{ type: "text", text: "something broke" }] } });
    else if (params.name === "slow") setTimeout(() => send({ id, result: { content: [{ type: "text", text: "done" }] } }), 5000);
    else send({ id, error: { code: -32602, message: `unknown tool ${params.name}` } });
  } else if (method === "resources/list") {
    send({ id, result: { resources: [{ uri: "fixture://readme", name: "README", mimeType: "text/plain" }] } });
  } else if (method === "resources/read") {
    send({ id, result: { contents: [{ uri: params.uri, text: "Fixture readme text." }] } });
  } else {
    send({ id, error: { code: -32601, message: `no method ${method}` } });
  }
});
