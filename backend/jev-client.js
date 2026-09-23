/**
 * Client for TypeSafe AI's Jev API (System One model).
 *
 * Jev answers a fixed set of questions about a piece of state in one pass.
 * Each question has a type:
 *   - choice: pick one key from `criteria`; returns { choice, confidence, probabilities }
 *   - score:  pick a level from the ordered `criteria` array; returns { score, confidence, probabilities }
 *
 * API: POST {JEV_API_URL}{JEV_API_PATH} with `Authorization: Bearer <key>`.
 * TypeSafe's own API is https://api.typesafe.ai/v1 + /systemone. Services that expose the same
 * request and response format (for example jevtypesafeai.com/api/v1 + /decide) work too.
 * Reference: https://docs.typesafe.ai/api.md
 */

const DEFAULT_MODEL = 'jev-latest';
// 429 (rate limited) and 529 (overloaded) are temporary; the API reference says to retry with backoff.
const RETRYABLE = new Set([429, 529]);
const MAX_RETRIES = 2;

const ALERT_LEVELS = ['low', 'medium', 'high', 'critical'];
const NECESSITY_LEVELS = ['Not necessary', 'Questionable', 'Likely necessary', 'Clearly necessary'];

const QUESTIONS = {
  decision: {
    type: 'choice',
    instructions:
      'Decide how this health insurance claim should be handled. Approve claims that are medically necessary, covered, ' +
      'and billed at a normal price. Deny treatment that is not covered, such as cosmetic or experimental procedures. ' +
      'Send anything unusual, ambiguous or possibly fraudulent to a human claims adjuster for review.',
    criteria: {
      approve: 'Medically necessary, covered, normally priced and normally billed',
      deny: 'Not covered: cosmetic, experimental, or not medically necessary',
      review: 'Unusual price or billing pattern, or ambiguous; a human adjuster should decide'
    }
  },
  claim_type: {
    type: 'choice',
    instructions: 'What kind of care is this claim for?',
    criteria: {
      emergency: 'Emergency or urgent care',
      preventive: 'Checkups, screenings and vaccinations',
      chronic: 'Ongoing management of a long-term condition, including mental health',
      therapy: 'Physical therapy or rehabilitation sessions',
      diagnostic: 'Lab tests and imaging',
      surgical: 'Surgical procedures',
      cosmetic: 'Cosmetic or aesthetic procedures',
      experimental: 'Experimental or investigational treatment',
      routine: 'Routine office visits, supplies and other everyday care'
    }
  },
  medical_necessity: {
    type: 'score',
    instructions: 'How medically necessary is this treatment for the stated diagnosis?',
    criteria: NECESSITY_LEVELS
  },
  cost_check: {
    type: 'choice',
    instructions: 'Compare the claimed amount with the typical US price for this service.',
    criteria: {
      normal: 'Within the typical price range',
      suspicious: 'Noticeably above the typical price range',
      potential_manipulation: 'Far above the typical price; likely overbilling'
    }
  },
  billing_check: {
    type: 'choice',
    instructions:
      'Assess the billing pattern: whether the provider is in network, how many claims were already filed this month, ' +
      'and whether claim frequency has been flagged.',
    criteria: {
      normal: 'Nothing unusual about how this claim was billed',
      suspicious: 'Somewhat unusual, such as an out-of-network provider or frequent claims',
      potential_manipulation: 'Strong signs of billing abuse'
    }
  },
  alert_level: {
    type: 'score',
    instructions: 'How urgently should a claims adjuster look at this claim?',
    criteria: [
      'Low: routine, no concerns',
      'Medium: worth a look',
      'High: significant concern',
      'Critical: likely fraud or a serious error'
    ]
  }
};

class JevError extends Error {
  constructor(message, { status, kind } = {}) {
    super(message);
    this.name = 'JevError';
    this.status = status;
    this.kind = kind; // 'auth' | 'http' | 'timeout' | 'network' | 'invalid_response'
  }
}

/**
 * The state Jev sees. Only the fields needed for a decision are sent:
 * no patient name, and never the test dataset's expected outcome.
 */
function buildState(claim) {
  return {
    diagnosis: claim.diagnosis,
    procedure: claim.procedure || 'Not specified',
    procedure_code: claim.procedureCode || 'Not specified',
    amount_usd: claim.amount,
    provider_network: claim.providerTier || 'in-network',
    claims_already_filed_this_month: claim.priorClaimsInMonth || 0,
    claim_frequency: claim.frequencyPattern || 'normal'
  };
}

function buildRequest(claim, model) {
  // `model` is required by the API.
  return { model: model || DEFAULT_MODEL, state: buildState(claim), questions: QUESTIONS };
}

// A score answer is a 0-based position on the levels scale. It can fall between
// levels, because it is the probability-weighted average level.
const levelIndex = (answer, count) => {
  const raw = Number(answer?.score);
  if (!Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(count - 1, Math.round(raw)));
};

/**
 * Turn Jev's answers into the app's assessment shape.
 * Throws JevError('invalid_response') if a required answer is missing.
 */
function parseResponse(json) {
  const a = json?.answers;
  const decision = a?.decision?.choice;
  if (!['approve', 'deny', 'review'].includes(decision)) {
    throw new JevError('Jev response has no valid "decision" answer', { kind: 'invalid_response' });
  }

  const necessityIdx = levelIndex(a.medical_necessity, NECESSITY_LEVELS.length);
  const alertIdx = levelIndex(a.alert_level, ALERT_LEVELS.length);
  const confidence = Number(a.decision.confidence);
  const pct = (n) => `${Math.round(n * 100)}%`;
  const label = (key) => QUESTIONS.claim_type.criteria[key] || key;

  const reasons = [
    `Jev chose "${decision}"${Number.isFinite(confidence) ? ` with ${pct(confidence)} confidence` : ''}`
  ];
  if (a.claim_type?.choice) reasons.push(`Care type: ${label(a.claim_type.choice)}`);
  if (necessityIdx !== null) reasons.push(`Medical necessity: ${NECESSITY_LEVELS[necessityIdx]}`);
  if (a.cost_check?.choice) reasons.push(`Price check: ${QUESTIONS.cost_check.criteria[a.cost_check.choice] || a.cost_check.choice}`);
  if (a.billing_check?.choice) reasons.push(`Billing check: ${QUESTIONS.billing_check.criteria[a.billing_check.choice] || a.billing_check.choice}`);

  return {
    decision,
    confidence: Number.isFinite(confidence) ? confidence : 0.5,
    alertLevel: alertIdx !== null ? ALERT_LEVELS[alertIdx] : 'medium',
    claimType: a.claim_type?.choice || 'routine',
    medicalNecessityScore: Number.isFinite(Number(a.medical_necessity?.score))
      ? Math.max(0, Math.min(1, Number(a.medical_necessity.score) / (NECESSITY_LEVELS.length - 1)))
      : null,
    costAnomaly: a.cost_check?.choice || 'normal',
    billingAnomaly: a.billing_check?.choice || 'normal',
    decisionProbabilities: a.decision.probabilities || null,
    reasons,
    jev: { model: json.model || null, usage: json.usage || null, answers: a }
  };
}

/**
 * Ask Jev to assess a claim.
 * @param {object} claim
 * @param {{apiKey: string, apiUrl: string, model?: string, timeoutMs?: number, fetchImpl?: Function}} options
 */
async function assess(claim, { apiKey, apiUrl, apiPath = '/systemone', model, timeoutMs = 8000, retryDelayMs = 500, fetchImpl = fetch }) {
  const url = `${apiUrl.replace(/\/+$/, '')}/${apiPath.replace(/^\/+/, '')}`;
  const body = JSON.stringify(buildRequest(claim, model));
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new JevError(`Jev did not respond within ${timeoutMs / 1000}s`, { kind: 'timeout' });
      }
      throw new JevError(`Could not reach Jev: ${err.message}`, { kind: 'network' });
    }
    if (!RETRYABLE.has(res.status) || attempt >= MAX_RETRIES) break;
    const retryAfter = Number(res.headers?.get?.('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 2000)
      : retryDelayMs * 2 ** attempt;
    await new Promise((r) => setTimeout(r, wait));
  }

  if (!res.ok) {
    let detail = '';
    try {
      const errBody = await res.json();
      detail = errBody?.detail?.message || errBody?.error?.message || errBody?.message || '';
      // 422 validation errors can come back as a list of field errors.
      if (!detail && Array.isArray(errBody?.detail)) {
        detail = errBody.detail.map((e) => `${(e.loc || []).join('.')}: ${e.msg}`).join('; ');
      }
    } catch (e) { /* non-JSON error body */ }
    const auth = res.status === 401 || res.status === 403;
    const label = {
      422: 'Jev rejected the request format',
      429: 'Jev rate limit reached',
      529: 'Jev is temporarily overloaded'
    }[res.status];
    throw new JevError(
      auth
        ? `Jev rejected the API key (HTTP ${res.status})${detail ? `: ${detail}` : ''}`
        : `${label || 'Jev returned an error'} (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
      { status: res.status, kind: auth ? 'auth' : 'http' }
    );
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new JevError('Jev returned a response that is not JSON', { kind: 'invalid_response' });
  }
  return parseResponse(json);
}

module.exports = { assess, buildRequest, buildState, parseResponse, QUESTIONS, JevError };
