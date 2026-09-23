import React, { useMemo } from 'react';
import Icon from './Icon';
import { DecisionPill, AlertTag, EngineTag } from './Badges';
import { money, dateTime, duration } from './format';

const OUTCOMES = [
  { key: 'approve', label: 'Approved', color: 'var(--success)' },
  { key: 'deny', label: 'Denied', color: 'var(--danger)' },
  { key: 'review', label: 'Needs review', color: 'var(--warning)' }
];

function Dashboard({ decisions, onNavigate }) {
  const m = useMemo(() => {
    const total = decisions.length;
    const byDecision = (k) => decisions.filter((d) => d.decision === k);
    const sum = (list) => list.reduce((s, d) => s + (Number(d.claim?.amount) || 0), 0);
    const times = decisions.map((d) => d.processingTimeMs || 0);
    const review = byDecision('review');
    return {
      total,
      counts: {
        approve: byDecision('approve').length,
        deny: byDecision('deny').length,
        review: review.length
      },
      urgent: review.filter((d) => d.alertLevel === 'high' || d.alertLevel === 'critical').length,
      apiCount: decisions.filter((d) => d.usedRealAPI).length,
      avgMs: total ? times.reduce((a, b) => a + b, 0) / total : 0,
      maxMs: total ? Math.max(...times) : 0,
      avgConfidence: total ? decisions.reduce((s, d) => s + (d.confidence || 0), 0) / total : 0,
      tested: decisions.filter((d) => d.claim?.expectedDecision).length,
      testMatched: decisions.filter((d) => d.claim?.expectedDecision && d.claim.expectedDecision === d.decision).length,
      guardrailed: decisions.filter((d) => d.guardrails?.length).length,
      totalValue: sum(decisions),
      approvedValue: sum(byDecision('approve')),
      reviewValue: sum(review),
      recent: [...decisions].reverse().slice(0, 8)
    };
  }, [decisions]);

  const pct = (n) => (m.total ? Math.round((n / m.total) * 100) : 0);

  if (m.total === 0) {
    return (
      <div className="panel">
        <div className="empty">
          <div className="empty-icon"><Icon name="inbox" size={22} /></div>
          <h3>No claims processed yet</h3>
          <p>Submit a claim or load a test dataset to see decisions, outcomes and engine metrics here.</p>
          <button className="btn btn-primary" onClick={() => onNavigate('submit')}>
            <Icon name="plus" size={14} />
            New claim
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <section className="kpi-grid">
        <div className="kpi">
          <span className="kpi-bar" style={{ background: 'var(--primary)' }} />
          <div className="kpi-label">Claims processed</div>
          <div className="kpi-value">{m.total}</div>
          <div className="kpi-meta">{money(m.totalValue)} claimed</div>
        </div>
        <div className="kpi">
          <span className="kpi-bar" style={{ background: 'var(--success)' }} />
          <div className="kpi-label">Approved</div>
          <div className="kpi-value">{m.counts.approve}</div>
          <div className="kpi-meta">{pct(m.counts.approve)}% of claims</div>
        </div>
        <div className="kpi">
          <span className="kpi-bar" style={{ background: 'var(--danger)' }} />
          <div className="kpi-label">Denied</div>
          <div className="kpi-value">{m.counts.deny}</div>
          <div className="kpi-meta">{pct(m.counts.deny)}% of claims</div>
        </div>
        <div className="kpi">
          <span className="kpi-bar" style={{ background: 'var(--warning)' }} />
          <div className="kpi-label">Needs review</div>
          <div className="kpi-value">{m.counts.review}</div>
          <div className="kpi-meta">{m.urgent} with high or critical alerts</div>
        </div>
      </section>

      <section className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <div>
              <div className="panel-title">Decision mix</div>
              <div className="panel-sub">Share of claims by outcome</div>
            </div>
          </div>
          <div className="panel-body">
            <div className="stack">
              {OUTCOMES.map((o) =>
                m.counts[o.key] ? (
                  <span
                    key={o.key}
                    style={{ width: `${(m.counts[o.key] / m.total) * 100}%`, background: o.color }}
                    title={`${o.label}: ${m.counts[o.key]}`}
                  />
                ) : null
              )}
            </div>
            <div className="legend">
              {OUTCOMES.map((o) => (
                <div className="legend-row" key={o.key}>
                  <span className="swatch" style={{ background: o.color }} />
                  <span>{o.label}</span>
                  <span className="num">{m.counts[o.key]}</span>
                  <span className="num muted">{pct(m.counts[o.key])}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <div>
              <div className="panel-title">Decision engine</div>
              <div className="panel-sub">Which engine decided, and how long it took</div>
            </div>
          </div>
          <div className="panel-body">
            <div className="metric-row"><span>Decided by Jev API</span><strong>{m.apiCount}</strong></div>
            <div className="metric-row"><span>Decided by fallback rules</span><strong>{m.total - m.apiCount}</strong></div>
            <div className="metric-row"><span>Average decision time</span><strong>{duration(m.avgMs)}</strong></div>
            <div className="metric-row"><span>Slowest decision</span><strong>{duration(m.maxMs)}</strong></div>
            <div className="metric-row"><span>Average confidence</span><strong>{Math.round(m.avgConfidence * 100)}%</strong></div>
            <div className="metric-row"><span>Sent to review by a policy rule</span><strong>{m.guardrailed}</strong></div>
            {m.tested > 0 && (
              <div className="metric-row">
                <span>Test claims with the expected outcome</span>
                <strong className={m.testMatched === m.tested ? 'expected-ok' : ''}>{m.testMatched} of {m.tested}</strong>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="kpi-grid kpi-grid-3">
        <div className="kpi">
          <div className="kpi-label">Total value claimed</div>
          <div className="kpi-value kpi-value-sm">{money(m.totalValue)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Value approved</div>
          <div className="kpi-value kpi-value-sm">{money(m.approvedValue)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Value held for review</div>
          <div className="kpi-value kpi-value-sm">{money(m.reviewValue)}</div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <div className="panel-title">Recent decisions</div>
            <div className="panel-sub">The last {m.recent.length} claims processed</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => onNavigate('claims')}>
            View all claims
            <Icon name="chevron" size={14} />
          </button>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Claim</th>
                <th>Patient</th>
                <th>Diagnosis</th>
                <th className="num">Amount</th>
                <th>Decision</th>
                <th>Alert</th>
                <th>Engine</th>
                <th>Processed</th>
              </tr>
            </thead>
            <tbody>
              {m.recent.map((d) => (
                <tr key={d.id}>
                  <td className="mono">{d.claimId}</td>
                  <td>{d.claim?.patientName || <span className="muted">—</span>}</td>
                  <td className="truncate">{d.claim?.diagnosis}</td>
                  <td className="num">{money(d.claim?.amount)}</td>
                  <td><DecisionPill decision={d.decision} /></td>
                  <td><AlertTag level={d.alertLevel} /></td>
                  <td><EngineTag usedRealAPI={d.usedRealAPI} /></td>
                  <td className="muted">{dateTime(d.processedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

export default Dashboard;
