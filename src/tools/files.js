import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { renderDiff } from "../ui.js";
import {
  IGNORED_DIRS,
  displayPath,
  isProtectedPath,
  isSecretFile,
  looksBinary,
  resolveInWorkspace,
} from "./workspace.js";

const MAX_LINES = 2000; // default lines returned by one read_file call
const MAX_LINE_LENGTH = 2000; // longer lines get cut (minified files)
const MAX_LIST_RESULTS = 200;
const MAX_GREP_MATCHES = 100;
const MAX_GREP_FILE_BYTES = 1_000_000;

// Drop files that .gitignore excludes (build output, logs, caches...), so
// list_files and grep show what a developer would consider "the code".
// `git check-ignore` applies every .gitignore rule for us; -z separates paths
// with NUL so odd file names survive. Exit codes: 0 = some paths ignored,
// 1 = none ignored, anything else = not a git repo or no git: keep everything.
function removeGitIgnored(cwd, files) {
  if (files.length === 0) return files;
  const result = spawnSync("git", ["check-ignore", "-z", "--stdin"], {
    cwd,
    input: files.join("\0"),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) return files;
  const ignored = new Set(result.stdout.split("\0").filter(Boolean));
  return files.filter((file) => !ignored.has(file));
}

// Shared helper: walk the workspace with Node's built-in glob, skipping
// ignored folders and .gitignored files. Returns paths relative to cwd,
// using forward slashes.
async function findFiles(cwd, pattern) {
  const results = [];
  for await (const entry of fs.glob(pattern, {
    cwd,
    // With withFileTypes, glob hands `exclude` a Dirent (name + type), not a string.
    exclude: (dirent) => IGNORED_DIRS.has(dirent.name),
    withFileTypes: true,
  })) {
    if (entry.isFile()) {
      results.push(displayPath(cwd, path.join(entry.parentPath, entry.name)));
    }
  }
  return removeGitIgnored(cwd, results).sort();
}

// ---------------------------------------------------------------- read_file

export const readFile = {
  name: "read_file",
  description:
    "Read a text file from the workspace. Returns lines prefixed with their " +
    "line numbers (`42\\tcode`). Use offset/limit to page through large files. " +
    "You must read a file before editing or overwriting it.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the workspace root." },
      offset: { type: "integer", description: "1-based line to start from. Default 1." },
      limit: { type: "integer", description: `Max lines to return. Default ${MAX_LINES}.` },
    },
    required: ["path"],
  },
  readOnly: true,

  async run({ path: filePath, offset = 1, limit = MAX_LINES }, ctx) {
    const absolute = resolveInWorkspace(ctx.cwd, filePath);
    if (isSecretFile(absolute)) {
      throw new Error("Refusing to read a .env file: it contains secrets.");
    }

    const buffer = await fs.readFile(absolute);
    if (looksBinary(buffer)) throw new Error("This looks like a binary file.");

    // Remember when we read it, so edits can detect changes made since then.
    const { mtimeMs } = await fs.stat(absolute);
    ctx.readFiles.set(absolute, mtimeMs);

    const lines = buffer.toString("utf8").split(/\r?\n/);
    const start = Math.max(1, offset);
    const slice = lines.slice(start - 1, start - 1 + limit);

    const numbered = slice.map((line, i) => {
      const text =
        line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}… [line truncated]` : line;
      return `${start + i}\t${text}`;
    });

    const end = start + slice.length - 1;
    if (end < lines.length) {
      numbered.push(`… [showing lines ${start}-${end} of ${lines.length}; use offset to read more]`);
    }
    return numbered.join("\n") || "(empty file)";
  },
};

// --------------------------------------------------------------- list_files

export const listFiles = {
  name: "list_files",
  description:
    "Find files by glob pattern, e.g. `**/*.js` or `src/**/*.test.ts`. " +
    "Skips node_modules, .git, build folders and anything in .gitignore. " +
    "Use this to explore the project.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern. Default `**/*` (all files)." },
    },
    required: [],
  },
  readOnly: true,

  async run({ pattern = "**/*" }, ctx) {
    const files = await findFiles(ctx.cwd, pattern);
    if (files.length === 0) return "No files matched.";

    const shown = files.slice(0, MAX_LIST_RESULTS);
    if (files.length > shown.length) {
      shown.push(`… [${files.length - shown.length} more; use a narrower pattern]`);
    }
    return shown.join("\n");
  },
};

// --------------------------------------------------------------------- grep

export const grep = {
  name: "grep",
  description:
    "Search file contents with a JavaScript regular expression. Returns " +
    "`path:line: text` for each match. Use it to find where something is " +
    "defined or used before reading whole files.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for." },
      glob: { type: "string", description: "Only search files matching this glob. Default `**/*`." },
      case_insensitive: { type: "boolean", description: "Ignore case. Default false." },
    },
    required: ["pattern"],
  },
  readOnly: true,

  async run({ pattern, glob = "**/*", case_insensitive = false }, ctx) {
    const regex = new RegExp(pattern, case_insensitive ? "i" : "");
    const matches = [];

    for (const file of await findFiles(ctx.cwd, glob)) {
      if (ctx.signal.aborted) break;

      const absolute = path.join(ctx.cwd, file);
      if (isSecretFile(absolute)) continue;

      const { size } = await fs.stat(absolute);
      if (size > MAX_GREP_FILE_BYTES) continue;

      const buffer = await fs.readFile(absolute);
      if (looksBinary(buffer)) continue;

      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
          if (matches.length >= MAX_GREP_MATCHES) {
            matches.push(`… [stopped at ${MAX_GREP_MATCHES} matches; narrow the pattern or glob]`);
            return matches.join("\n");
          }
        }
      }
    }
    return matches.length ? matches.join("\n") : "No matches.";
  },
};

// --------------------------------------------------------------- write_file

// Before changing an existing file, make sure the model has read it and
// that nobody (the user, another program) changed it since that read.
async function assertFreshRead(absolute, ctx) {
  const readAt = ctx.readFiles.get(absolute);
  if (readAt === undefined) {
    throw new Error("You must read_file this file before changing it.");
  }
  const { mtimeMs } = await fs.stat(absolute);
  if (mtimeMs !== readAt) {
    throw new Error("The file changed since you last read it. Read it again first.");
  }
}

async function fileExists(absolute) {
  return fs.access(absolute).then(() => true, () => false);
}

function assertWritable(absolute, ctx) {
  if (isSecretFile(absolute)) throw new Error("Refusing to change a .env file: it contains secrets.");
  if (isProtectedPath(ctx.cwd, absolute)) {
    throw new Error("Refusing to write inside .git or .devpilot; those folders are managed by git and DevPilot.");
  }
}

// Show the diff, ask the user, write if approved. Shared by write and edit.
async function applyChange({ absolute, oldText, newText, ctx }) {
  const shownPath = displayPath(ctx.cwd, absolute);
  const decision = await ctx.approve(
    {
      key: "edit", // "always" approves all file changes for this session
      title: `${oldText === "" ? "Create" : "Edit"} ${shownPath}`,
      preview: renderDiff(shownPath, oldText, newText),
      alwaysLabel: "always allow file edits this session",
    },
    ctx.signal
  );
  if (!decision.allowed) return decision.message;

  // Tier 2: save the old version for /undo, and maybe move to a work branch.
  // The hook returns a note for the model, or nothing.
  const note = ctx.beforeWrite ? await ctx.beforeWrite(absolute) : null;

  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, newText, "utf8");

  // Our own write is not an "outside change": record the new timestamp.
  const { mtimeMs } = await fs.stat(absolute);
  ctx.readFiles.set(absolute, mtimeMs);
  return note ? `Wrote ${shownPath}.\n${note}` : `Wrote ${shownPath}.`;
}

export const writeFile = {
  name: "write_file",
  description:
    "Create a new file, or completely replace an existing one. For changes " +
    "to part of an existing file, prefer edit_file. Overwriting requires a " +
    "prior read_file of that file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the workspace root." },
      content: { type: "string", description: "The full new content of the file." },
    },
    required: ["path", "content"],
  },
  readOnly: false,

  async run({ path: filePath, content }, ctx) {
    const absolute = resolveInWorkspace(ctx.cwd, filePath);
    assertWritable(absolute, ctx);

    let oldText = "";
    if (await fileExists(absolute)) {
      await assertFreshRead(absolute, ctx);
      oldText = await fs.readFile(absolute, "utf8");
    }
    return applyChange({ absolute, oldText, newText: content, ctx });
  },
};

// ---------------------------------------------------------------- edit_file

function countOccurrences(text, search) {
  let count = 0;
  for (let i = text.indexOf(search); i !== -1; i = text.indexOf(search, i + search.length)) {
    count++;
  }
  return count;
}

export const editFile = {
  name: "edit_file",
  description:
    "Replace an exact string in a file. `old_string` must match the file " +
    "exactly (including indentation) and must be unique, so include enough " +
    "surrounding lines to identify one spot. Set replace_all to change every " +
    "occurrence. Requires a prior read_file. Do not include the line-number " +
    "prefixes from read_file output.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the workspace root." },
      old_string: { type: "string", description: "Exact text to find." },
      new_string: { type: "string", description: "Text to replace it with." },
      replace_all: { type: "boolean", description: "Replace every occurrence. Default false." },
    },
    required: ["path", "old_string", "new_string"],
  },
  readOnly: false,

  async run({ path: filePath, old_string, new_string, replace_all = false }, ctx) {
    const absolute = resolveInWorkspace(ctx.cwd, filePath);
    assertWritable(absolute, ctx);
    if (old_string === new_string) throw new Error("old_string and new_string are identical.");
    if (old_string === "") throw new Error("old_string is empty; use write_file to create files.");

    await assertFreshRead(absolute, ctx);
    const oldText = await fs.readFile(absolute, "utf8");

    // The model always writes "\n". If this file uses Windows line endings
    // ("\r\n"), convert the strings so they can match and the file stays consistent.
    let search = old_string;
    let replacement = new_string;
    if (oldText.includes("\r\n")) {
      search = search.replace(/\r?\n/g, "\r\n");
      replacement = replacement.replace(/\r?\n/g, "\r\n");
    }

    const count = countOccurrences(oldText, search);
    if (count === 0) {
      throw new Error(
        "old_string was not found. Re-read the file and copy the text exactly, including whitespace."
      );
    }
    if (count > 1 && !replace_all) {
      throw new Error(
        `old_string appears ${count} times. Add more surrounding context to make it unique, or set replace_all.`
      );
    }

    // split/join replaces every occurrence without treating `$` specially,
    // which String.replace would do.
    const newText = oldText.split(search).join(replacement);
    return applyChange({ absolute, oldText, newText, ctx });
  },
};
