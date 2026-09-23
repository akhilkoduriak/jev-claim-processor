import React from 'react';
import { DECISION_LABELS, capitalize } from './format';

export function DecisionPill({ decision }) {
  return (
    <span className={`pill pill-${decision}`}>
      <span className="pill-dot" />
      {DECISION_LABELS[decision] || decision}
    </span>
  );
}

export function AlertTag({ level }) {
  return <span className={`alert-tag alert-${level}`}>{capitalize(level)}</span>;
}

export function EngineTag({ usedRealAPI }) {
  return (
    <span className={`engine-tag ${usedRealAPI ? 'engine-api' : 'engine-rules'}`}>
      {usedRealAPI ? 'Jev API' : 'Fallback rules'}
    </span>
  );
}

export function Confidence({ value }) {
  const pct = Math.round((value || 0) * 100);
  return (
    <span className="conf">
      <span className="conf-track">
        <span className="conf-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="conf-val">{pct}%</span>
    </span>
  );
}
