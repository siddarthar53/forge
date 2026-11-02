// Copy DevPilot (index.js, src/, package files) into ./agent and install its
// runtime dependencies there, so the packaged extension (.vsix) works on its
// own: install it, set your API key, and go. Run from vscode-extension/:
//
//   npm run bundle-agent
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(extension, "..");
const target = path.join(extension, "agent");

if (!existsSync(path.join(repo, "index.js")) || !existsSync(path.join(repo, "src", "agent.js"))) {
  console.error(`DevPilot not found in ${repo}; run this from the forge repository's vscode-extension folder.`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const item of ["index.js", "src", "package.json", "package-lock.json"]) {
  cpSync(path.join(repo, item), path.join(target, item), { recursive: true });
}
execSync("npm ci --omit=dev --no-audit --no-fund", { cwd: target, stdio: "inherit" });
console.log(`Bundled DevPilot into ${target}`);
