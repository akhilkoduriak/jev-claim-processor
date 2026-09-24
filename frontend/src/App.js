import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import Dashboard from './components/Dashboard';
import ClaimForm from './components/ClaimForm';
import ClaimsList from './components/ClaimsList';
import Compare from './components/Compare';
import Icon from './components/Icon';
import { DECISION_LABELS } from './components/format';

// In development the API runs on its own port. A production build is served by the API itself.
const API_URL = process.env.REACT_APP_API_URL ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5000');
const API_LABEL = API_URL || window.location.origin;

const PAGES = {
  overview: { label: 'Overview', icon: 'grid', subtitle: 'Decision volume, outcomes and engine health' },
  submit: { label: 'New claim', icon: 'plus', subtitle: 'Submit a single claim or load a test dataset' },
  claims: { label: 'Claims', icon: 'list', subtitle: 'Every processed claim and the reasoning behind its decision' },
  compare: { label: 'Jev vs LLM', icon: 'bars', subtitle: 'Tokens, latency, cost and agreement for Jev and an LLM on the same claims' }
};

const pageFromHash = () => {
  const key = window.location.hash.replace('#/', '');
  return PAGES[key] ? key : 'overview';
};

function App() {
  const [page, setPageState] = useState(pageFromHash);

  const setPage = useCallback((key) => {
    window.location.hash = `/${key}`;
    setPageState(key);
  }, []);

  useEffect(() => {
    const onHash = () => setPageState(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const [decisions, setDecisions] = useState([]);
  const [engineStatus, setEngineStatus] = useState(null);
  const [connected, setConnected] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState(null); // { type: 'success' | 'error', text }

  const fetchData = useCallback(async () => {
    try {
      const [res, eng] = await Promise.all([
        axios.get(`${API_URL}/api/decisions`),
        axios.get(`${API_URL}/api/engine`)
      ]);
      setDecisions(res.data);
      setEngineStatus(eng.data);
      setConnected(true);
    } catch (err) {
      setConnected(false);
    }
  }, []);

  // Poll for new decisions every 2 seconds
  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 2000);
    return () => clearInterval(interval);
  }, [fetchData]);

  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const handleClaimSubmit = async (claim) => {
    setSubmitting(true);
    try {
      const res = await axios.post(`${API_URL}/api/claims/process`, claim);
      const d = res.data.decision;
      setNotice({ type: 'success', text: `Claim ${d.claimId} processed: ${DECISION_LABELS[d.decision]}.` });
      await fetchData();
      setPage('claims');
      return true;
    } catch (err) {
      setNotice({ type: 'error', text: err.response?.data?.error || 'The claim could not be processed.' });
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  const handleBulkLoaded = ({ name, loaded, failed, matched }) => {
    const matchText = `${matched} of ${loaded} got the expected outcome.`;
    setNotice(
      failed
        ? { type: 'error', text: `${name}: ${loaded} claims loaded, ${failed} failed. ${matchText} See the browser console for errors.` }
        : { type: matched === loaded ? 'success' : 'warning', text: `${name}: ${loaded} claims loaded. ${matchText}` }
    );
    fetchData();
    setPage('overview');
  };

  const handleReset = async () => {
    if (!window.confirm('Delete all processed claims and decisions? This cannot be undone.')) return;
    try {
      await axios.post(`${API_URL}/api/reset`);
      setDecisions([]);
      setNotice({ type: 'success', text: 'All claims and decisions were cleared.' });
    } catch (err) {
      setNotice({ type: 'error', text: 'Could not clear data.' });
    }
  };

  const ENGINE_CHIPS = {
    connected: { label: 'Jev connected', tone: 'success' },
    ready: { label: 'Jev ready', tone: 'neutral' },
    error: { label: 'Jev unavailable · using fallback rules', tone: 'danger' },
    not_configured: { label: 'Jev not configured · using fallback rules', tone: 'warning' },
    disabled: { label: 'Jev off · using fallback rules', tone: 'neutral' }
  };
  const engine = !connected
    ? { label: 'Server offline', tone: 'danger', message: `Cannot reach ${API_LABEL}` }
    : { ...(ENGINE_CHIPS[engineStatus?.mode] || { label: 'Checking engine…', tone: 'neutral' }), message: engineStatus?.message };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Icon name="shield" size={18} /></div>
          <div>
            <div className="brand-name">Claim Processor</div>
            <div className="brand-sub">Triage console</div>
          </div>
        </div>

        <div className="nav-label">Workspace</div>
        <nav className="nav">
          {Object.entries(PAGES).map(([key, p]) => (
            <button
              key={key}
              className={`nav-item ${page === key ? 'active' : ''}`}
              onClick={() => setPage(key)}
            >
              <Icon name={p.icon} />
              {p.label}
              {key === 'claims' && decisions.length > 0 && (
                <span className="nav-count">{decisions.length}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">Demo environment · synthetic claims only</div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <h1 className="page-title">{PAGES[page].label}</h1>
            <p className="page-sub">{PAGES[page].subtitle}</p>
          </div>
          <div className="topbar-actions">
            <span className={`status-chip tone-${engine.tone}`} title={engine.message}>
              <span className="status-dot" />
              {engine.label}
            </span>
            <button className="btn btn-secondary btn-sm" onClick={handleReset} disabled={decisions.length === 0}>
              <Icon name="trash" size={14} />
              Clear data
            </button>
          </div>
        </header>

        <main className="content">
          {!connected && (
            <div className="banner banner-error">
              <Icon name="alert" />
              Cannot reach the API server at {API_LABEL}. Start it with <code>npm run backend</code>.
            </div>
          )}
          {notice && (
            <div className={`banner banner-${notice.type}`}>
              <Icon name={notice.type === 'success' ? 'check' : 'alert'} />
              <span>
{notice.text}</span>
              <button className="banner-close" onClick={() => setNotice(null)} aria-label="Dismiss">
                <Icon name="x" size={14} />
              </button>
            </div>
          )}

          {connected && engineStatus && ['error', 'not_configured'].includes(engineStatus.mode) && page === 'overview' && (
            <div className="banner banner-warning">
              <Icon name="alert" />
              <span>
                <strong>Jev is not deciding claims.</strong> {engineStatus.message}
                {(engineStatus.lastErrorKind === 'auth' || engineStatus.mode === 'not_configured') && (
                  <span className="banner-fix">
                    <strong>To fix:</strong> get a key from{' '}
                    <a href="https://console.typesafe.ai/keys" target="_blank" rel="noreferrer">console.typesafe.ai/keys</a>,
                    paste it after <code>JEV_API_KEY=</code> in <code>backend/.env</code>, and save. The app picks it up
                    automatically; the next claim will show whether it works.
                  </span>
                )}
              </span>
            </div>
          )}

          {page === 'overview' && <Dashboard decisions={decisions} onNavigate={setPage} />}
          {page === 'submit' && (
            <ClaimForm
              onSubmit={handleClaimSubmit}
              onBulkLoaded={handleBulkLoaded}
              submitting={submitting}
              apiUrl={API_URL}
            />
          )}
          {page === 'claims' && <ClaimsList decisions={decisions} onNavigate={setPage} />}
          {page === 'compare' && <Compare apiUrl={API_URL} />}
        </main>
      </div>
    </div>
  );
}

export default App;
