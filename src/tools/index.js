import { editFile, grep, listFiles, readFile, writeFile } from "./files.js";
import { runShell } from "./shell.js";

// Every tool is a plain object: { name, description, parameters, readOnly, run }.
// `parameters` is a JSON Schema; the model reads it to know what to send.
export const tools = [readFile, listFiles, grep, writeFile, editFile, runShell];

const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

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

// Minimal JSON Schema check: required fields exist and top-level types match.
// Models sometimes send wrong arguments; a clear message lets them fix it.
function validateArgs(schema, args) {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return "arguments must be a JSON object";
  }
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) return `missing required argument "${key}"`;
  }
  for (const [key, value] of Object.entries(args)) {
    const expected = schema.properties[key]?.type;
    if (!expected) return `unknown argument "${key}"`;

    const ok =
      expected === "integer" ? Number.isInteger(value) : typeof value === expected;
    if (!ok) return `argument "${key}" must be of type ${expected}`;
  }
  return null;
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

  try {
    return await tool.run(args, ctx);
  } catch (err) {
    if (ctx.signal.aborted) return "Cancelled by the user.";
    return `Error: ${err.message}`;
  }
}
