import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isSecretFile } from "./tools/workspace.js";

const execFileAsync = promisify(execFile);

export async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 50 * 1024 * 1024 });
  return stdout;
}

export async function isGitRepo(cwd) {
  try {
    return (await git(cwd, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch {
    return false; // not a repo, or git is not installed
  }
}

// `symbolic-ref` also works in a brand-new repo with no commits yet.
export async function currentBranch(cwd) {
  try {
    return (await git(cwd, ["symbolic-ref", "--short", "HEAD"])).trim();
  } catch {
    return null; // detached HEAD or not a repo
  }
}

// ---------------------------------------------------------- work branches
//
// The agent should not pile changes onto main. Before its first edit, if you
// are on a main-like branch, DevPilot creates `devpilot/<date-time>` and
// switches to it. `checkout -b` keeps your uncommitted changes as they are.

const MAIN_BRANCHES = new Set(["main", "master", "develop", "trunk"]);

export async function ensureWorkBranch(cwd) {
  if (!(await isGitRepo(cwd))) return null;
  const branch = await currentBranch(cwd);
  if (!branch || !MAIN_BRANCHES.has(branch)) return null;

  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const name = `devpilot/${stamp}`;
  await git(cwd, ["checkout", "-b", name]);
  return name;
}

// ----------------------------------------------------------------- commits

// `git status --porcelain -z`: "XY path\0", renames add "\0old-path".
export function parsePorcelain(output) {
  const parts = output.split("\0");
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    files.push({ status, path: entry.slice(3) });
    if (status[0] === "R" || status[0] === "C") i++; // skip the old path
  }
  return files;
}

// .devpilot/ holds session logs (whole conversations) and local settings.
const isDevPilotFile = (file) => file === ".devpilot" || /(^|\/)\.devpilot\//.test(file);

// Everything a commit would contain, minus secret files and DevPilot's own folder.
export async function changedFiles(cwd) {
  const all = parsePorcelain(await git(cwd, ["status", "--porcelain", "-z", "--untracked-files=all"]));
  const kept = all.filter((f) => !isDevPilotFile(f.path));
  const secrets = kept.filter((f) => isSecretFile(f.path));
  return { files: kept.filter((f) => !isSecretFile(f.path)), skipped: secrets.map((f) => f.path) };
}

const MAX_DIFF_CHARS = 24_000;

// The diff of the working tree against the last commit, including new files.
// `git add -N` ("intent to add") makes untracked files show up in `git diff`
// without really staging them; undoCommitPrep() takes that back if you cancel.
export async function diffForCommit(cwd, files) {
  const paths = files.map((f) => f.path);
  const untracked = files.filter((f) => f.status === "??").map((f) => f.path);
  if (untracked.length) await git(cwd, ["add", "-N", "--", ...untracked]);

  let diff;
  try {
    diff = await git(cwd, ["diff", "HEAD", "--", ...paths]);
  } catch {
    diff = await git(cwd, ["diff", "--", ...paths]); // no commits yet
  }
  if (diff.length > MAX_DIFF_CHARS) {
    diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n… [diff truncated: ${diff.length - MAX_DIFF_CHARS} more characters]`;
  }
  return { diff, untracked };
}

export async function undoCommitPrep(cwd, untracked) {
  if (untracked.length) await git(cwd, ["rm", "--cached", "-q", "--", ...untracked]).catch(() => {});
}

export async function commitFiles(cwd, files, message) {
  await git(cwd, ["add", "-A", "--", ...files.map((f) => f.path)]);
  await git(cwd, ["commit", "-m", message]);
  return (await git(cwd, ["log", "-1", "--oneline"])).trim();
}

// Ask the model for a commit message. This is a separate, tiny request that
// does not use or change the conversation.
export async function generateCommitMessage({ client, model, diff, files, signal }) {
  const fileList = files.map((f) => `${f.status} ${f.path}`).join("\n");
  const response = await client.chat.completions.create(
    {
      model,
      messages: [
        {
          role: "system",
          content:
            "You write git commit messages. Format: a summary line in the imperative mood " +
            "(\"Add\", \"Fix\"), at most 72 characters, no trailing period; then, only if " +
            "useful, a blank line and a few short lines or bullets explaining what changed " +
            "and why. Reply with the message only, no code fences.",
        },
        { role: "user", content: `Changed files:\n${fileList}\n\nDiff:\n${diff}` },
      ],
      usage: { include: true },
    },
    { signal }
  );

  const text = response.choices?.[0]?.message?.content ?? "";
  const message = text.replace(/^```\w*\n?|\n?```$/g, "").trim();
  return { message, usage: response.usage };
}
