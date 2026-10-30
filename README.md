# DevPilot

A minimal coding agent for the terminal: an LLM in a loop with tools, pointed
at a codebase. This is **Tier 1** of the build plan in
`Coding Agent Feature Map Claude Code, Codex, GitHub Copilot.md`.

## Run it

```bash
npm install
npm start                     # works on the DevPilot folder itself
```

To use it on another project, run it from that project's folder:

```bash
cd path/to/some/project
node "path/to/Coding Agent/index.js"
# or once: `npm link` inside this folder, then just `devpilot` anywhere
```

`.env` (in this folder) needs:

```
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=...          # must support tool calling
DEVPILOT_MAX_STEPS=25         # optional
```

Keys: `y` / `n` / `a` (always) at a permission prompt, or type feedback to
decline with a reason. **Ctrl+C** stops the current task; at the `You:` prompt
it quits. `exit` also quits.

## File map (read in this order)

| File | What it does |
| --- | --- |
| `index.js` | Loads `.env`, validates config, creates the OpenAI-compatible client, starts the chat. |
| `src/chat.js` | The REPL: reads your message, runs the agent, handles Ctrl+C and errors. |
| `src/agent.js` | **The agent loop.** Streams a reply, rebuilds tool calls from fragments, runs tools, repeats. |
| `src/tools/index.js` | Tool registry: converts tools to the API format, validates arguments, turns errors into results. |
| `src/tools/files.js` | `read_file`, `list_files`, `grep`, `write_file`, `edit_file`. |
| `src/tools/shell.js` | `run_shell`: PowerShell on Windows, bash elsewhere, with timeout and output truncation. |
| `src/tools/workspace.js` | Path safety (no escaping the workspace), `.env` protection, binary detection. |
| `src/permissions.js` | The y / n / always prompt. |
| `src/prompt.js` | Builds the system prompt: rules, environment info, and your project's `AGENTS.md`. |
| `src/session.js` | Holds the message history and appends every message to `.devpilot/sessions/*.jsonl`. |
| `src/ui.js` | Terminal colors and colored diffs. |

## What happens in one turn

```
You: "fix the failing test"
  │
  ▼
history = [system prompt, ...earlier messages, your message]
  │
  ▼
┌─► model call (streamed) ──► text?        print it as it arrives
│        │
│        └──────────────────► tool calls?  for each one:
│                                            validate args
│                                            ask permission (edits, shell)
│                                            run it, push {role:"tool"} result
└────────── loop again with the results added ◄─┘

stops when the model replies with no tool calls, you press Ctrl+C,
or it hits DEVPILOT_MAX_STEPS
```

## Concepts to study, and where they live

1. **Tool calling.** The model never runs anything itself. It returns JSON
   saying "call `read_file` with `{path}`"; *our* code runs it
   (`tools/index.js` → `executeToolCall`).
2. **Streaming tool calls.** Arguments arrive in pieces and are glued together
   by `index` (`agent.js` → `streamAssistantMessage`).
3. **History must stay valid.** Every `tool_call` needs a matching `tool`
   message, even when cancelled (`agent.js` → `runAgent`).
4. **Errors are results.** A bad call returns an error string the model can read
   and fix, instead of crashing the loop.
5. **String-replace edits.** `old_string` must be unique, which forces the model
   to give enough context. More reliable than rewriting whole files.
6. **Read-before-write + stale detection.** Edits require a prior read and fail
   if the file changed since then (`files.js` → `assertFreshRead`).
7. **Permissions.** Read-only tools run freely; edits show a diff and ask; shell
   commands ask (`permissions.js`).
8. **Bounded tools.** Caps on lines, matches, output size, and command time keep
   the context window from filling up.
9. **Prompt-injection awareness.** The system prompt says tool output is data,
   not instructions. `.env` files are never read.
10. **Cancellation.** One `AbortController` per turn is passed to the HTTP
    request, the permission prompt, and the running shell command.

## Not in Tier 1 (that's Tier 2)

Todo list and plan mode, token counting and auto-compaction, prompt caching,
session resume, git checkpoints, a Docker sandbox, slash commands, `.gitignore`
support in search.
