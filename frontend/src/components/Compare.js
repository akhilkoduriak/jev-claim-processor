import React, { useState, useEffect, useMemo, useCallback } from 'react';
import Icon from './Icon';
import { DecisionPill } from './Badges';
import { money } from './format';

const PROVIDER_NAMES = { anthropic: 'Claude', openai: 'OpenAI' };

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const num = (n, digits = 0) => (n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: digits }));
const perClaim = (n) => (n == null ? '—' : n < 0.01 ? `$${n.toFixed(6)}` : `$${n.toFixed(4)}`);
const ratio = (llm, jev) => (llm && jev ? `${num(llm / jev, 1)}×` : '—');
const priceLabel = (p) => (p ? `$${p.input} in / $${p.output} out per 1M tokens` : 'price unknown');

/**
 * Every figure uses the same set: the latest result for each claim where both
 * engines answered. Claims run more than once count once; failed calls are
 * counted separately and never affect the averages.
 */
function summarize(results) {
  const latest = new Map();
  results.forEach((r) => { if (r.jev.ok && r.llm.ok) latest.set(r.claimId, r); });
  const both = [...latest.values()];
  const tested = both.filter((r) => r.expectedDecision);
  const side = (key) => {
    const cost = avg(both.map((r) => r[key].costUsd).filter((c) => c != null));
    return {
      input: avg(both.map((r) => r[key].usage.inputTokens)),
      output: avg(both.map((r) => r[key].usage.outputTokens)),
      reasoning: avg(both.map((r) => r[key].usage.reasoningTokens).filter((t) => t != null)),
      latency: avg(both.map((r) => r[key].latencyMs)),
      cost,
      perMillion: cost == null ? null : cost * 1e6,
      matched: tested.filter((r) => r[key].answers.decision === r.expectedDecision).length
    };
  };
  return {
    runs: results.length,
    compared: both.length,
    tested: tested.length,
    failedJev: results.filter((r) => !r.jev.ok).length,
    failedLlm: results.filter((r) => !r.llm.ok).length,
    jev: side('jev'),
    llm: side('llm'),
    decisionAgree: both.filter((r) => r.agreement.decision).length,
    fullAgree: both.filter((r) => r.agreement.fields === r.agreement.total).length
  };
}

const TONES = {
  connected: 'success',
  ready: 'neutral',
  not_configured: 'warning',
  workspace_required: 'warning',
  model_unavailable: 'warning',
  rate_limited: 'warning',
  disabled: 'neutral',
  auth_error: 'danger',
  unreachable: 'danger',
  error: 'danger'
};

function EngineCard({ title, subtitle, st, rows }) {
  return (
    <div className="engine-card">
      <div className="engine-card-head">
        <div>
          <div className="engine-card-title">{title}</div>
          <div className="engine-card-sub mono">{subtitle}</div>
        </div>
        <span className={`status-chip tone-${TONES[st.state] || 'neutral'}`}>
          <span className="status-dot" />
          {st.label}
        </span>
      </div>
      <p className="engine-card-message">{st.message}</p>
      {rows.map(([k, v]) => (
        <div className="metric-row" key={k}><span>{k}</span><strong>{v}</strong></div>
      ))}
      {st.advice?.length > 0 && (
        <div className="engine-advice">
          <div className="engine-advice-title">What to do</div>
          <ol>{st.advice.map((a, i) => <li key={i}>{a}</li>)}</ol>
        </div>
      )}
    </div>
  );
}

function Compare({ apiUrl }) {
  const [conn, setConn] = useState(null);
  const [checking, setChecking] = useState(false);
  const [datasets, setDatasets] = useState(null);
  const [results, setResults] = useState([]);
  const [progress, setProgress] = useState(null); // { key, done, total }
  const [error, setError] = useState(null);

  const checkConnections = useCallback(async (refresh = false) => {
    setChecking(true);
    try {
      const res = await fetch(`${apiUrl}/api/compare/status${refresh ? '?refresh=1' : ''}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setConn(await res.json());
    } catch (e) {
      setError(`Could not check connections: ${e.message}`);
    } finally {
      setChecking(false);
    }
  }, [apiUrl]);

  useEffect(() => {
    checkConnections();
    Promise.all([
      fetch(`${apiUrl}/api/datasets`).then((x) => x.json()),
      fetch(`${apiUrl}/api/comparisons`).then((x) => x.json())
    ])
      .then(([d, r]) => { setDatasets(d); setResults(r); })
      .catch((e) => setError(`Could not load comparison data: ${e.message}`));
  }, [apiUrl, checkConnections]);

  const s = useMemo(() => summarize(results), [results]);
  const lastLlmError = useMemo(() => [...results].reverse().find((r) => !r.llm.ok)?.llm.error, [results]);
  const lastJevError = useMemo(() => [...results].reverse().find((r) => !r.jev.ok)?.jev.error, [results]);
  const llmName = conn ? PROVIDER_NAMES[conn.llm.provider] || conn.llm.provider : 'LLM';
  const llmReady = conn?.llm.state === 'connected';
  const jevReady = Boolean(conn?.jev.configured);
  const ready = llmReady && jevReady;
  const notReadyReason = !conn
    ? 'Checking connections…'
    : !jevReady
      ? 'Runs start once Jev has a key. See "What to do" under Jev above.'
      : !llmReady
        ? `Runs start once ${llmName} shows Connected. See "What to do" under ${llmName} above.`
        : null;

  const run = async (key) => {
    const ds = datasets[key];
    setError(null);
    setProgress({ key, done: 0, total: ds.samples.length });
    for (let i = 0; i < ds.samples.length; i++) {
      const sample = ds.samples[i];
      try {
        const res = await fetch(`${apiUrl}/api/compare`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...sample.claim, expectedDecision: sample.expected })
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        setResults((prev) => [...prev, body]);
        // A rejected key or request fails the same way on every claim, so stop instead of repeating it.
        const fatal = [['Jev', body.jev], [llmName, body.llm]].find(
          ([, side]) => !side.ok && (side.errorKind === 'auth' || [400, 401, 403, 404].includes(side.errorStatus))
        );
        if (fatal) {
          setError(`Stopped after ${sample.claim.claimId}: ${fatal[1].error}`);
          break;
        }
      } catch (e) {
        setError(`${sample.claim.claimId}: ${e.message}`);
        break;
      }
      setProgress({ key, done: i + 1, total: ds.samples.length });
    }
    setProgress(null);
    checkConnections(true);
  };

  const clear = async () => {
    if (!window.confirm('Delete all comparison results?')) return;
    await fetch(`${apiUrl}/api/comparisons`, { method: 'DELETE' });
    setResults([]);
  };

  if (!conn) {
    return error ? <div className="banner banner-error"><Icon name="alert" />{error}</div> : <p className="muted">Checking connections…</p>;
  }

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <div className="panel-title">Connections</div>
            <div className="panel-sub">Both engines get the same claim, the same six questions and the same allowed answers</div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => checkConnections(true)} disabled={checking || !!progress}>
            {checking ? 'Checking…' : 'Check again'}
          </button>
        </div>
        <div className="engine-grid">
          <EngineCard
            title="Jev"
            subtitle={conn.jev.model}
            st={conn.jev}
            rows={[
              ['Endpoint', conn.jev.endpoint],
              ['List price', priceLabel(conn.jev.price)]
            ]}
          />
          <EngineCard
            title={llmName}
            subtitle={conn.llm.model}
            st={conn.llm}
            rows={[
              ['Provider', `LLM_PROVIDER=${conn.llm.provider}`],
              ['Effort', conn.llm.effort || 'default'],
              ['List price', priceLabel(conn.llm.price)]
            ]}
          />
        </div>
        <p className="hint engine-foot">
          The {llmName} reply is a strict JSON object with no explanation text, the smallest output an LLM can give here.
          Change the provider or model with <code>LLM_PROVIDER</code>, <code>ANTHROPIC_MODEL</code> or <code>OPENAI_MODEL</code> in{' '}
          <code>backend/.env</code>. The app picks up changes when you save; then click <strong>Check again</strong>.
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <div className="panel-title">Run a comparison</div>
            <div className="panel-sub">Each claim is one paid call to Jev and one to {conn.llm.model}</div>
          </div>
        </div>
        <div className="panel-body">
          {notReadyReason && (
            <div className="banner banner-warning">
              <Icon name="alert" />
              <span>{notReadyReason}</span>
            </div>
          )}
          {error && <div className="banner banner-error"><Icon name="alert" /><span>{error}</span></div>}
          <div className="compare-runs">
            {datasets && Object.entries(datasets).map(([key, ds]) => (
              <div className="compare-run" key={key}>
                <div>
                  <div className="dataset-name">{ds.name.replace(/\s*\(.*\)$/, '')}</div>
                  <div className="dataset-meta">{ds.samples.length} claims</div>
                </div>
                {progress?.key === key ? (
                  <div style={{ minWidth: 160 }}>
                    <div className="progress"><span style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>
                    <div className="hint">{progress.done} of {progress.total}</div>
                  </div>
                ) : (
                  <button className="btn btn-secondary btn-sm" onClick={() => run(key)} disabled={!ready || !!progress}>
                    Run {ds.samples.length} claims
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {results.length === 0 ? (
        <div className="panel">
          <div className="empty">
            <div className="empty-icon"><Icon name="bars" size={22} /></div>
            <h3>No comparisons yet</h3>
            <p>Run a dataset to see tokens, latency, cost and agreement for Jev and {llmName}, claim by claim.</p>
          </div>
        </div>
      ) : (
        <>
          {(s.failedLlm > 0 || s.failedJev > 0) && (
            llmReady && jevReady ? (
              // Both engines work now, so these failures are history: say so instead of repeating old advice.
              <div className="banner banner-warning">
                <Icon name="alert" />
                <span>
                  {s.failedLlm + s.failedJev} earlier {s.failedLlm + s.failedJev === 1 ? 'call' : 'calls'} failed
                  ({[s.failedJev && `${s.failedJev} Jev`, s.failedLlm && `${s.failedLlm} ${llmName}`].filter(Boolean).join(', ')}).
                  Both engines are connected now, and failed calls are left out of the averages.
                  Use <strong>Clear results</strong> to remove them.
                </span>
              </div>
            ) : (
              <div className="banner banner-error">
                <Icon name="alert" />
                <span>
                  {s.failedLlm > 0 && <><strong>{s.failedLlm} {llmName} {s.failedLlm === 1 ? 'call' : 'calls'} failed.</strong> Latest error: {lastLlmError}<br /></>}
                  {s.failedJev > 0 && <><strong>{s.failedJev} Jev {s.failedJev === 1 ? 'call' : 'calls'} failed.</strong> Latest error: {lastJevError}<br /></>}
                  See <strong>What to do</strong> under Connections above, then click <strong>Check again</strong>.
                </span>
              </div>
            )
          )}

          <section className="panel">
            <div className="panel-head">
              <div>
                <div className="panel-title">Averages per claim</div>
                <div className="panel-sub">
                  {s.compared} {s.compared === 1 ? 'claim' : 'claims'} where both engines answered
                  {s.runs > s.compared ? ` (latest result for each, from ${s.runs} runs)` : ''} · list prices
                </div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={clear} disabled={!!progress}>Clear results</button>
            </div>
            <div className="table-wrap">
              <table className="table measure-table">
                <thead>
                  <tr><th>Measure</th><th className="num">Jev</th><th className="num">{llmName}</th><th className="num">{llmName} ÷ Jev</th></tr>
                </thead>
                <tbody>
                  <tr><td>Input tokens</td><td className="num">{num(s.jev.input)}</td><td className="num">{num(s.llm.input)}</td><td className="num">{ratio(s.llm.input, s.jev.input)}</td></tr>
                  <tr>
                    <td>Output tokens{s.llm.reasoning != null ? ` (${llmName}: ${num(s.llm.reasoning)} reasoning)` : ''}</td>
                    <td className="num">{num(s.jev.output)} <span className="muted">(free)</span></td>
                    <td className="num">{num(s.llm.output)}</td>
                    <td className="num">{ratio(s.llm.output, s.jev.output)}</td>
                  </tr>
                  <tr><td>Latency</td><td className="num">{s.jev.latency == null ? '—' : `${num(s.jev.latency)} ms`}</td><td className="num">{s.llm.latency == null ? '—' : `${num(s.llm.latency)} ms`}</td><td className="num">{ratio(s.llm.latency, s.jev.latency)}</td></tr>
                  <tr><td>Cost per claim</td><td className="num">{perClaim(s.jev.cost)}</td><td className="num">{perClaim(s.llm.cost)}</td><td className="num">{ratio(s.llm.cost, s.jev.cost)}</td></tr>
                  <tr className="row-strong"><td>Cost per 1 million claims</td><td className="num">{s.jev.perMillion == null ? '—' : money(s.jev.perMillion)}</td><td className="num">{s.llm.perMillion == null ? '—' : money(s.llm.perMillion)}</td><td className="num">{ratio(s.llm.perMillion, s.jev.perMillion)}</td></tr>
                  {s.tested > 0 && (
                    <tr><td>Matched expected outcome</td><td className="num">{s.jev.matched} of {s.tested}</td><td className="num">{s.llm.matched} of {s.tested}</td><td className="num">—</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="panel-body compare-agree">
              <span><strong>{s.decisionAgree} of {s.compared}</strong> same decision</span>
              <span><strong>{s.fullAgree} of {s.compared}</strong> all six answers the same</span>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <div className="panel-title">Claim by claim</div>
                <div className="panel-sub">Most recent first</div>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Claim</th><th>Jev</th><th>{llmName}</th><th>Agree</th>
                    <th className="num">Jev tokens</th><th className="num">{llmName} in / out</th>
                    <th className="num">Jev ms</th><th className="num">{llmName} ms</th>
                    <th className="num">Jev cost</th><th className="num">{llmName} cost</th>
                  </tr>
                </thead>
                <tbody>
                  {[...results].reverse().map((r) => (
                    <tr key={r.id}>
                      <td>
                        <div className="mono">{r.claimId}</div>
                        <div className="muted small truncate-block">{r.claim.diagnosis}</div>
                      </td>
                      <td>{r.jev.ok ? <DecisionPill decision={r.jev.answers.decision} /> : <span className="mismatch" title={r.jev.error}>error</span>}</td>
                      <td>{r.llm.ok ? <DecisionPill decision={r.llm.answers.decision} /> : <span className="mismatch" title={r.llm.error}>error</span>}</td>
                      <td>
                        {r.agreement ? (
                          <span title={r.agreement.differences.length ? `Differs on: ${r.agreement.differences.join(', ')}` : 'All answers match'}
                            className={r.agreement.fields === r.agreement.total ? 'expected-ok' : ''}>
                            {r.agreement.fields}/{r.agreement.total}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="num">{r.jev.ok ? num(r.jev.usage.inputTokens) : '—'}</td>
                      <td className="num">{r.llm.ok ? `${num(r.llm.usage.inputTokens)} / ${num(r.llm.usage.outputTokens)}` : '—'}</td>
                      <td className="num">{r.jev.ok ? num(r.jev.latencyMs) : '—'}</td>
                      <td className="num">{r.llm.ok ? num(r.llm.latencyMs) : '—'}</td>
                      <td className="num">{r.jev.ok ? perClaim(r.jev.costUsd) : '—'}</td>
                      <td className="num">{r.llm.ok ? perClaim(r.llm.costUsd) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}

export default Compare;
