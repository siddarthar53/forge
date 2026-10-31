import { toolDefinitions } from "./tools/index.js";

// ----------------------------------------------------------- token counting
//
// Exact counts need the model's own tokenizer, and every model family has a
// different one. Instead we combine two numbers:
//
//   1. The API tells us exactly how many tokens the prompt had after every
//      call (usage.prompt_tokens). That is the ground truth.
//   2. For messages added since that call (tool results, a new user message)
//      we estimate: about 4 characters per token for English and code.
//
// session.js keeps (1) and applies (2) to whatever came after it.

export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.ceil(text.length / 4);
}

// Tool definitions are sent with every request but are not in the history.
let toolTokens = null;
export function toolDefinitionTokens() {
  toolTokens ??= estimateTokens(toolDefinitions());
  return toolTokens;
}

export function contextStatus(session, state) {
  const tokens = session.estimateContextTokens(toolDefinitionTokens());
  const window = state.modelInfo?.contextLength ?? null;
  return {
    tokens,
    window,
    percent: window ? Math.round((100 * tokens) / window) : null,
  };
}

// ---------------------------------------------------------------- model info
//
// OpenRouter's /models endpoint lists every model with its context window
// and price per token. We need both: the window to know when to compact,
// the price to show /cost when the provider does not report cost itself.
let modelListCache = null;

export async function fetchModelInfo({ baseURL, apiKey, model, contextWindowOverride }) {
  let entry = null;
  try {
    modelListCache ??= await fetch(`${baseURL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    }).then((res) => (res.ok ? res.json() : { data: [] }));
    entry = modelListCache.data?.find((m) => m.id === model) ?? null;
  } catch {
    // Offline or a different provider: run without the extra info.
  }

  const price = (value) => (value === undefined || value === null ? null : Number(value));
  return {
    known: entry !== null,
    contextLength:
      contextWindowOverride || entry?.context_length || entry?.top_provider?.context_length || null,
    pricing: entry
      ? { prompt: price(entry.pricing?.prompt), completion: price(entry.pricing?.completion) }
      : null,
  };
}

// --------------------------------------------------------------------- cost

export function emptyUsage() {
  return { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, costIsEstimate: false };
}

// The dollar cost of one API call. OpenRouter includes it in `usage.cost`;
// otherwise fall back to tokens x price from the model list.
export function costOf(usage, pricing) {
  if (typeof usage.cost === "number") return { cost: usage.cost, estimated: false };
  if (pricing?.prompt !== null && pricing?.prompt !== undefined) {
    const cost =
      (usage.prompt_tokens ?? 0) * pricing.prompt + (usage.completion_tokens ?? 0) * (pricing.completion ?? 0);
    return { cost, estimated: true };
  }
  return { cost: 0, estimated: true };
}

export function addUsage(totals, usage, cost, estimated) {
  totals.calls += 1;
  totals.promptTokens += usage.prompt_tokens ?? 0;
  totals.completionTokens += usage.completion_tokens ?? 0;
  totals.cachedTokens += usage.prompt_tokens_details?.cached_tokens ?? 0;
  totals.cost += cost;
  if (estimated) totals.costIsEstimate = true;
}
