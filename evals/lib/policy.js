import { checkCommand, splitCommand } from "../../src/safety.js";

// How the eval runner answers DevPilot's approval prompts.
//
// Nobody watches an eval run, so something has to answer "y" or "n". File
// edits are always confined to the task's temporary workspace (DevPilot
// refuses paths outside it), so they are approved. Shell commands are not
// confined, so by default only a short list of safe ones is approved:
// tests, reading files, git inspection, and deleting relative paths inside
// the workspace. Everything else is declined with a short explanation.
//
// With DEVPILOT_SANDBOX=docker every command runs in a throwaway container,
// so `--approve all` is reasonable there.

const SAFE_FIRST_WORDS = new Set([
  "ls", "dir", "cat", "type", "head", "tail", "wc", "grep", "rg", "pwd", "echo",
  "mkdir", "touch", "cp", "mv", "Get-ChildItem", "Get-Content", "Select-String", "Test-Path",
]);
const SAFE_GIT = /^git\s+(status|diff|log|show|ls-files|rev-parse|branch)\b/;
const SAFE_NODE = /^node\s+(--test\b|(?!-)[\w./\\-]+\.m?js\b)/;
const SAFE_NPM = /^(npm\s+(test|t|run\s+[\w:-]+)|npx\s+(--yes\s+)?(jest|vitest|mocha))\b/;
const DELETE = /^(rm|Remove-Item|del|rd|rmdir)\b/;

// A path that clearly stays inside the workspace: relative, no "..", no "~",
// no drive letter, no variables, no wildcards at the top.
function isLocalPath(arg) {
  if (!arg || arg.startsWith("-")) return true; // flags
  if (/^(\/|\\|~|\$|%|[A-Za-z]:)/.test(arg)) return false;
  if (/(^|[\\/])\.\.([\\/]|$)/.test(arg)) return false;
  if (/^\.?[\\/]?\*/.test(arg) || arg === "." || arg === "./" || arg === ".\\") return false;
  return true;
}

function segmentIsSafe(segment) {
  const words = segment.trim().split(/\s+/);
  const first = words[0];
  if (SAFE_GIT.test(segment) || SAFE_NODE.test(segment) || SAFE_NPM.test(segment)) return true;
  if (DELETE.test(segment)) return words.slice(1).every(isLocalPath);
  if (SAFE_FIRST_WORDS.has(first)) {
    if (first === "cat" || first === "type" || first === "Get-Content") {
      if (words.slice(1).some((w) => /(^|[\\/])\.env/.test(w))) return false;
    }
    return words.slice(1).every((w) => isLocalPath(w.replace(/^['"]|['"]$/g, "")) || !/[\\/]/.test(w));
  }
  return false;
}

export function isSafeCommand(command) {
  if (/[`]|\$\(|<\(|>\s*\/|\bsudo\b/.test(command)) return false;
  if (checkCommand(command).verdict === "deny") return false;
  return splitCommand(command).every(segmentIsSafe);
}

// request: DevPilot's approval_request event. Returns the answer to send:
// "y", or a sentence the model reads as the reason for "no".
export function decide(request, { mode = "safe", decline = [] } = {}) {
  const title = request.title ?? "";
  if (decline.some((pattern) => new RegExp(pattern).test(title))) return { answer: "n", by: "task" };
  if (mode === "all") return { answer: "y", by: "policy" };

  const run = title.match(/^Run: (.*?)(\s+\[docker sandbox\])?$/s);
  if (run) {
    return isSafeCommand(run[1])
      ? { answer: "y", by: "policy" }
      : {
          answer: "This evaluation only allows tests, read-only commands and changes inside the project. Use the file tools instead.",
          by: "policy",
        };
  }
  return { answer: "y", by: "policy" }; // file edits (confined to the workspace), MCP, plans
}
