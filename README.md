# DevPilot

A coding agent for the terminal: an LLM in a loop with tools, pointed at a
codebase. This branch adds **sub-agents** on top of the
Tier 3 MCP branch, following the build plan in
`Coding Agent Feature Map Claude Code, Codex, GitHub Copilot.md`.

| Branch | Built on | Adds |
| --- | --- | --- |
| `tier-1` | | the minimum viable agent |
| `tier-2` | `tier-1` | plan mode, context management, resume, git, sandbox, slash commands |
| `tier-3-mcp` | `tier-2` | MCP client |
| `tier-3-subagents` | `tier-3-mcp` | sub-agents and parallel tool calls (this branch) |

## Run it

```bash
npm install
npm start                     # works on the DevPilot folder itself
npm test                      # unit tests + a scripted replay of the agent loop
```

To use it on another project, run it from that project's folder:

```bash
cd path/to/some/project
node "path/to/Coding Agent/index.js"
# or once: `npm link` inside this folder, then just `devpilot` anywhere

devpilot --continue           # pick up the most recent conversation here
devpilot --resume             # choose a saved conversation from a list
```

`.env` (in this folder) needs:

```
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=...          # must support tool calling
DEVPILOT_MAX_STEPS=25         # optional
```

Optional Tier 2 settings:

```
DEVPILOT_COMPACT_AT=0.8       # auto-compact when the context is 80% full
DEVPILOT_CONTEXT_WINDOW=...   # override the window read from OpenRouter
DEVPILOT_AUTO_BRANCH=0        # don't create a devpilot/* branch before the first edit
DEVPILOT_SANDBOX=docker       # run shell commands in a throwaway container
DEVPILOT_SANDBOX_IMAGE=node:22
DEVPILOT_SANDBOX_NETWORK=1    # allow network inside the sandbox (off by default)
OPENROUTER_BASE_URL=...       # any OpenAI-compatible endpoint
```

Per-project rules go in `<project>/.devpilot/settings.json` (or
`~/.devpilot/settings.json` for all projects):

```json
{
  "permissions": {
    "allow": ["npm test", "git status", "git diff"],
    "deny": ["git push", "npm publish"]
  },
  "testCommand": "npm test"
}
```

Keys: `y` / `n` / `a` (always) at a permission prompt, or type feedback to
decline with a reason. **Ctrl+C** stops the current task; at the `You:` prompt
it quits. `exit` also quits.

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

## File map (read in this order)

| File | What it does |
| --- | --- |
| `index.js` | Flags (`--continue`, `--resume`), `.env` config, the API client. |
| `src/chat.js` | The REPL: messages vs slash commands, Ctrl+C, one `app` object shared with the commands. |
| `src/agent.js` | **The agent loop.** Streaming, tool calls (in parallel when safe), usage, auto-compaction, loop detection, reporters. |
| `src/commands.js` | Every slash command. |
| `src/tools/index.js` | Toolsets (which tools an agent sees), JSON Schema validation, the plan-mode gate, result size cap. |
| `src/tools/files.js` | `read_file`, `list_files`, `grep` (all `.gitignore`-aware), `write_file`, `edit_file`. |
| `src/tools/shell.js` | `run_shell`: host shell or Docker sandbox, deny list, timeout, truncation. |
| `src/tools/todo.js` | `todo_write`: the agent's checklist. |
| `src/tools/plan.js` | `exit_plan_mode`: the agent asks you to approve its plan. |
| `src/tools/workspace.js` | Path safety, `.env` protection, protected folders (`.git`, `.devpilot`). |
| `src/safety.js` | Deny list for dangerous commands, allow/deny rules from settings. |
| `src/settings.js` | Loads `.devpilot/settings.json`. |
| `src/context.js` | Token counting, model info (window, prices), cost. |
| `src/compact.js` | Summarize-and-replace when the context fills up. |
| `src/caching.js` | Prompt-cache breakpoints for Claude models. |
| `src/session.js` | History + JSONL log; replaying the log to resume. |
| `src/checkpoints.js` | File snapshots per turn, for `/undo`. |
| `src/git.js` | Work branches, commit messages, commits. |
| `src/testloop.js` | The test-fix loop behind `/test`. |
| `src/mcp/client.js` | MCP over JSON-RPC: stdio and Streamable HTTP transports, handshake, cancellation. |
| `src/mcp/config.js` | `.mcp.json` / `~/.devpilot/mcp.json`, `${VAR}` expansion, trusting project servers. |
| `src/mcp/index.js` | Connects servers at startup and turns their tools into DevPilot tools. |
| `src/subagents.js` | Built-in and custom sub-agents, and the `task` tool that runs them. |
| `src/permissions.js` | The y / n / always prompt (queued, so parallel agents ask one at a time). |
| `src/prompt.js` | The system prompt (stable for caching) and the plan-mode reminder. |
| `src/ui.js` | Colors, diffs, number formatting, the `terminal` output object. |
| `test/` | `node --test` suites; `agent.test.js` replays scripted model streams. |

## What happens in one turn

```
You: "fix the failing test"
  │
  ▼
history = [system prompt, ...earlier messages, your message (+ plan-mode reminder)]
  │
  ▼
┌─► context nearly full? ──► yes: summarize history, replace it, continue
│        │
│        ▼
│   model call (streamed, cache breakpoints added) ──► text?  print it
│        │                                                   usage? count tokens + cost
│        └──────────────────────────────────────────────► tool calls?  for each one:
│                                                            validate args
│                                                            plan mode? only read-only tools
│                                                            deny list / allow rules (shell)
│                                                            ask permission (edits, shell)
│                                                            snapshot the file (for /undo)
│                                                            run it, push {role:"tool"} result
│                                                            same call + same result 3x? nudge
└──────────── loop again with the results added ◄─────────┘

stops when the model replies with no tool calls, you press Ctrl+C,
or it hits DEVPILOT_MAX_STEPS
```

## Tier 1 concepts (still here)

1. **Tool calling.** The model never runs anything itself; our code does
   (`tools/index.js` → `executeToolCall`).
2. **Streaming tool calls.** Arguments arrive in pieces and are glued together
   by `index` (`agent.js` → `streamAssistantMessage`).
3. **History must stay valid.** Every `tool_call` needs a matching `tool`
   message, even when cancelled, and now even after a crash (`session.js` →
   `repairHistory`).
4. **Errors are results** the model can read and fix.
5. **String-replace edits** with unique `old_string`.
6. **Read-before-write + stale detection** (`files.js` → `assertFreshRead`).
7. **Permissions.** Read-only tools run freely; edits and commands ask.
8. **Bounded tools.** Caps everywhere, plus a final cap on any tool result.
9. **Prompt-injection awareness.** Tool output is data, not instructions.
10. **Cancellation.** One `AbortController` per turn, now also passed to every
    permission prompt (Tier 1 forgot this, so Ctrl+C could not cancel one).

## Tier 2 concepts, and where they live

11. **Todo list.** The model keeps its own checklist (`tools/todo.js`). It
    sends the full list each time, so one call can add, reorder and check off.
12. **Plan mode** (`tools/plan.js`, gate in `tools/index.js`). The tool list
    and system prompt stay the same; a reminder rides on each user message
    instead. That keeps the cached prompt prefix valid.
13. **Token counting** (`context.js`, `session.js`). Exact counts come from
    the API's `usage` after each call; only messages added since then are
    estimated (about 4 characters per token).
14. **Auto-compaction** (`compact.js`). Near the limit, the model summarizes
    the conversation (goal, decisions, files, state, next steps) and the
    history is replaced by the summary. File reads are forgotten too, so the
    model must re-read before editing.
15. **Prompt caching** (`caching.js`). OpenAI-style providers cache repeated
    prefixes automatically; Claude needs `cache_control` breakpoints, added
    to a copy of the messages at request time. `/cost` shows the cache hit rate.
16. **Session resume** (`session.js`). The JSONL log is replayed:
    `message` appends, `reset` replaces (compaction, undo), plus todos and usage.
17. **Git integration** (`git.js`). A `devpilot/*` branch before the first
    edit on main; `/commit` with a model-written message that you approve;
    secrets and `.devpilot/` are never committed.
18. **Checkpoints** (`checkpoints.js`). The bytes of each file before its first
    change in a turn; `/undo` restores them and rewinds the conversation.
19. **Sandbox and deny list** (`tools/shell.js`, `safety.js`). Docker with no
    network and only the workspace mounted; a deny list for disasters; allow
    rules only for simple commands, so `npm test && rm -rf src` is not
    auto-allowed by an `npm test` rule.
20. **Test-fix loop** (`testloop.js`). DevPilot runs the tests itself, so the
    model cannot declare victory without them passing.
21. **Loop detection** (`agent.js`). Same call, same result, three times in a
    turn: the result gets a nudge to change approach.
22. **`.gitignore` support** in `list_files` and `grep` via `git check-ignore`.

## Tier 3: MCP

MCP (Model Context Protocol) lets DevPilot use tools from any MCP server:
GitHub, Postgres, Sentry, a browser, your own. Configure servers in
`<project>/.mcp.json` (shared with the team) or `~/.devpilot/mcp.json`
(just you). It is the same format Claude Code uses:

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
- `tools` is an allow-list (`*` matches a prefix); `disabled: true` skips a server.
- A project `.mcp.json` can start any program, so DevPilot asks before
  trusting each server, and asks again if its command or URL changes
  (remembered in `~/.devpilot/mcp-trust.json`).
- Every MCP tool call asks permission. Skip the prompt for specific tools
  in `.devpilot/settings.json`: `"allow": ["mcp__github__get_*"]`, or
  block them with `"deny"`.
- In plan mode only tools the server marks `readOnlyHint` are available.
- If a server offers resources, `mcp_list_resources` and `mcp_read_resource`
  let the model read them.

Concepts, and where they live:

23. **JSON-RPC by hand** (`mcp/client.js`). Requests have an `id` and get a
    response; notifications don't. A pending-request map matches replies to
    callers; timeouts and Ctrl+C send `notifications/cancelled`.
24. **Two transports.** stdio: newline-delimited JSON over a child process's
    pipes, stderr kept for error messages. Streamable HTTP: one POST per
    message, the reply is JSON or a short event stream, plus the
    `Mcp-Session-Id` header.
25. **Tools are data.** Each server tool becomes a normal DevPilot tool named
    `mcp__<server>__<tool>` with the server's own description and JSON
    Schema; the agent loop does not know the difference.
26. **Stable tool list.** Servers connect before the first model call, so
    the tools stay fixed and the prompt cache keeps working. A server that
    announces new tools is noted in `/mcp`; restart to pick them up.
27. **Trust boundaries.** Untrusted config is not executed silently, MCP
    output is treated as data, and secrets come from the environment.

Not done (yet): OAuth login for remote servers (use a token in `headers`),
the old SSE transport, MCP prompts as slash commands, and sampling/roots.

## Tier 3: sub-agents

The main agent can hand a self-contained job to a **sub-agent** with its
own fresh context window and a restricted set of tools, using the `task`
tool. Only the sub-agent's final report comes back, so a search through 30
files costs the main conversation a few hundred tokens instead of 30 files.

```
⏺ task {"agent":"explorer","description":"Find auth", ...}
  ⧉ explorer#1 Find auth
⏺ task {"agent":"explorer","description":"Find db", ...}
  ⧉ explorer#2 Find db
  ↳ explorer#1 grep {"pattern":"login"}
  ↳ explorer#2 grep {"pattern":"db"}
  ✓ explorer#2 done · 2 steps · 2.0k tokens
  ✓ explorer#1 done · 2 steps · 2.0k tokens
```

| Agent | Tools | Use |
| --- | --- | --- |
| `explorer` | read, list, grep, read-only MCP tools | Broad searches and "how does X work" questions. Read-only, so several run at once, also in plan mode. |
| `reviewer` | read tools + `run_shell` | Reviews the git diff for bugs and edge cases, can run tests, never edits. |
| `general` | everything except `task`, todos and plan tools | A self-contained chunk of work; edits still ask you. |

Add your own as Markdown files in `<project>/.devpilot/agents/` (or
`~/.devpilot/agents/` for every project). A project agent with a built-in's
name replaces it.

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

`tools` takes names or prefixes (`mcp__github__*`), and `mcp:read-only` for
every read-only MCP tool. `model` is optional (default: the main model).
`DEVPILOT_SUBAGENT_MAX_STEPS` (default 30) caps each run.

Concepts, and where they live:

28. **Context isolation** (`subagents.js`). A sub-agent is just `runAgent`
    again with a new session, a new system prompt and its own `readFiles`
    map. Its log goes to `.devpilot/subagents/`; the main log records which file.
29. **Toolsets** (`tools/index.js`). The model only sees the tools in its
    toolset, and calls to anything else are refused, so "read-only" is
    enforced, not just requested. Sub-agents never get `task` (no nesting).
30. **Parallel tool calls** (`agent.js` → `groupForParallel`). Neighbouring
    calls that are read-only and never prompt (reads, greps, read-only
    agents) run with `Promise.all`; results go back in the original order.
31. **Shared safety.** Sub-agents use your permission prompts (labelled
    `[explorer#2]` and queued one at a time), your allow/deny rules, the
    sandbox, and the same `/undo` checkpoint as the turn that started them.
    Their tokens and cost are added to `/cost`.
32. **Reporters** (`agent.js`). The loop reports events (text, tool call,
    result, notice) instead of printing, so the same loop drives the
    terminal, a sub-agent's one-line summaries, or an editor.

## Not in Tier 3 yet

Next on its own branch: a VS Code extension. Still open:
hooks, skills, headless mode and a GitHub Action, embedding search,
background mode. And Tier 4: an evaluation benchmark to measure all of this.
