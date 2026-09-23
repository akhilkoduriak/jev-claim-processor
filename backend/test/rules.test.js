process.env.USE_MOCK_JEV = 'true';
process.env.HIGH_VALUE_REVIEW_THRESHOLD = '50000';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const rules = require('../rules');
const engine = require('../decision-engine');
const { datasets } = require(path.join(__dirname, '../../sample-claims.json'));

const claim = (overrides) => ({
  claimId: 'T-1',
  amount: 200,
  diagnosis: 'Office Visit',
  procedure: 'Office Visit',
  providerTier: 'in-network',
  priorClaimsInMonth: 0,
  frequencyPattern: 'normal',
  ...overrides
});

// Every sample claim must produce the outcome the dataset says it should.
for (const [key, ds] of Object.entries(datasets)) {
  test(`dataset "${key}": every claim gets its expected outcome from the fallback rules`, async () => {
    const mismatches = [];
    for (const s of ds.samples) {
      const d = await engine.decide(s.claim);
      if (d.decision !== s.expected) {
        mismatches.push(`${s.claim.claimId} (${s.description}): expected ${s.expected}, got ${d.decision} — ${d.reasons.join('; ')}`);
      }
    }
    assert.deepStrictEqual(mismatches, []);
  });
}

test('words containing "er" are not mistaken for emergencies', () => {
  for (const diagnosis of ['Complex multi-organ surgery', 'Cancer screening', 'Physical therapy', 'Band-aid and supplies']) {
    assert.notStrictEqual(rules.classifyType(claim({ diagnosis, procedure: '' })).type, 'emergency', diagnosis);
  }
  assert.strictEqual(rules.classifyType(claim({ diagnosis: 'ER visit', procedure: '' })).type, 'emergency');
});

test('cosmetic and experimental care is denied', () => {
  assert.strictEqual(rules.assess(claim({ diagnosis: 'Cosmetic procedure', amount: 5000 })).decision, 'deny');
  assert.strictEqual(rules.assess(claim({ diagnosis: 'Experimental cancer treatment', amount: 3000 })).decision, 'deny');
});

test('price checks: above max is suspicious, above 2x max is likely overbilling', () => {
  assert.strictEqual(rules.checkCost(claim({ diagnosis: 'Lab Test', amount: 900 })).result, 'normal');
  assert.strictEqual(rules.checkCost(claim({ diagnosis: 'Lab Test', amount: 1500 })).result, 'suspicious');
  assert.strictEqual(rules.checkCost(claim({ diagnosis: 'Lab Test', amount: 2500 })).result, 'potential_manipulation');
});

test('billing checks: out-of-network alone is suspicious; stacked flags are likely abuse', () => {
  assert.strictEqual(rules.checkBilling(claim({ providerTier: 'out-of-network' })).result, 'suspicious');
  assert.strictEqual(rules.checkBilling(claim({ priorClaimsInMonth: 6 })).result, 'normal');
  assert.strictEqual(rules.checkBilling(claim({ frequencyPattern: 'suspicious', priorClaimsInMonth: 10 })).result, 'potential_manipulation');
});

test('guardrail: approvals at or above the high-value threshold go to review', () => {
  const c = { highValueThreshold: 50000, minConfidence: 0.6 };
  const approved = { decision: 'approve', confidence: 0.9, alertLevel: 'low', reasons: [] };
  const out = engine.applyGuardrails(claim({ amount: 50000 }), approved, c);
  assert.strictEqual(out.decision, 'review');
  assert.strictEqual(out.alertLevel, 'high');
  assert.strictEqual(out.guardrails.length, 1);
  assert.strictEqual(engine.applyGuardrails(claim({ amount: 49999 }), approved, c).decision, 'approve');
});

test('guardrail: low-confidence automatic decisions go to review', () => {
  const c = { highValueThreshold: 50000, minConfidence: 0.6 };
  const out = engine.applyGuardrails(claim(), { decision: 'deny', confidence: 0.4, alertLevel: 'low', reasons: [] }, c);
  assert.strictEqual(out.decision, 'review');
  assert.strictEqual(out.alertLevel, 'medium');
});

test('every decision has the fields the frontend relies on', async () => {
  const d = await engine.decide(claim());
  for (const field of ['id', 'claimId', 'decision', 'confidence', 'alertLevel', 'claimType', 'medicalNecessityScore',
    'costAnomaly', 'billingAnomaly', 'reasons', 'recommendedAction', 'usedRealAPI', 'engine', 'processingTimeMs']) {
    assert.ok(d[field] !== undefined, `missing ${field}`);
  }
  assert.strictEqual(d.engine, 'rules');
  assert.strictEqual(d.fallbackReason, 'Jev is turned off');
});
