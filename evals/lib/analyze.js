import { readFileSync } from "node:fs";

// Turn one DevPilot session log (.devpilot/sessions/*.jsonl) into metrics.
//
// The log is append-only and records everything: every message (even ones a
// later compaction removed from the model's view), usage per API call,
// resets, todos and sub-agent runs. So unlike the live history, the log shows
// the whole trajectory of a session.

// Tool results are plain text, and DevPilot's failures use fixed wording.
// Order matters: the first pattern that matches wins.
const RESULT_KINDS = [
  ["cancelled", /^Cancelled by the user\./],
  ["declined", /^The user declined this action/],
  ["blocked", /^Blocked: /],
  ["unknown_tool", /^Error: unknown tool/],
  ["bad_json", /^Error: the tool arguments were not valid JSON/],
  ["schema", /^Error: (missing required argument|unknown argument|argument "|arguments must be)/],
  ["plan_mode", /^Error: plan mode is on/],
  ["edit_no_match", /^Error: old_string (was not found|appears \d+ times)/],
  ["not_read_first", /^Error: You must read_file this file before changing it/],
  ["stale_read", /^Error: The file changed since you last read it/],
  ["secret_refused", /^Error: Refusing to (read|change) a \.env file/],
  ["outside_workspace", /^Error: Path is outside the workspace/],
  ["other_error", /^Error: /],
];

const NUDGE = "[DevPilot: you have made this exact call";
const EDIT_TOOLS = new Set(["write_file", "edit_file"]);
// Commands that count as "ran the tests".
const TEST_COMMAND = /\b(npm (run )?test|npm t\b|node --test|npx (jest|vitest|mocha)|jest|vitest|mocha|pytest|go test|cargo test|mvn( -q)? test)\b/;

export function classifyResult(text) {
  for (const [kind, pattern] of RESULT_KINDS) if (pattern.test(text)) return kind;
  return "ok";
}

function parseArgs(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}

export function readEvents(file) {
  const events = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // a half-written last line after a crash
    }
  }
  return events;
}

export function analyzeEvents(events) {
  const m = {
    model: null,
    userMessages: 0,
    apiCalls: 0,
    usageLogged: false, // older logs (Tier 1) have no usage events
    assistantMessages: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cost: 0,
    costIsEstimate: false,
    toolCalls: 0,
    toolCallsByName: {},
    resultKinds: {},
    toolErrors: 0,
    nudges: 0,
    compactions: 0,
    undos: 0,
    subagents: 0,
    todoUpdates: 0,
    edits: 0,
    verifiedAfterLastEdit: null, // null = made no edits
    blockedCommands: [],
    declinedThenRetried: 0,
    shellCommands: [],
    failedCommands: 0, // run_shell results with a non-zero exit code or a timeout
    finalAnswer: "",
    durationMs: null,
  };

  const callsById = new Map(); // tool_call_id -> { name, args, key }
  const declinedKeys = new Set();
  const sequence = []; // tool calls in order: { name, args }
  let firstTime = null;
  let lastTime = null;

  for (const event of events) {
    if (event.time) {
      const t = Date.parse(event.time);
      if (Number.isFinite(t)) {
        firstTime = firstTime === null ? t : Math.min(firstTime, t);
        lastTime = lastTime === null ? t : Math.max(lastTime, t);
      }
    }
    if (event.type === "session_start" || event.type === "session_resume") m.model ??= event.model;
    if (event.type === "usage") {
      m.usageLogged = true;
      const u = event.usage ?? {};
      m.apiCalls += u.calls ?? 1;
      m.promptTokens += u.prompt_tokens ?? 0;
      m.completionTokens += u.completion_tokens ?? 0;
      m.cachedTokens += u.prompt_tokens_details?.cached_tokens ?? 0;
      m.cost += event.cost ?? 0;
      if (event.estimated) m.costIsEstimate = true;
    }
    if (event.type === "reset" && event.reason === "compact") m.compactions++;
    if (event.type === "reset" && event.reason === "undo") m.undos++;
    if (event.type === "subagent") m.subagents++;
    if (event.type === "todos") m.todoUpdates++;
    if (event.type !== "message") continue;

    const message = event.message;
    if (message.role === "user" && typeof message.content === "string") m.userMessages++;

    if (message.role === "assistant") {
      m.assistantMessages++;
      if (message.content) m.finalAnswer = message.content;
      for (const call of message.tool_calls ?? []) {
        const name = call.function?.name ?? "?";
        const args = parseArgs(call.function?.arguments);
        const key = `${name} ${call.function?.arguments ?? ""}`;
        m.toolCalls++;
        m.toolCallsByName[name] = (m.toolCallsByName[name] ?? 0) + 1;
        if (declinedKeys.has(key)) m.declinedThenRetried++;
        callsById.set(call.id, { name, args, key });
        sequence.push({ name, args });
        if (name === "run_shell" && args?.command) m.shellCommands.push(args.command);
      }
    }

    if (message.role === "tool") {
      const call = callsById.get(message.tool_call_id);
      const text = String(message.content ?? "");
      const kind = classifyResult(text);
      m.resultKinds[kind] = (m.resultKinds[kind] ?? 0) + 1;
      if (!["ok", "cancelled", "declined", "blocked"].includes(kind)) m.toolErrors++;
      if (text.includes(NUDGE)) m.nudges++;
      if (kind === "declined" && call) declinedKeys.add(call.key);
      if (kind === "blocked" && call?.args?.command) m.blockedCommands.push(call.args.command);
      if (call?.name === "run_shell" && kind === "ok" && /^(Exit code: [1-9]\d*|Command timed out)/.test(text)) m.failedCommands++;
      if (call && EDIT_TOOLS.has(call.name) && kind === "ok") call.edited = true;
    }
  }

  // Verification: after the last successful edit, did it run the tests?
  const editIndexes = [];
  sequence.forEach((s, i) => {
    if (EDIT_TOOLS.has(s.name)) editIndexes.push(i);
  });
  m.edits = [...callsById.values()].filter((c) => c.edited).length;
  if (editIndexes.length) {
    const after = sequence.slice(editIndexes.at(-1) + 1);
    m.verifiedAfterLastEdit = after.some((s) => s.name === "run_shell" && TEST_COMMAND.test(s.args?.command ?? ""));
  }

  if (!m.usageLogged) m.apiCalls = m.assistantMessages; // one reply per call
  m.toolErrorRate = m.toolCalls ? m.toolErrors / m.toolCalls : 0;
  m.cacheHitRate = m.promptTokens ? m.cachedTokens / m.promptTokens : 0;
  m.durationMs = firstTime !== null && lastTime !== null ? lastTime - firstTime : null;
  return m;
}

export function analyzeFile(file) {
  return { file, ...analyzeEvents(readEvents(file)) };
}
