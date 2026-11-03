import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Settings files. Both are optional; the project file adds to the user file.
//
//   ~/.devpilot/settings.json          you, in every project
//   <project>/.devpilot/settings.json  this project only
//
// Example:
//
//   {
//     "permissions": {
//       "allow": ["npm test", "git status", "git diff"],
//       "deny":  ["git push", "npm publish"]
//     },
//     "testCommand": "npm test"
//   }
//
// allow: commands that start with one of these run without asking (only simple
//        commands: no `&&`, `;`, `|`, redirects or `$(...)`, see safety.js).
// deny:  commands containing a segment that starts with one of these never run.
//
// The file tools refuse to write inside .devpilot/, so the model cannot
// quietly allow-list commands for itself.
export function loadSettings(cwd) {
  const files = [
    path.join(os.homedir(), ".devpilot", "settings.json"),
    path.join(cwd, ".devpilot", "settings.json"),
  ];

  const settings = { allow: [], deny: [], testCommand: null, sources: [] };
  const strings = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === "string" && x.trim()) : []);

  for (const file of new Set(files)) {
    if (!existsSync(file)) continue;

    let data;
    try {
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`Could not parse ${file}: ${err.message}`);
    }

    settings.allow.push(...strings(data.permissions?.allow).map((s) => s.trim()));
    settings.deny.push(...strings(data.permissions?.deny).map((s) => s.trim()));
    if (typeof data.testCommand === "string") settings.testCommand = data.testCommand;
    settings.sources.push(file);
  }
  return settings;
}
