// A small stand-in for the `vscode` module: just the parts the extension
// uses, recording what it is asked to do. Real VS Code is not needed to test
// the extension's logic; the webview is tested separately in a browser.
"use strict";

const path = require("node:path");

class Uri {
  constructor({ scheme = "file", path: p = "", query = "" }) {
    this.scheme = scheme;
    this.path = p;
    this.query = query;
  }
  static file(p) {
    return new Uri({ scheme: "file", path: p });
  }
  static from(parts) {
    return new Uri(parts);
  }
  static joinPath(base, ...parts) {
    return new Uri({ scheme: base.scheme, path: path.posix.join(base.path, ...parts) });
  }
  get fsPath() {
    return this.path;
  }
  toString() {
    return `${this.scheme}://${this.path}`;
  }
}

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (fn) => (this.listeners.push(fn), { dispose() {} });
  }
  fire(value) {
    for (const fn of this.listeners) fn(value);
  }
  dispose() {}
}

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}
class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}
class TabInputTextDiff {
  constructor(original, modified) {
    this.original = original;
    this.modified = modified;
  }
}

function createFakeVscode({ workspace: root, settings = {}, secrets = {} }) {
  const log = { commands: new Map(), executed: [], messages: [], closedTabs: [], webviewMessages: [] };
  const providers = { webview: null, content: new Map() };
  const tabs = [];
  const noop = () => ({ dispose() {} });

  const vscode = {
    Uri,
    EventEmitter,
    Position,
    Range,
    TabInputTextDiff,
    StatusBarAlignment: { Left: 1, Right: 2 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },

    window: {
      activeTextEditor: undefined,
      visibleTextEditors: [],
      createOutputChannel: () => ({ append() {}, appendLine() {}, show() {}, dispose() {} }),
      createStatusBarItem: () => ({ text: "", tooltip: "", command: "", show() {}, dispose() {} }),
      registerWebviewViewProvider: (id, provider) => ((providers.webview = { id, provider }), { dispose() {} }),
      showInformationMessage: async (...args) => (log.messages.push(["info", ...args]), undefined),
      showWarningMessage: async (...args) => (log.messages.push(["warning", ...args]), undefined),
      showInputBox: async () => undefined,
      showTextDocument: async (uri, options) => log.executed.push(["showTextDocument", uri.toString(), options]),
      tabGroups: {
        get all() {
          return [{ tabs }];
        },
        close: async (closing) => {
          for (const tab of closing) {
            log.closedTabs.push(tab.input.modified.toString());
            tabs.splice(tabs.indexOf(tab), 1);
          }
        },
      },
      onDidChangeActiveTextEditor: noop,
      onDidChangeTextEditorSelection: noop,
    },

    workspace: {
      workspaceFolders: [{ uri: Uri.file(root), name: path.basename(root), index: 0 }],
      textDocuments: [],
      getConfiguration: () => ({ get: (key, fallback) => (key in settings ? settings[key] : fallback) }),
      asRelativePath: (uri) => (uri.fsPath.startsWith(root + "/") ? uri.fsPath.slice(root.length + 1) : uri.fsPath),
      registerTextDocumentContentProvider: (scheme, provider) => (providers.content.set(scheme, provider), { dispose() {} }),
      onDidChangeConfiguration: noop,
    },

    languages: {
      diagnostics: [],
      getDiagnostics: () => vscode.languages.diagnostics,
      onDidChangeDiagnostics: noop,
    },

    commands: {
      registerCommand: (name, fn) => (log.commands.set(name, fn), { dispose() {} }),
      executeCommand: async (name, ...args) => {
        log.executed.push([name, ...args]);
        // Opening a diff creates a tab, like VS Code does.
        if (name === "vscode.diff") tabs.push({ input: new TabInputTextDiff(args[0], args[1]) });
        if (log.commands.has(name)) return log.commands.get(name)(...args);
      },
    },
  };

  // A fake webview view: records what the extension posts to it.
  function createView() {
    const handlers = [];
    return {
      webview: {
        options: {},
        html: "",
        cspSource: "vscode-resource:",
        asWebviewUri: (uri) => uri,
        postMessage: async (message) => (log.webviewMessages.push(message), true),
        onDidReceiveMessage: (fn) => (handlers.push(fn), { dispose() {} }),
      },
      onDidDispose: noop,
      // Simulate the webview script sending a message.
      fromWebview: (message) => Promise.all(handlers.map((fn) => fn(message))),
    };
  }

  const context = {
    subscriptions: [],
    extensionPath: path.resolve(__dirname, ".."),
    extensionUri: Uri.file(path.resolve(__dirname, "..")),
    secrets: {
      get: async (key) => secrets[key],
      store: async (key, value) => void (secrets[key] = value),
      delete: async (key) => void delete secrets[key],
    },
  };

  return { vscode, log, providers, createView, context };
}

module.exports = { createFakeVscode };
