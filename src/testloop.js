import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execCommand } from "./tools/shell.js";
import { color } from "./ui.js";

// The test-fix loop (/test):
//
//   run the tests ──► pass? ──► done
//        ▲             │ no
//        │             ▼
//        └──── agent turn: "these tests failed, here is the output, fix it"
//
// The loop is driven by DevPilot, not by the model: we run the test command
// ourselves, so a model that says "fixed!" without checking cannot end the
// loop early, and it stops after a fixed number of rounds.

const MAX_ROUNDS = 3;
const TEST_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_FAILURE_CHARS = 15_000;

const NPM_PLACEHOLDER = /no test specified/;

// Guess the test command from the files in the project.
export function detectTestCommand(cwd, settings = {}) {
  if (settings.testCommand) return settings.testCommand;

  const has = (file) => existsSync(path.join(cwd, file));
  if (has("package.json")) {
    try {
      const test = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8")).scripts?.test;
      if (test && !NPM_PLACEHOLDER.test(test)) return "npm test";
    } catch {
      // unreadable package.json: keep looking
    }
  }
  if (has("pytest.ini") || has("pyproject.toml") || has("setup.cfg") || has("tox.ini")) return "pytest";
  if (has("Cargo.toml")) return "cargo test";
  if (has("go.mod")) return "go test ./...";
  if (has("pom.xml")) return "mvn -q test";
  return null;
}

// Failures usually show up at the end of the output, so keep the tail.
function tail(text, max = MAX_FAILURE_CHARS) {
  return text.length <= max ? text : `… [${text.length - max} earlier characters cut]\n${text.slice(-max)}`;
}

export async function runTestFixLoop(app, command, maxRounds = MAX_ROUNDS) {
  for (let round = 0; ; round++) {
    console.log(color.cyan(`\n▶ Running tests: ${command}`) + (app.config.sandbox ? color.dim("  [docker sandbox]") : ""));

    const result = await app.withTurn((signal) =>
      execCommand(command, { cwd: app.cwd, signal, timeoutMs: TEST_TIMEOUT_MS, sandbox: app.config.sandbox })
    );

    if (result.stopReason === "cancelled by user") {
      console.log(color.yellow("Test run cancelled."));
      return;
    }
    if (result.exitCode === 0 && !result.stopReason) {
      console.log(color.green(round === 0 ? "✓ Tests pass." : `✓ Tests pass after ${round} fix round(s).`));
      return;
    }

    const why = result.stopReason ? `the command ${result.stopReason}` : `exit code ${result.exitCode}`;
    const lastLines = result.output.split("\n").slice(-15).join("\n");
    console.log(color.red(`✗ Tests failed (${why}).`));
    if (lastLines) console.log(color.dim(lastLines));

    if (round >= maxRounds) {
      console.log(color.yellow(`Still failing after ${maxRounds} fix rounds; stopping. Send a message to keep going.`));
      return;
    }

    console.log(color.cyan(`\nAsking DevPilot to fix it (round ${round + 1} of ${maxRounds})…`));
    const status = await app.runTurn(
      `The test command \`${command}\` failed (${why}). Output:\n\n` +
        "```\n" +
        tail(result.output || "(no output)") +
        "\n```\n\n" +
        "Find the root cause and fix it. Fix the code rather than the tests, unless a " +
        "test is clearly wrong. You may run individual tests while you work. When you " +
        `are done, stop; DevPilot will rerun \`${command}\` to check.`
    );
    if (status !== "done") {
      console.log(color.yellow("Test-fix loop stopped."));
      return;
    }
  }
}
