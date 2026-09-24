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

function summarize(results) {
  const both = results.filter((r) => r.jev.ok && r.llm.ok);
  const side = (key) => {
    const ok = results.filter((r) => r[key].ok);
    const cost = avg(ok.map((r) => r[key].costUsd).filter((c) => c != null));
    const tested = ok.filter((r) => r.expectedDecision);
    return {
      failed: results.length - ok.length,
      input: avg(ok.map((r) => r[key].usage.inputTokens)),
      output: avg(ok.map((r) => r[key].usage.outputTokens)),
      reasoning: avg(ok.map((r) => r[key].usage.reasoningTokens).filter((t) => t != null)),
      latency: avg(ok.map((r) => r[key].latencyMs)),
      cost,
      perMillion: cost == null ? null : cost * 1e6,
      tested: tested.length,
      matched: tested.filter((r) => r[key].answers.decision === r.expectedDecision).length
    };
  };
  return {
    compared: both.length,
    jev: side('jev'),
    llm: side('llm'),
    decisionAgree: both.filter((r) => r.agreement.decision).length,
    fullAgree: both.filter((r) => r.agreement.fields === r.agreement.total).length
  };
}

function Compare({ apiUrl }) {
  const [config, setConfig] = useState(null);
  const [datasets, setDatasets] = useState(null);
  const [results, setResults] = useState([]);
  const [progress, setProgress] = useState(null); // { key, done, total }
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [c, d, r] = await Promise.all([
        fetch(`${apiUrl}/api/compare/config`).then((x) => x.json()),
        fetch(`${apiUrl}/api/datasets`).then((x) => x.json()),
        fetch(`${apiUrl}/api/comparisons`).then((x) => x.json())
      ]);
      setConfig(c);
      setDatasets(d);
      setResults(r);
    } catch (e) {
      setError(`Could not load comparison data: ${e.message}`);
    }
  }, [apiUrl]);

  useEffect(() => { load(); }, [load]);

  const s = useMemo(() => summarize(results), [results]);
  const lastLlmError = useMemo(() => [...results].reverse().find((r) => !r.llm.ok)?.llm.error, [results]);
  const lastJevError = useMemo(() => [...results].reverse().find((r) => !r.jev.ok)?.jev.error, [results]);
  const ready = config && config.jev.configured && config.llm.configured;
  const llmName = config ? PROVIDER_NAMES[config.llm.provider] || config.llm.provider : 'LLM';

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
  };

  const clear = async () => {
    if (!window.confirm('Delete all comparison results?')) return;
    await fetch(`${apiUrl}/api/comparisons`, { method: 'DELETE' });
    setResults([]);
  };

  if (!config) {
    return error ? <div className="banner banner-error"><Icon name="alert" />{error}</div> : <p className="muted">Loading…</p>;
  }

  return (
    <>
      <section className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <div>
              <div className="panel-title">Setup</div>
              <div className="panel-sub">Both engines get the same claim, the same six questions and the same allowed answers</div>
            </div>
          </div>
          <div className="panel-body">
            <div className="metric-row">
              <span>Jev</span>
              <strong>{config.jev.model}{config.jev.configured ? '' : ' · no key'}</strong>
            </div>
            <div className="metric-row"><span>Jev list price</span><strong>{priceLabel(config.jev.price)}</strong></div>
            <div className="metric-row">
              <span>{llmName}</span>
              <strong>{config.llm.model}{config.llm.effort ? ` · effort ${config.llm.effort}` : ''}{config.llm.configured ? '' : ' · no key'}</strong>
            </div>
            <div className="metric-row"><span>{llmName} list price</span><strong>{priceLabel(config.llm.price)}</strong></div>
            <p className="hint" style={{ marginTop: 10 }}>
              The {llmName} reply is a strict JSON object with no explanation text, the smallest output an LLM can give here.
              Change the provider or model with <code>LLM_PROVIDER</code>, <code>ANTHROPIC_MODEL</code> or <code>OPENAI_MODEL</code> in <code>backend/.env</code>.
            </p>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <div>
              <div className="panel-title">Run a comparison</div>
              <div className="panel-sub">Each claim is one paid call to Jev and one to {config.llm.model}</div>
            </div>
          </div>
          <div className="panel-body">
            {!ready && (
              <div className="banner banner-warning">
                <Icon name="alert" />
                <span>
                  Add {[!config.jev.configured && 'JEV_API_KEY', !config.llm.configured && (config.llm.provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY')].filter(Boolean).join(' and ')} to{' '}
                  <code>backend/.env</code> and save. The app picks it up automatically; reload this page.
                </span>
              </div>
            )}
            {error && <div className="banner banner-error"><Icon name="alert" />{error}</div>}
            <div className="compare-runs">
              {datasets && Object.entries(datasets).map(([key, ds]) => (
                <div className="compare-run" key={key}>
                  <div>
                    <div className="dataset-name">{ds.name.replace(/\s*\(.*\)$/, '')}</div>
                    <div className="dataset-meta">{ds.samples.length} claims</div>
                  </div>
                  {progress?.key === key ? (
                    <div style={{ minWidth: 140 }}>
                      <div className="progress"><span style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>
                      <div className="hint">{progress.done} of {progress.total}</div>
                    </div>
                  ) : (
                    <button className="btn btn-secondary btn-sm" onClick={() => run(key)} disabled={!ready || !!progress}>
                      Run
                    </button>
                  )}
                </div>
              ))}
            </div>
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
          {(s.llm.failed > 0 || s.jev.failed > 0) && (
            <div className="banner banner-error">
              <Icon name="alert" />
              <span>
                {s.llm.failed > 0 && <><strong>{s.llm.failed} of {results.length} {llmName} calls failed.</strong> Latest error: {lastLlmError}<br /></>}
                {s.jev.failed > 0 && <><strong>{s.jev.failed} of {results.length} Jev calls failed.</strong> Latest error: {lastJevError}<br /></>}
                {/workspace/i.test(lastLlmError || '') && (
                  <>To fix: copy your workspace ID (starts with <code>wrkspc_</code>) from the Anthropic Console under Settings → Workspaces,
                  paste it after <code>ANTHROPIC_WORKSPACE_ID=</code> in <code>backend/.env</code> and save. Or use an API key created inside a workspace.<br /></>
                )}
                Use <strong>Clear results</strong> to remove failed runs.
              </span>
            </div>
          )}

          <section className="panel">
            <div className="panel-head">
              <div>
                <div className="panel-title">Averages per claim</div>
                <div className="panel-sub">{s.compared} claims where both engines answered · list prices</div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={clear} disabled={!!progress}>Clear results</button>
            </div>
            <div className="table-wrap">
              <table className="table">
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
                  {s.jev.tested > 0 && (
                    <tr><td>Matched expected outcome</td><td className="num">{s.jev.matched} of {s.jev.tested}</td><td className="num">{s.llm.matched} of {s.llm.tested}</td><td /></tr>
                  )}
                  {(s.jev.failed > 0 || s.llm.failed > 0) && (
                    <tr><td>Errors</td><td className="num">{s.jev.failed}</td><td className="num">{s.llm.failed}</td><td /></tr>
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
