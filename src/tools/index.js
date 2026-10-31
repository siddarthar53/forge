import { editFile, grep, listFiles, readFile, writeFile } from "./files.js";
import { exitPlanMode } from "./plan.js";
import { runShell, truncateOutput } from "./shell.js";
import { todoWrite } from "./todo.js";

// Every tool is a plain object: { name, description, parameters, readOnly, run }.
// `parameters` is a JSON Schema; the model reads it to know what to send.
//
// The list never changes during a session (not even in plan mode), because
// the tool definitions are part of the cached prompt prefix.
export const tools = [readFile, listFiles, grep, writeFile, editFile, runShell, todoWrite, exitPlanMode];

const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

// Last line of defense for the context window: no single tool result may be
// larger than this, whatever the tool's own limits are.
const MAX_RESULT_CHARS = 40_000;

// The shape the OpenAI-compatible Chat Completions API expects in `tools`.
export function toolDefinitions() {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function matchesType(type, value) {
  switch (type) {
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case undefined:
      return true;
    default:
      return typeof value === type;
  }
}

// A small JSON Schema checker: types, enums, required fields, unknown fields,
// nested objects and arrays. Models sometimes send wrong arguments; a precise
// message ("todos[2].status must be one of ...") lets them fix it themselves.
//
// `where` is the path to the value, "" for the top-level arguments object.
function check(schema, value, where) {
  if (!matchesType(schema.type, value)) {
    return where ? `argument "${where}" must be of type ${schema.type}` : "arguments must be a JSON object";
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return `argument "${where}" must be one of: ${schema.enum.join(", ")}`;
  }
  if (schema.type === "array" && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const problem = check(schema.items, value[i], `${where}[${i}]`);
      if (problem) return problem;
    }
  }
  if (schema.type === "object" && schema.properties) {
    const prefix = where ? `${where}.` : "";
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) return `missing required argument "${prefix}${key}"`;
    }
    for (const [key, item] of Object.entries(value)) {
      const property = schema.properties[key];
      if (!property) return `unknown argument "${prefix}${key}"`;
      const problem = check(property, item, `${prefix}${key}`);
      if (problem) return problem;
    }
  }
  return null;
}

export function validateArgs(schema, args) {
  return check(schema, args, "");
}

// Run one tool call from the model. This never throws: every failure becomes
// a text result, because the model must get *some* answer for every call
// and can often recover from an error message on its own.
export async function executeToolCall(call, ctx) {
  const tool = toolsByName.get(call.function.name);
  if (!tool) {
    return `Error: unknown tool "${call.function.name}". Available tools: ${[...toolsByName.keys()].join(", ")}.`;
  }

  let args;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return "Error: the tool arguments were not valid JSON. Send them again as a JSON object.";
  }

  const problem = validateArgs(tool.parameters, args);
  if (problem) return `Error: ${problem}.`;

  // Plan mode: only tools that change nothing in the workspace may run.
  if (ctx.state?.mode === "plan" && !tool.readOnly) {
    return (
      `Error: plan mode is on, so ${tool.name} is not available. Keep exploring with ` +
      "read-only tools, then call exit_plan_mode with your plan."
    );
  }

  try {
    const result = await tool.run(args, ctx);
    return truncateOutput(String(result), MAX_RESULT_CHARS);
  } catch (err) {
    if (ctx.signal.aborted) return "Cancelled by the user.";
    return `Error: ${err.message}`;
  }
}
