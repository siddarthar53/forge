import { withCacheBreakpoints } from "./caching.js";
import { toolDefinitions } from "./tools/index.js";
import { todosAsText } from "./tools/todo.js";

// Compaction: when the conversation gets close to the model's context window,
// ask the model to summarize it, then replace the history with that summary.
//
//   before: [system, user, assistant, tool, tool, assistant, ... 150k tokens]
//   after:  [system, user("summary of everything so far ...")]
//
// The model loses the exact text of old tool results but keeps what matters:
// the goal, decisions, files involved and what is left to do.

const SUMMARY_REQUEST = `Stop working on the task for a moment. Write a summary of this
conversation so far that will replace the full history. Someone with only your
summary must be able to continue the work without asking the user anything.

Include:
1. The user's requests, in order, and the most recent request word for word.
2. Decisions made and constraints the user gave.
3. Files read, created or changed (paths), and what changed in each.
4. Commands run that matter (tests, builds) and their latest results.
5. Errors hit and how they were fixed, or that they are still open.
6. Current state: what is done, what is in progress, and the next steps.

Be specific (paths, function names, exact error messages). Don't call tools.
Reply with the summary only.`;

export async function compactConversation({ client, session, state, signal, focus, continueTask }) {
  const request = [
    ...session.messages,
    {
      role: "user",
      content: focus ? `${SUMMARY_REQUEST}\n\nPay special attention to: ${focus}` : SUMMARY_REQUEST,
    },
  ];

  const response = await client.chat.completions.create(
    {
      model: state.model,
      messages: withCacheBreakpoints(request, state.model),
      // Same tools as the normal requests: it keeps the cached prefix valid,
      // and some providers reject histories with tool calls but no tools.
      tools: toolDefinitions(),
      tool_choice: "none",
      usage: { include: true },
    },
    { signal }
  );
  if (response.usage) session.recordUsage(response.usage, state.modelInfo?.pricing, { updateContext: false });

  const summary = response.choices?.[0]?.message?.content?.trim();
  if (!summary) throw new Error("the model returned an empty summary");

  let intro =
    "This conversation was compacted to save context. Summary of everything before this point:\n\n" +
    summary;
  if (session.todos.length > 0) intro += `\n\nCurrent todo list:\n${todosAsText(session.todos)}`;

  const system = session.messages[0];
  const before = session.messages.length;

  // Mid-turn, the model should simply keep going. Between turns, an assistant
  // reply closes the pair so the user's next message does not follow another
  // user message.
  const messages = continueTask
    ? [system, { role: "user", content: `${intro}\n\nContinue the task from where you left off.` }]
    : [
        system,
        { role: "user", content: intro },
        { role: "assistant", content: "Understood. I have the summary and will continue from here." },
      ];

  session.replaceMessages(messages, "compact");
  return { summary, removedMessages: before - messages.length };
}
