# DevPilot

A coding agent for the terminal: an LLM in a loop with tools, pointed at a
codebase. This branch is **Tier 2** of the build plan in
`Coding Agent Feature Map Claude Code, Codex, GitHub Copilot.md`. Tier 1 (the
minimum viable agent) lives on the `tier-1` branch, unchanged.

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
| `/clear` | Start a fresh conversation (the old one stays saved). |
| `/sessions`, `/resume [n]` | List or continue saved conversations. |
| `/exit` | Quit. |

## File map (read in this order)

| File | What it does |
| --- | --- |
| `index.js` | Flags (`--continue`, `--resume`), `.env` config, the API client. |
| `src/chat.js` | The REPL: messages vs slash commands, Ctrl+C, one `app` object shared with the commands. |
| `src/agent.js` | **The agent loop.** Streaming, tool calls, usage, auto-compaction, loop detection. |
| `src/commands.js` | Every slash command. |
| `src/tools/index.js` | Tool registry, JSON Schema validation, the plan-mode gate, result size cap. |
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
| `src/permissions.js` | The y / n / always prompt. |
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

## Not in Tier 2 (that's Tier 3)

MCP client, sub-agents, hooks, skills, headless mode and a GitHub Action,
embedding search, background mode, a web UI. And Tier 4: an evaluation
benchmark to measure all of this.
