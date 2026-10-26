const express = require('express');
const fs = require('fs');
const path = require('path');
const AutoModQuarantine = require('../../plugins/AutoModQuarantine.plugin.js');
const HOSTS = new Set(['opencode.ai', 'api.moonshot.ai', 'api.moonshot.cn', 'api.meta.ai', 'api.openai.com', 'api.x.ai', 'api.anthropic.com', 'generativelanguage.googleapis.com', 'openrouter.ai', 'api.mistral.ai', 'api.deepseek.com', 'api.groq.com']);
const HEADERS = ['authorization', 'x-api-key', 'x-goog-api-key', 'anthropic-version', 'anthropic-beta', 'x-opencode-session'];
const PROFILE = path.join(__dirname, '../../config/automod-local.json');
const DAY = 24 * 60 * 60 * 1000;
module.exports = function registerAutomodRelay({ app, getModUser, verifyToken, rateLimit, fetchImpl = (...a) => fetch(...a), profilePath = PROFILE, settings = null }) {
  const limiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: { error: 'Rate limit exceeded' } });
  const scanLimiter = rateLimit({ windowMs: 60 * 1000, max: 240, message: { error: 'Rate limit exceeded' } });
  const am = new AutoModQuarantine(), cache = new Map(), inflight = new Map(), queue = [], warned = new Set(), memo = { at: -1, p: null };
  const store = settings || (() => { const db = () => require('../database').getDb(); return { get: k => db().prepare('SELECT value FROM server_settings WHERE key = ?').get(k)?.value || '', set: (k, v) => db().prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)').run(k, v) }; })();
  let busy = false;
  const profile = () => { try { const at = fs.statSync(profilePath).mtimeMs; if (at !== memo.at) { const p = JSON.parse(fs.readFileSync(profilePath, 'utf8')); Object.assign(memo, { at, p: p?.recommendedModel && /^https?:$/.test(new URL(p.recommendedEndpoint || 'http://127.0.0.1:11434').protocol) ? p : null }); } return memo.p; } catch { return null; } };
  const origin = p => new URL(p.recommendedEndpoint || 'http://127.0.0.1:11434').origin;
  const member = req => { const t = req.headers.authorization?.split(' ')[1], u = t ? verifyToken(t) : null; return u && !u.purpose ? u : null; };
  const mod = req => { const a = getModUser(req, 'delete_message'); return a.error || a.user.purpose ? null : a; };
  const fresh = url => { const v = cache.get(url); return v && Date.now() - v.at < DAY ? v : null; };
  const remember = (url, v) => { cache.delete(url); cache.set(url, v); cache.size > 4000 && cache.delete(cache.keys().next().value); return v; };
  const ollama = (p, route, body, ms) => fetchImpl(`${origin(p)}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: p.recommendedModel, ...body }), signal: AbortSignal.timeout(ms) });
  const ask = async (p, url, context) => {
    am._settings.serverRules = store.get('automod_rules') || AutoModQuarantine.DEFAULT_SETTINGS.serverRules;
    const [system, user] = am._scanPrompts(url, context);
    const r = await ollama(p, '/api/chat', { stream: false, format: 'json', think: false, keep_alive: '2m', options: { temperature: 0, num_predict: 384 }, messages: [{ role: 'system', content: `${system}\nKeep "reason" under 25 words.` }, { role: 'user', content: user }] }, 120000);
    if (!r.ok) throw new Error(`Ollama status ${r.status}`);
    const v = JSON.parse(JSON.parse(await r.text()).message?.content || 'null');
    if (typeof v?.safe !== 'boolean') throw new Error('The model gave no verdict');
    return { safe: v.safe, reason: String(v.reason || (v.safe ? 'AI verified safe' : 'AI flagged security risk')).slice(0, 300), source: 'haven_ai' };
  };
  const drain = async () => {
    if (busy) return;
    busy = true;
    let p = null;
    while (queue.length) {
      const { url, context, done } = queue.shift();
      p = profile();
      try { done(p ? remember(url, { ...(await ask(p, url, context)), at: Date.now() }) : null); } catch { done(null); }
    }
    busy = false;
    p && p.unloadAfterQueue !== false && ollama(p, '/api/generate', { keep_alive: 0 }, 15000).catch(() => {});
  };
  const scan = (url, context = '') => fresh(url) || inflight.get(url) || (queue.length >= 77 ? Promise.resolve(null) : (() => {
    const pr = new Promise(done => queue.push({ url, context: String(context).slice(0, 500), done })).finally(() => inflight.delete(url));
    inflight.set(url, pr);
    drain();
    return pr;
  })());
  const sweep = content => {
    if (typeof content !== 'string' || !content.includes('.') || !profile()) return;
    for (const { url } of am.extractUrls(content).slice(0, 7)) { const t = am.checkSourceTrust(url); t.ok && !t.trusted && scan(url, content); }
  };
  app.get('/api/automod/local-status', limiter, async (req, res) => {
    if (!member(req)) return res.status(401).json({ error: 'Unauthorized' });
    const p = profile();
    let models = [];
    try { const r = p && await fetchImpl(`${origin(p)}/api/tags`, { signal: AbortSignal.timeout(1500) }); models = r?.ok ? (JSON.parse(await r.text()).models || []).map(m => m.name) : []; } catch {}
    const available = !!p && models.includes(p.recommendedModel);
    res.set('Cache-Control', 'no-store').json({ available, model: p?.recommendedModel || '', rules: store.get('automod_rules'), reason: available ? '' : !p ? 'Run scripts/setup-automod-ai.sh on the Haven server to set up local AI' : models.length ? `Model ${p.recommendedModel} is not installed in Ollama` : 'Ollama is not running on the Haven server' });
  });
  app.post('/api/automod/scan', scanLimiter, express.json({ limit: '8kb' }), async (req, res) => {
    if (!member(req)) return res.status(401).json({ error: 'Unauthorized' });
    if (!profile()) return res.status(404).json({ error: 'This Haven server has no local AI set up' });
    const { url, context = '' } = req.body || {};
    let u;
    try { u = new URL(String(url)); } catch { return res.status(400).json({ error: 'A valid url is required' }); }
    if (!/^https?:$/.test(u.protocol) || String(url).length > 2048) return res.status(400).json({ error: 'A valid url is required' });
    const known = fresh(u.href) || inflight.get(u.href);
    if (!known && !mod(req)) return res.status(202).json({ pending: true });
    const v = await (known || scan(u.href, context));
    v ? res.set('Cache-Control', 'no-store').json({ safe: v.safe, reason: v.reason, source: v.source }) : res.status(503).json({ error: 'The Haven server AI is busy or offline' });
  });
  app.post('/api/automod/claim-warn', limiter, express.json({ limit: '4kb' }), (req, res) => {
    if (!mod(req)) return res.status(403).json({ error: 'Insufficient permissions' });
    const key = String(req.body?.key || '').slice(0, 600), claimed = !!key && !warned.has(key);
    claimed && warned.add(key) && warned.size > 5000 && warned.delete(warned.values().next().value);
    res.json({ claimed });
  });
  app.put('/api/automod/rules', limiter, express.json({ limit: '8kb' }), (req, res) => {
    const a = mod(req);
    if (!a?.isAdmin) return res.status(403).json({ error: 'Only admins can change the AutoMod rules' });
    const rules = String(req.body?.rules || '').trim().slice(0, 2000);
    rules !== store.get('automod_rules') && (store.set('automod_rules', rules), cache.clear());
    res.json({ rules });
  });
  app.post('/api/automod/relay', limiter, express.json({ limit: '64kb' }), async (req, res) => {
    const auth = getModUser(req, 'delete_message');
    if (auth.error || auth.user.purpose) return res.status(auth.status || 401).json({ error: auth.error || 'Unauthorized' });
    const { url, headers = {}, body } = req.body || {};
    let u;
    try { u = new URL(String(url)); } catch { return res.status(400).json({ error: 'A valid https url is required' }); }
    if (u.protocol !== 'https:' || (u.port && u.port !== '443') || u.username || u.password || !HOSTS.has(u.hostname)) return res.status(400).json({ error: `Haven only relays to known AI hosts, and ${u.hostname} is not one` });
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'A JSON body is required' });
    const lower = Object.fromEntries(Object.entries(headers && typeof headers === 'object' ? headers : {}).map(([k, v]) => [String(k).toLowerCase(), v]));
    const out = Object.fromEntries([['content-type', 'application/json'], ...HEADERS.filter(k => typeof lower[k] === 'string' && lower[k].length < 4096).map(k => [k, lower[k]])]);
    try {
      const r = await fetchImpl(u.href, { method: 'POST', headers: out, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30000) });
      res.set('Cache-Control', 'no-store').json({ status: r.status, body: (await r.text()).slice(0, 262144) });
    } catch (e) {
      res.status(502).json({ error: `Relay failed: ${e.name === 'TimeoutError' ? 'the AI host timed out' : e.message}` });
    }
  });
  return { scan, sweep, attachSweep: io => io.on('connection', s => ['send-message', 'send-thread-message', 'edit-message'].forEach(ev => s.on(ev, d => { try { sweep(d?.content); } catch {} }))) };
};
