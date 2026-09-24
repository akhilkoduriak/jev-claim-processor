/**
 * Connection checks for the comparison page.
 *
 * The LLM check lists the models the key can use. That call is free, and it
 * catches every setup problem a real request would hit: no key, a rejected
 * key, a missing workspace ID, a model the key can't use, or no network.
 */
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const anthropicClient = require('./anthropic-client');
const openaiClient = require('./openai-client');

const CACHE_MS = 30 * 1000;
let cache = null; // { key, at, result }

const NAMES = { anthropic: 'Claude', openai: 'OpenAI' };
const KEY_VARS = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };
const MODEL_VARS = { anthropic: 'ANTHROPIC_MODEL', openai: 'OPENAI_MODEL' };
const KEY_PAGES = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys'
};

async function listModels(c, deps) {
  const ids = [];
  if (c.provider === 'openai') {
    const client = deps.openai || new OpenAI({ apiKey: c.apiKey, maxRetries: 0, timeout: 10_000 });
    for await (const m of client.models.list()) ids.push(m.id);
  } else {
    const client = deps.anthropic || new Anthropic({
      apiKey: c.apiKey,
      maxRetries: 0,
      timeout: 10_000,
      ...(c.workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': c.workspaceId } } : {})
    });
    for await (const m of client.models.list()) ids.push(m.id);
  }
  return ids;
}

/**
 * @param {object} c  LLM config from comparison.llmConfig()
 * @param {{force?: boolean, anthropic?: object, openai?: object}} options  `anthropic`/`openai` are test doubles
 * @returns {{provider, model, state, label, message, advice: string[], checkedAt}}
 *   state: connected | not_configured | auth_error | workspace_required | model_unavailable | rate_limited | unreachable | error
 */
async function checkLlm(c, options = {}) {
  const name = NAMES[c.provider] || c.provider;
  const keyVar = KEY_VARS[c.provider];
  const base = { provider: c.provider, model: c.model, checkedAt: new Date().toISOString() };
  const result = (state, label, message, advice = []) => ({ ...base, state, label, message, advice });

  if (!c.apiKey || /^your_/.test(c.apiKey)) {
    return result('not_configured', 'Not configured', `No ${name} API key is set.`, [
      `Create a key at ${KEY_PAGES[c.provider]}.`,
      `Paste it after ${keyVar}= in backend/.env and save. The app picks it up automatically.`
    ]);
  }

  const cacheKey = JSON.stringify([c.provider, c.apiKey, c.workspaceId, c.model]);
  if (!options.force && cache && cache.key === cacheKey && Date.now() - cache.at < CACHE_MS) return cache.result;

  let r;
  try {
    const ids = await listModels(c, options);
    if (ids.includes(c.model)) {
      r = result('connected', 'Connected', `${name} accepted the key, and ${c.model} is available.`);
    } else {
      const similar = ids.filter((id) => id.split('-')[0] === c.model.split('-')[0]).slice(0, 6);
      r = result('model_unavailable', 'Model not available', `The key works, but ${c.model} isn't one of the models it can use.`, [
        `Set ${MODEL_VARS[c.provider]}= in backend/.env to a model this key can use${similar.length ? `, for example: ${similar.join(', ')}` : ''}.`
      ]);
    }
  } catch (raw) {
    const err = c.provider === 'openai' ? openaiClient.toLlmError(raw) : anthropicClient.toLlmError(raw);
    if (c.provider === 'anthropic' && err.status === 400 && /workspace/i.test(err.message)) {
      r = result('workspace_required', 'Workspace ID needed', 'This API key isn\'t tied to a workspace, so every request must name one.', [
        'In the Anthropic Console, open Settings → Workspaces and copy the workspace ID (it starts with wrkspc_).',
        'Paste it after ANTHROPIC_WORKSPACE_ID= in backend/.env and save.',
        'Or create a new key inside a workspace and use that as ANTHROPIC_API_KEY instead.'
      ]);
    } else if (err.kind === 'auth') {
      r = result('auth_error', 'Key rejected', `${name} rejected the API key.`, [
        `Check that ${keyVar} in backend/.env is complete, with no spaces or quotes.`,
        `If it is, the key may have been revoked: create a new one at ${KEY_PAGES[c.provider]}.`
      ]);
    } else if (err.kind === 'rate_limit') {
      r = result('rate_limited', 'Rate limited', `${name} is rate-limiting this key right now.`, ['Wait a minute and check again.']);
    } else if (err.kind === 'network') {
      r = result('unreachable', 'Can\'t reach', `Could not reach ${name}: ${err.message}`, ['Check your internet connection, then check again.']);
    } else {
      r = result('error', 'Error', err.message, ['Check the settings in backend/.env, then check again.']);
    }
  }
  cache = { key: cacheKey, at: Date.now(), result: r };
  return r;
}

/** Jev's state for the comparison page, from the decision engine's last call. */
function jevStatus(engineStatus, configured) {
  const advice = {
    not_configured: ['Paste your Jev key after JEV_API_KEY= in backend/.env and save.'],
    disabled: ['Set USE_MOCK_JEV=false in backend/.env to let the app call Jev.'],
    error: [
      'If the key was rejected, check that JEV_API_URL and JEV_API_PATH match where the key came from (see "Which Jev endpoint to use" in the README).',
      'Then save backend/.env; the next comparison will retry.'
    ]
  };
  const labels = { connected: 'Connected', ready: 'Ready', error: 'Last call failed', not_configured: 'Not configured', disabled: 'Turned off' };
  // The comparison page calls Jev directly, so "turned off" for claims doesn't stop comparisons.
  const mode = engineStatus.mode === 'disabled' && configured ? 'ready' : engineStatus.mode;
  return {
    state: mode,
    label: labels[mode] || mode,
    message: mode === 'ready' ? 'Jev is configured. The next comparison will call it.' : engineStatus.message,
    advice: advice[mode] || []
  };
}

function clearCache() {
  cache = null;
}

module.exports = { checkLlm, jevStatus, clearCache };
