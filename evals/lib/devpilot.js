import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { decide } from "./policy.js";

export const DEVPILOT_CLI = fileURLToPath(new URL("../../index.js", import.meta.url));

// Run one task through `devpilot --rpc` (see src/rpc.js) and collect what
// happened. DevPilot loads OPENROUTER_API_KEY and OPENROUTER_MODEL from its
// own .env; values in `env` win.
export function runDevPilot({ cwd, prompt, env = {}, approvals = {}, timeoutMs = 6 * 60_000, cli = DEVPILOT_CLI }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [cli, "--rpc"], {
      cwd,
      env: { ...process.env, NO_COLOR: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const record = {
      status: "running",
      ready: null,
      fatal: null,
      approvals: [], // { title, answer, by }
      questions: 0,
      errors: [],
      text: "",
      stderr: "",
    };
    const send = (message) => child.stdin.writable && child.stdin.write(JSON.stringify(message) + "\n");
    let finished = false;

    const finish = (status) => {
      if (finished) return;
      finished = true;
      record.status = status;
      clearTimeout(timer);
      send({ type: "shutdown" });
      child.stdin.end();
      setTimeout(() => child.kill(), 5000).unref();
    };

    const timer = setTimeout(() => {
      send({ type: "cancel" });
      setTimeout(() => finish("timeout"), 3000);
    }, timeoutMs);

    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      switch (event.type) {
        case "ready":
          record.ready = event;
          send({ type: "prompt", text: prompt });
          break;
        case "text":
          record.text += event.delta;
          break;
        case "tool_call":
          record.text = ""; // keep only the text after the last tool call
          break;
        case "approval_request": {
          const { answer, by } = decide(event, approvals);
          record.approvals.push({ title: event.title, answer, by });
          send({ type: "approval", id: event.id, answer });
          break;
        }
        case "question":
          record.questions++;
          send({ type: "answer", id: event.id, text: "" });
          break;
        case "error":
          record.errors.push(event.message);
          break;
        case "fatal":
          record.fatal = event.message;
          break;
        case "turn_end":
          if (record.status === "running") finish(event.status === "done" ? "done" : event.status);
          break;
      }
    });
    child.stderr.on("data", (chunk) => (record.stderr = (record.stderr + chunk).slice(-4000)));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!finished) record.status = record.fatal ? "fatal" : `exited (${code})`;
      record.durationMs = Date.now() - started;
      resolve(record);
    });
  });
}
