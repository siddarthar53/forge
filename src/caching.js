// Prompt caching
//
// Every request resends the whole conversation. Providers can cache the part
// that has not changed since the last request (the "prefix") and charge much
// less for it (and answer faster). Two kinds of providers:
//
//   automatic: OpenAI, DeepSeek, Grok, Gemini 2.5 ... cache any repeated prefix
//              by themselves. We only have to keep the prefix stable.
//   explicit:  Anthropic (Claude) caches only up to "breakpoints" we mark
//              with cache_control.
//
// "Keep the prefix stable" is a design rule for the whole agent:
//   - the system prompt and tool list never change during a session
//     (plan mode, todos and other state go into messages, not the prompt);
//   - history is only appended to; anything that rewrites it (compaction,
//     /clear, /undo) costs one cache miss and is a deliberate choice.
//
// We never modify the stored history here: breakpoints are added to a copy
// right before the request, so the session log stays provider-neutral.

export function needsCacheBreakpoints(model) {
  return /^anthropic\//.test(model) || /claude/i.test(model);
}

function markForCache(message) {
  if (typeof message.content !== "string" || message.content === "") return message;
  return {
    ...message,
    content: [{ type: "text", text: message.content, cache_control: { type: "ephemeral" } }],
  };
}

// Anthropic allows up to 4 breakpoints. We use two:
//   1. the system prompt          -> tools + system prompt are cached
//   2. the newest user message    -> the conversation up to it is cached,
//                                    which every step of a long turn reuses
export function withCacheBreakpoints(messages, model) {
  if (!needsCacheBreakpoints(model)) return messages;

  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUser = i;
      break;
    }
  }

  return messages.map((message, i) =>
    (i === 0 && message.role === "system") || i === lastUser ? markForCache(message) : message
  );
}
