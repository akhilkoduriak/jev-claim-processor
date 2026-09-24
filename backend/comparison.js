/**
 * Runs one claim through Jev and through an LLM (Claude or OpenAI) and
 * records tokens, latency, cost and whether the answers agree.
 *
 * This compares the raw engines: the app's policy rules (high-value and
 * low-confidence claims go to review) are not applied here.
 */
const { randomUUID } = require('crypto');
const jevClient = require('./jev-client');
const anthropic = require('./llm/anthropic-client');
const openai = require('./llm/openai-client');
const { costFor, priceFor } = require('./llm/pricing');
const { FIELDS } = require('./llm/prompt');
const engine = require('./decision-engine');

const NECESSITY_LEVELS = jevClient.QUESTIONS.medical_necessity.criteria;

function llmConfig() {
  const env = process.env;
  const provider = (env.LLM_PROVIDER || 'anthropic').trim().toLowerCase();
  if (provider === 'openai') {
    return {
      provider,
      apiKey: (env.OPENAI_API_KEY || '').trim(),
      model: (env.OPENAI_MODEL || '').trim() || openai.DEFAULT_MODEL,
      reasoningEffort: (env.OPENAI_REASONING_EFFORT || '').trim() || undefined
    };
  }
  return {
    provider: 'anthropic',
    apiKey: (env.ANTHROPIC_API_KEY || '').trim(),
    // Needed when the API key isn't scoped to a workspace (Console > Settings > Workspaces).
    workspaceId: (env.ANTHROPIC_WORKSPACE_ID || '').trim() || undefined,
    model: (env.ANTHROPIC_MODEL || '').trim() || anthropic.DEFAULT_MODEL,
    // Unset means "low" (a classification task); set it empty to send no effort at all.
    effort: env.ANTHROPIC_EFFORT === undefined ? 'low' : env.ANTHROPIC_EFFORT.trim() || undefined
  };
}

const keyLooksSet = (k) => Boolean(k) && !/^your_/.test(k);

function getConfig() {
  const llm = llmConfig();
  const jev = engine.config();
  return {
    llm: {
      provider: llm.provider,
      model: llm.model,
      effort: llm.effort || llm.reasoningEffort || null,
      configured: keyLooksSet(llm.apiKey),
      price: priceFor(llm.model)
    },
    jev: {
      configured: engine.isConfigured(jev),
      endpoint: `${jev.apiUrl}${jev.apiPath}`,
      model: jev.model || 'jev-latest',
      price: priceFor('jev')
    }
  };
}

/** Jev's parsed assessment in the same shape as the LLM's JSON answers. */
function jevAnswers(a) {
  const necessityScore = Number(a.jev?.answers?.medical_necessity?.score);
  return {
    decision: a.decision,
    claim_type: a.claimType,
    medical_necessity: Number.isFinite(necessityScore)
      ? NECESSITY_LEVELS[Math.max(0, Math.min(NECESSITY_LEVELS.length - 1, Math.round(necessityScore)))]
      : null,
    cost_check: a.costAnomaly,
    billing_check: a.billingAnomaly,
    alert_level: a.alertLevel
  };
}

async function runJev(claim, fetchImpl) {
  const c = engine.config();
  const started = process.hrtime.bigint();
  const a = await jevClient.assess(claim, { ...c, fetchImpl: fetchImpl || fetch });
  const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
  const usage = { inputTokens: a.jev?.usage?.input_tokens || 0, outputTokens: a.jev?.usage?.output_tokens || 0 };
  return {
    ok: true,
    model: a.jev?.model || null,
    answers: jevAnswers(a),
    confidence: a.confidence,
    usage,
    // List price: input tokens only, output is free.
    costUsd: costFor('jev', { inputTokens: usage.inputTokens }),
    // What the provider actually charged, if it reports it (the reseller does).
    billedUsd: typeof a.jev?.usage?.cost_usd === 'number' ? a.jev.usage.cost_usd : null,
    latencyMs
  };
}

async function runLlm(claim, clients = {}) {
  const c = llmConfig();
  const r = c.provider === 'openai'
    ? await openai.assess(claim, { apiKey: c.apiKey, model: c.model, reasoningEffort: c.reasoningEffort, client: clients.openai })
    : await anthropic.assess(claim, { apiKey: c.apiKey, workspaceId: c.workspaceId, model: c.model, effort: c.effort, client: clients.anthropic });
  const { confidence, ...answers } = r.answers;
  return {
    ok: true,
    provider: r.provider,
    model: r.model,
    effort: r.effort,
    answers,
    confidence,
    usage: r.usage,
    costUsd: r.costUsd,
    latencyMs: r.latencyMs
  };
}

const failed = (err) => ({ ok: false, error: err.message, errorKind: err.kind || null });

/**
 * Compare one claim. Both engines run at the same time.
 * @param {object} claim  a validated claim (see server.js parseClaim)
 * @param {{jevFetch?: Function, anthropic?: object, openai?: object}} deps  test doubles
 */
async function compareClaim(claim, deps = {}) {
  const { expectedDecision, ...forEngines } = claim;
  const [jevResult, llmResult] = await Promise.allSettled([
    runJev(forEngines, deps.jevFetch),
    runLlm(forEngines, { anthropic: deps.anthropic, openai: deps.openai })
  ]);
  const jev = jevResult.status === 'fulfilled' ? jevResult.value : failed(jevResult.reason);
  const llm = llmResult.status === 'fulfilled' ? llmResult.value : failed(llmResult.reason);
  if (!llm.ok) Object.assign(llm, { provider: llmConfig().provider, model: llmConfig().model });

  let agreement = null;
  if (jev.ok && llm.ok) {
    const keys = Object.keys(FIELDS);
    const matching = keys.filter((k) => jev.answers[k] === llm.answers[k]);
    agreement = {
      decision: jev.answers.decision === llm.answers.decision,
      fields: matching.length,
      total: keys.length,
      differences: keys.filter((k) => !matching.includes(k))
    };
  }

  return {
    id: randomUUID(),
    claimId: claim.claimId,
    claim: { diagnosis: claim.diagnosis, procedure: claim.procedure, amount: claim.amount, providerTier: claim.providerTier },
    expectedDecision: expectedDecision || null,
    comparedAt: new Date().toISOString(),
    jev,
    llm,
    agreement
  };
}

module.exports = { compareClaim, getConfig, llmConfig };
