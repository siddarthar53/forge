import { existsSync } from "node:fs";
import path from "node:path";
import { runAgent, terminalReporter } from "./agent.js";
import { createCheckpoints } from "./checkpoints.js";
import { isCommand, runCommand } from "./commands.js";
import { contextStatus, fetchModelInfo } from "./context.js";
import { currentBranch, ensureWorkBranch } from "./git.js";
import { connectMcpServers } from "./mcp/index.js";
import { PLAN_MODE_REMINDER, buildSystemPrompt } from "./prompt.js";
import { createSession, listSessions } from "./session.js";
import { loadSettings } from "./settings.js";
import { createTaskTool, loadAgents } from "./subagents.js";
import { registerTools } from "./tools/index.js";
import { prepareSandbox } from "./tools/shell.js";
import { renderTodos } from "./tools/todo.js";
import { color, truncate } from "./ui.js";

// The DevPilot "app": everything except the user interface.
//
//   terminal  (chat.js)  ─┐
//                         ├─► createApp() ─► agent loop, tools, sessions, commands
//   VS Code   (rpc.js)   ─┘
//
// A front end gives it three things:
//   ask(question, signal)      -> the user's typed answer (commit prompts, /resume, MCP trust)
//   approve(request, signal)   -> { allowed, message } for edits and commands
//   reporter                   -> how agent output is shown (see agent.js)
// and may set app.onTurnEnd to show the status after each turn.

// Which session file to open at startup, from --continue / --resume.
async function pickStartupSession(cwd, resume, ask) {
  if (!resume) return null;

  if (resume === "latest" || resume === "pick") {
    const sessions = listSessions(cwd);
    if (sessions.length === 0) {
      console.log(color.yellow("No saved sessions in this folder; starting a new one."));
      return null;
    }
    if (resume === "latest") return sessions[0].file;

    sessions.forEach((s, i) =>
      console.log(`  ${color.bold(String(i + 1).padStart(2))}. ${color.dim(s.modified.toLocaleString())}  ${s.title}`)
    );
    const answer = (await ask("Resume which session? (number, Enter for a new one) ")).trim();
    return sessions[Number(answer) - 1]?.file ?? null;
  }

  const file = path.resolve(resume);
  if (!existsSync(file)) throw new Error(`Session file not found: ${file}`);
  return file;
}

export async function createApp({ client, config, cwd = process.cwd(), ask, approve, reporter = terminalReporter, printTodos = true }) {
  const settings = loadSettings(cwd);
  if (config.sandbox) prepareSandbox(config.sandbox);

  // Runtime state that is not part of the conversation history.
  const state = {
    model: config.model,
    mode: "default", // or "plan"
    modelInfo: await fetchModelInfo({ ...config, contextWindowOverride: config.contextWindow }),
  };

  // MCP servers start before the first model call: their tools become part
  // of the (fixed) tool list and their instructions part of the system prompt.
  const mcp = await connectMcpServers({ cwd, ask });
  registerTools(mcp.tools);

  // Sub-agents pick their tools from everything registered so far (built-in
  // and MCP); then the task tool that starts them is added last.
  const agents = loadAgents(cwd);
  registerTools([createTaskTool(agents.agents)]);

  const systemPrompt = buildSystemPrompt({ cwd, sandbox: config.sandbox, extraSections: [mcp.promptSection()] });
  const checkpoints = createCheckpoints();

  // Files the model has read, mapped to their modified-time at that moment.
  // Lives for the whole conversation so edits in later turns can use earlier reads.
  const readFiles = new Map();

  // The AbortController of whatever is running now (a turn, /compact, /test).
  let currentTurn = null;

  async function withTurn(fn) {
    const previous = currentTurn; // /test runs turns inside its own turn
    const controller = new AbortController();
    currentTurn = controller;
    try {
      return await fn(controller.signal);
    } finally {
      currentTurn = previous;
    }
  }

  // Called right before a file tool writes (see files.js → applyChange).
  let branchChecked = false;
  async function beforeWrite(absolute) {
    await checkpoints.record(absolute);
    if (!config.autoBranch || branchChecked) return null;
    branchChecked = true;
    try {
      const branch = await ensureWorkBranch(cwd);
      if (branch) {
        console.log(color.cyan(`  ⎇ Switched to a new branch ${color.bold(branch)} so your main branch stays clean.`));
        return `Note: before this change DevPilot created and switched to the git branch "${branch}".`;
      }
    } catch (err) {
      console.log(color.yellow(`  Could not create a work branch: ${err.message}`));
    }
    return null;
  }

  // One user turn: the message, then the agent loop until it stops.
  // `text` is what the user typed; `extra` is context added by the front end
  // (e.g. the open file in VS Code), sent to the model but not shown as typed.
  async function runTurn(text, { extra = null } = {}) {
    const { session } = app;
    let content = extra ? `${text}\n\n${extra}` : text;
    if (state.mode === "plan") content += `\n\n${PLAN_MODE_REMINDER}`;

    return withTurn(async (signal) => {
      checkpoints.begin({ messageIndex: session.messages.length, prompt: text });
      session.addMessage({ role: "user", content });
      console.log();

      let status;
      try {
        ({ status } = await runAgent({
          client,
          session,
          state,
          maxSteps: config.maxSteps,
          compactAt: config.compactAt,
          onCompact: app.historyWasReset,
          reporter,
          toolContext: {
            cwd,
            signal,
            readFiles,
            approve,
            settings,
            state,
            session,
            sandbox: config.sandbox,
            beforeWrite,
            client, // sub-agents make their own model calls
            config,
            printTodos,
          },
        }));
        if (status === "max_steps") {
          console.log(color.yellow(`[stopped after ${config.maxSteps} steps; send a message to let it continue]`));
        }
      } catch (err) {
        // API failures (bad key, rate limit, network) end the turn, not the app.
        // The SDK has already retried transient errors twice by this point.
        status = signal.aborted ? "interrupted" : "error";
        if (!signal.aborted) {
          console.error(color.red(`\nError: ${err.message}`));
          session.logEvent("error", { message: err.message, status: err.status });
        }
      }
      console.log();
      app.onTurnEnd?.(status);
      return status;
    });
  }

  // Everything the slash commands need, in one place.
  const app = {
    cwd,
    client,
    config,
    settings,
    state,
    checkpoints,
    readFiles,
    ask,
    approve,
    mcp,
    agents,
    session: null,
    onTurnEnd: null,
    withTurn,
    runTurn,

    // Handle one line from the user: a slash command or a message.
    // Returns "exit" when the user asked to quit.
    async submit(line, options) {
      if (isCommand(line)) return runCommand(app, line);
      await runTurn(line, options);
      return null;
    },

    // Ctrl+C / the Stop button. Returns false when nothing was running.
    abort() {
      if (!currentTurn) return false;
      currentTurn.abort();
      return true;
    },

    get busy() {
      return currentTurn !== null;
    },

    // A fresh conversation, or a saved one when `resumeFile` is given.
    newSession(resumeFile = null) {
      app.session = createSession({ cwd, model: state.model, systemPrompt, resumeFile });
      checkpoints.clear();
      readFiles.clear();
    },

    // History was rewritten (compaction): old checkpoints can no longer
    // rewind the conversation, and the model no longer has file contents in
    // view, so it must read files again before editing them.
    historyWasReset() {
      checkpoints.historyWasReset();
      readFiles.clear();
    },

    // After resuming: show where the conversation left off.
    printRecap() {
      const lastReply = [...app.session.messages].reverse().find((m) => m.role === "assistant" && m.content);
      if (lastReply) console.log(color.dim(`Last reply: ${truncate(lastReply.content, 160)}`));
      if (app.session.todos.length) console.log(renderTodos(app.session.todos));
    },

    // Numbers for a status line or the VS Code footer.
    async status() {
      const { tokens, window, percent } = contextStatus(app.session, state);
      return {
        model: state.model,
        mode: state.mode,
        tokens,
        window,
        percent,
        cost: app.session.usage.cost,
        costIsEstimate: app.session.usage.costIsEstimate,
        branch: await currentBranch(cwd),
        busy: app.busy,
      };
    },

    async close() {
      app.abort();
      await mcp.close();
      app.session?.logEvent("session_end");
    },
  };

  app.newSession(await pickStartupSession(cwd, config.resume, ask));
  return app;
}
