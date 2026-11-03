// @ts-check
"use strict";

const vscode = require("vscode");

// What the editor shows right now, in the shape DevPilot's --rpc mode
// expects (see formatEditorContext in src/rpc.js):
//
//   { activeFile: { path, language, cursorLine },
//     selection:  { startLine, endLine, text },
//     diagnostics: [{ path, line, severity, message, source }],
//     openFiles:  ["other.js", ...] }
//
// Paths are relative to the workspace folder DevPilot runs in. Files outside
// it are left out: DevPilot cannot read them anyway.

const MAX_DIAGNOSTICS = 30;

/** @param {vscode.Uri} uri @param {string} root */
function relativePath(uri, root) {
  if (uri.scheme !== "file") return null;
  const relative = vscode.workspace.asRelativePath(uri, false);
  // asRelativePath returns the full path when the file is outside the workspace.
  if (relative === uri.fsPath || relative.startsWith("..")) return null;
  return relative.split("\\").join("/");
}

const SEVERITY = ["error", "warning", "info", "hint"];

/** @param {string} root */
function collectEditorContext(root) {
  const editor = vscode.window.activeTextEditor;
  /** @type {any} */
  const context = {};

  if (editor) {
    const file = relativePath(editor.document.uri, root);
    if (file) {
      context.activeFile = {
        path: file,
        language: editor.document.languageId,
        cursorLine: editor.selection.active.line + 1,
      };
      if (!editor.selection.isEmpty) {
        context.selection = {
          startLine: editor.selection.start.line + 1,
          endLine: editor.selection.end.line + 1,
          text: editor.document.getText(editor.selection),
        };
      }
      context.diagnostics = vscode.languages
        .getDiagnostics(editor.document.uri)
        .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning)
        .slice(0, MAX_DIAGNOSTICS)
        .map((d) => ({
          path: file,
          line: d.range.start.line + 1,
          severity: SEVERITY[d.severity] ?? "error",
          message: d.message,
          source: d.source ?? undefined,
        }));
    }
  }

  const others = vscode.window.visibleTextEditors
    .filter((e) => e !== editor)
    .map((e) => relativePath(e.document.uri, root))
    .filter((p) => p && p !== context.activeFile?.path);
  if (others.length) context.openFiles = [...new Set(others)];

  return context;
}

/** A short label for the chip above the message box, e.g. "auth.js:10-14 · 2 problems". */
function describeContext(context) {
  if (!context.activeFile) return null;
  const name = context.activeFile.path.split("/").pop();
  let label = name;
  if (context.selection) {
    label += context.selection.startLine === context.selection.endLine ? `:${context.selection.startLine}` : `:${context.selection.startLine}-${context.selection.endLine}`;
  }
  const problems = context.diagnostics?.length ?? 0;
  if (problems) label += ` · ${problems} problem${problems === 1 ? "" : "s"}`;
  return { label, path: context.activeFile.path };
}

module.exports = { collectEditorContext, describeContext };
