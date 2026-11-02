// DevPilot chat view (runs inside the VS Code webview).
//
// It draws what the extension forwards from `devpilot --rpc` and sends the
// user's actions back. All state lives here; the extension replays its
// transcript when the view is re-created.
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  // ---------------------------------------------------------------- helpers

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") el.className = value;
      else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  const escapeHtml = (text) =>
    String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const svg = (path, extra = "") =>
    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${extra}>${path}</svg>`;
  const ICONS = {
    send: svg('<path d="M2 8h11M9 4l4 4-4 4"/>'),
    stop: svg('<rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none"/>'),
    dot: svg('<circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none"/>'),
    check: svg('<path d="M3 8.5l3 3 7-7"/>'),
    cross: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
    spinner: svg('<path d="M8 2a6 6 0 1 1-6 6"/>', 'class="spin"'),
    file: svg('<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/>'),
    agent: svg('<rect x="3" y="5" width="10" height="8" rx="2"/><path d="M8 2v3M6 9h.01M10 9h.01"/>'),
  };
  const icon = (name) => {
    const span = h("span", { class: "tool-icon" });
    span.innerHTML = ICONS[name];
    return span;
  };

  // A small, safe Markdown renderer: text is escaped first, then fences,
  // inline code, bold/italic, headings and lists are recognised.
  function renderMarkdown(source) {
    const blocks = [];
    const text = String(source).replace(/```(\w*)\n?([\s\S]*?)(```|$)/g, (_, lang, code) => {
      blocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
      return `\u0000${blocks.length - 1}\u0000`;
    });
    const inline = (s) =>
      escapeHtml(s)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "$1");
    const out = [];
    let list = null;
    const closeList = () => {
      if (list) out.push(`</${list}>`);
      list = null;
    };
    let paragraph = [];
    const flush = () => {
      if (paragraph.length) out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
      paragraph = [];
    };
    for (const line of text.split("\n")) {
      const block = line.match(/^\u0000(\d+)\u0000$/);
      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (block) {
        flush();
        closeList();
        out.push(blocks[Number(block[1])]);
      } else if (heading) {
        flush();
        closeList();
        out.push(`<h${heading[1].length + 1}>${inline(heading[2])}</h${heading[1].length + 1}>`);
      } else if (bullet || numbered) {
        flush();
        const kind = bullet ? "ul" : "ol";
        if (list !== kind) {
          closeList();
          out.push(`<${kind}>`);
          list = kind;
        }
        out.push(`<li>${inline((bullet || numbered)[1])}</li>`);
      } else if (!line.trim()) {
        flush();
        closeList();
      } else {
        closeList();
        paragraph.push(line);
      }
    }
    flush();
    closeList();
    return out.join("").replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  }

  // ------------------------------------------------------------------ state

  const COMMANDS = [
    ["/help", "List the commands"],
    ["/plan", "Toggle plan mode"],
    ["/todos", "Show the checklist"],
    ["/test", "Run the tests and fix failures"],
    ["/undo", "Undo the last turn"],
    ["/commit", "Commit with a generated message"],
    ["/compact", "Summarize to free context"],
    ["/context", "How full the context is"],
    ["/cost", "Tokens and cost"],
    ["/model", "Show or switch the model"],
    ["/mcp", "MCP servers and tools"],
    ["/agents", "Sub-agents"],
    ["/sessions", "Saved conversations"],
    ["/resume", "Continue a saved conversation"],
    ["/clear", "Start a new conversation"],
  ];

  const state = {
    busy: false,
    status: null,
    process: { state: "starting", message: null, needs: null },
    context: null,
    includeContext: true,
    todos: [],
    tools: new Map(), // tool call id -> item
    approvals: new Map(), // request id -> item
    assistant: null, // the assistant message being streamed
    lastLog: null,
    slashIndex: 0,
  };

  // ------------------------------------------------------------------ layout

  const messages = h("div", { class: "messages", role: "log", "aria-live": "polite" });
  const banner = h("div");
  const todosBox = h("div");
  const chips = h("div", { class: "chips" });
  const input = h("textarea", { rows: 1, placeholder: "Ask DevPilot, or type / for commands", "aria-label": "Message DevPilot" });
  const sendButton = h("button", { class: "icon-btn primary", title: "Send (Enter)", "aria-label": "Send" });
  const hint = h("span", { class: "hint" }, "Enter to send · Shift+Enter for a new line");
  const slashMenu = h("div", { class: "slash-menu", hidden: true, role: "listbox" });
  const footer = h("div", { class: "footer" });

  document.getElementById("app").append(
    banner,
    messages,
    todosBox,
    h("div", { class: "composer" }, slashMenu, h("div", { class: "composer-box" }, chips, input, h("div", { class: "composer-row" }, hint, sendButton))),
    footer
  );

  function scrollToBottom(force) {
    const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
    if (force || nearBottom) messages.scrollTop = messages.scrollHeight;
  }

  function add(el) {
    messages.querySelector(".welcome")?.remove();
    messages.append(el);
    state.lastLog = null;
    scrollToBottom(true);
    return el;
  }

  function showWelcome() {
    messages.replaceChildren(
      h(
        "div",
        { class: "welcome" },
        h("h2", {}, "DevPilot"),
        h("p", {}, "A coding agent for this folder. It sees your open file, selection and problems, asks before it edits or runs anything, and shows each change in the diff view."),
        h(
          "div",
          { class: "suggestions" },
          [
            ["Explain the open file", "Explain what the open file does and how it fits into the project."],
            ["Find and fix a bug", "Look for a bug in the open file, explain it, and fix it."],
            ["Review my changes", "Use the reviewer sub-agent to review my uncommitted changes."],
            ["Show commands", "/help"],
          ].map(([label, text]) => h("button", { class: "suggestion", onclick: () => send(text) }, label))
        )
      )
    );
  }

  // ------------------------------------------------------------------ items

  function userMessage(text, command) {
    add(h("div", { class: `msg user${command ? " command" : ""}` }, h("div", { class: "bubble" }, text)));
  }

  function assistantMessage(text = "") {
    const body = h("div", { class: "md" });
    const el = add(h("div", { class: "msg assistant" }, h("div", { class: "msg-label" }, "DevPilot"), body));
    const item = { el, body, text, frame: 0 };
    render(item);
    return item;
  }

  function render(item, streaming) {
    item.body.innerHTML = renderMarkdown(item.text);
    item.body.classList.toggle("cursor", Boolean(streaming));
  }

  function summarize(name, rawArgs) {
    let args = {};
    try {
      args = JSON.parse(rawArgs || "{}");
    } catch {
      return { text: rawArgs };
    }
    const path = args.path;
    if (["read_file", "write_file", "edit_file"].includes(name) && path) return { text: path, path };
    if (name === "run_shell") return { text: args.command };
    if (name === "grep") return { text: `/${args.pattern}/${args.glob ? ` in ${args.glob}` : ""}` };
    if (name === "list_files") return { text: args.pattern || "**/*" };
    if (name === "task") return { text: `${args.agent}: ${args.description}` };
    if (name === "todo_write") return { text: "update the checklist" };
    if (name === "exit_plan_mode") return { text: "present the plan" };
    return { text: JSON.stringify(args) };
  }

  function prettyName(name) {
    const mcp = name.match(/^mcp__(.+?)__(.+)$/);
    return mcp ? `${mcp[1]} · ${mcp[2]}` : name;
  }

  function toolCall(event) {
    const { text, path } = summarize(event.name, event.args);
    const summary = h("span", { class: "tool-summary", title: text });
    if (path) {
      summary.append(
        h("span", { class: "path", onclick: (e) => (e.stopPropagation(), vscode.postMessage({ type: "openFile", path })) }, path)
      );
    } else summary.append(text);

    const iconSlot = h("span");
    iconSlot.append(icon("spinner"));
    const argsPre = h("pre", {}, prettyArgs(event.args));
    const resultPre = h("pre", { hidden: true });
    const activity = h("div", { class: "activity" });
    const el = h(
      "div",
      { class: "tool running" },
      h("div", { class: "tool-head", onclick: () => el.classList.toggle("open"), title: "Show details" }, iconSlot, h("span", { class: "tool-name" }, event.name === "task" ? "agent" : prettyName(event.name)), summary),
      activity,
      h("div", { class: "tool-body" }, argsPre, resultPre)
    );
    add(el);
    state.tools.set(event.id, { el, iconSlot, resultPre, activity, name: event.name });
  }

  function prettyArgs(raw) {
    try {
      return JSON.stringify(JSON.parse(raw || "{}"), null, 2);
    } catch {
      return raw;
    }
  }

  const FAILED = /^(Error|Blocked|Cancelled|The user declined)/;

  function toolResult(event) {
    const item = state.tools.get(event.id);
    if (!item) return;
    const failed = FAILED.test(event.result);
    item.el.classList.remove("running");
    item.el.classList.add(failed ? "failed" : "ok");
    item.iconSlot.replaceChildren(icon(failed ? "cross" : "check"));
    item.resultPre.hidden = false;
    item.resultPre.textContent = event.result;
    if (failed) item.el.querySelector(".tool-summary").title = event.result.split("\n")[0];
  }

  // Sub-agent progress lines ("↳ explorer#2 grep ...") go under their task.
  const SUBAGENT_LINE = /^\s*(⧉|↳|✓)\s+([\w-]+#\d+)/;
  function log(text) {
    const sub = text.match(SUBAGENT_LINE);
    if (sub) {
      const running = [...state.tools.values()].filter((t) => t.name === "task" && t.el.classList.contains("running"));
      const target = running.find((t) => t.agentId === sub[2]) ?? running.find((t) => !t.agentId && sub[1] === "⧉") ?? running.at(-1);
      if (target) {
        if (sub[1] === "⧉") target.agentId = sub[2];
        if (sub[1] !== "⧉") target.activity.append(h("div", {}, text.trim()));
        scrollToBottom();
        return;
      }
    }
    if (state.lastLog) {
      state.lastLog.textContent += `\n${text}`;
      scrollToBottom();
      return;
    }
    const el = add(h("div", { class: "log" }, text));
    state.lastLog = el;
  }

  function diffPreview(preview) {
    const pre = h("pre");
    for (const line of preview.split("\n")) {
      if (/^(\+\+\+|---)/.test(line)) continue;
      const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : "";
      pre.append(h("span", { class: `line ${kind}` }, line || " "));
    }
    return pre;
  }

  function approvalCard(event) {
    const feedback = h("input", { type: "text", placeholder: "Or tell DevPilot what to do instead…", "aria-label": "Feedback" });
    const answer = h("div", { class: "answer", hidden: true });
    const respond = (value) => vscode.postMessage({ type: "approval", id: event.id, answer: value });
    feedback.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && feedback.value.trim()) respond(feedback.value.trim());
    });

    const body = event.diff ? diffPreview(event.preview || "") : event.preview ? h("pre", { class: "plain" }, event.preview) : null;
    const el = h(
      "div",
      { class: "card pending", role: "group", "aria-label": event.title },
      h("div", { class: "card-title" }, event.title),
      body,
      h(
        "div",
        { class: "actions" },
        h("button", { class: "btn", onclick: () => respond("y") }, event.diff ? "Apply" : "Allow"),
        event.canAlways ? h("button", { class: "btn secondary", title: event.alwaysLabel, onclick: () => respond("a") }, "Always") : null,
        h("button", { class: "btn secondary", onclick: () => respond("n") }, "Deny"),
        event.diff ? h("button", { class: "btn link", onclick: () => vscode.postMessage({ type: "openDiff", id: event.id }) }, "Open diff") : null
      ),
      h("div", { class: "feedback" }, feedback),
      answer
    );
    add(el);
    state.approvals.set(event.id, { el, answer });
  }

  function settleApproval(id, value) {
    const item = state.approvals.get(id);
    if (!item) return;
    item.el.classList.remove("pending");
    item.el.classList.add("done");
    const label =
      value === "y" ? ["allowed", "Allowed"] : value === "a" ? ["allowed", "Allowed for this session"] : value === "n" ? ["denied", "Denied"] : value === null ? ["", "Cancelled"] : ["denied", `Denied: ${value}`];
    item.answer.className = `answer ${label[0]}`;
    item.answer.textContent = label[1];
    item.answer.hidden = false;
    state.approvals.delete(id);
  }

  function questionCard(event) {
    const field = h("input", { type: "text", "aria-label": "Answer" });
    const el = h("div", { class: "card pending" }, h("div", { class: "question-text" }, event.text), h("div", { class: "question" }, field, h("button", { class: "btn", onclick: () => submit() }, "Send")));
    const submit = () => {
      vscode.postMessage({ type: "answer", id: event.id, text: field.value });
      el.classList.remove("pending");
      el.classList.add("done");
      field.disabled = true;
    };
    field.addEventListener("keydown", (e) => e.key === "Enter" && submit());
    add(el);
    field.focus();
  }

  function errorMessage(text) {
    add(h("div", { class: "error-msg" }, text));
  }

  // ------------------------------------------------------------------ panels

  function renderTodos() {
    if (!state.todos.length) return todosBox.replaceChildren();
    const done = state.todos.filter((t) => t.status === "completed").length;
    const marks = { pending: "○", in_progress: "●", completed: "✓" };
    const details = h(
      "details",
      { class: "todos", open: done < state.todos.length },
      h("summary", {}, h("span", {}, "Checklist"), h("span", {}, `${done}/${state.todos.length}`)),
      h("ul", {}, state.todos.map((t) => h("li", { class: t.status }, h("span", { class: "mark" }, marks[t.status] ?? "○"), h("span", {}, t.content))))
    );
    todosBox.replaceChildren(details);
  }

  function renderFooter() {
    const s = state.status;
    if (!s) return footer.replaceChildren();
    const parts = [];
    if (s.mode === "plan") parts.push(h("span", { class: "badge plan" }, "plan mode"));
    parts.push(h("span", { class: "model", title: s.model }, s.model));
    if (s.window) {
      const fraction = Math.min(1, s.tokens / s.window);
      parts.push(
        h(
          "span",
          { class: `meter${fraction >= 0.8 ? " full" : fraction >= 0.6 ? " warn" : ""}`, title: `${s.tokens.toLocaleString()} of ${s.window.toLocaleString()} tokens` },
          h("span", { class: "bar" }, h("span", { class: "fill", style: `width:${Math.round(fraction * 100)}%` })),
          `${s.percent}%`
        )
      );
    }
    const cost = s.cost > 0 && s.cost < 0.01 ? `$${s.cost.toFixed(4)}` : `$${(s.cost || 0).toFixed(2)}`;
    parts.push(h("span", { title: s.costIsEstimate ? "estimated from list prices" : "reported by OpenRouter" }, cost));
    if (s.branch) parts.push(h("span", { title: "git branch" }, `⎇ ${s.branch}`));
    footer.replaceChildren(...parts);
  }

  function renderBanner() {
    const p = state.process;
    if (p.state === "running") return banner.replaceChildren();
    if (p.state === "starting") return banner.replaceChildren(h("div", { class: "banner" }, h("p", {}, "Starting DevPilot…")));
    const buttons = [];
    if (p.needs === "apiKey") buttons.push(h("button", { class: "btn", onclick: () => vscode.postMessage({ type: "setApiKey" }) }, "Set API key"));
    if (p.needs === "model" || p.needs === "settings") buttons.push(h("button", { class: "btn", onclick: () => vscode.postMessage({ type: "openSettings" }) }, "Open settings"));
    if (p.state === "exited") buttons.push(h("button", { class: "btn secondary", onclick: () => vscode.postMessage({ type: "restart" }) }, "Restart"));
    buttons.push(h("button", { class: "btn link", onclick: () => vscode.postMessage({ type: "showLog" }) }, "Show output"));
    banner.replaceChildren(
      h("div", { class: `banner${p.state === "exited" ? " error" : ""}` }, h("p", {}, p.message || (p.state === "exited" ? "DevPilot stopped." : "DevPilot is not running.")), h("div", { class: "actions" }, buttons))
    );
  }

  function renderChips() {
    chips.replaceChildren();
    if (!state.context) return;
    const chip = h(
      "span",
      { class: `chip${state.includeContext ? "" : " off"}`, title: state.includeContext ? `DevPilot will see ${state.context.path}, your selection and its problems` : "Editor context is not sent" },
      icon("file"),
      h("span", { class: "chip-label" }, state.context.label),
      h(
        "button",
        {
          "aria-label": state.includeContext ? "Don't send editor context" : "Send editor context",
          title: state.includeContext ? "Don't send" : "Send",
          onclick: () => {
            state.includeContext = !state.includeContext;
            vscode.setState({ includeContext: state.includeContext });
            renderChips();
          },
        },
        state.includeContext ? "×" : "+"
      )
    );
    chips.append(chip);
  }

  function renderSendButton() {
    sendButton.innerHTML = state.busy ? ICONS.stop : ICONS.send;
    sendButton.title = state.busy ? "Stop" : "Send (Enter)";
    sendButton.setAttribute("aria-label", state.busy ? "Stop" : "Send");
    sendButton.disabled = state.process.state !== "running" && !state.busy;
  }

  // ------------------------------------------------------------------ input

  function send(text) {
    text = text.trim();
    if (!text) return;
    if (state.busy && !text.startsWith("/")) return;
    vscode.postMessage({ type: "send", text, includeContext: state.includeContext });
    input.value = "";
    autosize();
    closeSlashMenu();
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  }

  function matchingCommands() {
    const value = input.value;
    if (!value.startsWith("/") || value.includes(" ") || value.includes("\n")) return [];
    return COMMANDS.filter(([name]) => name.startsWith(value));
  }

  function renderSlashMenu() {
    const matches = matchingCommands();
    if (!matches.length) return closeSlashMenu();
    state.slashIndex = Math.min(state.slashIndex, matches.length - 1);
    slashMenu.replaceChildren(
      ...matches.map(([name, desc], i) =>
        h(
          "div",
          { class: `slash-item${i === state.slashIndex ? " active" : ""}`, role: "option", onmousedown: (e) => (e.preventDefault(), pickCommand(name)) },
          h("span", { class: "name" }, name),
          h("span", { class: "desc" }, desc)
        )
      )
    );
    slashMenu.hidden = false;
  }

  function closeSlashMenu() {
    slashMenu.hidden = true;
    state.slashIndex = 0;
  }

  function pickCommand(name) {
    input.value = `${name} `;
    closeSlashMenu();
    input.focus();
  }

  input.addEventListener("input", () => {
    autosize();
    renderSlashMenu();
  });
  input.addEventListener("keydown", (e) => {
    const matches = slashMenu.hidden ? [] : matchingCommands();
    if (matches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      state.slashIndex = (state.slashIndex + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
      return renderSlashMenu();
    }
    if (matches.length && e.key === "Tab") {
      e.preventDefault();
      return pickCommand(matches[state.slashIndex][0]);
    }
    if (e.key === "Escape") return closeSlashMenu();
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (matches.length && input.value.trim() !== matches[state.slashIndex][0]) return pickCommand(matches[state.slashIndex][0]);
      send(input.value);
    }
  });
  input.addEventListener("blur", () => setTimeout(closeSlashMenu, 100));
  sendButton.addEventListener("click", () => (state.busy ? vscode.postMessage({ type: "stop" }) : send(input.value)));

  // ------------------------------------------------------------------ events

  function finishAssistant() {
    if (state.assistant) render(state.assistant, false);
    state.assistant = null;
  }

  function onEvent(event) {
    switch (event.type) {
      case "turn_start":
        state.busy = true;
        finishAssistant();
        userMessage(event.text, event.command);
        renderSendButton();
        break;
      case "text":
        if (!state.assistant) state.assistant = assistantMessage();
        state.assistant.text += event.delta;
        if (!state.assistant.frame) {
          state.assistant.frame = requestAnimationFrame(() => {
            if (!state.assistant) return;
            state.assistant.frame = 0;
            render(state.assistant, true);
            scrollToBottom();
          });
        }
        break;
      case "text_end":
        finishAssistant();
        break;
      case "tool_call":
        finishAssistant();
        toolCall(event);
        break;
      case "tool_result":
        toolResult(event);
        break;
      case "log":
        log(event.text);
        break;
      case "approval_request":
        finishAssistant();
        approvalCard(event);
        break;
      case "request_cancelled":
        settleApproval(event.id, null);
        break;
      case "question":
        questionCard(event);
        break;
      case "todos":
        state.todos = event.todos || [];
        renderTodos();
        break;
      case "status":
        state.status = event;
        renderFooter();
        break;
      case "history":
        messages.replaceChildren();
        state.tools.clear();
        state.approvals.clear();
        state.assistant = null;
        state.lastLog = null;
        for (const item of event.items) {
          if (item.role === "user") userMessage(item.text);
          else if (item.role === "assistant") assistantMessage(item.text);
          else if (item.role === "tool") {
            const id = `h${Math.random()}`;
            toolCall({ id, name: item.name, args: item.args });
            const t = state.tools.get(id);
            t.el.classList.replace("running", "ok");
            t.iconSlot.replaceChildren(icon("dot"));
          }
        }
        if (!event.items.length) showWelcome();
        state.todos = event.todos || [];
        renderTodos();
        break;
      case "error":
      case "fatal":
        finishAssistant();
        errorMessage(event.message);
        break;
      case "turn_end":
        finishAssistant();
        state.busy = false;
        for (const t of state.tools.values()) if (t.el.classList.contains("running")) toolResult({ id: [...state.tools.entries()].find(([, v]) => v === t)[0], result: "Cancelled by the user." });
        renderSendButton();
        input.focus();
        break;
    }
  }

  window.addEventListener("message", ({ data }) => {
    switch (data.type) {
      case "init":
        state.process = data.process;
        state.status = data.status;
        state.busy = data.busy;
        state.includeContext = vscode.getState()?.includeContext ?? data.includeContext;
        showWelcome();
        for (const event of data.transcript) onEvent(event);
        state.busy = data.busy;
        renderBanner();
        renderFooter();
        renderSendButton();
        renderChips();
        break;
      case "event":
        onEvent(data.event);
        break;
      case "approvalAnswered":
        settleApproval(data.id, data.answer);
        break;
      case "process":
        state.process = data;
        if (data.state !== "running") state.busy = false;
        renderBanner();
        renderSendButton();
        break;
      case "context":
        state.context = data.context;
        renderChips();
        break;
      case "reset":
        state.todos = [];
        state.status = null;
        state.busy = false;
        state.tools.clear();
        state.approvals.clear();
        showWelcome();
        renderTodos();
        renderFooter();
        renderSendButton();
        break;
    }
  });

  showWelcome();
  renderSendButton();
  vscode.postMessage({ type: "ready" });
  input.focus();
})();
