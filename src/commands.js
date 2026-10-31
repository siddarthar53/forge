import { compactConversation } from "./compact.js";
import { contextStatus, estimateTokens, fetchModelInfo, toolDefinitionTokens } from "./context.js";
import {
  changedFiles,
  commitFiles,
  diffForCommit,
  generateCommitMessage,
  git,
  isGitRepo,
  undoCommitPrep,
} from "./git.js";
import { listSessions } from "./session.js";
import { detectTestCommand, runTestFixLoop } from "./testloop.js";
import { renderTodos } from "./tools/todo.js";
import { displayPath } from "./tools/workspace.js";
import { color, formatCost, formatTokens, progressBar, truncate } from "./ui.js";

// Slash commands are handled by DevPilot itself; they never go to the model
// (except /test and /compact, which use it on purpose). Each command gets
// the `app` object from chat.js: the session, state, client, settings...

function printSessions(sessions, current) {
  sessions.forEach((s, i) => {
    const when = s.modified.toLocaleString();
    const mark = s.file === current ? color.green(" (current)") : "";
    console.log(`  ${color.bold(String(i + 1).padStart(2))}. ${color.dim(when)}  ${s.title}${mark} ${color.dim(`· ${s.messageCount} messages`)}`);
  });
}

const COMMANDS = [
  {
    name: "help",
    description: "List the commands",
    run() {
      console.log(color.bold("Commands"));
      for (const c of COMMANDS) {
        const usage = `/${c.name}${c.args ? ` ${c.args}` : ""}`;
        console.log(`  ${color.cyan(usage.padEnd(22))} ${c.description}`);
      }
      console.log(color.dim("\nKeys: Ctrl+C stops the current task; at the prompt it quits."));
    },
  },

  // ---------------------------------------------------------- conversation
  {
    name: "clear",
    description: "Start a fresh conversation (the old one stays saved)",
    run(app) {
      app.newSession();
      console.log("Started a new conversation. /resume brings back earlier ones.");
    },
  },
  {
    name: "compact",
    args: "[focus]",
    description: "Summarize the conversation to free up context",
    async run(app, focus) {
      if (app.session.messages.length <= 3) {
        console.log("Nothing to compact yet.");
        return;
      }
      const before = contextStatus(app.session, app.state).tokens;
      console.log(color.dim("Summarizing the conversation…"));
      await app.withTurn((signal) =>
        compactConversation({
          client: app.client,
          session: app.session,
          state: app.state,
          signal,
          focus: focus || null,
          continueTask: false,
        })
      );
      app.historyWasReset();
      const after = contextStatus(app.session, app.state).tokens;
      console.log(`Compacted: about ${formatTokens(before)} → ${formatTokens(after)} tokens.`);
    },
  },
  {
    name: "sessions",
    description: "List saved conversations in this folder",
    run(app) {
      const sessions = listSessions(app.cwd);
      if (sessions.length === 0) console.log("No saved conversations yet.");
      else printSessions(sessions, app.session.logFile);
    },
  },
  {
    name: "resume",
    args: "[number]",
    description: "Continue a saved conversation",
    async run(app, arg) {
      const sessions = listSessions(app.cwd).filter((s) => s.file !== app.session.logFile);
      if (sessions.length === 0) {
        console.log("No other saved conversations in this folder.");
        return;
      }

      let choice = arg;
      if (!choice) {
        printSessions(sessions, null);
        choice = (await app.ask("Resume which one? (number, Enter to cancel) ")).trim();
        if (!choice) return;
      }
      const picked = sessions[Number(choice) - 1];
      if (!picked) {
        console.log(color.yellow(`No conversation number ${choice}.`));
        return;
      }

      app.newSession(picked.file);
      console.log(`Resumed: ${picked.title} ${color.dim(`(${app.session.messages.length} messages)`)}`);
      app.printRecap();
    },
  },

  // ------------------------------------------------------- model and usage
  {
    name: "model",
    args: "[id]",
    description: "Show or switch the model (any OpenRouter id with tool calling)",
    async run(app, arg) {
      const { state } = app;
      if (!arg) {
        const window = state.modelInfo?.contextLength;
        console.log(`Model: ${color.bold(state.model)}${window ? color.dim(` · ${formatTokens(window)} context`) : ""}`);
        console.log(color.dim("Switch with /model <id>, e.g. /model anthropic/claude-sonnet-4.5"));
        return;
      }
      const info = await fetchModelInfo({ ...app.config, model: arg, contextWindowOverride: app.config.contextWindow });
      if (!info.known) console.log(color.yellow(`"${arg}" is not in OpenRouter's model list; switching anyway.`));
      state.model = arg;
      state.modelInfo = info;
      app.session.logEvent("model", { model: arg });
      const window = info.contextLength ? ` · ${formatTokens(info.contextLength)} context` : "";
      console.log(`Model is now ${color.bold(arg)}${color.dim(window)}`);
    },
  },
  {
    name: "cost",
    description: "Tokens and cost of this conversation",
    run(app) {
      const u = app.session.usage;
      const cachedShare = u.promptTokens ? Math.round((100 * u.cachedTokens) / u.promptTokens) : 0;
      console.log(`API calls:      ${u.calls}`);
      console.log(`Input tokens:   ${formatTokens(u.promptTokens)} ${color.dim(`(${formatTokens(u.cachedTokens)} from cache, ${cachedShare}%)`)}`);
      console.log(`Output tokens:  ${formatTokens(u.completionTokens)}`);
      console.log(`Cost:           ${formatCost(u.cost)}${u.costIsEstimate ? color.dim(" (estimated from list prices)") : ""}`);
    },
  },
  {
    name: "context",
    description: "How full the context window is",
    run(app) {
      const { tokens, window, percent } = contextStatus(app.session, app.state);
      const system = estimateTokens(app.session.messages[0]?.content ?? "");
      if (window) {
        console.log(`${progressBar(tokens / window)} ${formatTokens(tokens)} / ${formatTokens(window)} tokens (${percent}%)`);
        console.log(color.dim(`Auto-compacts at ${Math.round(app.config.compactAt * 100)}%.`));
      } else {
        console.log(`About ${formatTokens(tokens)} tokens (context window unknown; set DEVPILOT_CONTEXT_WINDOW).`);
      }
      console.log(color.dim(`System prompt ~${formatTokens(system)} · tools ~${formatTokens(toolDefinitionTokens())} · ${app.session.messages.length - 1} messages`));
    },
  },

  // --------------------------------------------------------- planning
  {
    name: "plan",
    description: "Toggle plan mode (read-only exploring, then a plan to approve)",
    run(app) {
      app.state.mode = app.state.mode === "plan" ? "default" : "plan";
      app.session.logEvent("mode", { mode: app.state.mode });
      console.log(
        app.state.mode === "plan"
          ? `${color.yellow("Plan mode on.")} DevPilot will only read and explore, then propose a plan for you to approve.`
          : "Plan mode off. DevPilot can edit files and run commands again (with your approval)."
      );
    },
  },
  {
    name: "todos",
    description: "Show DevPilot's current checklist",
    run(app) {
      console.log(renderTodos(app.session.todos));
    },
  },

  // ----------------------------------------------------- code and git
  {
    name: "undo",
    description: "Undo the last turn: restore the files it changed and rewind",
    async run(app) {
      const turn = await app.checkpoints.undoLast();
      if (!turn) {
        console.log("Nothing to undo in this conversation.");
        return;
      }
      for (const { absolute } of turn.restored) app.readFiles.delete(absolute);
      if (turn.messageIndex !== null) {
        app.session.replaceMessages(app.session.messages.slice(0, turn.messageIndex), "undo");
      }

      console.log(`Undid: ${color.bold(truncate(turn.prompt, 70))}`);
      if (turn.restored.length === 0) console.log(color.dim("  (that turn changed no files)"));
      for (const { absolute, deleted } of turn.restored) {
        console.log(`  ${deleted ? color.red("deleted ") : color.green("restored")} ${displayPath(app.cwd, absolute)}`);
      }
      if (turn.messageIndex === null) {
        console.log(color.yellow("The conversation was compacted since, so it still mentions this turn; tell DevPilot what you undid."));
      }
      console.log(color.dim("Changes made by shell commands (installs, scripts, git) are not undone."));
    },
  },
  {
    name: "commit",
    args: "[message]",
    description: "Commit all changes, with a message written by the model",
    async run(app, arg) {
      if (!(await isGitRepo(app.cwd))) {
        console.log("This folder is not a git repository.");
        return;
      }
      // git status paths are relative to the repo root, so work from there.
      const root = (await git(app.cwd, ["rev-parse", "--show-toplevel"])).trim();
      const { files, skipped } = await changedFiles(root);
      if (skipped.length) console.log(color.yellow(`Not committing secret files: ${skipped.join(", ")}`));
      if (files.length === 0) {
        console.log("Nothing to commit.");
        return;
      }

      console.log(color.bold(`${files.length} changed file(s):`));
      for (const f of files.slice(0, 30)) console.log(`  ${color.dim(f.status)} ${f.path}`);
      if (files.length > 30) console.log(color.dim(`  … and ${files.length - 30} more`));

      if (arg) {
        console.log(color.green(`Committed ${await commitFiles(root, files, arg)}`));
        return;
      }

      await app.withTurn(async (signal) => {
        const { diff, untracked } = await diffForCommit(root, files);
        let committed = false;
        try {
          console.log(color.dim("Writing a commit message…"));
          const generated = await generateCommitMessage({
            client: app.client,
            model: app.state.model,
            diff,
            files,
            signal,
          });
          if (generated.usage) {
            app.session.recordUsage(generated.usage, app.state.modelInfo?.pricing, { updateContext: false });
          }
          let message = generated.message;
          if (!message) throw new Error("the model returned an empty message");

          for (;;) {
            console.log(`\n${message.split("\n").map((line) => `  ${line}`).join("\n")}\n`);
            const answer = (
              await app.ask(`${color.yellow("?")} ${color.bold("Commit with this message?")}\n  [y] commit  [e] edit  [n] cancel\n  > `, signal)
            )
              .trim()
              .toLowerCase();

            if (answer === "y" || answer === "yes") {
              const line = await commitFiles(root, files, message);
              committed = true;
              console.log(color.green(`Committed ${line}`));
              return;
            }
            if (answer === "e" || answer === "edit") {
              const edited = (await app.ask("  New message (one line): ", signal)).trim();
              if (edited) message = edited;
              continue;
            }
            console.log("Commit cancelled.");
            return;
          }
        } finally {
          if (!committed) await undoCommitPrep(root, untracked);
        }
      });
    },
  },
  {
    name: "test",
    args: "[command]",
    description: "Run the tests; if they fail, let DevPilot fix them and rerun",
    async run(app, arg) {
      const command = arg || detectTestCommand(app.cwd, app.settings);
      if (!command) {
        console.log("No test command found. Use /test <command>, or set testCommand in .devpilot/settings.json.");
        return;
      }
      await runTestFixLoop(app, command);
    },
  },

  {
    name: "exit",
    description: "Quit DevPilot",
    run: () => "exit",
  },
];

export function isCommand(line) {
  return /^\/[a-z]+(\s|$)/i.test(line);
}

export async function runCommand(app, line) {
  const [, name, rest = ""] = line.match(/^\/(\S+)\s*([\s\S]*)$/);
  const command = COMMANDS.find((c) => c.name === name.toLowerCase() || (name === "quit" && c.name === "exit"));
  if (!command) {
    console.log(color.yellow(`Unknown command /${name}. Type /help for the list.`));
    return null;
  }

  try {
    return await command.run(app, rest.trim());
  } catch (err) {
    if (err.name === "AbortError") console.log(color.yellow("[cancelled]"));
    else console.error(color.red(`/${command.name} failed: ${err.message}`));
    return null;
  }
}
