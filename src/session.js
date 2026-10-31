import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { addUsage, costOf, emptyUsage, estimateTokens } from "./context.js";

// A session holds the conversation history (what we send to the model)
// and mirrors every change into a JSONL log file on disk.
//
// JSONL = one JSON object per line. It is append-only, so a crash never
// corrupts earlier lines, and it can be replayed to resume a session:
//
//   {"type":"message", "message":{...}}     push one message
//   {"type":"reset",   "messages":[...]}    history was rewritten (compact, undo)
//   {"type":"system",  "content":"..."}     new system prompt (on resume)
//   {"type":"todos",   "todos":[...]}       the todo list changed
//   {"type":"usage",   "usage":{...}, ...}  tokens and cost of one API call
//
// Replaying those events in order rebuilds exactly what the model last saw.

export function sessionsDir(cwd) {
  return path.join(cwd, ".devpilot", "sessions");
}

export function createSession({ cwd, model, systemPrompt, resumeFile = null }) {
  const dir = sessionsDir(cwd);
  mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = resumeFile ?? path.join(dir, `${stamp}.jsonl`);

  function logEvent(type, data = {}) {
    const entry = { time: new Date().toISOString(), type, ...data };
    appendFileSync(logFile, JSON.stringify(entry) + "\n");
  }

  const messages = [];
  const usage = emptyUsage();
  let todos = [];

  // Context tracking (see context.js): the exact token count the API reported
  // after its last call, and how many messages the history had at that point.
  let knownTokens = 0;
  let knownLength = 0;

  // Every message goes through here, so the log never misses one.
  function addMessage(message) {
    messages.push(message);
    logEvent("message", { message });
  }

  // Rewrite the whole history. `splice` keeps the same array object, so code
  // holding a reference to `session.messages` sees the new contents.
  function replaceMessages(newMessages, reason) {
    messages.splice(0, messages.length, ...newMessages);
    knownTokens = 0;
    knownLength = 0;
    logEvent("reset", { reason, messages: newMessages });
  }

  function setTodos(list) {
    todos = list;
    logEvent("todos", { todos });
  }

  // Called after every API call with its usage report.
  function recordUsage(report, pricing, { updateContext = true } = {}) {
    const { cost, estimated } = costOf(report, pricing);
    addUsage(usage, report, cost, estimated);
    logEvent("usage", { usage: report, cost, estimated });

    if (updateContext) {
      knownTokens = (report.prompt_tokens ?? 0) + (report.completion_tokens ?? 0);
      knownLength = messages.length; // includes the reply that was just added
    }
  }

  function estimateContextTokens(toolTokens = 0) {
    if (knownLength > 0 && knownLength <= messages.length) {
      const added = messages.slice(knownLength);
      return knownTokens + (added.length ? estimateTokens(added) : 0);
    }
    return toolTokens + estimateTokens(messages);
  }

  if (resumeFile) {
    const replayed = replayLog(resumeFile);
    messages.push(...replayed.messages);
    todos = replayed.todos;
    Object.assign(usage, replayed.usage);

    logEvent("session_resume", { cwd, model });

    // The environment may have changed since (date, git branch): use a fresh
    // system prompt. It is logged as its own small event.
    if (messages[0]?.role === "system") messages[0] = { role: "system", content: systemPrompt };
    else messages.unshift({ role: "system", content: systemPrompt });
    logEvent("system", { content: systemPrompt });

    // If DevPilot was killed in the middle of running tools, some tool calls
    // have no result. The API rejects such a history, so fill the gaps.
    const repaired = repairHistory(messages);
    if (repaired !== messages) replaceMessages(repaired, "repair");
  } else {
    logEvent("session_start", { cwd, model });
    addMessage({ role: "system", content: systemPrompt });
  }

  return {
    messages,
    logFile,
    usage,
    get todos() {
      return todos;
    },
    addMessage,
    replaceMessages,
    setTodos,
    recordUsage,
    estimateContextTokens,
    logEvent,
  };
}

// Rebuild messages, todos and usage totals from a session log.
export function replayLog(file) {
  let messages = [];
  let todos = [];
  const usage = emptyUsage();

  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // a half-written last line after a crash
    }

    if (event.type === "message") messages.push(event.message);
    else if (event.type === "reset") messages = [...event.messages];
    else if (event.type === "system" && messages[0]?.role === "system")
      messages[0] = { role: "system", content: event.content };
    else if (event.type === "todos") todos = event.todos;
    else if (event.type === "usage") addUsage(usage, event.usage, event.cost ?? 0, event.estimated);
  }
  return { messages, todos, usage };
}

// Every assistant tool call must be followed by a tool message with its id.
// Returns the same array if nothing was missing, otherwise a fixed copy.
export function repairHistory(messages) {
  const fixed = [];
  let changed = false;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    fixed.push(message);
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;

    const answered = new Set();
    for (let j = i + 1; j < messages.length && messages[j].role === "tool"; j++) {
      answered.add(messages[j].tool_call_id);
    }

    // Copy this message's tool results, then add any that are missing.
    let j = i + 1;
    for (; j < messages.length && messages[j].role === "tool"; j++) fixed.push(messages[j]);
    for (const call of message.tool_calls) {
      if (!answered.has(call.id)) {
        changed = true;
        fixed.push({
          role: "tool",
          tool_call_id: call.id,
          content: "Cancelled: DevPilot stopped before this tool finished.",
        });
      }
    }
    i = j - 1;
  }
  return changed ? fixed : messages;
}

// Newest first, with the first user message as a title.
export function listSessions(cwd, limit = 20) {
  const dir = sessionsDir(cwd);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const file = path.join(dir, name);
      return { file, modified: statSync(file).mtime };
    })
    .sort((a, b) => b.modified - a.modified)
    .slice(0, limit)
    .map((entry) => {
      const { messages } = replayLog(entry.file);
      const firstUser = messages.find((m) => m.role === "user" && typeof m.content === "string");
      return {
        ...entry,
        messageCount: messages.length,
        title: firstUser
          ? firstUser.content
              .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 70)
          : "(no messages)",
      };
    })
    .filter((entry) => entry.messageCount > 1); // skip sessions with only a system prompt
}
