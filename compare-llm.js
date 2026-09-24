/**
 * Compare Jev with an LLM (Claude or OpenAI) on a test dataset.
 *
 * Usage (with the backend running):
 *   node compare-llm.js                      # quick_test (3 claims)
 *   node compare-llm.js comprehensive        # 32 claims
 *   node compare-llm.js fraud_checks --limit 5
 *
 * Every claim is one paid call to Jev and one to the LLM.
 * Choose the LLM in backend/.env: LLM_PROVIDER=anthropic|openai.
 */
const API_URL = process.env.API_URL || 'http://localhost:5000';
const args = process.argv.slice(2);
const datasetKey = args.find((a) => !a.startsWith('--')) || 'quick_test';
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;

const usd = (n) => (n == null ? 'n/a' : n < 0.01 ? `$${n.toFixed(6)}` : `$${n.toFixed(4)}`);
const money = (n) => (n == null ? 'n/a' : `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pad = (s, n) => String(s).padEnd(n);
const num = (n, d = 0) => (n == null ? 'n/a' : n.toLocaleString('en-US', { maximumFractionDigits: d }));

async function api(path, init) {
  const res = await fetch(API_URL + path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function summarize(results) {
  const both = results.filter((r) => r.jev.ok && r.llm.ok);
  const side = (key) => {
    const ok = results.filter((r) => r[key].ok);
    const cost = avg(ok.map((r) => r[key].costUsd).filter((c) => c != null));
    return {
      ok: ok.length,
      failed: results.length - ok.length,
      input: avg(ok.map((r) => r[key].usage.inputTokens)),
      output: avg(ok.map((r) => r[key].usage.outputTokens)),
      reasoning: avg(ok.map((r) => r[key].usage.reasoningTokens).filter((t) => t != null)),
      latency: avg(ok.map((r) => r[key].latencyMs)),
      cost,
      perMillion: cost == null ? null : cost * 1e6,
      expected: ok.filter((r) => r.expectedDecision).length,
      expectedMatched: ok.filter((r) => r.expectedDecision && r[key].answers.decision === r.expectedDecision).length
    };
  };
  return {
    total: results.length,
    compared: both.length,
    jev: side('jev'),
    llm: side('llm'),
    decisionAgreement: both.filter((r) => r.agreement.decision).length,
    fullAgreement: both.filter((r) => r.agreement.fields === r.agreement.total).length
  };
}

(async () => {
  const config = await api('/api/compare/config');
  const datasets = await api('/api/datasets');
  const ds = datasets[datasetKey];
  if (!ds) {
    console.error(`Unknown dataset "${datasetKey}". Available: ${Object.keys(datasets).join(', ')}`);
    process.exit(1);
  }
  if (!config.jev.configured || !config.llm.configured) {
    console.error('Both engines need a key in backend/.env:');
    if (!config.jev.configured) console.error('  JEV_API_KEY');
    if (!config.llm.configured) console.error(`  ${config.llm.provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'}`);
    process.exit(1);
  }

  const samples = ds.samples.slice(0, limit);
  const llmName = `${config.llm.model}${config.llm.effort ? ` (effort: ${config.llm.effort})` : ''}`;
  console.log(`\nJev vs ${config.llm.provider === 'openai' ? 'OpenAI' : 'Claude'}: ${ds.name}, ${samples.length} claims`);
  console.log(`  Jev: ${config.jev.model} at ${config.jev.endpoint}`);
  console.log(`  LLM: ${llmName}\n`);
  console.log(`${pad('Claim', 16)}${pad('Jev', 10)}${pad('LLM', 10)}${pad('Agree', 7)}${pad('Jev tokens', 12)}${pad('LLM tokens in/out', 19)}${pad('Jev ms', 8)}${pad('LLM ms', 8)}`);

  const results = [];
  for (const s of samples) {
    let r;
    try {
      r = await api('/api/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...s.claim, expectedDecision: s.expected })
      });
    } catch (err) {
      console.log(`${pad(s.claim.claimId, 16)}request failed: ${err.message}`);
      continue;
    }
    results.push(r);
    const jd = r.jev.ok ? r.jev.answers.decision : 'ERROR';
    const ld = r.llm.ok ? r.llm.answers.decision : 'ERROR';
    const agree = r.agreement ? `${r.agreement.fields}/${r.agreement.total}` : '-';
    console.log(
      pad(r.claimId, 16) + pad(jd, 10) + pad(ld, 10) + pad(agree, 7) +
      pad(r.jev.ok ? num(r.jev.usage.inputTokens) : '-', 12) +
      pad(r.llm.ok ? `${num(r.llm.usage.inputTokens)} / ${num(r.llm.usage.outputTokens)}` : '-', 19) +
      pad(r.jev.ok ? num(r.jev.latencyMs) : '-', 8) + pad(r.llm.ok ? num(r.llm.latencyMs) : '-', 8)
    );
    if (!r.jev.ok) console.log(`    Jev error: ${r.jev.error}`);
    if (!r.llm.ok) console.log(`    LLM error: ${r.llm.error}`);
    if (r.agreement && r.agreement.differences.length) console.log(`    differs on: ${r.agreement.differences.join(', ')}`);
  }

  const s = summarize(results);
  const ratio = (a, b) => (a && b ? `${num(a / b, 1)}x` : 'n/a');
  console.log(`\nAverages per claim (${s.compared} claims where both engines answered)`);
  console.log(`${pad('', 26)}${pad('Jev', 16)}${pad('LLM', 16)}LLM / Jev`);
  const row = (label, j, l, fmt = (x) => x) => console.log(pad(label, 26) + pad(fmt(j), 16) + pad(fmt(l), 16) + ratio(l, j));
  row('Input tokens', s.jev.input, s.llm.input, num);
  row('Output tokens', s.jev.output, s.llm.output, num);
  if (s.llm.reasoning != null) console.log(`${pad('  of which reasoning', 26)}${pad('-', 16)}${num(s.llm.reasoning)}`);
  row('Latency (ms)', s.jev.latency, s.llm.latency, num);
  row('Cost per claim', s.jev.cost, s.llm.cost, usd);
  row('Cost per 1M claims', s.jev.perMillion, s.llm.perMillion, money);
  console.log('\nCosts are list prices from backend/llm/pricing.js. Jev bills input tokens only.');
  console.log(`\nAgreement: same decision on ${s.decisionAgreement} of ${s.compared}; all six answers the same on ${s.fullAgreement} of ${s.compared}`);
  if (s.jev.expected) {
    console.log(`Expected outcomes: Jev ${s.jev.expectedMatched} of ${s.jev.expected}, LLM ${s.llm.expectedMatched} of ${s.llm.expected}`);
  }
  if (s.jev.failed || s.llm.failed) console.log(`Errors: Jev ${s.jev.failed}, LLM ${s.llm.failed}`);
  console.log(`\nView details at http://localhost:3000/#/compare\n`);
  if (s.jev.failed || s.llm.failed || results.length < samples.length) process.exitCode = 1;
})().catch((err) => {
  console.error(`\nFailed: ${err.message}\nIs the backend running on ${API_URL}? Start it with: npm run backend\n`);
  process.exit(1);
});
