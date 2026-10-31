import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runAgent } from "./agent.js";
import { createCheckpoints } from "./checkpoints.js";
import { isCommand, runCommand } from "./commands.js";
import { contextStatus, fetchModelInfo } from "./context.js";
import { ensureWorkBranch } from "./git.js";
import { createPermissions } from "./permissions.js";
import { PLAN_MODE_REMINDER, buildSystemPrompt } from "./prompt.js";
import { createSession, listSessions } from "./session.js";
import { loadSettings } from "./settings.js";
import { prepareSandbox } from "./tools/shell.js";
import { renderTodos } from "./tools/todo.js";
import { color, formatCost, formatTokens, truncate } from "./ui.js";

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

export async function startChat({ client, config }) {
  const cwd = process.cwd();
  const rl = readline.createInterface({ input, output });

  // rl.question accepts an AbortSignal, so Ctrl+C can cancel a pending
  // permission prompt as well as a running model call.
  const ask = (question, signal) => rl.question(question, signal ? { signal } : {});
  const approve = createPermissions({ ask });

  const settings = loadSettings(cwd);
  if (config.sandbox) prepareSandbox(config.sandbox);

  // Runtime state that is not part of the conversation history.
  const state = {
    model: config.model,
    mode: "default", // or "plan"
    modelInfo: await fetchModelInfo({ ...config, contextWindowOverride: config.contextWindow }),
  };

  const systemPrompt = buildSystemPrompt({ cwd, sandbox: config.sandbox });
  const checkpoints = createCheckpoints();

  // Files the model has read, mapped to their modified-time at that moment.
  // Lives for the whole conversation so edits in later turns can use earlier reads.
  const readFiles = new Map();

  // The AbortController of whatever is running now (a turn, /compact, /test).
  // Ctrl+C aborts it; with nothing running, Ctrl+C at the prompt quits.
  let currentTurn = null;
  let closed = false;
  rl.on("SIGINT", () => {
    if (currentTurn) {
      currentTurn.abort();
      console.log(color.yellow("\n[interrupted]"));
    } else {
      rl.close();
    }
  });
  rl.on("close", () => (closed = true));

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

  function statusLine() {
    const { tokens, window, percent } = contextStatus(app.session, state);
    const usage = app.session.usage;
    const parts = [
      window ? `context ${formatTokens(tokens)}/${formatTokens(window)} (${percent}%)` : `context ~${formatTokens(tokens)} tokens`,
      `${formatCost(usage.cost)}${usage.costIsEstimate ? " est." : ""}`,
    ];
    if (state.mode === "plan") parts.push("plan mode");
    console.log(color.dim(parts.join(" · ")));
  }

  // One user turn: the message, then the agent loop until it stops.
  async function runTurn(text) {
    const { session } = app;
    const content = state.mode === "plan" ? `${text}\n\n${PLAN_MODE_REMINDER}` : text;

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
          toolContext: { cwd, signal, readFiles, approve, settings, state, session, sandbox: config.sandbox, beforeWrite },
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
      statusLine();
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
    session: null,
    withTurn,
    runTurn,

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
  };

  app.newSession(await pickStartupSession(cwd, config.resume, ask));

  const window = state.modelInfo.contextLength;
  console.log(color.bold("\nDevPilot") + color.dim(" · coding agent · tier 2"));
  console.log(color.dim(`Model:     ${state.model}${window ? ` (${formatTokens(window)} context)` : ""}`));
  console.log(color.dim(`Workspace: ${cwd}`));
  console.log(color.dim(`Log:       ${app.session.logFile}`));
  if (config.sandbox) {
    console.log(color.dim(`Sandbox:   docker (${config.sandbox.image}, network ${config.sandbox.network ? "on" : "off"})`));
  }
  if (settings.sources.length) console.log(color.dim(`Settings:  ${settings.sources.join(", ")}`));
  if (config.resume && app.session.messages.length > 1) {
    console.log(color.green(`Resumed ${app.session.messages.length - 1} messages.`));
    app.printRecap();
  }
  console.log(color.dim("Type /help for commands · Ctrl+C stops the current task · 'exit' or Ctrl+C at the prompt quits\n"));

  while (!closed) {
    let line;
    try {
      const label = state.mode === "plan" ? color.yellow("You (plan): ") : color.green("You: ");
      line = (await rl.question(label)).trim();
    } catch {
      break; // the prompt was closed (Ctrl+C or end of input)
    }

    if (!line) continue;
    if (line.toLowerCase() === "exit") break;

    if (isCommand(line)) {
      const result = await runCommand(app, line);
      if (result === "exit") break;
      console.log();
      continue;
    }

    await runTurn(line);
    console.log();
  }

  rl.close();
  app.session.logEvent("session_end");
  console.log(color.dim("Goodbye!"));
}
