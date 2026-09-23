import React, { useState, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import Icon from './Icon';

const newClaim = () => ({
  claimId: `CLM-${uuidv4().slice(0, 8).toUpperCase()}`,
  patientName: '',
  amount: '',
  diagnosis: '',
  procedure: '',
  procedureCode: '',
  providerTier: 'in-network',
  priorClaimsInMonth: 0,
  frequencyPattern: 'normal'
});

const DIAGNOSES = [
  'Emergency Room Visit',
  'Annual Checkup',
  'Diabetes Follow-up',
  'Hypertension Management',
  'Surgery - ACL Repair',
  'Preventive Screening',
  'Mental Health Counseling',
  'Urgent Care Visit',
  'Lab Test',
  'Cosmetic procedure'
];

const PROCEDURES = [
  'Office Visit',
  'Emergency care',
  'Lab Test',
  'Physical Therapy',
  'Surgery',
  'Imaging - MRI',
  'Vaccination',
  'Counseling Session'
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ClaimForm({ onSubmit, onBulkLoaded, submitting, apiUrl }) {
  const [mode, setMode] = useState('single');
  const [form, setForm] = useState(newClaim);
  const [datasets, setDatasets] = useState(null);
  const [datasetError, setDatasetError] = useState(null);
  const [progress, setProgress] = useState(null); // { key, done, total }

  useEffect(() => {
    if (mode !== 'dataset' || datasets) return;
    fetch(`${apiUrl}/api/datasets`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setDatasets)
      .catch((e) => setDatasetError(e.message));
  }, [mode, datasets, apiUrl]);

  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    const claim = {
      ...form,
      amount: parseFloat(form.amount),
      priorClaimsInMonth: parseInt(form.priorClaimsInMonth, 10) || 0
    };
    const ok = await onSubmit(claim);
    if (ok) setForm(newClaim());
  };

  const loadDataset = async (key) => {
    const ds = datasets[key];
    const total = ds.samples.length;
    let failed = 0;
    let matched = 0;
    setProgress({ key, done: 0, total });

    for (let i = 0; i < total; i++) {
      const sample = ds.samples[i];
      try {
        const res = await fetch(`${apiUrl}/api/claims/process`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...sample.claim, expectedDecision: sample.expected })
        });
        if (!res.ok) {
          failed++;
        } else {
          const { decision } = await res.json();
          if (decision.decision === sample.expected) matched++;
        }
      } catch (error) {
        failed++;
        console.error('Error loading claim:', error);
      }
      setProgress({ key, done: i + 1, total });
      await delay(150);
    }

    setProgress(null);
    onBulkLoaded({ name: displayName(ds.name), loaded: total - failed, failed, matched });
  };

  return (
    <div className="panel">
      <div className="tabs">
        <button className={`tab ${mode === 'single' ? 'active' : ''}`} onClick={() => setMode('single')} disabled={!!progress}>
          Single claim
        </button>
        <button className={`tab ${mode === 'dataset' ? 'active' : ''}`} onClick={() => setMode('dataset')} disabled={!!progress}>
          Load test dataset
        </button>
      </div>

      {mode === 'single' && (
        <form className="panel-body form" onSubmit={handleSubmit}>
          <div className="form-section">
            <div className="form-section-title">Patient and claim</div>
            <div className="form-section-sub">Who the claim is for and how much is being claimed.</div>
            <div className="field-grid">
              <div className="field">
                <label htmlFor="claimId">Claim ID</label>
                <input id="claimId" value={form.claimId} readOnly />
                <div className="hint">Generated automatically</div>
              </div>
              <div className="field">
                <label htmlFor="patientName">Patient name</label>
                <input id="patientName" value={form.patientName} onChange={set('patientName')} placeholder="e.g. Jane Doe" />
              </div>
              <div className="field">
                <label htmlFor="amount">Claim amount (USD) <span className="req">*</span></label>
                <input id="amount" type="number" min="1" step="0.01" required value={form.amount} onChange={set('amount')} placeholder="e.g. 1500" />
              </div>
              <div className="field">
                <label htmlFor="prior">Claims already filed this month</label>
                <input id="prior" type="number" min="0" value={form.priorClaimsInMonth} onChange={set('priorClaimsInMonth')} />
              </div>
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-title">Clinical details</div>
            <div className="form-section-sub">Pick from the list or type your own.</div>
            <div className="field-grid">
              <div className="field">
                <label htmlFor="diagnosis">Diagnosis <span className="req">*</span></label>
                <input id="diagnosis" list="diagnosis-options" required value={form.diagnosis} onChange={set('diagnosis')} placeholder="e.g. Emergency Room Visit" />
                <datalist id="diagnosis-options">
                  {DIAGNOSES.map((d) => <option key={d} value={d} />)}
                </datalist>
              </div>
              <div className="field">
                <label htmlFor="procedure">Procedure</label>
                <input id="procedure" list="procedure-options" value={form.procedure} onChange={set('procedure')} placeholder="e.g. Office Visit" />
                <datalist id="procedure-options">
                  {PROCEDURES.map((p) => <option key={p} value={p} />)}
                </datalist>
              </div>
              <div className="field">
                <label htmlFor="procedureCode">Procedure code</label>
                <input id="procedureCode" value={form.procedureCode} onChange={set('procedureCode')} placeholder="e.g. 99213" />
              </div>
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-title">Provider and billing</div>
            <div className="form-section-sub">Used to spot unusual billing patterns.</div>
            <div className="field-grid">
              <div className="field">
                <label htmlFor="providerTier">Provider network</label>
                <select id="providerTier" value={form.providerTier} onChange={set('providerTier')}>
                  <option value="in-network">In-network</option>
                  <option value="out-of-network">Out-of-network</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="frequencyPattern">Claim frequency</label>
                <select id="frequencyPattern" value={form.frequencyPattern} onChange={set('frequencyPattern')}>
                  <option value="normal">Normal</option>
                  <option value="suspicious">Suspicious</option>
                </select>
              </div>
            </div>
          </div>

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setForm(newClaim())} disabled={submitting}>
              Reset
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? <><span className="spinner" /> Processing</> : 'Submit claim'}
            </button>
          </div>
        </form>
      )}

      {mode === 'dataset' && (
        <div className="panel-body">
          <p className="section-intro">
            Each dataset sends its claims through the processor one at a time, exactly as if they were entered by hand.
            Every test claim records the outcome it should get, so you can check the engine's answers on the Claims page.
            You can also run them from a terminal with <code>node load-samples.js &lt;name&gt;</code>.
          </p>

          {datasetError && (
            <div className="banner banner-error">
              <Icon name="alert" />
              Could not load datasets: {datasetError}
            </div>
          )}
          {!datasets && !datasetError && <p className="muted">Loading datasets…</p>}

          {datasets && (
            <div className="dataset-grid">
              {Object.entries(datasets).map(([key, ds]) => {
                const categories = countBy(ds.samples.map((s) => s.category || 'Other'));
                const expected = countBy(ds.samples.map((s) => s.expected));
                const running = progress?.key === key;
                return (
                  <div className="dataset" key={key}>
                    <div className="dataset-head">
                      <div className="dataset-icon"><Icon name="database" size={16} /></div>
                      <div style={{ flex: 1 }}>
                        <div className="dataset-name">{displayName(ds.name)}</div>
                        <div className="dataset-meta">{ds.samples.length} claims · <code>{key}</code></div>
                      </div>
                    </div>
                    <p className="dataset-desc">{ds.description}</p>
                    <div className="dataset-expected">
                      Expected: {expected.approve || 0} approved · {expected.deny || 0} denied · {expected.review || 0} for review
                    </div>
                    <div className="chips">
                      {Object.entries(categories).map(([cat, n]) => (
                        <span className="chip" key={cat}>{cat} · {n}</span>
                      ))}
                    </div>
                    {running ? (
                      <div>
                        <div className="progress"><span style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>
                        <div className="hint">Processing {progress.done} of {progress.total}</div>
                      </div>
                    ) : (
                      <button className="btn btn-secondary" onClick={() => loadDataset(key)} disabled={!!progress}>
                        Load {ds.samples.length} claims
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const displayName = (name) => name.replace(/\s*\(.*\)$/, '');

const countBy = (items) =>
  items.reduce((acc, item) => {
    acc[item] = (acc[item] || 0) + 1;
    return acc;
  }, {});

export default ClaimForm;
