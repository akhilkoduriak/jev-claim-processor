process.env.USE_MOCK_JEV = 'false';
process.env.JEV_API_KEY = 'jv_test_key';
process.env.JEV_API_URL = 'https://jev.example.test/v1';
process.env.JEV_API_PATH = '/systemone';
process.env.LLM_PROVIDER = 'anthropic';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
delete process.env.ANTHROPIC_MODEL;
delete process.env.ANTHROPIC_EFFORT;

const test = require('node:test');
const assert = require('node:assert');
const Anthropic = require('@anthropic-ai/sdk');
const { QUESTIONS } = require('../jev-client');
const prompt = require('../llm/prompt');
const pricing = require('../llm/pricing');
const claudeClient = require('../llm/anthropic-client');
const openaiClient = require('../llm/openai-client');
const comparison = require('../comparison');

const claim = {
  claimId: 'CMP-1',
  patientName: 'Private Person',
  amount: 2500,
  diagnosis: 'Emergency Room Visit',
  procedure: 'Emergency care',
  procedureCode: '99285',
  providerTier: 'in-network',
  priorClaimsInMonth: 0,
  frequencyPattern: 'normal'
};

const goodAnswers = {
  decision: 'approve',
  claim_type: 'emergency',
  medical_necessity: 'Clearly necessary',
  cost_check: 'normal',
  billing_check: 'normal',
  alert_level: 'low',
  confidence: 0.9
};

/** Stub of the Anthropic SDK client that records requests. */
function claudeStub(response, calls = []) {
  return {
    calls,
    beta: {
      messages: {
        create: async (req) => {
          calls.push(req);
          if (response instanceof Error) throw response;
          return typeof response === 'function' ? response(req) : response;
        }
      }
    }
  };
}

const claudeResponse = (answers, extra = {}) => ({
  model: 'claude-opus-5',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify(answers) }],
  usage: { input_tokens: 1200, output_tokens: 150, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  ...extra
});

// ---------- Prompt and schema ----------

test('schema has one strict field per Jev question, with the same allowed values', () => {
  const s = prompt.SCHEMA;
  assert.strictEqual(s.additionalProperties, false);
  assert.deepStrictEqual([...s.required].sort(), [...Object.keys(QUESTIONS), 'confidence'].sort());
  assert.deepStrictEqual(s.properties.decision.enum, Object.keys(QUESTIONS.decision.criteria));
  assert.deepStrictEqual(s.properties.claim_type.enum, Object.keys(QUESTIONS.claim_type.criteria));
  assert.deepStrictEqual(s.properties.medical_necessity.enum, QUESTIONS.medical_necessity.criteria);
  assert.deepStrictEqual(s.properties.alert_level.enum, ['low', 'medium', 'high', 'critical']);
});

test('prompt gives the LLM every question and option description, but no private or test-only data', () => {
  const p = prompt.buildUserPrompt({ ...claim, expectedDecision: 'approve' });
  for (const [key, q] of Object.entries(QUESTIONS)) {
    assert.ok(p.includes(q.instructions), `${key} instructions`);
    const descriptions = Array.isArray(q.criteria) ? q.criteria : Object.values(q.criteria);
    for (const d of descriptions) assert.ok(p.includes(d), `${key}: ${d}`);
  }
  assert.ok(p.includes('"amount_usd": 2500'));
  assert.ok(!p.includes('Private Person'), 'patient name must not be sent');
  assert.ok(!p.includes('expected'), 'expected outcome must not be sent');
});

test('validateAnswers catches values outside the schema', () => {
  assert.strictEqual(prompt.validateAnswers(goodAnswers), null);
  assert.match(prompt.validateAnswers({ ...goodAnswers, decision: 'maybe' }), /decision/);
  assert.match(prompt.validateAnswers({ ...goodAnswers, confidence: 3 }), /confidence/);
  assert.match(prompt.validateAnswers(null), /not a JSON object/);
});

// ---------- Pricing ----------

test('cost: Anthropic bills cache writes at 1.25x and reads at 0.1x input', () => {
  const cost = pricing.costFor('claude-opus-5', { inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 1000, cacheReadTokens: 1000 });
  // (1000*5 + 1000*6.25 + 1000*0.5 + 100*25) / 1e6
  assert.ok(Math.abs(cost - 0.01425) < 1e-12, String(cost));
});

test('cost: OpenAI cached tokens are part of input and bill at the cached rate', () => {
  const cost = pricing.costFor('gpt-6-sol', { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100 });
  // (600*2 + 400*0.2 + 100*10) / 1e6
  assert.ok(Math.abs(cost - 0.00228) < 1e-12, String(cost));
});

test('cost: Jev bills input only; unknown models return null; dated IDs match their base price', () => {
  assert.ok(Math.abs(pricing.costFor('jev', { inputTokens: 1e6, outputTokens: 500 }) - 0.042) < 1e-12);
  assert.strictEqual(pricing.costFor('some-new-model', { inputTokens: 10 }), null);
  assert.deepStrictEqual(pricing.priceFor('gpt-6-sol-2026-09-01'), pricing.PRICES['gpt-6-sol']);
});

// ---------- Claude client ----------

test('Claude request: default model, structured output schema, low effort, refusal fallbacks on', async () => {
  const stub = claudeStub(claudeResponse(goodAnswers));
  const r = await claudeClient.assess(claim, { client: stub });
  const req = stub.calls[0];
  assert.strictEqual(req.model, 'claude-opus-5');
  assert.deepStrictEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.strictEqual(req.fallbacks, 'default');
  assert.deepStrictEqual(req.output_config, { format: { type: 'json_schema', schema: prompt.SCHEMA }, effort: 'low' });
  assert.strictEqual(req.system, prompt.SYSTEM_PROMPT);
  assert.strictEqual(req.messages[0].role, 'user');
  assert.deepStrictEqual(r.answers, goodAnswers);
  assert.strictEqual(r.usage.inputTokens, 1200);
  assert.ok(Math.abs(r.costUsd - (1200 * 5 + 150 * 25) / 1e6) < 1e-12);
  assert.ok(r.latencyMs >= 0);
});

test('Claude: effort can be turned off, and cost uses the model that actually served the request', async () => {
  const stub = claudeStub(claudeResponse(goodAnswers, { model: 'claude-sonnet-5' }));
  const r = await claudeClient.assess(claim, { client: stub, model: 'claude-opus-5', effort: undefined });
  assert.strictEqual(stub.calls[0].output_config.effort, undefined);
  assert.strictEqual(r.model, 'claude-sonnet-5');
  assert.strictEqual(r.requestedModel, 'claude-opus-5');
  assert.ok(Math.abs(r.costUsd - (1200 * 2 + 150 * 10) / 1e6) < 1e-12);
});

test('Claude: refusals, truncation and bad replies become clear errors', async () => {
  await assert.rejects(
    claudeClient.assess(claim, { client: claudeStub(claudeResponse(goodAnswers, { stop_reason: 'refusal', stop_details: { category: 'bio' } })) }),
    { kind: 'refusal', message: /bio/ }
  );
  await assert.rejects(claudeClient.assess(claim, { client: claudeStub(claudeResponse(goodAnswers, { stop_reason: 'max_tokens' })) }), { kind: 'truncated' });
  await assert.rejects(
    claudeClient.assess(claim, { client: claudeStub({ ...claudeResponse(goodAnswers), content: [{ type: 'text', text: 'not json' }] }) }),
    { kind: 'invalid_response' }
  );
  await assert.rejects(claudeClient.assess(claim, { client: claudeStub(claudeResponse({ ...goodAnswers, decision: 'maybe' })) }), { kind: 'invalid_response' });
});

test('Claude: SDK errors are mapped by type, not by message text', async () => {
  const authErr = new Anthropic.AuthenticationError(401, { type: 'error' }, 'invalid x-api-key', new Headers());
  await assert.rejects(claudeClient.assess(claim, { client: claudeStub(authErr) }), { kind: 'auth', status: 401 });
  const rateErr = new Anthropic.RateLimitError(429, { type: 'error' }, 'slow down', new Headers());
  await assert.rejects(claudeClient.assess(claim, { client: claudeStub(rateErr) }), { kind: 'rate_limit' });
});

test('Claude: the workspace header is sent through the SDK when a workspace ID is set', async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url: String(url), headers: new Headers(init.headers) });
    return new Response(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', ...claudeResponse(goodAnswers)
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const r = await claudeClient.assess(claim, { apiKey: 'sk-ant-test', workspaceId: 'wrkspc_123', fetch: fakeFetch });
  assert.strictEqual(r.answers.decision, 'approve');
  assert.ok(seen[0].url.includes('/v1/messages'), seen[0].url);
  assert.strictEqual(seen[0].headers.get('anthropic-workspace-id'), 'wrkspc_123');
  assert.strictEqual(seen[0].headers.get('x-api-key'), 'sk-ant-test');
  assert.match(seen[0].headers.get('anthropic-beta'), /server-side-fallback-2026-07-01/);

  await claudeClient.assess(claim, { apiKey: 'sk-ant-test', fetch: fakeFetch });
  assert.strictEqual(seen[1].headers.get('anthropic-workspace-id'), null, 'no header without a workspace ID');
});

// ---------- OpenAI client ----------

test('OpenAI request: strict JSON schema, no reasoning effort unless set; usage includes cached and reasoning tokens', async () => {
  const calls = [];
  const stub = {
    responses: {
      create: async (req) => {
        calls.push(req);
        return {
          model: 'gpt-6-sol',
          status: 'completed',
          output_text: JSON.stringify(goodAnswers),
          usage: { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 120 } }
        };
      }
    }
  };
  const r = await openaiClient.assess(claim, { client: stub });
  assert.strictEqual(calls[0].model, 'gpt-6-sol');
  assert.deepStrictEqual(calls[0].text.format, { type: 'json_schema', name: 'claim_assessment', schema: prompt.SCHEMA, strict: true });
  assert.strictEqual(calls[0].reasoning, undefined);
  assert.strictEqual(r.usage.reasoningTokens, 120);
  assert.ok(Math.abs(r.costUsd - (1000 * 2 + 200 * 10) / 1e6) < 1e-12);

  await openaiClient.assess(claim, { client: stub, reasoningEffort: 'low' });
  assert.deepStrictEqual(calls[1].reasoning, { effort: 'low' });
});

test('OpenAI: an incomplete reply is an error, not a silent partial answer', async () => {
  const stub = { responses: { create: async () => ({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '' }) } };
  await assert.rejects(openaiClient.assess(claim, { client: stub }), { kind: 'truncated', message: /max_output_tokens/ });
});

// ---------- Comparison ----------

const jevOk = {
  model: 'jev-1.13.0',
  answers: {
    decision: { type: 'choice', choice: 'approve', confidence: 0.53, probabilities: { approve: 0.69, deny: 0, review: 0.31 } },
    claim_type: { type: 'choice', choice: 'emergency', confidence: 0.97, probabilities: {} },
    medical_necessity: { type: 'score', score: 2.9, confidence: 0.9, probabilities: {} },
    cost_check: { type: 'choice', choice: 'normal', confidence: 0.9, probabilities: {} },
    billing_check: { type: 'choice', choice: 'normal', confidence: 0.9, probabilities: {} },
    alert_level: { type: 'score', score: 0.2, confidence: 0.9, probabilities: {} }
  },
  usage: { input_tokens: 1010, output_tokens: 245, cost_usd: 0.000425 }
};
const jevFetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => jevOk });

test('comparison: both engines run; tokens, cost and full agreement are recorded', async () => {
  const stub = claudeStub(claudeResponse(goodAnswers));
  const r = await comparison.compareClaim({ ...claim, expectedDecision: 'approve' }, { jevFetch, anthropic: stub });
  assert.strictEqual(r.jev.ok, true);
  assert.strictEqual(r.llm.ok, true);
  assert.strictEqual(r.jev.usage.inputTokens, 1010);
  assert.ok(Math.abs(r.jev.costUsd - 1010 * 0.042 / 1e6) < 1e-15, 'Jev list price bills input only');
  assert.strictEqual(r.jev.billedUsd, 0.000425);
  assert.deepStrictEqual(r.agreement, { decision: true, fields: 6, total: 6, differences: [] });
  assert.strictEqual(r.expectedDecision, 'approve');
  assert.strictEqual(r.llm.confidence, 0.9);
  assert.ok(!('confidence' in r.llm.answers));
  assert.ok(!JSON.stringify(stub.calls[0]).includes('expected'), 'expected outcome is not sent to the LLM');
});

test('comparison: differences are listed field by field', async () => {
  const stub = claudeStub(claudeResponse({ ...goodAnswers, decision: 'review', alert_level: 'medium' }));
  const r = await comparison.compareClaim(claim, { jevFetch, anthropic: stub });
  assert.deepStrictEqual(r.agreement, { decision: false, fields: 4, total: 6, differences: ['decision', 'alert_level'] });
});

test('comparison: if one engine fails, the other result is kept and agreement is empty', async () => {
  const stub = claudeStub(new Anthropic.RateLimitError(429, { type: 'error' }, 'slow down', new Headers()));
  const r = await comparison.compareClaim(claim, { jevFetch, anthropic: stub });
  assert.strictEqual(r.jev.ok, true);
  assert.strictEqual(r.llm.ok, false);
  assert.strictEqual(r.llm.errorKind, 'rate_limit');
  assert.strictEqual(r.llm.model, 'claude-opus-5');
  assert.strictEqual(r.agreement, null);
});

test('config reports provider, model and whether each side has a key', () => {
  const c = comparison.getConfig();
  assert.strictEqual(c.llm.provider, 'anthropic');
  assert.strictEqual(c.llm.model, 'claude-opus-5');
  assert.strictEqual(c.llm.effort, 'low');
  assert.strictEqual(c.llm.configured, true);
  assert.strictEqual(c.jev.configured, true);
  assert.strictEqual(c.jev.endpoint, 'https://jev.example.test/v1/systemone');
  process.env.LLM_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = '';
  const o = comparison.getConfig();
  assert.strictEqual(o.llm.model, 'gpt-6-sol');
  assert.strictEqual(o.llm.configured, false);
  process.env.LLM_PROVIDER = 'anthropic';
});

// ---------- Connection status ----------

const status = require('../llm/status');
const engineForStatus = require('../decision-engine');

const modelsStub = (ids, calls = { n: 0 }) => ({
  calls,
  models: {
    list: () => {
      calls.n++;
      if (ids instanceof Error) throw ids;
      return (async function* () { for (const id of ids) yield { id }; })();
    }
  }
});
const cfg = (overrides = {}) => ({ provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-opus-5', ...overrides });

test('status: no key means "not configured", with where to get one', async () => {
  status.clearCache();
  const r = await status.checkLlm(cfg({ apiKey: '' }));
  assert.strictEqual(r.state, 'not_configured');
  assert.ok(r.advice.some((a) => a.includes('ANTHROPIC_API_KEY=')));
  assert.ok(r.advice.some((a) => a.includes('console.anthropic.com')));
});

test('status: connected when the key works and the model is listed', async () => {
  status.clearCache();
  const r = await status.checkLlm(cfg(), { anthropic: modelsStub(['claude-opus-5', 'claude-sonnet-5']) });
  assert.strictEqual(r.state, 'connected');
  assert.deepStrictEqual(r.advice, []);
});

test('status: model not available suggests models the key can use', async () => {
  status.clearCache();
  const r = await status.checkLlm(cfg({ model: 'claude-opus-9' }), { anthropic: modelsStub(['claude-opus-5', 'claude-sonnet-5', 'gpt-x']) });
  assert.strictEqual(r.state, 'model_unavailable');
  assert.match(r.advice[0], /ANTHROPIC_MODEL=.*claude-opus-5, claude-sonnet-5/);
  assert.ok(!r.advice[0].includes('gpt-x'));
});

test('status: a key without a workspace gets workspace advice; a bad key gets key advice', async () => {
  status.clearCache();
  const wsErr = new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header' } }, 'x', new Headers());
  const ws = await status.checkLlm(cfg(), { anthropic: modelsStub(wsErr) });
  assert.strictEqual(ws.state, 'workspace_required');
  assert.ok(ws.advice.some((a) => a.includes('ANTHROPIC_WORKSPACE_ID=')));

  status.clearCache();
  const authErr = new Anthropic.AuthenticationError(401, { type: 'error' }, 'invalid x-api-key', new Headers());
  const auth = await status.checkLlm(cfg(), { anthropic: modelsStub(authErr) });
  assert.strictEqual(auth.state, 'auth_error');
});

test('status: results are cached for 30 s unless a refresh is forced', async () => {
  status.clearCache();
  const stub = modelsStub(['claude-opus-5']);
  await status.checkLlm(cfg(), { anthropic: stub });
  await status.checkLlm(cfg(), { anthropic: stub });
  assert.strictEqual(stub.calls.n, 1);
  await status.checkLlm(cfg(), { anthropic: stub, force: true });
  assert.strictEqual(stub.calls.n, 2);
});

test('status: OpenAI is checked the same way', async () => {
  status.clearCache();
  const r = await status.checkLlm(cfg({ provider: 'openai', apiKey: 'sk-test', model: 'gpt-6-sol' }), { openai: modelsStub(['gpt-6-sol']) });
  assert.strictEqual(r.state, 'connected');
});

test('status: comparison calls update Jev\'s status, so a failure shows on the page', async () => {
  engineForStatus.resetStatus();
  const rejected = async () => ({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({ detail: { message: 'Cannot authenticate' } }) });
  await comparison.compareClaim(claim, { jevFetch: rejected, anthropic: claudeStub(claudeResponse(goodAnswers)) });
  const j = status.jevStatus(engineForStatus.getStatus(), true);
  assert.strictEqual(j.state, 'error');
  assert.match(j.message, /rejected the API key/);
  assert.ok(j.advice.length > 0);

  await comparison.compareClaim(claim, { jevFetch, anthropic: claudeStub(claudeResponse(goodAnswers)) });
  assert.strictEqual(status.jevStatus(engineForStatus.getStatus(), true).state, 'connected');
});
