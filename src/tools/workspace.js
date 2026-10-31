import path from "node:path";

// Folders the file tools never walk into: huge, generated, or private.
export const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".devpilot",
  "dist",
  "build",
  "coverage",
]);

// Turn a path from the model into an absolute path, and refuse anything
// that escapes the workspace (e.g. "../../Windows/System32").
export function resolveInWorkspace(cwd, filePath) {
  const absolute = path.resolve(cwd, filePath);
  const relative = path.relative(cwd, absolute);

  const escapes =
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative); // different drive letter on Windows

  if (escapes) {
    throw new Error(`Path is outside the workspace: ${filePath}`);
  }
  return absolute;
}

// Display paths relative to the workspace with forward slashes on every OS.
export function displayPath(cwd, absolute) {
  return path.relative(cwd, absolute).split(path.sep).join("/") || ".";
}

// The file tools never write into these folders: .git is git's database, and
// .devpilot holds session logs and settings (an allow-list the model must
// not be able to edit for itself).
const PROTECTED_DIRS = new Set([".git", ".devpilot"]);

export function isProtectedPath(cwd, absolute) {
  const first = path.relative(cwd, absolute).split(path.sep)[0];
  return PROTECTED_DIRS.has(first);
}

// .env files hold API keys. Never send their contents to the model.
export function isSecretFile(absolute) {
  return /^\.env(\..*)?$/.test(path.basename(absolute));
}

// A file is treated as binary if its first 8 KB contain a NUL byte.
export function looksBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}
