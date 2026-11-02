// @ts-check
"use strict";

const crypto = require("node:crypto");
const vscode = require("vscode");
const { AgentProcess, resolveCliPath } = require("./lib/agent-process");
const { collectEditorContext, describeContext } = require("./lib/editor-context");

// The DevPilot VS Code extension.
//
//   ┌──────────── VS Code ─────────────┐        ┌──── child process ────┐
//   │ chat webview  ◄─postMessage─►  extension  ◄─JSON lines─►  devpilot --rpc │
//   │ diff editor, status bar, editor context    │        │ (the same agent as  │
//   └────────────────────────────────────────────┘        │  the terminal one)  │
//                                                          └─────────────────────┘
//
// The extension never talks to the model itself. It starts DevPilot in the
// workspace folder, forwards your messages (plus what your editor shows),
// draws what DevPilot reports, and turns approval requests into diff views.

const VIEW_ID = "devpilot.chat";
const DIFF_SCHEME = "devpilot-diff";
const SECRET_KEY = "devpilot.openrouterApiKey";
const MAX_TRANSCRIPT = 3000;

class Controller {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.context = context;
    this.output = vscode.window.createOutputChannel("DevPilot");
    /** @type {vscode.WebviewView | null} */
    this.view = null;
    /** @type {AgentProcess | null} */
    this.agent = null;
    this.processState = { state: "stopped", message: null, needs: null };
    /** @type {object[]} events kept so the chat can be redrawn after the view is re-created */
    this.transcript = [];
    this.status = null;
    this.busy = false;
    /** @type {Map<number, { event: any, before?: vscode.Uri, after?: vscode.Uri }>} */
    this.approvals = new Map();
    /** @type {Map<string, string>} uri -> text for the diff view */
    this.diffContents = new Map();
    this.diffChanged = new vscode.EventEmitter();

    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBar.command = "devpilot.focus";
    this.statusBar.text = "$(hubot) DevPilot";
    this.statusBar.tooltip = "Open DevPilot";
    this.statusBar.show();

    context.subscriptions.push(this.output, this.statusBar, this.diffChanged);
  }

  // ------------------------------------------------------------ webview

  /** @param {vscode.WebviewView} view */
  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((message) => this.onWebviewMessage(message));
    view.onDidDispose(() => (this.view = null));
    this.ensureStarted();
  }

  /** @param {vscode.Webview} webview @param {vscode.Uri} media */
  html(webview, media) {
    const nonce = crypto.randomBytes(16).toString("base64");
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.js"));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>DevPilot</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  /** @param {object} message */
  post(message) {
    this.view?.webview.postMessage(message);
  }

  async onWebviewMessage(message) {
    switch (message.type) {
      case "ready":
        this.post({
          type: "init",
          transcript: this.transcript,
          status: this.status,
          process: this.processState,
          busy: this.busy,
          includeContext: vscode.workspace.getConfiguration("devpilot").get("includeEditorContext", true),
        });
        this.postContext();
        return;
      case "send":
        return this.sendPrompt(message.text, { includeContext: message.includeContext });
      case "stop":
        return this.stop();
      case "approval":
        return this.answerApproval(message.id, message.answer);
      case "answer":
        this.agent?.send({ type: "answer", id: message.id, text: message.text });
        return;
      case "openDiff":
        return this.openDiff(message.id);
      case "openFile":
        return this.openFile(message.path, message.line);
      case "restart":
        return this.restart();
      case "setApiKey":
        return this.setApiKey();
      case "openSettings":
        return vscode.commands.executeCommand("workbench.action.openSettings", "devpilot");
      case "showLog":
        return this.output.show();
    }
  }

  // -------------------------------------------------------- agent process

  get workspaceFolder() {
    return vscode.workspace.workspaceFolders?.[0] ?? null;
  }

  async ensureStarted() {
    if (this.agent?.running) return true;
    const folder = this.workspaceFolder;
    if (!folder) {
      this.setProcessState("stopped", "Open a folder to use DevPilot. It works on the files of that folder.");
      return false;
    }
    if (folder.uri.scheme !== "file") {
      this.setProcessState("stopped", "DevPilot needs a folder on this machine (not a remote or virtual workspace).");
      return false;
    }

    const config = vscode.workspace.getConfiguration("devpilot");
    const cliPath = resolveCliPath({ setting: config.get("cliPath", ""), extensionPath: this.context.extensionPath });
    if (!cliPath) {
      this.setProcessState("exited", "Could not find DevPilot. Set devpilot.cliPath to the index.js of your DevPilot folder.", "settings");
      return false;
    }

    /** @type {Record<string, string>} */
    const env = { ...config.get("env", {}) };
    const apiKey = await this.context.secrets.get(SECRET_KEY);
    if (apiKey) env.OPENROUTER_API_KEY = apiKey;
    const model = config.get("model", "");
    if (model) env.OPENROUTER_MODEL = model;

    const agent = new AgentProcess({ cliPath, cwd: folder.uri.fsPath, nodePath: config.get("nodePath", "node") || "node", env });
    this.agent = agent;
    agent.on("event", (event) => this.onAgentEvent(event));
    agent.on("stderr", (chunk) => this.output.append(chunk));
    agent.on("exit", (info) => this.onAgentExit(agent, info));

    this.output.appendLine(`[devpilot] starting ${cliPath} in ${folder.uri.fsPath}`);
    this.setProcessState("starting", null);
    agent.start();
    return true;
  }

  async restart() {
    const agent = this.agent;
    this.agent = null;
    await agent?.stop();
    this.clearApprovals();
    this.transcript = [];
    this.busy = false;
    this.post({ type: "reset" });
    await this.ensureStarted();
  }

  stop() {
    this.agent?.send({ type: "cancel" });
  }

  onAgentExit(agent, { code, fatal, stderr }) {
    if (this.agent !== agent) return; // an old process we replaced on purpose
    this.agent = null;
    this.busy = false;
    this.clearApprovals();
    const message = fatal ?? (stderr.trim().split("\n").slice(-3).join("\n") || `DevPilot exited (code ${code}).`);
    this.output.appendLine(`[devpilot] exited with code ${code}: ${message}`);
    const needs = /OPENROUTER_API_KEY/.test(message) ? "apiKey" : /OPENROUTER_MODEL/.test(message) ? "model" : null;
    this.setProcessState("exited", message, needs);
    this.updateStatusBar();
  }

  setProcessState(state, message, needs = null) {
    this.processState = { state, message, needs };
    this.post({ type: "process", ...this.processState });
  }

  remember(event) {
    this.transcript.push(event);
    if (this.transcript.length > MAX_TRANSCRIPT) this.transcript.splice(0, this.transcript.length - MAX_TRANSCRIPT);
  }

  onAgentEvent(event) {
    switch (event.type) {
      case "ready":
        this.setProcessState("running", null);
        this.output.appendLine(`[devpilot] ready: ${event.model} in ${event.cwd}`);
        for (const s of event.mcp ?? []) {
          this.output.appendLine(`[devpilot] MCP ${s.name}: ${s.status}${s.error ? ` (${s.error})` : ""}`);
        }
        break;
      case "status":
        this.status = event;
        this.updateStatusBar();
        this.post({ type: "event", event });
        return;
      case "turn_start":
        this.busy = true;
        break;
      case "turn_end":
        this.busy = false;
        break;
      case "history":
        // /clear, /resume, /undo: the chat is redrawn from this.
        this.transcript = [];
        break;
      case "approval_request":
        this.approvals.set(event.id, { event });
        if (event.diff && vscode.workspace.getConfiguration("devpilot").get("openDiffs", true)) this.openDiff(event.id);
        break;
      case "request_cancelled":
        this.closeDiff(event.id);
        this.approvals.delete(event.id);
        break;
      case "fatal":
        this.output.appendLine(`[devpilot] ${event.message}`);
        break;
    }
    this.remember(event);
    this.post({ type: "event", event });
  }

  updateStatusBar() {
    const s = this.status;
    if (!this.agent?.running || !s) {
      this.statusBar.text = "$(hubot) DevPilot";
      this.statusBar.tooltip = "Open DevPilot";
      return;
    }
    const parts = ["$(hubot) DevPilot"];
    if (s.mode === "plan") parts.push("plan");
    if (s.percent !== null && s.percent !== undefined) parts.push(`${s.percent}%`);
    this.statusBar.text = parts.join(" · ");
    const cost = s.cost < 0.01 && s.cost > 0 ? `$${s.cost.toFixed(4)}` : `$${(s.cost ?? 0).toFixed(2)}`;
    this.statusBar.tooltip = `${s.model}\nContext: ${s.tokens} of ${s.window ?? "?"} tokens\nCost: ${cost}${s.branch ? `\nBranch: ${s.branch}` : ""}`;
  }

  // ------------------------------------------------------------ prompts

  /** @param {string} text @param {{ includeContext?: boolean }} [options] */
  async sendPrompt(text, { includeContext } = {}) {
    text = String(text ?? "").trim();
    if (!text) return;
    if (!(await this.ensureStarted())) return;
    if (this.busy && !text.startsWith("/")) {
      vscode.window.showInformationMessage("DevPilot is still working. Stop it first, or wait for it to finish.");
      return;
    }

    const config = vscode.workspace.getConfiguration("devpilot");
    // DevPilot reads and writes files on disk; unsaved edits would conflict.
    if (config.get("saveBeforeSend", true) && !text.startsWith("/")) {
      const folder = this.workspaceFolder;
      const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && folder && d.uri.fsPath.startsWith(folder.uri.fsPath));
      await Promise.all(dirty.map((d) => d.save()));
    }

    const include = includeContext ?? config.get("includeEditorContext", true);
    const context = include && !text.startsWith("/") ? collectEditorContext(this.workspaceFolder?.uri.fsPath ?? "") : undefined;

    const sent = this.agent?.send({ type: "prompt", text, context });
    if (!sent) vscode.window.showWarningMessage("DevPilot is not running. Use “DevPilot: Restart Agent”.");
  }

  /** Commands from menus and the palette: show the chat, then send. */
  async sendFromCommand(text) {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    await this.sendPrompt(text, { includeContext: true });
  }

  postContext() {
    const folder = this.workspaceFolder;
    if (!folder) return;
    const described = describeContext(collectEditorContext(folder.uri.fsPath));
    this.post({ type: "context", context: described });
  }

  // ---------------------------------------------------------- approvals

  answerApproval(id, answer) {
    if (!this.approvals.has(id)) return;
    this.agent?.send({ type: "approval", id, answer });
    this.closeDiff(id);
    this.approvals.delete(id);
    this.post({ type: "approvalAnswered", id, answer });
  }

  diffUris(id, diff) {
    const make = (side) => vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${id}/${side}/${diff.path}` });
    return { before: make("before"), after: make("after") };
  }

  async openDiff(id) {
    const entry = this.approvals.get(id);
    const diff = entry?.event.diff;
    if (!entry || !diff) return;
    const { before, after } = this.diffUris(id, diff);
    this.diffContents.set(before.toString(), diff.oldText);
    this.diffContents.set(after.toString(), diff.newText);
    entry.before = before;
    entry.after = after;
    const title = `${diff.path} ↔ DevPilot's change${diff.oldText === "" ? " (new file)" : ""}`;
    await vscode.commands.executeCommand("vscode.diff", before, after, title, { preview: true, preserveFocus: true });
  }

  closeDiff(id) {
    const entry = this.approvals.get(id);
    if (!entry?.after) return;
    const target = entry.after.toString();
    const tabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === target);
    if (tabs.length) vscode.window.tabGroups.close(tabs);
    if (entry.before) this.diffContents.delete(entry.before.toString());
    this.diffContents.delete(target);
  }

  clearApprovals() {
    for (const id of this.approvals.keys()) this.closeDiff(id);
    this.approvals.clear();
  }

  /** The approval behind the diff editor in front, or else the newest one. */
  currentApprovalId() {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme === DIFF_SCHEME) {
      const id = Number(uri.path.split("/")[1]);
      if (this.approvals.has(id)) return id;
    }
    return [...this.approvals.keys()].at(-1) ?? null;
  }

  // ------------------------------------------------------------- misc

  async openFile(file, line) {
    const folder = this.workspaceFolder;
    if (!folder || !file) return;
    const uri = vscode.Uri.joinPath(folder.uri, file);
    const position = new vscode.Position(Math.max(0, (Number(line) || 1) - 1), 0);
    await vscode.window.showTextDocument(uri, { selection: new vscode.Range(position, position), preview: true });
  }

  async setApiKey() {
    const key = await vscode.window.showInputBox({
      title: "OpenRouter API key",
      prompt: "Stored in VS Code's secret storage and passed to DevPilot as OPENROUTER_API_KEY.",
      password: true,
      ignoreFocusOut: true,
      placeHolder: "sk-or-...",
    });
    if (key === undefined) return;
    if (key.trim()) await this.context.secrets.store(SECRET_KEY, key.trim());
    else await this.context.secrets.delete(SECRET_KEY);
    await this.restart();
  }

  async dispose() {
    await this.agent?.stop();
  }
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const controller = new Controller(context);

  // The text of the "before" and "after" documents in the diff view.
  const diffProvider = {
    onDidChange: controller.diffChanged.event,
    /** @param {vscode.Uri} uri */
    provideTextDocumentContent: (uri) => controller.diffContents.get(uri.toString()) ?? "",
  };

  const command = (name, fn) => vscode.commands.registerCommand(name, fn);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, controller, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffProvider),

    command("devpilot.focus", () => vscode.commands.executeCommand(`${VIEW_ID}.focus`)),
    command("devpilot.newChat", () => controller.sendPrompt("/clear")),
    command("devpilot.togglePlan", () => controller.sendPrompt("/plan")),
    command("devpilot.stop", () => controller.stop()),
    command("devpilot.restart", () => controller.restart()),
    command("devpilot.setApiKey", () => controller.setApiKey()),
    command("devpilot.showLog", () => controller.output.show()),
    command("devpilot.explainSelection", () => controller.sendFromCommand("Explain the selected code: what it does, how it fits into the project, and anything surprising.")),
    command("devpilot.fixProblems", () => controller.sendFromCommand("Fix the problems the editor reports in the active file. Read the code first, fix the causes, then verify.")),
    command("devpilot.reviewChanges", () => controller.sendFromCommand("Use the reviewer sub-agent to review my uncommitted changes, then summarize its findings for me.")),
    command("devpilot.acceptChange", () => {
      const id = controller.currentApprovalId();
      if (id !== null) controller.answerApproval(id, "y");
    }),
    command("devpilot.rejectChange", async () => {
      const id = controller.currentApprovalId();
      if (id === null) return;
      const feedback = await vscode.window.showInputBox({ prompt: "Optional: tell DevPilot what to do instead", ignoreFocusOut: true });
      controller.answerApproval(id, feedback?.trim() || "n");
    }),

    // Keep the "context" chip above the message box up to date.
    vscode.window.onDidChangeActiveTextEditor(() => controller.postContext()),
    vscode.window.onDidChangeTextEditorSelection(debounce(() => controller.postContext(), 150)),
    vscode.languages.onDidChangeDiagnostics(debounce(() => controller.postContext(), 300)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("devpilot.model") || e.affectsConfiguration("devpilot.cliPath") || e.affectsConfiguration("devpilot.env") || e.affectsConfiguration("devpilot.nodePath")) {
        vscode.window.showInformationMessage("DevPilot settings changed.", "Restart agent").then((choice) => {
          if (choice) controller.restart();
        });
      }
    }),
    { dispose: () => controller.dispose() }
  );

  return controller; // handy for tests
}

function debounce(fn, ms) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

function deactivate() {}

module.exports = { activate, deactivate, Controller };
