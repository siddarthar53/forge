import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Which MCP servers to start. Two files, same format (the format Claude Code
// and other tools use, so one .mcp.json can serve several agents):
//
//   ~/.devpilot/mcp.json   your servers, in every project
//   <project>/.mcp.json    servers for this project, usually committed
//
//   {
//     "mcpServers": {
//       "github": {
//         "command": "npx",
//         "args": ["-y", "@modelcontextprotocol/server-github"],
//         "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" },
//         "tools": ["get_*", "search_*"]
//       },
//       "docs": {
//         "url": "https://example.com/mcp",
//         "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" }
//       }
//     }
//   }
//
// command/args/env -> a local server started as a child process (stdio)
// url/headers      -> a remote server over Streamable HTTP
// tools            -> optional allow-list; `*` at the end matches a prefix
// disabled: true   -> skip this server
// timeout          -> seconds to wait for one tool call (default 120)
//
// `${VAR}` is replaced by the environment variable VAR, so tokens stay out
// of the file. A project's .mcp.json can start any program on your machine,
// so DevPilot asks before trusting it (and again if it changes).

export function userConfigFile() {
  return path.join(os.homedir(), ".devpilot", "mcp.json");
}

export function projectConfigFile(cwd) {
  return path.join(cwd, ".mcp.json");
}

function trustFile() {
  return path.join(os.homedir(), ".devpilot", "mcp-trust.json");
}

// Replace ${VAR} in every string of a config value.
export function expandEnv(value, env = process.env, missing = new Set()) {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
      if (env[name] === undefined) missing.add(name);
      return env[name] ?? "";
    });
  }
  if (Array.isArray(value)) return value.map((item) => expandEnv(item, env, missing));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v, env, missing)]));
  }
  return value;
}

function validateServer(name, raw, file) {
  const where = `MCP server "${name}" in ${file}`;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`${where}: names may only use letters, digits, _ and -`);
  if (typeof raw !== "object" || raw === null) throw new Error(`${where}: must be an object`);
  const hasCommand = typeof raw.command === "string" && raw.command.trim() !== "";
  const hasUrl = typeof raw.url === "string" && raw.url.trim() !== "";
  if (hasCommand === hasUrl) throw new Error(`${where}: needs either "command" (local) or "url" (remote)`);
  if (raw.args !== undefined && !(Array.isArray(raw.args) && raw.args.every((a) => typeof a === "string"))) {
    throw new Error(`${where}: "args" must be a list of strings`);
  }
  if (raw.tools !== undefined && !(Array.isArray(raw.tools) && raw.tools.every((t) => typeof t === "string"))) {
    throw new Error(`${where}: "tools" must be a list of tool names`);
  }
  if (hasUrl && !/^https?:\/\//.test(raw.url)) throw new Error(`${where}: "url" must start with http:// or https://`);
}

function readConfigFile(file, scope) {
  if (!existsSync(file)) return [];
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Could not parse ${file}: ${err.message}`);
  }
  const servers = data?.mcpServers ?? {};
  return Object.entries(servers).map(([name, raw]) => {
    validateServer(name, raw, file);
    return { name, scope, file, raw };
  });
}

// Fingerprint of everything that decides what runs. Changing the command,
// args, env, url or headers makes DevPilot ask again.
export function fingerprint(raw) {
  const { command, args, env, url, headers } = raw;
  return createHash("sha256").update(JSON.stringify({ command, args, env, url, headers })).digest("hex").slice(0, 16);
}

function loadTrust() {
  try {
    return JSON.parse(readFileSync(trustFile(), "utf8"));
  } catch {
    return {};
  }
}

function saveTrust(trust) {
  mkdirSync(path.dirname(trustFile()), { recursive: true });
  writeFileSync(trustFile(), JSON.stringify(trust, null, 2) + "\n");
}

// Returns the servers to start, already expanded. `ask` prompts the user;
// without it (non-interactive) untrusted project servers are skipped.
export async function loadMcpServers(cwd, { ask } = {}) {
  const userServers = readConfigFile(userConfigFile(), "user");
  const projectServers = readConfigFile(projectConfigFile(cwd), "project");

  // A project server with the same name as one of yours replaces it.
  const byName = new Map();
  for (const server of [...userServers, ...projectServers]) byName.set(server.name, server);

  const trust = loadTrust();
  const result = { servers: [], skipped: [] };

  for (const server of byName.values()) {
    if (server.raw.disabled) {
      result.skipped.push({ name: server.name, reason: "disabled" });
      continue;
    }

    if (server.scope === "project") {
      const key = `${path.resolve(cwd)}::${server.name}`;
      const print = fingerprint(server.raw);
      if (trust[key] !== print) {
        const what = server.raw.command ? [server.raw.command, ...(server.raw.args ?? [])].join(" ") : server.raw.url;
        const answer = ask
          ? (await ask(`.mcp.json wants to start the MCP server "${server.name}":\n    ${what}\n  Trust it? [y] yes  [n] skip  > `)).trim().toLowerCase()
          : "n";
        if (answer !== "y" && answer !== "yes") {
          result.skipped.push({ name: server.name, reason: "not trusted" });
          continue;
        }
        trust[key] = print;
        saveTrust(trust);
      }
    }

    const missing = new Set();
    const expanded = expandEnv(server.raw, process.env, missing);
    result.servers.push({
      name: server.name,
      scope: server.scope,
      transport: expanded.command ? "stdio" : "http",
      command: expanded.command,
      args: expanded.args ?? [],
      env: expanded.env ?? {},
      url: expanded.url,
      headers: expanded.headers ?? {},
      tools: server.raw.tools ?? null,
      timeoutMs: (Number(server.raw.timeout) || 120) * 1000,
      missingEnv: [...missing],
    });
  }
  return result;
}
