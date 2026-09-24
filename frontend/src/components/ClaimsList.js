import React, { useState, useMemo } from 'react';
import Icon from './Icon';
import { DecisionPill, AlertTag, EngineTag, Confidence } from './Badges';
import { money, dateTime, capitalize, duration, DECISION_LABELS } from './format';

const isMismatch = (d) => d.claim?.expectedDecision && d.claim.expectedDecision !== d.decision;

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'approve', label: 'Approved' },
  { key: 'deny', label: 'Denied' },
  { key: 'review', label: 'Needs review' }
];

function ClaimsList({ decisions, onNavigate }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [expandedId, setExpandedId] = useState(null);

  const counts = useMemo(() => {
    const c = { all: decisions.length, approve: 0, deny: 0, review: 0, mismatch: 0 };
    decisions.forEach((d) => {
      c[d.decision] = (c[d.decision] || 0) + 1;
      if (isMismatch(d)) c.mismatch++;
    });
    return c;
  }, [decisions]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...decisions].reverse().filter((d) => {
      if (filter === 'mismatch' ? !isMismatch(d) : filter !== 'all' && d.decision !== filter) return false;
      if (!q) return true;
      return [d.claimId, d.claim?.patientName, d.claim?.diagnosis, d.claim?.procedure]
        .some((v) => (v || '').toLowerCase().includes(q));
    });
  }, [decisions, query, filter]);

  return (
    <div className="panel">
      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={15} />
          <input
            type="search"
            placeholder="Search claim ID, patient, diagnosis"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="segmented" role="tablist">
          {[...FILTERS, ...(counts.mismatch ? [{ key: 'mismatch', label: 'Unexpected' }] : [])].map((f) => (
            <button
              key={f.key}
              className={filter === f.key ? 'active' : ''}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span className="seg-count">{counts[f.key] || 0}</span>
            </button>
          ))}
        </div>
      </div>

      {decisions.length === 0 ? (
        <div className="empty">
          <div className="empty-icon"><Icon name="inbox" size={22} /></div>
          <h3>No claims yet</h3>
          <p>Processed claims will be listed here with the reasoning behind each decision.</p>
          <button className="btn btn-primary" onClick={() => onNavigate('submit')}>
            <Icon name="plus" size={14} />
            New claim
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="empty empty-sm">
          <h3>No matching claims</h3>
          <p>Try a different search term or filter.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 36 }} />
                <th>Claim</th>
                <th>Patient</th>
                <th>Diagnosis</th>
                <th className="num">Amount</th>
                <th>Decision</th>
                <th>Alert</th>
                <th>Confidence</th>
                <th>Engine</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const open = expandedId === d.id;
                return (
                  <React.Fragment key={d.id}>
                    <tr
                      className={`clickable ${open ? 'is-open' : ''}`}
                      onClick={() => setExpandedId(open ? null : d.id)}
                    >
                      <td><span className={`chev ${open ? 'open' : ''}`}><Icon name="chevron" size={14} /></span></td>
                      <td className="mono">{d.claimId}</td>
                      <td>{d.claim?.patientName || <span className="muted">—</span>}</td>
                      <td className="truncate">{d.claim?.diagnosis}</td>
                      <td className="num">{money(d.claim?.amount)}</td>
                      <td>
                        <DecisionPill decision={d.decision} />
                        {isMismatch(d) && <span className="mismatch" title={`Test data expected: ${DECISION_LABELS[d.claim.expectedDecision]}`}>≠ expected</span>}
                      </td>
                      <td><AlertTag level={d.alertLevel} /></td>
                      <td><Confidence value={d.confidence} /></td>
                      <td><EngineTag usedRealAPI={d.usedRealAPI} /></td>
                    </tr>
                    {open && (
                      <tr className="detail-row">
                        <td colSpan={9}>
                          <ClaimDetail d={d} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const PROB_COLORS = { approve: 'var(--success)', deny: 'var(--danger)', review: 'var(--warning)' };

function ClaimDetail({ d }) {
  const c = d.claim || {};
  const necessity = d.medicalNecessityScore == null ? '—' : `${Math.round(d.medicalNecessityScore * 100)}%`;
  return (
    <div className="detail">
      <div className="detail-grid">
        <div>
          <h4>Claim</h4>
          <dl className="kv">
            <dt>Procedure</dt><dd>{c.procedure || '—'}</dd>
            <dt>Procedure code</dt><dd className="mono">{c.procedureCode || '—'}</dd>
            <dt>Provider</dt><dd>{capitalize(c.providerTier)}</dd>
            <dt>Claims this month</dt><dd>{c.priorClaimsInMonth ?? 0}</dd>
            <dt>Frequency</dt><dd>{capitalize(c.frequencyPattern)}</dd>
          </dl>
        </div>
        <div>
          <h4>Assessment</h4>
          <dl className="kv">
            <dt>Care type</dt><dd>{capitalize(d.claimType)}</dd>
            <dt>Medical necessity</dt><dd>{necessity}</dd>
            <dt>Price check</dt><dd>{capitalize(d.costAnomaly)}</dd>
            <dt>Billing check</dt><dd>{capitalize(d.billingAnomaly)}</dd>
          </dl>
        </div>
        <div>
          <h4>Decision</h4>
          <dl className="kv">
            <dt>Outcome</dt><dd><DecisionPill decision={d.decision} /></dd>
            <dt>Confidence</dt><dd>{Math.round((d.confidence || 0) * 100)}%</dd>
            <dt>Alert level</dt><dd><AlertTag level={d.alertLevel} /></dd>
            <dt>Decision time</dt><dd>{duration(d.processingTimeMs || 0)}</dd>
            <dt>Processed</dt><dd>{dateTime(d.processedAt)}</dd>
            {c.expectedDecision && (
              <>
                <dt>Test expected</dt>
                <dd>
                  {DECISION_LABELS[c.expectedDecision]}{' '}
                  {isMismatch(d) ? <span className="mismatch">does not match</span> : <span className="expected-ok">matches</span>}
                </dd>
              </>
            )}
          </dl>
        </div>
        <div>
          <h4>Next step</h4>
          <p className="detail-text"><strong>{d.recommendedAction?.nextStep}</strong></p>
          <p className="detail-text muted">{d.recommendedAction?.details}</p>
          {d.guardrails?.map((g, i) => <div className="guardrail" key={i}>Policy rule: {g}</div>)}
        </div>
      </div>

      <div className="detail-foot">
        <div>
          <h4>Engine</h4>
          <dl className="kv">
            <dt>Decided by</dt><dd><EngineTag usedRealAPI={d.usedRealAPI} /></dd>
            {d.jev?.model && (<><dt>Model</dt><dd className="mono">{d.jev.model}</dd></>)}
            {d.jev?.usage?.input_tokens != null && (<><dt>Input tokens</dt><dd>{d.jev.usage.input_tokens}</dd></>)}
            {d.fallbackReason && (<><dt>Why not Jev</dt><dd>{d.fallbackReason}</dd></>)}
          </dl>
          {d.decisionProbabilities && (
            <div className="probs">
              {['approve', 'deny', 'review'].map((k) => {
                const p = d.decisionProbabilities[k] || 0;
                return (
                  <div className="prob" key={k}>
                    <span>{DECISION_LABELS[k]}</span>
                    <span className="prob-track"><span className="prob-fill" style={{ width: `${p * 100}%`, background: PROB_COLORS[k] }} /></span>
                    <span className="num">{Math.round(p * 100)}%</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div>
          <h4>Reasons</h4>
          <ul className="reasons">
            {(d.reasons || []).map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      </div>
    </div>
  );
}

export default ClaimsList;
