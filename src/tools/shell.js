import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 600;
const MAX_OUTPUT_CHARS = 30_000;

const isWindows = process.platform === "win32";

// Which shell runs the command. The system prompt tells the model the same
// thing, so it writes PowerShell on Windows and bash elsewhere.
export const SHELL_NAME = isWindows ? "PowerShell" : "bash";

function shellCommand(command) {
  return isWindows
    ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]]
    : ["/bin/bash", ["-c", command]];
}

// Killing a shell does not always kill what it started (e.g. `npm test`
// spawns node). On Windows, taskkill /T kills the whole process tree.
function killTree(child) {
  if (isWindows) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
}

// Keep the beginning and the end: errors are often at the end of output.
function truncateOutput(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const half = MAX_OUTPUT_CHARS / 2;
  const cut = text.length - MAX_OUTPUT_CHARS;
  return `${text.slice(0, half)}\n… [${cut} characters truncated] …\n${text.slice(-half)}`;
}

export const runShell = {
  name: "run_shell",
  description:
    `Run a ${SHELL_NAME} command in the workspace root and return its exit ` +
    "code and combined stdout/stderr. Use it for tests, builds, git and package " +
    "managers. Commands cannot read keyboard input, so avoid interactive " +
    "programs. Prefer read_file/list_files/grep over shell for reading files.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run." },
      timeout_seconds: {
        type: "integer",
        description: `Kill the command after this many seconds. Default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}.`,
      },
    },
    required: ["command"],
  },
  readOnly: false,

  async run({ command, timeout_seconds = DEFAULT_TIMEOUT_SECONDS }, ctx) {
    const decision = await ctx.approve({
      key: `shell:${command}`, // "always" approves only this exact command
      title: `Run: ${command}`,
      alwaysLabel: "always allow this exact command",
    });
    if (!decision.allowed) return decision.message;

    const timeoutMs = Math.min(timeout_seconds, MAX_TIMEOUT_SECONDS) * 1000;
    const [program, args] = shellCommand(command);

    return new Promise((resolve) => {
      // stdin "ignore": a command waiting for input gets end-of-file instead of hanging.
      const child = spawn(program, args, { cwd: ctx.cwd, stdio: ["ignore", "pipe", "pipe"] });

      let output = "";
      let stopReason = null;
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));

      const stop = (reason) => {
        stopReason = reason;
        killTree(child);
      };
      const timer = setTimeout(() => stop(`timed out after ${timeoutMs / 1000}s`), timeoutMs);
      const onAbort = () => stop("cancelled by user");
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const finish = (header) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        resolve(`${header}\n${truncateOutput(output.trim()) || "(no output)"}`);
      };

      child.on("error", (err) => finish(`Failed to start: ${err.message}`));
      child.on("close", (code) =>
        finish(stopReason ? `Command ${stopReason}.` : `Exit code: ${code}`)
      );
    });
  },
};
