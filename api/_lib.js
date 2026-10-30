'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOLDOWN_MS = 4 * 3600 * 1000;
const NINE_DAYS_MS = 9 * 24 * 3600 * 1000;
const POW_BITS_HEX = 4;
const MIN_AGE_MS = 3000;
const MAX_AGE_MS = 10 * 60 * 1000;
const CHOICES = ['messi', 'ronaldo'];

// On Vercel / serverless, filesystem is read-only except /tmp
const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const DATA_FILE = isServerless ? path.join('/tmp', 'data.json') : path.join(__dirname, '..', 'data.json');
const SECRET_FILE = isServerless ? path.join('/tmp', '.secret') : path.join(__dirname, '..', '.secret');

// Secret handling: consistent across all serverless containers and nodes
const secret = process.env.SECRET || 'touchline-goat-referendum-secure-vault-2026-sagnikdhar2018-production';
const hmac = s => crypto.createHmac('sha256', secret).update(s).digest('hex');

// Cryptographically salted cloud persistent counter keys (untamperable from outside)
const cloudNs = 'goat-referendum-' + hmac('namespace_seed_2026_prod').slice(0, 16);
const cloudKeyMessi = 'm_' + hmac('messi_v2_prod').slice(0, 12);
const cloudKeyRonaldo = 'r_' + hmac('ronaldo_v2_prod').slice(0, 12);

async function cloudIncr(choice) {
  const key = choice === 'messi' ? cloudKeyMessi : cloudKeyRonaldo;
  try {
    const res = await fetch(`https://abacus.jasoncameron.dev/hit/${cloudNs}/${key}`, {
      signal: AbortSignal.timeout(4000)
    });
    if (res.ok) {
      const data = await res.json();
      if (typeof data.value === 'number') return data.value;
    }
  } catch (_) {}
  return null;
}

async function cloudGet() {
  try {
    const [resM, resR] = await Promise.all([
      fetch(`https://abacus.jasoncameron.dev/get/${cloudNs}/${cloudKeyMessi}`, { signal: AbortSignal.timeout(4000) }),
      fetch(`https://abacus.jasoncameron.dev/get/${cloudNs}/${cloudKeyRonaldo}`, { signal: AbortSignal.timeout(4000) })
    ]);
    const [dM, dR] = await Promise.all([resM.json(), resR.json()]);
    const messi = typeof dM.value === 'number' ? dM.value : 0;
    const ronaldo = typeof dR.value === 'number' ? dR.value : 0;
    return { messi, ronaldo };
  } catch (_) {
    return { messi: 0, ronaldo: 0 };
  }
}

// Persistence Layer (Filesystem fallback)
let db = { counts: { messi: 0, ronaldo: 0 }, voters: {}, recentBallots: [], deadlineMs: Date.now() + NINE_DAYS_MS };

function loadDb() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (parsed && parsed.counts) {
        db.counts.messi = Math.max(db.counts.messi, Number(parsed.counts.messi) || 0);
        db.counts.ronaldo = Math.max(db.counts.ronaldo, Number(parsed.counts.ronaldo) || 0);
        if (parsed.voters) Object.assign(db.voters, parsed.voters);
        if (Array.isArray(parsed.recentBallots)) db.recentBallots = parsed.recentBallots;
        if (parsed.deadlineMs) db.deadlineMs = parsed.deadlineMs;
      }
    }
  } catch (_) {}
  if (!db.deadlineMs) db.deadlineMs = Date.now() + NINE_DAYS_MS;
  if (!Array.isArray(db.recentBallots)) db.recentBallots = [];
  return db;
}
loadDb();

function saveDb() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db));
  } catch (_) {}
}

function getDb() {
  return loadDb();
}

function recordBallot(choice, proof) {
  const ballot = {
    choice,
    proof: String(proof).slice(0, 12),
    timestamp: Date.now()
  };
  db.recentBallots = [ballot, ...(db.recentBallots || [])].slice(0, 15);
  saveDb();
  return ballot;
}

// Vercel KV / Upstash Redis global persistent storage (zero-config if enabled in Vercel dashboard)
const kvUrl = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').trim();
const kvToken = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const hasKV = Boolean(kvUrl && kvToken);

async function kvIncr(choice) {
  if (!hasKV) return null;
  try {
    const res = await fetch(`${kvUrl.replace(/\/+$/, '')}/incr/goat:votes:${choice}`, {
      headers: { Authorization: `Bearer ${kvToken}` }
    });
    if (res.ok) {
      const data = await res.json();
      return typeof data.result === 'number' ? data.result : null;
    }
  } catch (_) {}
  return null;
}

async function kvSetVoter(ipKey) {
  if (!hasKV) return;
  try {
    // 4 hour cooldown = 14400 seconds
    await fetch(`${kvUrl.replace(/\/+$/, '')}/setex/goat:voters:${ipKey}/14400/1`, {
      headers: { Authorization: `Bearer ${kvToken}` }
    });
  } catch (_) {}
}

async function getStateAsync(ipKey) {
  if (hasKV) {
    try {
      const base = kvUrl.replace(/\/+$/, '');
      const headers = { Authorization: `Bearer ${kvToken}` };
      const [mRes, rRes, vRes] = await Promise.all([
        fetch(`${base}/get/goat:votes:messi`, { headers }),
        fetch(`${base}/get/goat:votes:ronaldo`, { headers }),
        fetch(`${base}/ttl/goat:voters:${ipKey}`, { headers })
      ]);
      const [mData, rData, vData] = await Promise.all([mRes.json(), rRes.json(), vRes.json()]);
      const m = Math.max(db.counts.messi, +(mData?.result || 0));
      const r = Math.max(db.counts.ronaldo, +(rData?.result || 0));
      const ttl = +(vData?.result || 0);
      const cooldownMs = ttl > 0 ? ttl * 1000 : 0;
      return { messi: m, ronaldo: r, cooldownMs, deadlineMs: db.deadlineMs, recentBallots: db.recentBallots || [] };
    } catch (_) {}
  }

  loadDb();
  const cloud = await cloudGet();
  db.counts.messi = Math.max(db.counts.messi, cloud.messi);
  db.counts.ronaldo = Math.max(db.counts.ronaldo, cloud.ronaldo);

  const last = db.voters[ipKey];
  const left = last ? Math.max(0, COOLDOWN_MS - (Date.now() - last)) : 0;
  return { ...db.counts, cooldownMs: left, deadlineMs: db.deadlineMs, recentBallots: db.recentBallots || [] };
}

// IP normalization
function normIP(ip) {
  ip = (ip || '').split('%')[0].replace(/^::ffff:/i, '');
  if (!ip.includes(':')) return ip;
  const [a, b] = ip.split('::');
  const L = a ? a.split(':') : [], R = b ? b.split(':') : [];
  if (b !== undefined) while (L.length + R.length < 8) R.unshift('0');
  return [...L, ...R].slice(0, 4).map(x => x.padStart(4, '0')).join(':') + '/64';
}

function getIP(req) {
  // On Vercel, x-forwarded-for or x-real-ip is standard
  const xff = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  let ip = xff.length ? xff[0] : (req.headers['x-real-ip'] || req.socket?.remoteAddress || '127.0.0.1');
  return normIP(ip);
}

// Rate limiting & bans
const buckets = new Map(), strikes = new Map(), bans = new Map(), usedTokens = new Map();

function allow(key, limit, windowMs) {
  const now = Date.now(), arr = (buckets.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= limit) { buckets.set(key, arr); return false; }
  arr.push(now); buckets.set(key, arr); return true;
}

function isBanned(ip) {
  return bans.has(ip) && bans.get(ip) > Date.now();
}

function strike(ip, n = 1) {
  const s = (strikes.get(ip) || 0) + n;
  strikes.set(ip, s);
  if (s >= 8) {
    bans.set(ip, Date.now() + 3600 * 1000);
    strikes.delete(ip);
  }
}

function makeToken(ipKey) {
  const p = `${crypto.randomBytes(8).toString('hex')}.${Date.now()}.${ipKey.slice(0, 16)}`;
  return `${p}.${hmac(p).slice(0, 32)}`;
}

function checkToken(token, nonce, ipKey) {
  if (typeof token !== 'string' || typeof nonce !== 'string' || nonce.length > 20) return 'bad token';
  const parts = token.split('.');
  if (parts.length !== 4) return 'bad token';
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

async function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (req.body && typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (_) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer'
};

function send(res, code, body) {
  res.writeHead(code, HEADERS);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function getState(ipKey) {
  const last = db.voters[ipKey];
  const left = last ? Math.max(0, COOLDOWN_MS - (Date.now() - last)) : 0;
  return { ...db.counts, cooldownMs: left, deadlineMs: db.deadlineMs };
}

module.exports = {
  COOLDOWN_MS,
  POW_BITS_HEX,
  MIN_AGE_MS,
  CHOICES,
  hmac,
  getDb,
  saveDb,
  normIP,
  getIP,
  isBanned,
  allow,
  strike,
  makeToken,
  checkToken,
  parseBody,
  send,
  getState,
  getStateAsync,
  cloudIncr,
  recordBallot,
  kvIncr,
  kvSetVoter
};
