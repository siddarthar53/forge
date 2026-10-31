import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { checkCommand } from "../safety.js";
import { color } from "../ui.js";

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 600;
const MAX_OUTPUT_CHARS = 30_000;

const isWindows = process.platform === "win32";

// Which shell runs the command. The system prompt tells the model the same
// thing, so it writes PowerShell on Windows and bash elsewhere. Inside the
// Docker sandbox it is always bash (the container runs Linux).
export function shellName(sandbox) {
  if (sandbox) return "bash (inside a Docker container)";
  return isWindows ? "PowerShell" : "bash";
}

// ------------------------------------------------------------------ sandbox
//
// With DEVPILOT_SANDBOX=docker every command runs in a throwaway container:
//
//   docker run --rm --network none -v <workspace>:/workspace -w /workspace <image> bash -c "<command>"
//
//   --rm            the container is deleted when the command ends
//   --network none  no internet: a hijacked command cannot upload your code
//   -v ...          only the workspace is visible, nothing else on your disk
//   --user uid:gid  (Linux/macOS) files it creates belong to you, not root
//
// A command can still damage files inside the workspace; that is what
// permissions, checkpoints (/undo) and git are for.

function sandboxSpawn(command, cwd, sandbox) {
  const containerName = `devpilot-${randomBytes(4).toString("hex")}`;
  const args = ["run", "--rm", "--name", containerName, "-v", `${cwd}:/workspace`, "-w", "/workspace"];
  if (!sandbox.network) args.push("--network", "none");
  if (typeof process.getuid === "function") {
    // An unknown uid has no home folder; npm and friends need a writable one.
    args.push("--user", `${process.getuid()}:${process.getgid()}`, "-e", "HOME=/tmp");
  }
  args.push(sandbox.image, "bash", "-c", command);
  return { program: "docker", args, containerName };
}

// Run once at startup: fail early with a clear message, and pull the image
// now so the first command does not time out while it downloads.
export function prepareSandbox(sandbox) {
  const check = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (check.status !== 0) {
    throw new Error("DEVPILOT_SANDBOX=docker is set, but Docker is not installed or not running.");
  }
  const inspect = spawnSync("docker", ["image", "inspect", sandbox.image], { stdio: "ignore" });
  if (inspect.status !== 0) {
    console.log(color.dim(`Pulling sandbox image ${sandbox.image} (first run only)…`));
    const pull = spawnSync("docker", ["pull", sandbox.image], { stdio: "inherit" });
    if (pull.status !== 0) throw new Error(`Could not pull the Docker image ${sandbox.image}.`);
  }
}

// --------------------------------------------------------------- execution

function hostSpawn(command) {
  return isWindows
    ? { program: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] }
    : { program: "/bin/bash", args: ["-c", command] };
}

// Killing a shell does not always kill what it started (e.g. `npm test`
// spawns node). On Windows, taskkill /T kills the whole process tree. For the
// sandbox, killing the docker client leaves the container running, so we
// stop the container itself.
function killTree(child, containerName) {
  if (containerName) spawn("docker", ["kill", containerName], { stdio: "ignore" });
  if (isWindows) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
}

// Keep the beginning and the end: errors are often at the end of output.
export function truncateOutput(text, max = MAX_OUTPUT_CHARS) {
  if (text.length <= max) return text;
  const half = max / 2;
  const cut = text.length - max;
  return `${text.slice(0, half)}\n… [${cut} characters truncated] …\n${text.slice(-half)}`;
}

// Run a command and collect its output. Used by the run_shell tool and by
// the /test loop. Never rejects: problems end up in the result.
export function execCommand(command, { cwd, signal, timeoutMs, sandbox = null }) {
  const { program, args, containerName } = sandbox ? sandboxSpawn(command, cwd, sandbox) : hostSpawn(command);

  return new Promise((resolve) => {
    // stdin "ignore": a command waiting for input gets end-of-file instead of hanging.
    const child = spawn(program, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

    let output = "";
    let stopReason = null;
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));

    const stop = (reason) => {
      stopReason = reason;
      killTree(child, containerName);
    };
    const timer = setTimeout(() => stop(`timed out after ${timeoutMs / 1000}s`), timeoutMs);
    const onAbort = () => stop("cancelled by user");
    if (signal?.aborted) onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ ...result, output: output.trim() });
    };

    child.on("error", (err) => finish({ exitCode: null, stopReason: `failed to start: ${err.message}` }));
    child.on("close", (code) => finish({ exitCode: code, stopReason }));
  });
}

export function formatResult({ exitCode, stopReason, output }) {
  const header = stopReason ? `Command ${stopReason}.` : `Exit code: ${exitCode}`;
  return `${header}\n${truncateOutput(output) || "(no output)"}`;
}

export const runShell = {
  name: "run_shell",
  description:
    "Run a shell command in the workspace root and return its exit code and " +
    "combined stdout/stderr. The shell (bash or PowerShell, and whether it runs " +
    "in a sandbox) is named in the system prompt. Use it for tests, builds, git " +
    "and package managers. Commands cannot read keyboard input, so avoid " +
    "interactive programs. Prefer read_file/list_files/grep over shell for " +
    "reading files. Dangerous commands are blocked.",
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
    // 1. The deny list and the allow rules from settings (safety.js).
    const check = checkCommand(command, ctx.settings);
    if (check.verdict === "deny") {
      console.log(color.red(`  ✗ Blocked: ${command}`) + color.dim(` (${check.reason})`));
      return (
        `Blocked: this command was not run because ${check.reason}. ` +
        "Find a safer way, or ask the user to run it themselves if it is really needed."
      );
    }

    // 2. Otherwise ask, unless an allow rule matched.
    if (check.verdict === "allow") {
      console.log(color.dim(`  ✓ Run: ${command} (${check.reason})`));
    } else {
      const decision = await ctx.approve(
        {
          key: `shell:${command}`, // "always" approves only this exact command
          title: `Run: ${command}${ctx.sandbox ? color.dim("  [docker sandbox]") : ""}`,
          alwaysLabel: "always allow this exact command",
        },
        ctx.signal
      );
      if (!decision.allowed) return decision.message;
    }

    const timeoutMs = Math.max(1, Math.min(timeout_seconds, MAX_TIMEOUT_SECONDS)) * 1000;
    const result = await execCommand(command, {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeoutMs,
      sandbox: ctx.sandbox,
    });
    return formatResult(result);
  },
};
