/**
 * Bulk Load Sample Claims Script
 *
 * Usage:
 *   node load-samples.js                    # Load the comprehensive dataset (32 claims)
 *   node load-samples.js quick_test         # Quick test (3 claims)
 *   node load-samples.js fraud_checks       # Fraud and billing checks (10 claims)
 *
 * Exits with code 1 if any claim fails or gets an outcome other than the expected one.
 */

const fs = require('fs');
const path = require('path');

const API_URL = process.env.API_URL || 'http://localhost:5000';
const selectedDataset = process.argv[2] || 'comprehensive';

// Read sample datasets
const sampleFile = path.join(__dirname, 'sample-claims.json');
const sampleData = JSON.parse(fs.readFileSync(sampleFile, 'utf8'));

// Get dataset
const dataset = sampleData.datasets[selectedDataset];

if (!dataset) {
  console.error(`\n❌ Dataset not found: ${selectedDataset}`);
  console.error('\nAvailable datasets:');
  Object.keys(sampleData.datasets).forEach(key => {
    console.error(`  - ${key}: ${sampleData.datasets[key].name}`);
  });
  process.exit(1);
}

const samples = dataset.samples;

console.log(`\n🏥 Smart Insurance Claim Processor - Bulk Load Script`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`\n📊 Dataset: ${dataset.name}`);
console.log(`📝 ${dataset.description}`);
console.log(`🎯 Loading ${samples.length} sample claims`);
console.log(`🔗 API URL: ${API_URL}\n`);

/**
 * Load claims with delay between requests
 */
async function loadSamples() {
  let successful = 0;
  let failed = 0;
  const results = [];
  const categoryStats = {};
  const mismatches = [];

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const category = sample.category || 'Other';

    if (!categoryStats[category]) {
      categoryStats[category] = { total: 0, approved: 0, denied: 0, review: 0, failed: 0 };
    }
    categoryStats[category].total++;

    try {
      console.log(`[${i + 1}/${samples.length}] ${sample.description}`);

      const response = await fetch(`${API_URL}/api/claims/process`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ...sample.claim, expectedDecision: sample.expected })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      successful++;

      // Print decision summary
      const decision = data.decision;
      const emoji = decision.decision === 'approve' ? '✅'
                    : decision.decision === 'deny' ? '❌'
                    : '👁️';

      const matches = decision.decision === sample.expected;
      if (!matches) mismatches.push(`${sample.claim.claimId}: expected ${sample.expected}, got ${decision.decision}`);
      console.log(`  ${emoji} Decision: ${decision.decision.toUpperCase()}  ${matches ? '(as expected)' : `(EXPECTED ${sample.expected.toUpperCase()})`}`);
      console.log(`     Confidence: ${(decision.confidence * 100).toFixed(0)}% | Alert: ${decision.alertLevel}`);
      console.log(`     Processing: ${decision.processingTimeMs.toFixed(1)}ms`);

      console.log(decision.usedRealAPI ? '     Engine: Jev API' : `     Engine: fallback rules (${decision.fallbackReason})`);

      // Track stats
      if (decision.decision === 'approve') categoryStats[category].approved++;
      else if (decision.decision === 'deny') categoryStats[category].denied++;
      else categoryStats[category].review++;

      results.push({
        claim: sample.claim.claimId,
        description: sample.description,
        category: category,
        decision: decision.decision,
        confidence: decision.confidence,
        success: true
      });

      // Small delay between requests
      await new Promise(resolve => setTimeout(resolve, 150));

    } catch (error) {
      failed++;
      categoryStats[category].failed++;
      console.log(`  ❌ Error: ${error.message}`);

      results.push({
        claim: sample.claim.claimId,
        description: sample.description,
        category: category,
        error: error.message,
        success: false
      });
    }

    console.log();
  }

  // Print summary
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📈 Load Complete!`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  // Overall stats
  console.log(`Overall Results:`);
  console.log(`  ✅ Successful: ${successful}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`  📊 Total: ${successful + failed}\n`);

  // Decision breakdown
  const approved = results.filter(r => r.success && r.decision === 'approve').length;
  const denied = results.filter(r => r.success && r.decision === 'deny').length;
  const review = results.filter(r => r.success && r.decision === 'review').length;

  console.log(`Decision Breakdown:`);
  console.log(`  ✅ Approved: ${approved}`);
  console.log(`  ❌ Denied: ${denied}`);
  console.log(`  👁️  Under Review: ${review}\n`);

  // Category breakdown
  console.log(`By Category:`);
  Object.entries(categoryStats).forEach(([category, stats]) => {
    const rate = stats.total > 0 ? ((stats.approved + stats.denied + stats.review) / stats.total * 100).toFixed(0) : 0;
    console.log(`  ${category}: ${stats.total} total | ✅${stats.approved} ❌${stats.denied} 👁️${stats.review} | Success: ${rate}%`);
  });

  // Confidence stats
  const confidences = results
    .filter(r => r.success && r.confidence)
    .map(r => r.confidence);

  if (confidences.length > 0) {
    const avgConfidence = (confidences.reduce((a, b) => a + b, 0) / confidences.length * 100).toFixed(0);
    const minConfidence = Math.min(...confidences);
    const maxConfidence = Math.max(...confidences);
    console.log(`\nConfidence Statistics:`);
    console.log(`  Average: ${avgConfidence}%`);
    console.log(`  Range: ${(minConfidence * 100).toFixed(0)}% - ${(maxConfidence * 100).toFixed(0)}%\n`);
  }

  console.log(`Expected outcomes: ${successful - mismatches.length} of ${successful} matched`);
  mismatches.forEach((m) => console.log(`  ✖ ${m}`));
  console.log();

  console.log(`📊 Next Steps:`);
  console.log(`  🌐 View Dashboard: http://localhost:3000`);
  console.log(`  📈 View Stats: http://localhost:5000/api/stats`);
  console.log(`  📋 View Decisions: http://localhost:5000/api/decisions\n`);

  if (failed || mismatches.length) process.exitCode = 1;
}

// Run the loader
loadSamples().catch(error => {
  console.error('Fatal error:', error.message);
  console.log(`\n⚠️  Make sure the backend server is running on ${API_URL}`);
  console.log(`Run: npm run backend (or npm run dev for both)\n`);
  process.exit(1);
});
