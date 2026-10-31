import { withCacheBreakpoints } from "./caching.js";
import { compactConversation } from "./compact.js";
import { contextStatus } from "./context.js";
import { executeToolCall, toolDefinitions } from "./tools/index.js";
import { color, formatTokens, terminal, truncate } from "./ui.js";

// Stream one assistant reply. Text is printed as it arrives. Tool calls
// arrive in fragments, so we glue them back together by their `index`:
//
//   chunk 1: { index: 0, id: "call_1", function: { name: "read_file", arguments: "" } }
//   chunk 2: { index: 0, function: { arguments: "{\"path\":" } }
//   chunk 3: { index: 0, function: { arguments: "\"index.js\"}" } }
//
// The last chunk carries `usage`: exact token counts (and, on OpenRouter,
// the cost) of this call. That feeds the token counter and /cost.
async function streamAssistantMessage({ client, model, messages, signal }) {
  const stream = await client.chat.completions.create(
    {
      model,
      messages: withCacheBreakpoints(messages, model), // see caching.js
      tools: toolDefinitions(),
      stream: true,
      stream_options: { include_usage: true }, // send usage in the final chunk
      usage: { include: true }, // OpenRouter: include the cost in dollars
    },
    { signal } // aborting this signal cancels the HTTP request
  );

  let content = "";
  const toolCalls = [];
  let finishReason = null;
  let usage = null;

  try {
    for await (const chunk of stream) {
      // OpenRouter reports some provider errors inside the stream.
      if (chunk.error) throw new Error(chunk.error.message ?? "stream error");
      if (chunk.usage) usage = chunk.usage;

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta ?? {};
      if (delta.content) {
        content += delta.content;
        terminal.write(delta.content);
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
      return { message: { role: "assistant", content: content || "(interrupted)" }, aborted: true, usage };
    }
    throw err;
  }

  if (content) terminal.write("\n");
  if (finishReason === "length") {
    terminal.log(color.yellow("[the reply hit the model's output limit and was cut off]"));
  }

  const message = { role: "assistant", content: content || null };
  const calls = toolCalls.filter(Boolean);
  if (calls.length > 0) message.tool_calls = calls;
  return { message, aborted: false, usage };
}

function describeCall(call) {
  return `${color.cyan("⏺")} ${color.bold(call.function.name)} ${color.dim(truncate(call.function.arguments, 100))}`;
}

function describeResult(result) {
  const lines = result.split("\n");
  const extra = lines.length > 1 ? color.dim(` (+${lines.length - 1} lines)`) : "";
  return `  ${color.dim("⎿")} ${color.dim(truncate(lines[0], 100))}${extra}`;
}

// Loop detection. A stuck model repeats itself: the same failing command,
// the same edit that does not match. When the exact same call returns the
// exact same result for the third time in a turn, we add a nudge to it.
const REPEAT_LIMIT = 3;

function noticeRepeats(repeats, call, result) {
  const key = `${call.function.name} ${call.function.arguments}`;
  const previous = repeats.get(key);
  const count = previous?.result === result ? previous.count + 1 : 1;
  repeats.set(key, { result, count });

  if (count < REPEAT_LIMIT) return result;
  return (
    `${result}\n\n[DevPilot: you have made this exact call ${count} times in this turn and got ` +
    "the same result each time. Repeating it will not help. Step back, rethink the cause, " +
    "and try a different approach, or ask the user.]"
  );
}

// The agent loop. One user message can take many model calls:
//
//   model -> "call read_file"  -> we run it -> send the result back
//   model -> "call edit_file"  -> we run it -> send the result back
//   model -> "Done, I fixed X" -> no tool calls, so the turn ends
//
// Before every call we check the context window and compact if it is
// nearly full. maxSteps stops a model that never stops calling tools.
export async function runAgent({ client, session, state, toolContext, maxSteps, compactAt, onCompact }) {
  const { signal } = toolContext;
  const repeats = new Map();

  for (let step = 1; step <= maxSteps; step++) {
    const status = contextStatus(session, state);
    if (status.window && status.tokens >= status.window * compactAt) {
      terminal.log(
        color.yellow(
          `[context ${status.percent}% full (${formatTokens(status.tokens)}/${formatTokens(status.window)}): compacting…]`
        )
      );
      try {
        await compactConversation({ client, session, state, signal, continueTask: true });
        onCompact?.();
        const after = contextStatus(session, state);
        terminal.log(color.dim(`[compacted to about ${formatTokens(after.tokens)} tokens]`));
      } catch (err) {
        if (signal.aborted) return { status: "interrupted" };
        terminal.log(color.yellow(`[compaction failed: ${err.message}; continuing without it]`));
      }
    }

    const { message, aborted, usage } = await streamAssistantMessage({
      client,
      model: state.model,
      messages: session.messages,
      signal,
    });
    session.addMessage(message);
    if (usage) session.recordUsage(usage, state.modelInfo?.pricing);

    if (aborted) return { status: "interrupted" };
    if (!message.tool_calls) return { status: "done" };

    // Every tool call needs a matching tool result in the history, even if we
    // were interrupted; otherwise the next API request is rejected.
    for (const call of message.tool_calls) {
      terminal.log(describeCall(call));
      let result = signal.aborted ? "Cancelled by the user." : await executeToolCall(call, toolContext);
      result = noticeRepeats(repeats, call, result);
      terminal.log(describeResult(result));
      session.addMessage({ role: "tool", tool_call_id: call.id, content: result });
    }

    if (signal.aborted) return { status: "interrupted" };
  }

  return { status: "max_steps" };
}
