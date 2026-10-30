import { executeToolCall, toolDefinitions } from "./tools/index.js";
import { color, truncate } from "./ui.js";

// Stream one assistant reply. Text is printed as it arrives. Tool calls
// arrive in fragments, so we glue them back together by their `index`:
//
//   chunk 1: { index: 0, id: "call_1", function: { name: "read_file", arguments: "" } }
//   chunk 2: { index: 0, function: { arguments: "{\"path\":" } }
//   chunk 3: { index: 0, function: { arguments: "\"index.js\"}" } }
async function streamAssistantMessage({ client, model, messages, signal }) {
  const stream = await client.chat.completions.create(
    { model, messages, tools: toolDefinitions(), stream: true },
    { signal } // aborting this signal cancels the HTTP request
  );

  let content = "";
  const toolCalls = [];
  let finishReason = null;

  try {
    for await (const chunk of stream) {
      // OpenRouter reports some provider errors inside the stream.
      if (chunk.error) throw new Error(chunk.error.message ?? "stream error");

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta ?? {};
      if (delta.content) {
        content += delta.content;
        process.stdout.write(delta.content);
      }

      for (const part of delta.tool_calls ?? []) {
        toolCalls[part.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
        const call = toolCalls[part.index];
        if (part.id) call.id = part.id;
        if (part.function?.name) call.function.name += part.function.name;
        if (part.function?.arguments) call.function.arguments += part.function.arguments;
      }
    }
  } catch (err) {
    // Ctrl+C mid-stream: keep whatever text arrived, drop half-built tool calls.
    if (signal.aborted) {
      return { message: { role: "assistant", content: content || "(interrupted)" }, aborted: true };
    }
    throw err;
  }

  if (content) process.stdout.write("\n");
  if (finishReason === "length") {
    console.log(color.yellow("[the reply hit the model's output limit and was cut off]"));
  }

  const message = { role: "assistant", content: content || null };
  const calls = toolCalls.filter(Boolean);
  if (calls.length > 0) message.tool_calls = calls;
  return { message, aborted: false };
}

function describeCall(call) {
  return `${color.cyan("⏺")} ${color.bold(call.function.name)} ${color.dim(truncate(call.function.arguments, 100))}`;
}

function describeResult(result) {
  const lines = result.split("\n");
  const extra = lines.length > 1 ? color.dim(` (+${lines.length - 1} lines)`) : "";
  return `  ${color.dim("⎿")} ${color.dim(truncate(lines[0], 100))}${extra}`;
}

// The agent loop. One user message can take many model calls:
//
//   model -> "call read_file"  -> we run it -> send the result back
//   model -> "call edit_file"  -> we run it -> send the result back
//   model -> "Done, I fixed X" -> no tool calls, so the turn ends
//
// maxSteps stops a model that never stops calling tools.
export async function runAgent({ client, model, session, toolContext, maxSteps }) {
  const { signal } = toolContext;

  for (let step = 1; step <= maxSteps; step++) {
    const { message, aborted } = await streamAssistantMessage({
      client,
      model,
      messages: session.messages,
      signal,
    });
    session.addMessage(message);

    if (aborted) return { status: "interrupted" };
    if (!message.tool_calls) return { status: "done" };

    // Every tool call needs a matching tool result in the history, even if we
    // were interrupted; otherwise the next API request is rejected.
    for (const call of message.tool_calls) {
      console.log(describeCall(call));
      const result = signal.aborted
        ? "Cancelled by the user."
        : await executeToolCall(call, toolContext);
      console.log(describeResult(result));
      session.addMessage({ role: "tool", tool_call_id: call.id, content: result });
    }

    if (signal.aborted) return { status: "interrupted" };
  }

  return { status: "max_steps" };
}
