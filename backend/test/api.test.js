const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.USE_MOCK_JEV = 'true';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-test-'));
process.env.FRONTEND_BUILD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-build-'));
fs.writeFileSync(path.join(process.env.FRONTEND_BUILD_DIR, 'index.html'), '<div id="root"></div>');

const test = require('node:test');
const assert = require('node:assert');
const app = require('../server');

let server;
let base;

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  fs.rmSync(process.env.FRONTEND_BUILD_DIR, { recursive: true, force: true });
});

const post = (url, body, raw = false) =>
  fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? body : JSON.stringify(body)
  });

const valid = {
  claimId: 'API-1',
  patientName: 'Jane Doe',
  amount: 250,
  diagnosis: 'Annual Checkup',
  procedure: 'Office Visit',
  providerTier: 'in-network',
  priorClaimsInMonth: 0,
  frequencyPattern: 'normal'
};

test('health and engine status', async () => {
  const health = await (await fetch(`${base}/health`)).json();
  assert.strictEqual(health.status, 'ok');
  const engine = await (await fetch(`${base}/api/engine`)).json();
  assert.strictEqual(engine.mode, 'disabled');
  assert.ok(engine.message);
});

test('rejects invalid claims with a clear message', async () => {
  const cases = [
    [{ ...valid, claimId: '' }, /claimId/],
    [{ ...valid, amount: 0 }, /amount/],
    [{ ...valid, amount: 'abc' }, /amount/],
    [{ ...valid, diagnosis: '  ' }, /diagnosis/],
    [{ ...valid, providerTier: 'partner' }, /providerTier/],
    [{ ...valid, frequencyPattern: 'weird' }, /frequencyPattern/],
    [{ ...valid, priorClaimsInMonth: -1 }, /priorClaimsInMonth/],
    [{ ...valid, expectedDecision: 'maybe' }, /expectedDecision/],
    [[valid], /JSON object/]
  ];
  for (const [body, message] of cases) {
    const res = await post('/api/claims/process', body);
    assert.strictEqual(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, message);
  }
});

test('rejects malformed JSON', async () => {
  const res = await post('/api/claims/process', '{"claimId":', true);
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /not valid JSON/);
});

test('processes a claim, stores it, and drops unknown fields', async () => {
  const res = await post('/api/claims/process', { ...valid, amount: '250', isAdmin: true, expectedDecision: 'approve' });
  assert.strictEqual(res.status, 200);
  const { decision, claim } = await res.json();
  assert.strictEqual(decision.decision, 'approve');
  assert.strictEqual(claim.amount, 250);
  assert.strictEqual(claim.isAdmin, undefined);
  assert.strictEqual(claim.expectedDecision, 'approve');

  const decisions = await (await fetch(`${base}/api/decisions`)).json();
  assert.strictEqual(decisions.length, 1);
  const one = await (await fetch(`${base}/api/decisions/${decision.id}`)).json();
  assert.strictEqual(one.claimId, 'API-1');
  assert.strictEqual((await fetch(`${base}/api/decisions/nope`)).status, 404);
});

test('stats count outcomes and test-claim matches', async () => {
  const stats = await (await fetch(`${base}/api/stats`)).json();
  assert.strictEqual(stats.totalProcessed, 1);
  assert.strictEqual(stats.approved, 1);
  assert.strictEqual(stats.testClaims, 1);
  assert.strictEqual(stats.testClaimsMatchingExpected, 1);
});

test('datasets route serves all sample datasets', async () => {
  const datasets = await (await fetch(`${base}/api/datasets`)).json();
  assert.deepStrictEqual(Object.keys(datasets).sort(), ['comprehensive', 'fraud_checks', 'quick_test']);
  for (const ds of Object.values(datasets)) {
    for (const s of ds.samples) assert.ok(['approve', 'deny', 'review'].includes(s.expected), s.claim.claimId);
  }
});

test('serves the built frontend for app routes but not for API routes', async () => {
  const page = await fetch(`${base}/`);
  assert.strictEqual(page.status, 200);
  assert.match(await page.text(), /id="root"/);
  const deep = await fetch(`${base}/some/app/route`);
  assert.match(await deep.text(), /id="root"/);
  assert.strictEqual((await fetch(`${base}/api/decisions/nope`)).status, 404);
  assert.strictEqual((await (await fetch(`${base}/health`)).json()).status, 'ok');
});

test('reset clears everything', async () => {
  await post('/api/reset', {});
  assert.deepStrictEqual(await (await fetch(`${base}/api/decisions`)).json(), []);
  assert.deepStrictEqual(await (await fetch(`${base}/api/claims`)).json(), []);
});
