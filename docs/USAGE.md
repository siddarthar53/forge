# Using DevPilot

- [Install and run](#install-and-run)
- [Configuration (`.env`)](#configuration-env)
- [In the chat](#in-the-chat)
- [Slash commands](#slash-commands)
- [Permission rules (`.devpilot/settings.json`)](#permission-rules-devpilotsettingsjson)
- [Project instructions (`AGENTS.md`)](#project-instructions-agentsmd)
- [MCP servers (`.mcp.json`)](#mcp-servers-mcpjson)
- [Custom sub-agents (`.devpilot/agents/*.md`)](#custom-sub-agents-devpilotagentsmd)
- [VS Code](#vs-code)

## Install and run

Needs Node.js 22 or newer and an [OpenRouter](https://openrouter.ai) API key.

```bash
git clone https://github.com/siddarthar53/forge.git
cd forge
npm install
cp .env.example .env          # then put your key and model in it
npm start                     # runs DevPilot on its own folder
npm test                      # 37 tests, no API key needed
```

To use it on another project, run it from that project's folder:

```bash
cd path/to/your/project
node path/to/forge/index.js
# or once, inside forge: `npm link`, then just `devpilot` anywhere

devpilot --continue           # pick up the most recent conversation here
devpilot --resume             # choose a saved conversation from a list
devpilot --rpc                # JSON-lines mode for editors (used by the VS Code extension)
```

## Configuration (`.env`)

`.env` lives in DevPilot's own folder, not in your project.

| Variable | Default | What it does |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | required | Your OpenRouter key. |
| `OPENROUTER_MODEL` | required | A model that supports tool calling, e.g. `anthropic/claude-sonnet-4.5`. |
| `OPENROUTER_BASE_URL` | OpenRouter | Any OpenAI-compatible endpoint. |
| `DEVPILOT_MAX_STEPS` | `25` | Model calls per message before it stops and asks you to continue. |
| `DEVPILOT_SUBAGENT_MAX_STEPS` | `30` | The same, for each sub-agent. |
| `DEVPILOT_COMPACT_AT` | `0.8` | Summarize the conversation when the context is this full. |
| `DEVPILOT_CONTEXT_WINDOW` | from OpenRouter | Override the model's context window (tokens). |
| `DEVPILOT_AUTO_BRANCH` | on | `0` = don't create a `devpilot/*` branch before the first edit on main. |
| `DEVPILOT_SANDBOX` | off | `docker` = run shell commands in a throwaway container. |
| `DEVPILOT_SANDBOX_IMAGE` | `node:22` | The container image. |
| `DEVPILOT_SANDBOX_NETWORK` | off | `1` = allow network inside the sandbox. |

## In the chat

- At a permission prompt: `y` yes, `n` no, `a` always (for this session), or
  type feedback to decline with a reason the model will read.
- **Ctrl+C** stops the current task. At the `You:` prompt it quits; so does `exit`.
- Every edit shows a diff first. Every shell command shows the exact command.

## Slash commands

| Command | What it does |
| --- | --- |
| `/help` | List the commands. |
| `/plan` | Toggle plan mode: read-only exploring, then a plan you approve. |
| `/todos` | Show the agent's checklist. |
| `/test [cmd]` | Run the tests; on failure the agent fixes and DevPilot reruns (max 3 rounds). |
| `/undo` | Undo the last turn: restore the files it changed and rewind the chat. |
| `/commit [msg]` | Commit all changes; without a message the model writes one for you to approve. |
| `/compact [focus]` | Summarize the conversation to free up context. |
| `/context` | How full the context window is. |
| `/cost` | Tokens (and how many came from the cache) and dollars for this conversation. |
| `/model [id]` | Show or switch the model. |
| `/mcp` | MCP servers: status, tools, errors. |
| `/agents` | Sub-agents the model can start, with their tools. |
| `/clear` | Start a fresh conversation (the old one stays saved). |
| `/sessions`, `/resume [n]` | List or continue saved conversations. |
| `/exit` | Quit. |

## Permission rules (`.devpilot/settings.json`)

In your project's `.devpilot/settings.json` (or `~/.devpilot/settings.json`
for every project):

```json
{
  "permissions": {
    "allow": ["npm test", "git status", "git diff", "mcp__github__get_*"],
    "deny": ["git push", "npm publish"]
  },
  "testCommand": "npm test"
}
```

- `allow`: commands starting with one of these run without asking, but only
  simple ones (no `&&`, `;`, `|`, redirects or `$(...)`). MCP tool names and
  prefixes ending in `*` work too.
- `deny`: never run, anywhere in a chain of commands.
- Some commands are always blocked: recursive deletes of `/`, `~` or the whole
  workspace, disk formatting, force pushes, piping a download into a shell, and
  anything touching `.env`.
- The model's file tools cannot write inside `.devpilot/` or `.git/`, so it
  cannot change these rules itself.

## Project instructions (`AGENTS.md`)

Put an `AGENTS.md` in your project root with build and test commands, code
style and "never do X" rules. DevPilot adds it to the system prompt.

## MCP servers (`.mcp.json`)

Configure servers in `<project>/.mcp.json` (shared with your team) or
`~/.devpilot/mcp.json` (just you). It is the same format Claude Code uses:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" },
      "tools": ["get_*", "search_*", "list_*"]
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "timeout": 60
    }
  }
}
```

- `command` + `args` + `env`: a local server DevPilot starts (stdio).
  `url` + `headers`: a remote server (Streamable HTTP).
- `${VAR}` is read from your environment, so tokens stay out of the file.
- `tools` is an allow-list (`*` matches a prefix); `disabled: true` skips a server;
  `timeout` is seconds per tool call (default 120).
- A project's `.mcp.json` can start any program, so DevPilot asks before
  trusting each server, and again if its command or URL changes.
- Every MCP tool call asks permission unless an allow rule matches. In plan
  mode only tools the server marks read-only are available.
- Not supported yet: OAuth login (use a token in `headers`), the old SSE
  transport, MCP prompts and sampling.

## Custom sub-agents (`.devpilot/agents/*.md`)

Built in: `explorer` (read-only search), `reviewer` (reviews the git diff, can
run tests) and `general` (can edit; edits still ask you). Add your own as a
Markdown file in `<project>/.devpilot/agents/` or `~/.devpilot/agents/`:

```markdown
---
name: test-writer
description: Writes unit tests for one module, following the project's style.
tools: read_file, list_files, grep, write_file, edit_file, run_shell
model: anthropic/claude-haiku-4.5
---
You write focused unit tests. Read the module and its existing tests first,
match their style, and run the tests before you report back.
```

`tools` takes names or prefixes (`mcp__github__*`), or `mcp:read-only` for every
read-only MCP tool. `model` is optional. A project agent with a built-in's name
replaces it.

## VS Code

See [`vscode-extension/README.md`](../vscode-extension/README.md). In short:

```bash
cd vscode-extension
npm install
npm run package          # → devpilot-0.1.0.vsix, with DevPilot bundled inside
```

Then in VS Code: *Extensions* → `…` → *Install from VSIX…*, run *DevPilot: Set
OpenRouter API Key*, and set `devpilot.model` in Settings.
