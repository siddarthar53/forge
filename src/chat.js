import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runAgent } from "./agent.js";
import { createPermissions } from "./permissions.js";
import { buildSystemPrompt } from "./prompt.js";
import { createSession } from "./session.js";
import { color } from "./ui.js";

export async function startChat({ client, model, maxSteps }) {
  const cwd = process.cwd();
  const rl = readline.createInterface({ input, output });

  const session = createSession({ cwd, model, systemPrompt: buildSystemPrompt({ cwd }) });

  // rl.question accepts an AbortSignal, so Ctrl+C can cancel a pending
  // permission prompt as well as a running model call.
  const ask = (question, signal) => rl.question(question, { signal });
  const approve = createPermissions({ ask });

  // Files the model has read, mapped to their modified-time at that moment.
  // Lives for the whole session so edits in later turns can use earlier reads.
  const readFiles = new Map();

  // Ctrl+C: while the agent works, stop the current turn but keep the session.
  // At the "You:" prompt, quit.
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

  console.log(color.bold("\nDevPilot") + color.dim(" · coding agent"));
  console.log(color.dim(`Model:     ${model}`));
  console.log(color.dim(`Workspace: ${cwd}`));
  console.log(color.dim(`Log:       ${session.logFile}`));
  console.log(color.dim("Ctrl+C stops the current task · type 'exit' or press Ctrl+C at the prompt to quit\n"));

  while (!closed) {
    let prompt;
    try {
      prompt = (await rl.question(color.green("You: "))).trim();
    } catch {
      break; // the prompt was closed (Ctrl+C or end of input)
    }

    if (!prompt) continue;
    if (prompt.toLowerCase() === "exit") break;

    session.addMessage({ role: "user", content: prompt });
    currentTurn = new AbortController();
    console.log();

    try {
      const { status } = await runAgent({
        client,
        model,
        session,
        maxSteps,
        toolContext: { cwd, signal: currentTurn.signal, readFiles, approve },
      });
      if (status === "max_steps") {
        console.log(color.yellow(`[stopped after ${maxSteps} steps; send a message to let it continue]`));
      }
    } catch (err) {
      // API failures (bad key, rate limit, network) end the turn, not the app.
      // The SDK has already retried transient errors twice by this point.
      if (!currentTurn.signal.aborted) {
        console.error(color.red(`\nError: ${err.message}`));
        session.logEvent("error", { message: err.message, status: err.status });
      }
    } finally {
      currentTurn = null;
    }
    console.log();
  }

  rl.close();
  session.logEvent("session_end");
  console.log(color.dim("Goodbye!"));
}
