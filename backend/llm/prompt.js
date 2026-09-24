/**
 * The LLM gets exactly what Jev gets: the same claim fields, the same six
 * questions, and the same allowed answers with their descriptions. It must
 * reply with JSON matching SCHEMA and nothing else, which keeps its output
 * (and so its cost) as small as an LLM's can be. That makes the comparison
 * as favourable to the LLM as possible.
 */
const { QUESTIONS, buildState } = require('../jev-client');

const ALERT_LEVELS = ['low', 'medium', 'high', 'critical'];

// Map each Jev question to one JSON field. Score questions become enums of
// their level labels (or the app's alert levels) so answers compare directly.
const FIELDS = {
  decision: { enum: Object.keys(QUESTIONS.decision.criteria) },
  claim_type: { enum: Object.keys(QUESTIONS.claim_type.criteria) },
  medical_necessity: { enum: QUESTIONS.medical_necessity.criteria },
  cost_check: { enum: Object.keys(QUESTIONS.cost_check.criteria) },
  billing_check: { enum: Object.keys(QUESTIONS.billing_check.criteria) },
  alert_level: { enum: ALERT_LEVELS }
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, { type: 'string', enum: f.enum }])),
    confidence: {
      type: 'number',
      description: 'Your confidence in the decision, from 0 to 1'
    }
  },
  required: [...Object.keys(FIELDS), 'confidence']
};

const SYSTEM_PROMPT =
  'You triage health insurance claims. Answer every question about the claim using only the allowed values, ' +
  'and reply with the JSON object only.';

function describeQuestion(key, q) {
  const options = Array.isArray(q.criteria)
    ? q.criteria.map((c) => `  - "${c}"`)
    : Object.entries(q.criteria).map(([k, v]) => `  - "${k}": ${v}`);
  if (key === 'alert_level') {
    // Score levels are described as "Low: routine…"; the JSON value is the lowercase level name.
    return `${key}: ${q.instructions}\n${q.criteria.map((c, i) => `  - "${ALERT_LEVELS[i]}": ${c}`).join('\n')}`;
  }
  return `${key}: ${q.instructions}\n${options.join('\n')}`;
}

function buildUserPrompt(claim) {
  const questions = Object.entries(QUESTIONS).map(([k, q]) => describeQuestion(k, q)).join('\n\n');
  return (
    `Claim:\n${JSON.stringify(buildState(claim), null, 2)}\n\n` +
    `Questions (answer each with one of the allowed values):\n\n${questions}\n\n` +
    'Also give "confidence": your confidence in the decision, from 0 to 1.'
  );
}

/** Check an LLM reply against the schema; returns an error message or null. */
function validateAnswers(a) {
  if (!a || typeof a !== 'object') return 'reply is not a JSON object';
  for (const [k, f] of Object.entries(FIELDS)) {
    if (!f.enum.includes(a[k])) return `"${k}" is ${JSON.stringify(a[k])}, not one of the allowed values`;
  }
  if (typeof a.confidence !== 'number' || a.confidence < 0 || a.confidence > 1) return '"confidence" must be a number from 0 to 1';
  return null;
}

module.exports = { SCHEMA, SYSTEM_PROMPT, FIELDS, ALERT_LEVELS, buildUserPrompt, validateAnswers };
