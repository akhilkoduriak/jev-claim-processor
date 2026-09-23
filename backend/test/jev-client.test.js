process.env.USE_MOCK_JEV = 'false';
process.env.JEV_API_KEY = 'jv_test_key';
process.env.JEV_API_URL = 'https://api.example.test/v1';

const test = require('node:test');
const assert = require('node:assert');
const jev = require('../jev-client');
const engine = require('../decision-engine');

const claim = {
  claimId: 'T-1',
  patientName: 'Private Person',
  amount: 2500,
  diagnosis: 'Emergency Room Visit',
  procedure: 'Emergency care',
  procedureCode: '99285',
  providerTier: 'in-network',
  priorClaimsInMonth: 0,
  frequencyPattern: 'normal',
  expectedDecision: 'approve'
};

// A response in the documented shape: choice answers carry choice/confidence/probabilities,
// score answers carry a (possibly fractional) level index.
const okResponse = {
  model: 'jev-1.13.0',
  answers: {
    decision: { type: 'choice', choice: 'approve', confidence: 0.91, probabilities: { approve: 0.91, deny: 0.02, review: 0.07 } },
    claim_type: { type: 'choice', choice: 'emergency', confidence: 0.97, probabilities: {} },
    medical_necessity: { type: 'score', score: 2.8, confidence: 0.9, probabilities: {} },
    cost_check: { type: 'choice', choice: 'normal', confidence: 0.88, probabilities: {} },
    billing_check: { type: 'choice', choice: 'normal', confidence: 0.93, probabilities: {} },
    alert_level: { type: 'score', score: 0.2, confidence: 0.85, probabilities: {} }
  },
  usage: { input_tokens: 612, output_tokens: 0 }
};

const fakeFetch = (status, body, calls = []) => async (url, init) => {
  calls.push({ url, init });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => {
      if (typeof body === 'string') throw new SyntaxError('not json');
      return body;
    }
  };
};

test('request matches the documented Jev format and leaves out private or test-only fields', () => {
  const body = jev.buildRequest(claim);
  assert.deepStrictEqual(Object.keys(body).sort(), ['model', 'questions', 'state']);
  assert.strictEqual(body.model, 'jev-latest', 'model is required by the API; defaults to jev-latest');
  assert.strictEqual(body.state.amount_usd, 2500);
  assert.ok(!JSON.stringify(body.state).includes('Private Person'), 'patient name must not be sent');
  assert.ok(!JSON.stringify(body.state).includes('expected'), 'expected outcome must not be sent');

  for (const [key, q] of Object.entries(body.questions)) {
    assert.ok(['choice', 'score'].includes(q.type), `${key}: type`);
    assert.ok(q.instructions.length > 10, `${key}: instructions`);
    if (q.type === 'choice') assert.ok(Object.keys(q.criteria).length >= 2 && Object.keys(q.criteria).length <= 255, `${key}: choice criteria`);
    if (q.type === 'score') assert.ok(Array.isArray(q.criteria) && q.criteria.length >= 2 && q.criteria.length <= 10, `${key}: score levels`);
  }
  assert.deepStrictEqual(Object.keys(body.questions.decision.criteria), ['approve', 'deny', 'review']);
  assert.strictEqual(jev.buildRequest(claim, 'jev-1.13.0').model, 'jev-1.13.0');
});

test('calls POST {url}/systemone with a Bearer key', async () => {
  const calls = [];
  await jev.assess(claim, { apiKey: 'k', apiUrl: 'https://api.example.test/v1/', fetchImpl: fakeFetch(200, okResponse, calls) });
  assert.strictEqual(calls[0].url, 'https://api.example.test/v1/systemone');
  assert.strictEqual(calls[0].init.method, 'POST');
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer k');
});

test('endpoint path is configurable for services with the same format', async () => {
  const calls = [];
  await jev.assess(claim, { apiKey: 'k', apiUrl: 'https://reseller.test/api/v1', apiPath: '/decide', fetchImpl: fakeFetch(200, okResponse, calls) });
  assert.strictEqual(calls[0].url, 'https://reseller.test/api/v1/decide');
});

test('parses answers into the app\'s assessment shape', () => {
  const a = jev.parseResponse(okResponse);
  assert.strictEqual(a.decision, 'approve');
  assert.strictEqual(a.confidence, 0.91);
  assert.strictEqual(a.alertLevel, 'low');
  assert.strictEqual(a.claimType, 'emergency');
  assert.ok(Math.abs(a.medicalNecessityScore - 2.8 / 3) < 1e-9, 'score 2.8 on a 0-3 scale is 93%');
  assert.ok(a.reasons.includes('Medical necessity: Clearly necessary'), 'label uses the nearest level');
  assert.deepStrictEqual(a.decisionProbabilities, okResponse.answers.decision.probabilities);
  assert.strictEqual(a.jev.model, 'jev-1.13.0');
  assert.ok(a.reasons[0].includes('91%'));
});

test('rejects a response with no valid decision', () => {
  assert.throws(() => jev.parseResponse({ answers: { decision: { choice: 'maybe' } } }), { kind: 'invalid_response' });
  assert.throws(() => jev.parseResponse({}), { kind: 'invalid_response' });
});

test('classifies errors: 401 is an auth error, 500 is an HTTP error, bad JSON is invalid', async () => {
  const opts = (status, body) => ({ apiKey: 'k', apiUrl: 'https://x.test', fetchImpl: fakeFetch(status, body) });
  await assert.rejects(jev.assess(claim, opts(401, { detail: { message: 'Cannot authenticate' } })), { kind: 'auth', status: 401 });
  await assert.rejects(jev.assess(claim, opts(500, {})), { kind: 'http', status: 500 });
  await assert.rejects(jev.assess(claim, opts(200, 'not json')), { kind: 'invalid_response' });
});

test('retries on 429 and 529, then succeeds', async () => {
  const statuses = [429, 529, 200];
  const calls = [];
  const flaky = async (url, init) => {
    calls.push(init);
    const status = statuses.shift();
    return { ok: status === 200, status, headers: { get: () => null }, json: async () => okResponse };
  };
  const a = await jev.assess(claim, { apiKey: 'k', apiUrl: 'https://x.test', retryDelayMs: 1, fetchImpl: flaky });
  assert.strictEqual(a.decision, 'approve');
  assert.strictEqual(calls.length, 3);
});

test('gives up after repeated 529s with a clear message', async () => {
  const calls = [];
  const opts = { apiKey: 'k', apiUrl: 'https://x.test', retryDelayMs: 1, fetchImpl: fakeFetch(529, {}, calls) };
  await assert.rejects(jev.assess(claim, opts), (err) => err.status === 529 && /overloaded/.test(err.message));
  assert.strictEqual(calls.length, 3, 'one call plus two retries');
});

test('does not retry a rejected key', async () => {
  const calls = [];
  await assert.rejects(jev.assess(claim, { apiKey: 'k', apiUrl: 'https://x.test', fetchImpl: fakeFetch(401, {}, calls) }), { kind: 'auth' });
  assert.strictEqual(calls.length, 1);
});

test('times out instead of hanging', async () => {
  const hang = (url, init) => new Promise((resolve, reject) => {
    // AbortSignal.timeout doesn't keep the event loop alive by itself (a real request would),
    // so hold it open until the abort fires. Without this, Node 22 cancels the test file.
    const keepAlive = setTimeout(() => {}, 5000);
    init.signal.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(init.signal.reason);
    });
  });
  await assert.rejects(jev.assess(claim, { apiKey: 'k', apiUrl: 'https://x.test', timeoutMs: 50, fetchImpl: hang }), { kind: 'timeout' });
});

test('engine uses Jev when it answers', async () => {
  engine.resetStatus();
  const d = await engine.decide(claim, { fetchImpl: fakeFetch(200, okResponse) });
  assert.strictEqual(d.engine, 'jev');
  assert.strictEqual(d.usedRealAPI, true);
  assert.strictEqual(d.decision, 'approve');
  assert.strictEqual(engine.getStatus().mode, 'connected');
});

test('guardrails also apply to Jev decisions', async () => {
  engine.resetStatus();
  const d = await engine.decide({ ...claim, amount: 80000 }, { fetchImpl: fakeFetch(200, okResponse) });
  assert.strictEqual(d.engine, 'jev');
  assert.strictEqual(d.decision, 'review');
  assert.strictEqual(d.guardrails.length, 1);
});

test('engine falls back to rules on a rejected key, then skips Jev during the cooldown', async () => {
  engine.resetStatus();
  const calls = [];
  const first = await engine.decide(claim, { fetchImpl: fakeFetch(401, { detail: { message: 'Cannot authenticate' } }, calls) });
  assert.strictEqual(first.engine, 'rules');
  assert.match(first.fallbackReason, /rejected the API key/);
  assert.strictEqual(engine.getStatus().mode, 'error');

  const second = await engine.decide(claim, { fetchImpl: fakeFetch(200, okResponse, calls) });
  assert.strictEqual(second.engine, 'rules');
  assert.match(second.fallbackReason, /^Jev skipped/);
  assert.strictEqual(calls.length, 1, 'Jev should not be called again during the cooldown');
});

test('engine falls back to rules on a server error and recovers on the next success', async () => {
  engine.resetStatus();
  const failed = await engine.decide(claim, { fetchImpl: fakeFetch(503, {}) });
  assert.strictEqual(failed.engine, 'rules');
  const ok = await engine.decide(claim, { fetchImpl: fakeFetch(200, okResponse) });
  assert.strictEqual(ok.engine, 'jev');
  assert.strictEqual(engine.getStatus().mode, 'connected');
});
