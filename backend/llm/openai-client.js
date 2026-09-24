/**
 * OpenAI (Responses API) answering the same six questions as Jev, with a
 * strict JSON schema so the reply is guaranteed to match.
 */
const OpenAI = require('openai');
const { SCHEMA, SYSTEM_PROMPT, buildUserPrompt, validateAnswers } = require('./prompt');
const { costFor } = require('./pricing');
const { LlmError } = require('./anthropic-client');

const DEFAULT_MODEL = 'gpt-6-sol';

// The API's own message, without the SDK's "400 {json}" prefix.
const apiMessage = (err) => err?.error?.error?.message || err?.error?.message || err.message;

function toLlmError(err) {
  if (err instanceof LlmError) return err;
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new LlmError(`OpenAI rejected the API key (HTTP ${err.status})`, { kind: 'auth', status: err.status });
  }
  if (err instanceof OpenAI.RateLimitError) {
    return new LlmError('OpenAI rate limit reached (HTTP 429)', { kind: 'rate_limit', status: 429 });
  }
  if (err instanceof OpenAI.BadRequestError) {
    return new LlmError(`OpenAI rejected the request (HTTP 400): ${apiMessage(err)}`, { kind: 'http', status: 400 });
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new LlmError(`Could not reach OpenAI: ${err.message}`, { kind: 'network' });
  }
  if (err instanceof OpenAI.APIError) {
    return new LlmError(`OpenAI API error (HTTP ${err.status}): ${apiMessage(err)}`, { kind: 'http', status: err.status });
  }
  return new LlmError(err.message || String(err), { kind: 'network' });
}

/**
 * @param {object} claim
 * @param {{apiKey?: string, model?: string, reasoningEffort?: string, client?: object}} options
 *   `reasoningEffort` is only sent when set, since non-reasoning models reject it.
 *   `client` lets tests pass a stub with `responses.create`.
 */
async function assess(claim, { apiKey, model = DEFAULT_MODEL, reasoningEffort, client } = {}) {
  const openai = client || new OpenAI({ apiKey, timeout: 60_000, maxRetries: 2 });
  const request = {
    model,
    instructions: SYSTEM_PROMPT,
    input: buildUserPrompt(claim),
    text: { format: { type: 'json_schema', name: 'claim_assessment', schema: SCHEMA, strict: true } }
  };
  if (reasoningEffort) request.reasoning = { effort: reasoningEffort };

  const started = process.hrtime.bigint();
  let response;
  try {
    response = await openai.responses.create(request);
  } catch (err) {
    throw toLlmError(err);
  }
  const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;

  if (response.status && response.status !== 'completed') {
    const why = response.incomplete_details?.reason || response.status;
    throw new LlmError(`OpenAI did not finish the reply (${why})`, { kind: 'truncated' });
  }

  let answers;
  try {
    answers = JSON.parse(response.output_text);
  } catch (err) {
    throw new LlmError('OpenAI returned text that is not valid JSON', { kind: 'invalid_response' });
  }
  const invalid = validateAnswers(answers);
  if (invalid) throw new LlmError(`OpenAI's reply failed validation: ${invalid}`, { kind: 'invalid_response' });

  const u = response.usage || {};
  const usage = {
    inputTokens: u.input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    cachedInputTokens: u.input_tokens_details?.cached_tokens || 0,
    // Reasoning tokens are part of output_tokens and billed as output.
    reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? null
  };
  const servedBy = response.model || model;
  return {
    provider: 'openai',
    model: servedBy,
    requestedModel: model,
    effort: reasoningEffort || null,
    answers,
    usage,
    costUsd: costFor(servedBy, usage) ?? costFor(model, usage),
    latencyMs
  };
}

module.exports = { assess, DEFAULT_MODEL };
