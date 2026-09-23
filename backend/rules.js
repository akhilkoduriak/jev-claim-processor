/**
 * Rule-based fallback engine.
 *
 * Used when the Jev API is disabled, not configured, or unreachable.
 * Returns the same assessment shape as the Jev client so the rest of the
 * app does not care which engine made the call.
 */

// First match wins, so more specific types come first.
const CLAIM_TYPES = [
  { type: 'experimental', necessity: 0.2, pattern: /\b(experimental|investigational|clinical trial)\b/ },
  { type: 'cosmetic', necessity: 0.1, pattern: /\b(cosmetic|aesthetic)\b/ },
  { type: 'emergency', necessity: 0.95, pattern: /\b(emergency|er|trauma|accident|urgent|chest pain|fracture|laceration)\b/ },
  { type: 'preventive', necessity: 0.9, pattern: /\b(preventive|screening|checkup|check-up|vaccination|vaccine|immuni[sz]ation|wellness|annual)\b/ },
  { type: 'therapy', necessity: 0.8, pattern: /\b(rehabilitation|physical therapy|pt treatment|occupational therapy)\b/ },
  { type: 'surgical', necessity: 0.8, pattern: /\b(surgery|surgical|repair|replacement|implant)\b|ectomy\b/ },
  { type: 'diagnostic', necessity: 0.8, pattern: /\b(lab|labs|panel|test|mri|ct|x-ray|xray|imaging|scan|ultrasound|biopsy|mammograph\w*)\b/ },
  { type: 'chronic', necessity: 0.85, pattern: /\b(diabetes|hypertension|asthma|arthritis|copd|depression|anxiety|follow-up|management|therapy|counseling|psychiatric)\b/ }
];
const DEFAULT_TYPE = { type: 'routine', necessity: 0.75 };

// Typical upper price for a service. Above `max` is suspicious; above 2x `max` is likely overbilling.
const PRICE_BANDS = [
  { service: 'surgery', max: 60000, pattern: /\b(surgery|surgical|repair|replacement|implant)\b|ectomy\b/ },
  { service: 'emergency care', max: 6000, pattern: /\b(emergency|er|trauma)\b/ },
  { service: 'urgent care', max: 1500, pattern: /\burgent\b/ },
  { service: 'imaging', max: 3000, pattern: /\b(mri|ct|x-ray|xray|imaging|scan|ultrasound|mammograph\w*)\b/ },
  { service: 'lab work', max: 1000, pattern: /\b(lab|labs|panel|test)\b/ },
  { service: 'a therapy session', max: 400, pattern: /\b(therapy|counseling|rehabilitation)\b/ },
  { service: 'a vaccination', max: 300, pattern: /\bvaccin\w*/ },
  { service: 'an office visit', max: 600, pattern: /\b(office visit|checkup|check-up|follow-up|visit|evaluation|eval|management)\b/ }
];
const DEFAULT_BAND = { service: 'this kind of claim', max: 5000 };

const claimText = (claim) =>
  `${claim.diagnosis || ''} ${claim.procedure || ''}`.toLowerCase();

function classifyType(claim) {
  const text = claimText(claim);
  return CLAIM_TYPES.find((t) => t.pattern.test(text)) || DEFAULT_TYPE;
}

function checkCost(claim) {
  const text = claimText(claim);
  const band = PRICE_BANDS.find((b) => b.pattern.test(text)) || DEFAULT_BAND;
  const amount = Number(claim.amount) || 0;
  const fmt = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

  if (amount > band.max * 2) {
    return { result: 'potential_manipulation', reason: `${fmt(amount)} is more than twice the typical maximum of ${fmt(band.max)} for ${band.service}` };
  }
  if (amount > band.max) {
    return { result: 'suspicious', reason: `${fmt(amount)} is above the typical maximum of ${fmt(band.max)} for ${band.service}` };
  }
  return { result: 'normal', reason: null };
}

function checkBilling(claim) {
  let score = 0;
  const flags = [];
  const prior = claim.priorClaimsInMonth || 0;

  if (claim.providerTier === 'out-of-network') { score += 0.3; flags.push('out-of-network provider'); }
  if (claim.frequencyPattern === 'suspicious') { score += 0.4; flags.push('claim frequency flagged as suspicious'); }
  if (prior >= 8) { score += 0.3; flags.push(`${prior} claims already this month`); }
  else if (prior >= 5) { score += 0.15; flags.push(`${prior} claims already this month`); }

  const result = score >= 0.7 ? 'potential_manipulation' : score >= 0.3 ? 'suspicious' : 'normal';
  return { result, reason: flags.length ? `Billing flags: ${flags.join(', ')}` : null };
}

/**
 * Assess a claim with the fallback rules.
 * @returns {{decision, confidence, alertLevel, claimType, medicalNecessityScore, costAnomaly, billingAnomaly, reasons}}
 */
function assess(claim) {
  const typeInfo = classifyType(claim);
  // Claim frequency is judged by the billing check only, not by necessity.
  const necessity = typeInfo.necessity;
  const cost = checkCost(claim);
  const billing = checkBilling(claim);
  const flagged = [cost, billing];
  const reasons = [];

  let decision;
  let confidence;
  let alertLevel;

  if (necessity < 0.4) {
    // Not covered: cosmetic or experimental care is denied regardless of price or billing.
    decision = 'deny';
    confidence = 1 - necessity;
    alertLevel = 'low';
    reasons.push(`${capitalize(typeInfo.type)} treatment is not covered`);
  } else if (flagged.some((f) => f.result === 'potential_manipulation')) {
    decision = 'review';
    confidence = 0.8;
    alertLevel = 'critical';
    reasons.push('Strong signs of overbilling or billing abuse');
  } else if (flagged.some((f) => f.result === 'suspicious')) {
    decision = 'review';
    confidence = 0.65;
    alertLevel = 'high';
    reasons.push('Unusual price or billing pattern');
  } else if (necessity >= 0.75) {
    decision = 'approve';
    confidence = necessity;
    alertLevel = 'low';
    reasons.push(`${capitalize(typeInfo.type)} care, medically necessary, normal price and billing`);
  } else {
    decision = 'review';
    confidence = 0.55;
    alertLevel = 'medium';
    reasons.push('Medical necessity is unclear');
  }

  flagged.forEach((f) => f.result !== 'normal' && reasons.push(f.reason));

  return {
    decision,
    confidence,
    alertLevel,
    claimType: typeInfo.type,
    medicalNecessityScore: necessity,
    costAnomaly: cost.result,
    billingAnomaly: billing.result,
    reasons
  };
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

module.exports = { assess, classifyType, checkCost, checkBilling };
