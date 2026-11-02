import { editFile, grep, listFiles, readFile, writeFile } from "./files.js";
import { exitPlanMode } from "./plan.js";
import { runShell, truncateOutput } from "./shell.js";
import { todoWrite } from "./todo.js";

// Every tool is a plain object: { name, description, parameters, readOnly, run }.
// `parameters` is a JSON Schema; the model reads it to know what to send.
// Optional fields:
//   validate: false        skip our schema check (MCP tools validate themselves)
//   readOnlyFor(args)      read-only-ness that depends on the arguments (task)
//   parallel: true / fn    safe to run at the same time as other such calls
//
// The list never changes during a session (not even in plan mode), because
// the tool definitions are part of the cached prompt prefix. MCP tools and
// the task tool are added once at startup, before the first model call.
export const builtinTools = [readFile, listFiles, grep, writeFile, editFile, runShell, todoWrite, exitPlanMode];
export const tools = [...builtinTools];

// Last line of defense for the context window: no single tool result may be
// larger than this, whatever the tool's own limits are.
const MAX_RESULT_CHARS = 40_000;

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

function parseArgs(call) {
  try {
    return JSON.parse(call.function.arguments || "{}");
  } catch {
    return undefined;
  }
}

export function isReadOnly(tool, args) {
  return typeof tool.readOnlyFor === "function" ? tool.readOnlyFor(args ?? {}) : Boolean(tool.readOnly);
}

// ----------------------------------------------------------------- toolsets
//
// A toolset is the list of tools one agent can see. The main agent gets all
// of them; a sub-agent gets a subset (an explorer only gets read tools). The
// model only knows about the tools in its own toolset, and calls to anything
// else are refused, so a restricted agent really is restricted.
export function createToolset(list) {
  let byName = new Map(list.map((tool) => [tool.name, tool]));

  const toolset = {
    tools: list,

    add(extra) {
      for (const tool of extra) {
        if (byName.has(tool.name)) throw new Error(`two tools are named "${tool.name}"`);
        list.push(tool);
      }
      byName = new Map(list.map((tool) => [tool.name, tool]));
    },

    get(name) {
      return byName.get(name);
    },

    // The shape the OpenAI-compatible Chat Completions API expects in `tools`.
    definitions() {
      return list.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
    },

    // Can this call run at the same time as its neighbours? Only calls that
    // change nothing and never ask the user (see agent.js).
    isParallelSafe(call) {
      const tool = byName.get(call.function.name);
      if (!tool) return true; // it will just return an error
      const args = parseArgs(call);
      return typeof tool.parallel === "function" ? tool.parallel(args ?? {}) : tool.parallel === true;
    },

    // Run one tool call from the model. This never throws: every failure
    // becomes a text result, because the model must get *some* answer for
    // every call and can often recover from an error message on its own.
    async execute(call, ctx) {
      const tool = byName.get(call.function.name);
      if (!tool) {
        return `Error: unknown tool "${call.function.name}". Available tools: ${[...byName.keys()].join(", ")}.`;
      }

      const args = parseArgs(call);
      if (args === undefined) return "Error: the tool arguments were not valid JSON. Send them again as a JSON object.";

      if (tool.validate !== false) {
        const problem = validateArgs(tool.parameters, args);
        if (problem) return `Error: ${problem}.`;
      } else if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return "Error: arguments must be a JSON object.";
      }

      // Plan mode: only tools that change nothing in the workspace may run.
      if (ctx.state?.mode === "plan" && !isReadOnly(tool, args)) {
        return (
          `Error: plan mode is on, so ${tool.name} is not available${tool.readOnlyFor ? " with these arguments" : ""}. ` +
          "Keep exploring with read-only tools, then call exit_plan_mode with your plan."
        );
      }

      try {
        const result = await tool.run(args, ctx);
        return truncateOutput(String(result), MAX_RESULT_CHARS);
      } catch (err) {
        if (ctx.signal.aborted) return "Cancelled by the user.";
        return `Error: ${err.message}`;
      }
    },
  };
  return toolset;
}

// The main agent's toolset, plus the module-level helpers Tier 2 code uses.
export const mainToolset = createToolset(tools);

export function registerTools(extra) {
  mainToolset.add(extra);
}

export function toolDefinitions() {
  return mainToolset.definitions();
}

export function executeToolCall(call, ctx) {
  return mainToolset.execute(call, ctx);
}

// `name` or `prefix*`, e.g. "read_file" or "mcp__github__*".
export function selectTools(patterns, from = tools) {
  const wanted = (tool) =>
    patterns.some((p) => (p.endsWith("*") ? tool.name.startsWith(p.slice(0, -1)) : tool.name === p));
  return from.filter(wanted);
}
