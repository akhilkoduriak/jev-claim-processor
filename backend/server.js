const path = require('path');
const dotenv = require('dotenv');

const ENV_FILE = path.join(__dirname, '.env');
dotenv.config({ path: ENV_FILE });

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const engine = require('./decision-engine');
const comparison = require('./comparison');

const app = express();
const PORT = process.env.PORT || 5000;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const SAMPLES_FILE = path.join(__dirname, '../sample-claims.json');
const claimsFile = path.join(DATA_DIR, 'claims.json');
const decisionsFile = path.join(DATA_DIR, 'decisions.json');
const comparisonsFile = path.join(DATA_DIR, 'comparisons.json');

app.use(cors());
app.use(express.json({ limit: '100kb' }));

// ---------- Storage ----------

function initializeStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(claimsFile)) fs.writeFileSync(claimsFile, '[]');
  if (!fs.existsSync(decisionsFile)) fs.writeFileSync(decisionsFile, '[]');
  if (!fs.existsSync(comparisonsFile)) fs.writeFileSync(comparisonsFile, '[]');
}

function readList(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return [];
  }
}

function append(file, item) {
  const list = readList(file);
  list.push(item);
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
}

// ---------- Validation ----------

const PROVIDER_TIERS = ['in-network', 'out-of-network'];
const FREQUENCY_PATTERNS = ['normal', 'suspicious'];
const DECISIONS = ['approve', 'deny', 'review'];

const optionalString = (v) => (typeof v === 'string' ? v.trim() : '');

/** Returns { claim } with only known fields, or { error }. */
function parseClaim(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }
  const claimId = optionalString(body.claimId);
  const diagnosis = optionalString(body.diagnosis);
  const amount = Number(body.amount);
  const prior = body.priorClaimsInMonth === undefined || body.priorClaimsInMonth === '' ? 0 : Number(body.priorClaimsInMonth);
  const providerTier = body.providerTier || 'in-network';
  const frequencyPattern = body.frequencyPattern || 'normal';

  if (!claimId) return { error: 'claimId is required' };
  if (claimId.length > 64) return { error: 'claimId must be 64 characters or fewer' };
  if (!diagnosis) return { error: 'diagnosis is required' };
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'amount must be a number greater than 0' };
  if (amount > 10000000) return { error: 'amount must be $10,000,000 or less' };
  if (!Number.isInteger(prior) || prior < 0) return { error: 'priorClaimsInMonth must be a whole number of 0 or more' };
  if (!PROVIDER_TIERS.includes(providerTier)) return { error: `providerTier must be one of: ${PROVIDER_TIERS.join(', ')}` };
  if (!FREQUENCY_PATTERNS.includes(frequencyPattern)) return { error: `frequencyPattern must be one of: ${FREQUENCY_PATTERNS.join(', ')}` };
  if (body.expectedDecision !== undefined && !DECISIONS.includes(body.expectedDecision)) {
    return { error: `expectedDecision must be one of: ${DECISIONS.join(', ')}` };
  }

  const claim = {
    claimId,
    patientName: optionalString(body.patientName),
    amount: Math.round(amount * 100) / 100,
    diagnosis,
    procedure: optionalString(body.procedure),
    procedureCode: optionalString(body.procedureCode),
    providerTier,
    priorClaimsInMonth: prior,
    frequencyPattern,
    submittedAt: new Date().toISOString()
  };
  // Test datasets carry the outcome they are meant to produce. It is stored
  // for comparison only and is never sent to the decision engine.
  if (body.expectedDecision) claim.expectedDecision = body.expectedDecision;
  return { claim };
}

// ---------- Routes ----------

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), engine: engine.getStatus().mode });
});

app.get('/api/engine', (req, res) => {
  res.json(engine.getStatus());
});

app.post('/api/claims/process', async (req, res) => {
  const { claim, error } = parseClaim(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const { expectedDecision, ...claimForEngine } = claim;
    const decision = await engine.decide(claimForEngine);
    decision.claim = claim;
    append(claimsFile, claim);
    append(decisionsFile, decision);
    res.json({ success: true, claim, decision });
  } catch (err) {
    console.error('Error processing claim:', err);
    res.status(500).json({ error: 'The claim could not be processed' });
  }
});

app.get('/api/claims', (req, res) => {
  res.json(readList(claimsFile));
});

app.get('/api/decisions', (req, res) => {
  res.json(readList(decisionsFile));
});

app.get('/api/decisions/:id', (req, res) => {
  const decision = readList(decisionsFile).find((d) => d.id === req.params.id);
  if (!decision) return res.status(404).json({ error: 'Decision not found' });
  res.json(decision);
});

app.get('/api/stats', (req, res) => {
  const decisions = readList(decisionsFile);
  const sum = (list) => list.reduce((s, d) => s + (d.claim?.amount || 0), 0);
  const by = (k) => decisions.filter((d) => d.decision === k);
  const tested = decisions.filter((d) => d.claim?.expectedDecision);
  res.json({
    totalProcessed: decisions.length,
    approved: by('approve').length,
    denied: by('deny').length,
    review: by('review').length,
    decidedByJev: decisions.filter((d) => d.usedRealAPI).length,
    avgConfidence: decisions.length
      ? Number((decisions.reduce((s, d) => s + d.confidence, 0) / decisions.length).toFixed(2))
      : 0,
    totalAmount: sum(decisions),
    approvedAmount: sum(by('approve')),
    testClaims: tested.length,
    testClaimsMatchingExpected: tested.filter((d) => d.decision === d.claim.expectedDecision).length
  });
});

app.get('/api/datasets', (req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(SAMPLES_FILE, 'utf8')).datasets);
  } catch (err) {
    res.status(500).json({ error: `Could not read sample-claims.json: ${err.message}` });
  }
});

app.post('/api/reset', (req, res) => {
  fs.writeFileSync(claimsFile, '[]');
  fs.writeFileSync(decisionsFile, '[]');
  fs.writeFileSync(comparisonsFile, '[]');
  res.json({ success: true, message: 'Data cleared' });
});

// ---------- Jev vs LLM comparison ----------

app.get('/api/compare/config', (req, res) => {
  res.json(comparison.getConfig());
});

app.get('/api/compare/status', async (req, res) => {
  try {
    res.json(await comparison.getStatus({ force: req.query.refresh === '1' }));
  } catch (err) {
    console.error('Error checking connections:', err);
    res.status(500).json({ error: 'Could not check connections' });
  }
});

app.post('/api/compare', async (req, res) => {
  const { claim, error } = parseClaim(req.body);
  if (error) return res.status(400).json({ error });

  const cfg = comparison.getConfig();
  const missing = [];
  if (!cfg.jev.configured) missing.push('JEV_API_KEY');
  if (!cfg.llm.configured) missing.push(cfg.llm.provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY');
  if (missing.length) {
    return res.status(400).json({ error: `Set ${missing.join(' and ')} in backend/.env to run comparisons` });
  }

  try {
    const result = await comparison.compareClaim(claim);
    append(comparisonsFile, result);
    res.json(result);
  } catch (err) {
    console.error('Error comparing claim:', err);
    res.status(500).json({ error: 'The comparison could not be run' });
  }
});

app.get('/api/comparisons', (req, res) => {
  res.json(readList(comparisonsFile));
});

app.delete('/api/comparisons', (req, res) => {
  fs.writeFileSync(comparisonsFile, '[]');
  res.json({ success: true });
});

// In production (for example the Docker image) the API also serves the built frontend.
const FRONTEND_BUILD = process.env.FRONTEND_BUILD_DIR || path.join(__dirname, '../frontend/build');
if (fs.existsSync(path.join(FRONTEND_BUILD, 'index.html'))) {
  app.use(express.static(FRONTEND_BUILD));
  app.get(/^\/(?!api\/|health$).*/, (req, res) => res.sendFile(path.join(FRONTEND_BUILD, 'index.html')));
}

// Malformed JSON and other body-parser errors
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

initializeStorage();

if (require.main === module) {
  // Pick up a new API key or setting as soon as backend/.env is saved,
  // without restarting. (PORT still needs a restart.)
  fs.watchFile(ENV_FILE, { interval: 1000 }, () => {
    dotenv.config({ path: ENV_FILE, override: true });
    engine.resetStatus();
    const s = engine.getStatus();
    console.log(`backend/.env changed; settings reloaded. Decision engine: ${s.mode}.`);
  });

  app.listen(PORT, () => {
    const s = engine.getStatus();
    console.log(`Claim Processor API running on http://localhost:${PORT}`);
    console.log(`Decision engine: ${s.mode}. ${s.message}`);
  });
}

module.exports = app;
