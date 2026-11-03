// @ts-check
"use strict";

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { existsSync } = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

// Runs `devpilot --rpc` as a child process and speaks its JSON-lines
// protocol (see src/rpc.js in the DevPilot repo). It knows nothing about
// VS Code, so it can be tested with plain Node.
//
//   const agent = new AgentProcess({ cliPath, cwd, env });
//   agent.on("event", (e) => ...);     // every message DevPilot sends
//   agent.on("exit", ({ code, stderr, fatal }) => ...);
//   agent.start();
//   agent.send({ type: "prompt", text: "fix the bug" });

const MAX_STDERR_CHARS = 8000;

/**
 * Where DevPilot's index.js is: an explicit setting, the copy bundled into
 * the extension (`npm run bundle-agent`), or the repository the extension
 * folder sits in (when you run it from source).
 * @param {{ setting?: string, extensionPath: string }} options
 * @returns {string | null}
 */
function resolveCliPath({ setting, extensionPath }) {
  const candidates = [
    setting ? path.resolve(setting) : null,
    path.join(extensionPath, "agent", "index.js"),
    path.join(extensionPath, "..", "index.js"),
  ].filter(Boolean);
  for (const candidate of /** @type {string[]} */ (candidates)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

class AgentProcess extends EventEmitter {
  /**
   * @param {{ cliPath: string, cwd: string, nodePath?: string, env?: Record<string, string | undefined> }} options
   */
  constructor({ cliPath, cwd, nodePath = "node", env = {} }) {
    super();
    this.cliPath = cliPath;
    this.cwd = cwd;
    this.nodePath = nodePath;
    this.env = env;
    /** @type {import("node:child_process").ChildProcess | null} */
    this.child = null;
    this.stderr = "";
    /** @type {string | null} */
    this.fatal = null;
    this.ready = null; // the "ready" event, once it arrived
  }

  get running() {
    return this.child !== null;
  }

  start() {
    if (this.child) return;
    this.stderr = "";
    this.fatal = null;
    this.ready = null;

    const child = spawn(this.nodePath, [this.cliPath, "--rpc"], {
      cwd: this.cwd,
      env: { ...process.env, ...this.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    readline.createInterface({ input: /** @type {NodeJS.ReadableStream} */ (child.stdout) }).on("line", (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        this.stderr = (this.stderr + line + "\n").slice(-MAX_STDERR_CHARS);
        return;
      }
      if (event.type === "ready") this.ready = event;
      if (event.type === "fatal") this.fatal = event.message;
      this.emit("event", event);
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_STDERR_CHARS);
      this.emit("stderr", chunk);
    });

    child.on("error", (err) => {
      // e.g. "node" not found
      this.fatal ??= `Could not start ${this.nodePath}: ${err.message}`;
    });
    child.on("close", (code, signal) => {
      this.child = null;
      this.emit("exit", { code, signal, stderr: this.stderr, fatal: this.fatal });
    });
  }

  /** @param {object} message */
  send(message) {
    if (!this.child?.stdin?.writable) return false;
    this.child.stdin.write(JSON.stringify(message) + "\n");
    return true;
  }

  /** Ask DevPilot to finish (it closes MCP servers), then make sure it is gone. */
  async stop(timeoutMs = 3000) {
    const child = this.child;
    if (!child) return;
    const exited = new Promise((resolve) => child.once("close", resolve));
    this.send({ type: "shutdown" });
    child.stdin?.end();
    const timer = setTimeout(() => child.kill(), timeoutMs);
    await exited;
    clearTimeout(timer);
  }
}

module.exports = { AgentProcess, resolveCliPath };
