/**
 * Claude (Anthropic Messages API) answering the same six questions as Jev,
 * with structured outputs so the reply is guaranteed to match the schema.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { SCHEMA, SYSTEM_PROMPT, buildUserPrompt, validateAnswers } = require('./prompt');
const { costFor } = require('./pricing');

const DEFAULT_MODEL = 'claude-opus-5';
// Refusal fallbacks: if the model declines, the API re-runs the request on
// Anthropic's recommended fallback model inside the same call.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

class LlmError extends Error {
  constructor(message, { kind, status } = {}) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind; // 'auth' | 'rate_limit' | 'http' | 'network' | 'refusal' | 'truncated' | 'invalid_response'
    this.status = status;
  }
}

// The API's own message, without the SDK's "400 {json}" prefix.
const apiMessage = (err) => err?.error?.error?.message || err?.error?.message || err.message;

function toLlmError(err) {
  if (err instanceof LlmError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new LlmError(`Anthropic rejected the API key (HTTP ${err.status})`, { kind: 'auth', status: err.status });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new LlmError('Anthropic rate limit reached (HTTP 429)', { kind: 'rate_limit', status: 429 });
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new LlmError(`Anthropic rejected the request (HTTP 400): ${apiMessage(err)}`, { kind: 'http', status: 400 });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new LlmError(`Could not reach Anthropic: ${err.message}`, { kind: 'network' });
  }
  if (err instanceof Anthropic.APIError) {
    return new LlmError(`Anthropic API error (HTTP ${err.status}): ${apiMessage(err)}`, { kind: 'http', status: err.status });
  }
  return new LlmError(err.message || String(err), { kind: 'network' });
}

/**
 * @param {object} claim
 * @param {{apiKey?: string, workspaceId?: string, model?: string, effort?: string, client?: object, fetch?: Function}} options
 *   `workspaceId` is required for API keys that aren't scoped to a workspace.
 *   `effort` defaults to "low" when not given; pass undefined explicitly to send no effort.
 *   `client` lets tests pass a stub with `beta.messages.create`; `fetch` replaces the SDK's HTTP layer.
 */
async function assess(claim, options = {}) {
  const { apiKey, workspaceId, model = DEFAULT_MODEL, client } = options;
  const effort = 'effort' in options ? options.effort : 'low';
  const anthropic = client || new Anthropic({
    apiKey,
    timeout: 60_000,
    maxRetries: 2,
    ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {})
  });
  const outputConfig = { format: { type: 'json_schema', schema: SCHEMA } };
  if (effort) outputConfig.effort = effort;

  const started = process.hrtime.bigint();
  let response;
  try {
    response = await anthropic.beta.messages.create({
      model,
      max_tokens: 4096,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(claim) }],
      output_config: outputConfig
    });
  } catch (err) {
    throw toLlmError(err);
  }
  const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;

  if (response.stop_reason === 'refusal') {
    throw new LlmError(`Claude declined the request (${response.stop_details?.category || 'no category'})`, { kind: 'refusal' });
  }
  if (response.stop_reason === 'max_tokens') {
    throw new LlmError('Claude hit max_tokens before finishing the JSON reply', { kind: 'truncated' });
  }

  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let answers;
  try {
    answers = JSON.parse(text);
  } catch (err) {
    throw new LlmError('Claude returned text that is not valid JSON', { kind: 'invalid_response' });
  }
  const invalid = validateAnswers(answers);
  if (invalid) throw new LlmError(`Claude's reply failed validation: ${invalid}`, { kind: 'invalid_response' });

  const u = response.usage || {};
  const usage = {
    inputTokens: u.input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    cacheWriteTokens: u.cache_creation_input_tokens || 0,
    cacheReadTokens: u.cache_read_input_tokens || 0,
    // Claude bills thinking as output tokens; the API doesn't report it separately.
    reasoningTokens: null
  };
  // Price by the model that actually served the request (a fallback may have run).
  const servedBy = response.model || model;
  return {
    provider: 'anthropic',
    model: servedBy,
    requestedModel: model,
    effort: effort || null,
    answers,
    usage,
    costUsd: costFor(servedBy, usage),
    latencyMs
  };
}

module.exports = { assess, LlmError, DEFAULT_MODEL, FALLBACK_BETA };
