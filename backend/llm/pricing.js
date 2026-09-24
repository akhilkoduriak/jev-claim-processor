/**
 * List prices in USD per 1M tokens, standard (non-batch) tier.
 * Checked 24 September 2026. Update these when providers change prices.
 *   Anthropic: https://platform.claude.com/docs/en/about-claude/pricing.md
 *   OpenAI:    https://developers.openai.com/api/docs/pricing
 *   Jev:       https://docs.typesafe.ai/models.md (output tokens are free)
 */
const PRICES = {
  // Anthropic. Cache writes bill at 1.25x input, cache reads at 0.1x input.
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },

  // OpenAI. Cached input is listed separately.
  'gpt-6-astra': { input: 10, cachedInput: 1, output: 50 },
  'gpt-6-sol': { input: 2, cachedInput: 0.2, output: 10 },
  'gpt-6-luna': { input: 0.1, cachedInput: 0.01, output: 0.5 },
  'gpt-5.6-sol': { input: 4, cachedInput: 0.4, output: 20 },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2 },
  'gpt-5-nano': { input: 0.05, cachedInput: 0.005, output: 0.4 },

  // TypeSafe Jev (list price)
  jev: { input: 0.042, output: 0 }
};

const PER_TOKEN = 1 / 1e6;

/** Price for a model, matching an exact ID first, then the longest known prefix (e.g. dated snapshots). */
function priceFor(model) {
  if (!model) return null;
  if (PRICES[model]) return PRICES[model];
  const match = Object.keys(PRICES).filter((k) => model.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return match ? PRICES[match] : null;
}

/**
 * Cost in USD for one call, or null if the model's price is unknown.
 * usage: { inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, cachedInputTokens }
 * inputTokens excludes cache reads/writes for Anthropic; includes cached tokens for OpenAI.
 */
function costFor(model, usage) {
  const p = priceFor(model);
  if (!p) return null;
  const u = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, cachedInputTokens: 0, ...usage };
  if (p.cachedInput !== undefined) {
    // OpenAI: cached tokens are part of input_tokens and bill at the cached rate.
    const uncached = u.inputTokens - u.cachedInputTokens;
    return (uncached * p.input + u.cachedInputTokens * p.cachedInput + u.outputTokens * p.output) * PER_TOKEN;
  }
  // Anthropic / Jev: input_tokens excludes cache reads and writes.
  return (
    u.inputTokens * p.input +
    u.cacheWriteTokens * p.input * 1.25 +
    u.cacheReadTokens * p.input * 0.1 +
    u.outputTokens * p.output
  ) * PER_TOKEN;
}

module.exports = { PRICES, priceFor, costFor };
