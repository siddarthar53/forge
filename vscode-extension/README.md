# DevPilot for VS Code

The DevPilot coding agent in a VS Code side panel. It is the same agent as
the terminal version (MCP servers, sub-agents, plan mode, `/undo`,
`/commit`...), with an editor UI on top:

- **Chat panel** in the activity bar, with streaming replies, tool calls you
  can expand, sub-agent progress, the agent's checklist, and a footer with
  the model, context usage, cost and git branch.
- **Diff review.** When DevPilot wants to change a file, VS Code's diff view
  opens with the proposed change. Accept or reject it from the diff editor's
  title bar (✓ / ✕) or from the card in the chat, or type what to do instead.
- **Editor context.** Each message includes the open file, your selection
  and the problems VS Code reports for that file. The chip above the
  message box shows what will be sent; click × to leave it out.
- **Commands:** *Explain Selection* and *Fix Problems in This File* in the
  editor's right-click menu; *Review My Changes*, *New Chat*, *Toggle Plan
  Mode* and *Restart Agent* in the command palette. Type `/` in the chat for
  DevPilot's slash commands.

## Setup

1. Install Node.js 22 or newer.
2. Install the extension: *Extensions* view → `…` → *Install from VSIX…* and
   pick `devpilot-0.1.0.vsix`.
3. Run **DevPilot: Set OpenRouter API Key** from the command palette. The key
   is kept in VS Code's secret storage.
4. Set **devpilot.model** in Settings to an OpenRouter model that supports
   tool calling, e.g. `anthropic/claude-sonnet-4.5`.
5. Open a folder, click the DevPilot icon in the activity bar, and ask away.

DevPilot reads the same project files as in the terminal: `AGENTS.md`,
`.mcp.json`, `.devpilot/settings.json` and `.devpilot/agents/*.md`.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `devpilot.model` | (empty) | OpenRouter model id. Empty: `OPENROUTER_MODEL` from DevPilot's `.env` or your environment. |
| `devpilot.cliPath` | (empty) | DevPilot's `index.js`. Empty: the copy bundled in the extension, or the repository the extension sits in. |
| `devpilot.nodePath` | `node` | Node.js used to run DevPilot. |
| `devpilot.env` | `{}` | Extra environment variables, e.g. `{ "DEVPILOT_SANDBOX": "docker" }`. |
| `devpilot.includeEditorContext` | `true` | Send open file, selection and problems with each message. |
| `devpilot.openDiffs` | `true` | Open the diff view for every proposed change. |
| `devpilot.saveBeforeSend` | `true` | Save unsaved files before sending, so DevPilot works on what you see. |

## How it works

```
VS Code                                            child process
┌─────────────────────────────────────┐           ┌───────────────────┐
│ chat webview ⇄ extension.js ⇄ diff  │ ⇄ JSON ⇄  │ devpilot --rpc    │
│ view, status bar, editor context    │   lines   │ (the agent itself)│
└─────────────────────────────────────┘           └───────────────────┘
```

The extension never calls the model. It starts `devpilot --rpc` in your
workspace folder and exchanges one JSON object per line over stdin/stdout
(`src/rpc.js` in the DevPilot repository documents every message). That
keeps one agent implementation for both front ends, and the extension stays
small:

| File | What it does |
| --- | --- |
| `extension.js` | Activation, the webview provider, commands, diff views, status bar. |
| `lib/agent-process.js` | Starts DevPilot and speaks the JSON-lines protocol. No VS Code dependency. |
| `lib/editor-context.js` | Collects the open file, selection, problems and open editors. |
| `media/chat.js`, `media/chat.css` | The chat UI. Colors come from the VS Code theme. |
| `scripts/bundle-agent.mjs` | Copies DevPilot into `agent/` for a self-contained `.vsix`. |

## Develop

```bash
cd vscode-extension
npm install
npm run check      # type-check against the VS Code API
npm test           # extension logic against the real agent (fake vscode module)
npm run package    # bundle the agent and build devpilot-0.1.0.vsix
```

To try it from source, open the `forge` repository in VS Code, and run
*Debug: Start Debugging* with an "Extension Development Host" launch config
pointing at `vscode-extension/`. It uses `../index.js` directly.

## Limits

- One workspace folder: DevPilot runs in the first folder of the window.
- Local folders only (not Remote SSH, WSL or virtual workspaces).
- DevPilot edits files on disk. Unsaved changes are saved before each
  message (see `devpilot.saveBeforeSend`).
- No inline completions (ghost text): that is a different, low-latency
  model path, not an agent.
