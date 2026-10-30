import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// A session holds the conversation history (what we send to the model)
// and mirrors every change into a JSONL log file on disk.
//
// JSONL = one JSON object per line. It is append-only, so a crash never
// corrupts earlier lines, and it is easy to read back later (Tier 2: resume).
export function createSession({ cwd, model, systemPrompt }) {
  const dir = path.join(cwd, ".devpilot", "sessions");
  mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(dir, `${stamp}.jsonl`);

  function logEvent(type, data = {}) {
    const entry = { time: new Date().toISOString(), type, ...data };
    appendFileSync(logFile, JSON.stringify(entry) + "\n");
  }

  const messages = [];

  // Every message goes through here, so the log never misses one.
  function addMessage(message) {
    messages.push(message);
    logEvent("message", { message });
  }

  logEvent("session_start", { cwd, model });
  addMessage({ role: "system", content: systemPrompt });

  return { messages, addMessage, logEvent, logFile };
}
