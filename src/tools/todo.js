import { color } from "../ui.js";

// The todo list is the model's own checklist. It does not touch your files;
// it helps the model stay on track in long tasks (it re-reads the list in
// every tool result) and shows you its progress.
//
// The model always sends the whole list, which keeps the tool simple and
// means a single call can add, reorder, and check off items at once.

const MARKS = {
  pending: () => color.dim("[ ]"),
  in_progress: () => color.yellow("[>]"),
  completed: () => color.green("[x]"),
};

export function renderTodos(todos) {
  if (todos.length === 0) return color.dim("  (no todos)");
  return todos
    .map(({ content, status }) => {
      const text = status === "completed" ? color.dim(content) : status === "in_progress" ? color.bold(content) : content;
      return `  ${MARKS[status]()} ${text}`;
    })
    .join("\n");
}

// Plain version for the model (no colors).
export function todosAsText(todos) {
  const mark = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
  return todos.map(({ content, status }) => `${mark[status]} ${content}`).join("\n");
}

export const todoWrite = {
  name: "todo_write",
  description:
    "Create or update your checklist for the current task. Send the FULL list " +
    "every time; it replaces the previous one. Use it for tasks with three or " +
    "more steps: write the steps up front, keep exactly one item in_progress " +
    "while you work on it, and mark items completed as soon as they are done. " +
    "Skip it for simple one-step requests.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The complete, updated list.",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "What to do, as a short imperative sentence." },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  // It only changes DevPilot's own state, so it is allowed in plan mode too.
  readOnly: true,

  async run({ todos }, ctx) {
    const active = todos.filter((t) => t.status === "in_progress").length;
    if (active > 1) throw new Error(`${active} items are in_progress; keep exactly one in_progress at a time.`);

    const list = todos.map(({ content, status }) => ({ content: content.trim(), status }));
    ctx.session.setTodos(list);
    console.log(renderTodos(list));

    const done = list.filter((t) => t.status === "completed").length;
    return `Todo list updated (${done}/${list.length} completed):\n${todosAsText(list)}`;
  },
};
