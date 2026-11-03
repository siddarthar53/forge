import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createApp } from "./app.js";
import { contextStatus } from "./context.js";
import { printMcpSummary } from "./mcp/index.js";
import { createPermissions } from "./permissions.js";
import { color, formatCost, formatTokens } from "./ui.js";

// The terminal front end: a readline prompt around the app (see app.js).
export async function startChat({ client, config }) {
  const rl = readline.createInterface({ input, output });

  // rl.question accepts an AbortSignal, so Ctrl+C can cancel a pending
  // permission prompt as well as a running model call.
  const ask = (question, signal) => rl.question(question, signal ? { signal } : {});
  const approve = createPermissions({ ask });

  const app = await createApp({ client, config, ask, approve });
  const { state, settings, mcp, agents } = app;

  // Ctrl+C: while the agent works, stop the current turn but keep the session.
  // At the "You:" prompt, quit.
  let closed = false;
  rl.on("SIGINT", () => {
    if (app.abort()) console.log(color.yellow("\n[interrupted]"));
    else rl.close();
  });
  rl.on("close", () => (closed = true));

  // A dim status line after every turn.
  app.onTurnEnd = () => {
    const { tokens, window, percent } = contextStatus(app.session, state);
    const usage = app.session.usage;
    const parts = [
      window ? `context ${formatTokens(tokens)}/${formatTokens(window)} (${percent}%)` : `context ~${formatTokens(tokens)} tokens`,
      `${formatCost(usage.cost)}${usage.costIsEstimate ? " est." : ""}`,
    ];
    if (state.mode === "plan") parts.push("plan mode");
    console.log(color.dim(parts.join(" · ")));
  };

  const window = state.modelInfo.contextLength;
  console.log(color.bold("\nDevPilot") + color.dim(" · coding agent · tier 3"));
  console.log(color.dim(`Model:     ${state.model}${window ? ` (${formatTokens(window)} context)` : ""}`));
  console.log(color.dim(`Workspace: ${app.cwd}`));
  console.log(color.dim(`Log:       ${app.session.logFile}`));
  if (config.sandbox) {
    console.log(color.dim(`Sandbox:   docker (${config.sandbox.image}, network ${config.sandbox.network ? "on" : "off"})`));
  }
  if (settings.sources.length) console.log(color.dim(`Settings:  ${settings.sources.join(", ")}`));
  printMcpSummary(mcp);
  const custom = agents.agents.filter((a) => a.source !== "built-in");
  if (custom.length) console.log(color.dim(`Agents:    ${custom.map((a) => a.name).join(", ")} (custom)`));
  for (const error of agents.errors) console.log(color.yellow(`Agents:    ${error}`));
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

    const result = await app.submit(line);
    if (result === "exit") break;
    console.log();
  }

  rl.close();
  await app.close();
  console.log(color.dim("Goodbye!"));
}
