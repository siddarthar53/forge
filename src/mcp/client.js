import { spawn } from "node:child_process";

// A small MCP client, written by hand so every line can be explained.
//
// MCP (Model Context Protocol) is JSON-RPC 2.0 between DevPilot (the client)
// and a server that offers tools. Three kinds of messages:
//
//   request       { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }
//   response      { jsonrpc: "2.0", id: 1, result: {...} }   or  { ..., error: {code, message} }
//   notification  { jsonrpc: "2.0", method: "notifications/initialized" }   (no id, no reply)
//
// A session always starts with a handshake:
//
//   client -> initialize { protocolVersion, capabilities, clientInfo }
//   server <- { protocolVersion, capabilities, serverInfo, instructions? }
//   client -> notifications/initialized
//
// After that we only need tools/list, tools/call, resources/list and
// resources/read. The transport (how bytes travel) is separate:
//   stdio: we start the server as a child process, one JSON message per line
//   http:  "Streamable HTTP", each message is a POST; the reply is JSON or
//          a short Server-Sent Events stream

export const PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_VERSIONS = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);

const DEFAULT_TIMEOUT_MS = 60_000;

export class McpError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// ------------------------------------------------------------------- stdio

const MAX_STDERR_CHARS = 4000;

// Windows starts `npx`, `uvx` and friends through .cmd shims, which spawn()
// can only run through the shell. Quote arguments that contain spaces.
function spawnArgs(command, args) {
  if (process.platform !== "win32") return [command, args, {}];
  const quote = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  return [quote(command), args.map(quote), { shell: true }];
}

export class StdioTransport {
  constructor({ command, args = [], env = {}, cwd }) {
    this.description = [command, ...args].join(" ");
    this.options = { command, args, env, cwd };
    this.stderr = "";
    this.closed = false;
  }

  start(onMessage, onClose) {
    const { command, args, env, cwd } = this.options;
    const [program, programArgs, extra] = spawnArgs(command, args);
    this.child = spawn(program, programArgs, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...extra,
    });

    // stdout carries newline-delimited JSON. A chunk can end mid-line, so
    // keep the unfinished part until the next chunk arrives.
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          onMessage(JSON.parse(line));
        } catch {
          // Not JSON: some servers print banners to stdout. Ignore them.
        }
      }
    });

    // stderr is the server's log. Keep the tail for error messages and /mcp.
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_STDERR_CHARS);
    });

    return new Promise((resolve, reject) => {
      this.child.once("spawn", resolve);
      this.child.once("error", (err) => reject(new McpError(`could not start "${command}": ${err.message}`)));
      this.child.once("exit", (code, signal) => {
        this.closed = true;
        onClose(`the server process exited (${signal ?? `code ${code}`})`);
      });
    });
  }

  async send(message) {
    if (this.closed || !this.child.stdin.writable) throw new McpError("the server process is not running");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  async close() {
    if (this.closed || !this.child) return;
    this.child.stdin.end(); // well-behaved servers exit on end-of-input
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 2000);
    await exited;
    clearTimeout(timer);
  }
}

// --------------------------------------------------------- streamable HTTP

// Read a text/event-stream body. Events are separated by a blank line; each
// `data:` line is part of the event's payload.
async function readEventStream(body, onEvent) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let end;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) onEvent(data);
    }
  }
}

export class HttpTransport {
  constructor({ url, headers = {} }) {
    this.description = url;
    this.url = url;
    this.headers = headers;
    this.sessionId = null;
    this.protocolVersion = null;
    this.closed = false;
    this.stderr = "";
  }

  async start(onMessage) {
    this.onMessage = onMessage;
  }

  async send(message, signal) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.headers,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    if (this.protocolVersion) headers["MCP-Protocol-Version"] = this.protocolVersion;

    let response;
    try {
      response = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(message), signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new McpError(`could not reach ${this.url}: ${err.cause?.code ?? err.message}`);
    }

    // The server hands out a session id during initialize; send it back from now on.
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;

    if (response.status === 202) return; // accepted a notification or response
    if (!response.ok) {
      const text = (await response.text().catch(() => "")).slice(0, 300);
      if (response.status === 401 || response.status === 403) {
        throw new McpError(`${this.url} refused the request (HTTP ${response.status}); check the server's "headers" (e.g. an Authorization token)`);
      }
      if (response.status === 404 && this.sessionId) {
        throw new McpError("the server ended the session (HTTP 404); restart DevPilot to reconnect");
      }
      throw new McpError(`HTTP ${response.status} from ${this.url}${text ? `: ${text}` : ""}`);
    }

    const type = response.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream")) {
      await readEventStream(response.body, (data) => {
        try {
          this.onMessage(JSON.parse(data));
        } catch {
          // ignore malformed events
        }
      });
    } else if (type.includes("application/json")) {
      const payload = await response.json();
      for (const item of Array.isArray(payload) ? payload : [payload]) this.onMessage(item);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.sessionId) return;
    // Tell the server we are done. Servers may not support DELETE; that's fine.
    await fetch(this.url, {
      method: "DELETE",
      headers: { ...this.headers, "Mcp-Session-Id": this.sessionId },
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  }
}

// ------------------------------------------------------------------ client

export class McpClient {
  constructor(name, transport, { clientVersion = "0.0.0" } = {}) {
    this.name = name;
    this.transport = transport;
    this.clientVersion = clientVersion;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject }
    this.serverInfo = null;
    this.capabilities = {};
    this.instructions = null;
    this.toolsChanged = false;
    this.closedReason = null;
  }

  async connect({ timeoutMs = 30_000 } = {}) {
    await this.transport.start(
      (message) => this.#handle(message),
      (reason) => this.#onClosed(reason)
    );

    const result = await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {}, // we offer the server nothing extra (no sampling, no roots)
        clientInfo: { name: "devpilot", version: this.clientVersion },
      },
      { timeoutMs }
    );

    if (!SUPPORTED_VERSIONS.has(result.protocolVersion)) {
      throw new McpError(`the server wants protocol version ${result.protocolVersion}, which DevPilot does not support`);
    }
    if (this.transport instanceof HttpTransport) this.transport.protocolVersion = result.protocolVersion;

    this.protocolVersion = result.protocolVersion;
    this.serverInfo = result.serverInfo ?? null;
    this.capabilities = result.capabilities ?? {};
    this.instructions = typeof result.instructions === "string" ? result.instructions : null;

    await this.notify("notifications/initialized");
    return result;
  }

  request(method, params = {}, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (this.closedReason) return Promise.reject(new McpError(`not connected: ${this.closedReason}`));

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        fn(value);
      };
      const timer = setTimeout(() => {
        this.notify("notifications/cancelled", { requestId: id, reason: "timeout" }).catch(() => {});
        finish(reject, new McpError(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      // Ctrl+C: tell the server to stop working on it, then give up locally.
      const onAbort = () => {
        this.notify("notifications/cancelled", { requestId: id, reason: "cancelled by the user" }).catch(() => {});
        finish(reject, Object.assign(new Error("cancelled"), { name: "AbortError" }));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(id, {
        resolve: (value) => finish(resolve, value),
        reject: (err) => finish(reject, err),
      });
      this.transport.send({ jsonrpc: "2.0", id, method, params }, signal).catch((err) => {
        if (this.pending.has(id)) this.pending.get(id).reject(err);
      });
    });
  }

  notify(method, params) {
    const message = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    return this.transport.send(message);
  }

  // Follow `nextCursor` until the server has sent everything.
  async listAll(method, key, options) {
    const items = [];
    let cursor;
    for (let page = 0; page < 100; page++) {
      const result = await this.request(method, cursor ? { cursor } : {}, options);
      items.push(...(result[key] ?? []));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return items;
  }

  listTools(options) {
    return this.listAll("tools/list", "tools", options);
  }

  callTool(name, args, options) {
    return this.request("tools/call", { name, arguments: args }, options);
  }

  listResources(options) {
    return this.listAll("resources/list", "resources", options);
  }

  readResource(uri, options) {
    return this.request("resources/read", { uri }, options);
  }

  async close() {
    this.#onClosed("closed by DevPilot");
    await this.transport.close();
  }

  #onClosed(reason) {
    if (this.closedReason) return;
    this.closedReason = reason;
    const stderr = this.transport.stderr?.trim();
    for (const { reject } of this.pending.values()) {
      reject(new McpError(`${reason}${stderr ? `\n${stderr.split("\n").slice(-5).join("\n")}` : ""}`));
    }
    this.pending.clear();
  }

  #handle(message) {
    // A response to one of our requests.
    if (message.id !== undefined && message.method === undefined) {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      if (message.error) waiting.reject(new McpError(message.error.message ?? "unknown error", message.error.code));
      else waiting.resolve(message.result ?? {});
      return;
    }

    // A request from the server. We answer ping; everything else (sampling,
    // roots, elicitation) we did not offer during initialize, so we refuse it.
    if (message.id !== undefined) {
      const reply =
        message.method === "ping"
          ? { jsonrpc: "2.0", id: message.id, result: {} }
          : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `DevPilot does not support ${message.method}` } };
      this.transport.send(reply).catch(() => {});
      return;
    }

    // Notifications. The tool list sent to the model must stay the same for
    // the whole session (prompt caching), so a changed list is only noted.
    if (message.method === "notifications/tools/list_changed") this.toolsChanged = true;
  }
}
