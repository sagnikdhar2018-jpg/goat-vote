'use strict';
// Zero-dependency vote server. Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || !!process.env.VERCEL;
const COOLDOWN_MS = 4 * 3600 * 1000;                 // 4 hour cooldown per IP
const NINE_DAYS_MS = 9 * 24 * 3600 * 1000;           // 9 day poll duration
const POW_BITS_HEX = 4;                              // proof-of-work difficulty (leading hex zeros)
const MIN_AGE_MS = 3000, MAX_AGE_MS = 10 * 60 * 1000;
const CHOICES = ['messi', 'ronaldo'];

// Filesystem safety: Vercel/Lambda filesystem is read-only except /tmp
const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const DATA_FILE = isServerless ? path.join('/tmp', 'data.json') : path.join(__dirname, 'data.json');
const SECRET_FILE = isServerless ? path.join('/tmp', '.secret') : path.join(__dirname, '.secret');

const secret = process.env.SECRET || 'touchline-goat-referendum-permanent-salt-v1-2026';
const hmac = s => crypto.createHmac('sha256', secret).update(s).digest('hex');

// ---------- persistence ----------
let db = { counts: { messi: 0, ronaldo: 0 }, voters: {}, deadlineMs: Date.now() + NINE_DAYS_MS };
try {
  if (fs.existsSync(DATA_FILE)) {
    db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  }
} catch (_) {}
if (!db.deadlineMs) { db.deadlineMs = Date.now() + NINE_DAYS_MS; }

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2), () => {});
    } catch (_) {}
  }, 500);
}

function gracefulShutdown() {
  clearTimeout(saveTimer);
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (_) {}
  process.exit(0);
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// ---------- IP handling ----------
function normIP(ip) {
  ip = (ip || '').split('%')[0].replace(/^::ffff:/i, '');
  if (!ip.includes(':')) return ip;
  const [a, b] = ip.split('::');
  const L = a ? a.split(':') : [], R = b ? b.split(':') : [];
  if (b !== undefined) while (L.length + R.length < 8) R.unshift('0');
  return [...L, ...R].slice(0, 4).map(x => x.padStart(4, '0')).join(':') + '/64';
}
function getIP(req) {
  let ip = req.socket?.remoteAddress || '127.0.0.1';
  if (TRUST_PROXY) {
    const xff = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (xff.length) ip = xff[xff.length - 1];
  }
  return normIP(ip);
}

// ---------- rate limiting / bans ----------
const buckets = new Map(), strikes = new Map(), bans = new Map(), usedTokens = new Map();
function allow(key, limit, windowMs) {
  const now = Date.now(), arr = (buckets.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= limit) { buckets.set(key, arr); return false; }
  arr.push(now); buckets.set(key, arr); return true;
}
function strike(ip, n = 1) {
  const s = (strikes.get(ip) || 0) + n; strikes.set(ip, s);
  if (s >= 8) { bans.set(ip, Date.now() + 3600 * 1000); strikes.delete(ip); }
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of bans) if (v < now) bans.delete(k);
  for (const [k, v] of usedTokens) if (v < now) usedTokens.delete(k);
  for (const [k, arr] of buckets) if (!arr.some(t => now - t < 3600e3)) buckets.delete(k);
  for (const [k, t] of Object.entries(db.voters)) if (now - t > COOLDOWN_MS) delete db.voters[k];
  save();
}, 5 * 60 * 1000).unref();

// ---------- helpers ----------
const BOT_UA = /bot|crawl|spider|curl|wget|python|requests|scrapy|httpclient|java\/|go-http|axios|node-fetch|undici|headless|phantom|selenium|puppeteer|playwright|postman/i;
const HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'; img-src 'self' https: data: blob:; font-src 'self' https: data:; connect-src 'self' https:; frame-ancestors 'none'"
};
function send(res, code, body, type = 'application/json', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...HEADERS, ...extra });
  res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
}
const state = ipKey => {
  const last = db.voters[ipKey], left = last ? Math.max(0, COOLDOWN_MS - (Date.now() - last)) : 0;
  return { ...db.counts, cooldownMs: left, deadlineMs: db.deadlineMs, recentBallots: db.recentBallots || [] };
};
function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (req.body && typeof req.body === 'string') {
    try { return Promise.resolve(JSON.parse(req.body)); } catch (_) { return Promise.resolve({}); }
  }
  return new Promise((ok, no) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 2048) { no(new Error('big')); req.destroy(); } });
    req.on('end', () => { try { ok(JSON.parse(d)); } catch (e) { no(e); } });
  });
}
function makeToken(ipKey) {
  const p = `${crypto.randomBytes(8).toString('hex')}.${Date.now()}.${ipKey.slice(0, 16)}`;
  return `${p}.${hmac(p).slice(0, 32)}`;
}
function checkToken(token, nonce, ipKey) {
  if (typeof token !== 'string' || typeof nonce !== 'string' || nonce.length > 20) return 'bad token';
  const parts = token.split('.'); if (parts.length !== 4) return 'bad token';
  const p = parts.slice(0, 3).join('.');
  const good = Buffer.from(hmac(p).slice(0, 32)), got = Buffer.from(parts[3]);
  if (good.length !== got.length || !crypto.timingSafeEqual(good, got)) return 'bad token';
  if (parts[2] !== ipKey.slice(0, 16)) return 'bad token';
  const age = Date.now() - +parts[1];
  if (age < MIN_AGE_MS) return 'too fast';
  if (age > MAX_AGE_MS) return 'expired';
  if (usedTokens.has(parts[0])) return 'reused';
  const h = crypto.createHash('sha256').update(`${token}:${nonce}`).digest('hex');
  if (!h.startsWith('0'.repeat(POW_BITS_HEX))) return 'bad proof';
  usedTokens.set(parts[0], Date.now() + MAX_AGE_MS + 1000);
  return null;
}

// ---------- hot-reload template cache ----------
let indexCache = null, indexCacheAt = 0;
function getIndex() {
  const now = Date.now();
  if (!indexCache || now - indexCacheAt > 5000) {
    const p1 = path.join(__dirname, 'index.html');
    const p2 = path.join(__dirname, 'public', 'index.html');
    const target = fs.existsSync(p1) ? p1 : p2;
    indexCache = fs.readFileSync(target, 'utf8');
    indexCacheAt = now;
  }
  return indexCache;
}

// Request handler for both standalone server and serverless export
async function handleRequest(req, res) {
  const ip = getIP(req), ipKey = hmac(ip);
  const url = req.url.split('?')[0];
  try {
    if (bans.has(ip) && bans.get(ip) > Date.now()) return send(res, 403, { error: 'Temporarily blocked for suspicious activity.' });
    if (!allow('g:' + ip, 90, 60e3)) { strike(ip); return send(res, 429, { error: 'Too many requests. Slow down.' }, undefined, { 'Retry-After': '60' }); }

    if (req.method === 'GET' && (url === '/' || url === '/index.html')) return send(res, 200, getIndex(), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url === '/api/state') return send(res, 200, state(ipKey));

    if (req.method === 'GET' && url === '/api/challenge') {
      if (!allow('c:' + ip, 10, 60e3)) return send(res, 429, { error: 'Too many challenges.' });
      return send(res, 200, { token: makeToken(ipKey), difficulty: POW_BITS_HEX, minAgeMs: MIN_AGE_MS });
    }

    if (req.method === 'POST' && url === '/api/vote') {
      if (Date.now() >= db.deadlineMs) return send(res, 400, { error: 'Referendum has concluded.' });
      if (!allow('v:' + ip, 6, 10 * 60e3)) { strike(ip); return send(res, 429, { error: 'Too many vote attempts. Try later.' }); }
      if (!allow('gv', 150, 60e3)) return send(res, 429, { error: 'Server is busy. Try again shortly.' });
      const ua = req.headers['user-agent'] || '', origin = req.headers.origin;
      if (!/^application\/json/.test(req.headers['content-type'] || '') || !ua || BOT_UA.test(ua))
        { strike(ip, 3); return send(res, 403, { error: 'Request rejected.' }); }
      const body = await readBody(req);
      if (body.website || body.official_ballot_fax_number) { strike(ip, 8); return send(res, 403, { error: 'Request rejected.' }); }
      const bad = checkToken(body.token, body.nonce, ipKey);
      if (bad) { strike(ip, 2); return send(res, 400, { error: 'Verification failed (' + bad + '). Please try again.' }); }
      if (!CHOICES.includes(body.choice)) return send(res, 400, { error: 'Invalid choice.' });
      const last = db.voters[ipKey];
      if (last && Date.now() - last < COOLDOWN_MS) return send(res, 429, { error: 'You already voted. Come back later.', ...state(ipKey) });
      db.voters[ipKey] = Date.now();
      db.counts[body.choice]++;
      db.recentBallots = [{ choice: body.choice, proof: body.nonce ? '0000' + String(body.nonce).slice(0, 6) : '000000', timestamp: Date.now() }, ...(db.recentBallots || [])].slice(0, 15);
      save();
      return send(res, 200, { ok: true, ...state(ipKey) });
    }
    send(res, 404, { error: 'Not found' });
  } catch { send(res, 400, { error: 'Bad request' }); }
}

if (!isServerless && require.main === module) {
  http.createServer(handleRequest).listen(PORT, () => console.log(`Vote server running on http://localhost:${PORT}`));
}

module.exports = handleRequest;
