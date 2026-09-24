/**
 * Decides a claim: Jev first, fallback rules if Jev is off or fails,
 * then the same policy guardrails on top of either engine.
 */
const { randomUUID } = require('crypto');
const jevClient = require('./jev-client');
const rules = require('./rules');

// After Jev rejects the key, stop calling it for a minute so every claim
// doesn't pay for a request that is certain to fail.
const AUTH_COOLDOWN_MS = 60 * 1000;

const config = () => ({
  apiKey: (process.env.JEV_API_KEY || '').trim(),
  apiUrl: (process.env.JEV_API_URL || 'https://api.typesafe.ai/v1').trim(),
  apiPath: (process.env.JEV_API_PATH || '/systemone').trim(),
  model: (process.env.JEV_MODEL || '').trim() || undefined,
  enabled: process.env.USE_MOCK_JEV !== 'true',
  highValueThreshold: Number(process.env.HIGH_VALUE_REVIEW_THRESHOLD) || 50000,
  minConfidence: Number(process.env.MIN_AUTO_DECISION_CONFIDENCE) || 0.6
});

const isConfigured = (c) => Boolean(c.apiKey) && !/^your_/.test(c.apiKey);

const status = {
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  lastErrorKind: null,
  model: null
};

function getStatus() {
  const c = config();
  let mode;
  let message;
  if (!c.enabled) {
    mode = 'disabled';
    message = 'Jev is turned off (USE_MOCK_JEV=true). Claims are decided by the fallback rules.';
  } else if (!isConfigured(c)) {
    mode = 'not_configured';
    message = 'No Jev API key is set in backend/.env. Claims are decided by the fallback rules.';
  } else if (status.lastErrorAt && (!status.lastSuccessAt || status.lastErrorAt > status.lastSuccessAt)) {
    mode = 'error';
    message = `${status.lastError.replace(/\.$/, '')}. Claims are being decided by the fallback rules.`;
  } else if (status.lastSuccessAt) {
    mode = 'connected';
    message = 'Claims are being decided by Jev.';
  } else {
    mode = 'ready';
    message = 'Jev is configured. The next claim will be sent to Jev.';
  }
  return {
    mode,
    message,
    apiUrl: c.apiUrl,
    model: status.model,
    lastSuccessAt: status.lastSuccessAt,
    lastErrorAt: status.lastErrorAt,
    lastError: status.lastError,
    lastErrorKind: status.lastErrorKind,
    guardrails: { highValueThreshold: c.highValueThreshold, minConfidence: c.minConfidence }
  };
}

function inAuthCooldown() {
  return status.lastErrorKind === 'auth' &&
    Date.now() - Date.parse(status.lastErrorAt) < AUTH_COOLDOWN_MS;
}

/** Policy rules that apply whichever engine made the call. */
function applyGuardrails(claim, assessment, c) {
  const a = { ...assessment, reasons: [...assessment.reasons], guardrails: [] };

  if (a.decision === 'approve' && claim.amount >= c.highValueThreshold) {
    a.decision = 'review';
    a.alertLevel = a.alertLevel === 'critical' ? 'critical' : 'high';
    const msg = `Claims of $${c.highValueThreshold.toLocaleString('en-US')} or more always need an adjuster's sign-off`;
    a.guardrails.push(msg);
    a.reasons.push(msg);
  }

  if (a.decision !== 'review' && a.confidence < c.minConfidence) {
    const msg = `Confidence ${Math.round(a.confidence * 100)}% is below the ${Math.round(c.minConfidence * 100)}% needed for an automatic decision`;
    a.decision = 'review';
    a.alertLevel = a.alertLevel === 'low' ? 'medium' : a.alertLevel;
    a.guardrails.push(msg);
    a.reasons.push(msg);
  }

  return a;
}

const ACTIONS = {
  approve: {
    action: 'AUTO_APPROVE',
    details: 'The claim meets the criteria for automatic approval.',
    nextStep: 'Process payment within 5 business days'
  },
  deny: {
    action: 'AUTO_DENY',
    details: 'The treatment is not covered under the policy.',
    nextStep: 'Send a denial notice with appeal instructions'
  },
  review: {
    action: 'MANUAL_REVIEW',
    details: 'The claim needs a claims adjuster to make the final decision.',
    nextStep: 'Route to the claims review queue'
  }
};

async function decide(claim, { fetchImpl } = {}) {
  const started = process.hrtime.bigint();
  const c = config();
  let assessment;
  let usedRealAPI = false;
  let fallbackReason = null;

  if (!c.enabled) {
    fallbackReason = 'Jev is turned off';
  } else if (!isConfigured(c)) {
    fallbackReason = 'No Jev API key configured';
  } else if (inAuthCooldown()) {
    fallbackReason = 'Jev skipped: it rejected the API key less than a minute ago';
  } else {
    try {
      assessment = await jevClient.assess(claim, { ...c, fetchImpl: fetchImpl || fetch });
      usedRealAPI = true;
      status.lastSuccessAt = new Date().toISOString();
      status.model = assessment.jev?.model || status.model;
    } catch (err) {
      status.lastErrorAt = new Date().toISOString();
      status.lastError = err.message;
      status.lastErrorKind = err.kind || 'unknown';
      fallbackReason = err.message;
      console.warn(`[jev] ${err.message}; using fallback rules for claim ${claim.claimId}`);
    }
  }

  if (!assessment) assessment = rules.assess(claim);
  const final = applyGuardrails(claim, assessment, c);

  return {
    id: randomUUID(),
    claimId: claim.claimId,
    claim,
    processedAt: new Date().toISOString(),
    ...final,
    recommendedAction: ACTIONS[final.decision],
    usedRealAPI,
    engine: usedRealAPI ? 'jev' : 'rules',
    fallbackReason,
    processingTimeMs: Number(process.hrtime.bigint() - started) / 1e6
  };
}

/** Record the outcome of a Jev call made elsewhere (the comparison page), so status stays accurate. */
function recordJevCall({ ok, model, error }) {
  if (ok) {
    status.lastSuccessAt = new Date().toISOString();
    status.model = model || status.model;
  } else {
    status.lastErrorAt = new Date().toISOString();
    status.lastError = error.message;
    status.lastErrorKind = error.kind || 'unknown';
  }
}

// For tests.
function resetStatus() {
  Object.keys(status).forEach((k) => { status[k] = null; });
}

module.exports = { decide, getStatus, applyGuardrails, resetStatus, recordJevCall, config, isConfigured };
