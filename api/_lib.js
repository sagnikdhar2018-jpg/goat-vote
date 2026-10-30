'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TEN_DAYS_MS = 10 * 24 * 3600 * 1000;
const POW_BITS_HEX = 4;
const MIN_AGE_MS = 3000;
const MAX_AGE_MS = 10 * 60 * 1000;
const CHOICES = ['messi', 'ronaldo'];

// On Vercel / serverless, filesystem is read-only except /tmp
const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const DATA_FILE = isServerless ? path.join('/tmp', 'data.json') : path.join(__dirname, '..', 'data.json');

// Consistent HMAC secret across all nodes and serverless containers
const secret = process.env.SECRET || 'touchline-goat-referendum-secure-vault-2026-sagnikdhar2018-production';
const hmac = s => crypto.createHmac('sha256', secret).update(String(s || '')).digest('hex');

// Persistence Layer (Filesystem / Memory fallback)
let db = {
  counts: { messi: 0, ronaldo: 0 },
  voters: {},
  devices: {},
  recentBallots: [],
  deadlineMs: Date.now() + TEN_DAYS_MS
};

function loadDb() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (parsed && parsed.counts) {
        db.counts.messi = Math.max(db.counts.messi, Number(parsed.counts.messi) || 0);
        db.counts.ronaldo = Math.max(db.counts.ronaldo, Number(parsed.counts.ronaldo) || 0);
        if (parsed.voters) Object.assign(db.voters, parsed.voters);
        if (parsed.devices) Object.assign(db.devices, parsed.devices);
        if (Array.isArray(parsed.recentBallots)) db.recentBallots = parsed.recentBallots;
        if (parsed.deadlineMs) db.deadlineMs = parsed.deadlineMs;
      }
    }
  } catch (_) {}
  if (!db.deadlineMs) db.deadlineMs = Date.now() + TEN_DAYS_MS;
  if (!Array.isArray(db.recentBallots)) db.recentBallots = [];
  if (!db.devices) db.devices = {};
  if (!db.voters) db.voters = {};
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

// Global High-Speed Persistent Redis Layer (Upstash / Vercel KV)
const kvUrl = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || 'https://classic-calf-243852.upstash.io').trim();
const kvToken = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAA7iMAQIgcDE5NDJkZDA3M2VhODQ0MGY5OTI2MDBlMjdjNjIxMjk3NA').trim();
const hasKV = Boolean(kvUrl && kvToken);

// In-memory cache for instant <5ms responses
let cachedGlobalState = { messi: 0, ronaldo: 0, recentBallots: [] };
let lastGlobalFetch = 0;
let isRefreshingGlobal = false;

async function refreshGlobalState() {
  if (!hasKV || isRefreshingGlobal) return cachedGlobalState;
  isRefreshingGlobal = true;
  try {
    const base = kvUrl.replace(/\/+$/, '');
    const headers = { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' };
    const res = await fetch(`${base}/pipeline`, {
      method: 'POST',
      headers,
      body: JSON.stringify([
        ['GET', 'goat:votes:messi'],
        ['GET', 'goat:votes:ronaldo'],
        ['LRANGE', 'goat:ballots', '0', '9'],
        ['GET', 'goat:deadline']
      ]),
      signal: AbortSignal.timeout(2000)
    });

    if (res.ok) {
      const data = await res.json();
      const messi = +(data[0]?.result || 0);
      const ronaldo = +(data[1]?.result || 0);
      let ballots = [];
      if (Array.isArray(data[2]?.result)) {
        ballots = data[2].result.map(x => {
          try { return JSON.parse(x); } catch (_) { return null; }
        }).filter(Boolean);
      }
      const srvDeadline = +(data[3]?.result || 0);
      if (srvDeadline > 0) {
        db.deadlineMs = srvDeadline;
        saveDb();
      }
      cachedGlobalState = {
        messi: hasKV ? messi : Math.max(db.counts.messi, messi),
        ronaldo: hasKV ? ronaldo : Math.max(db.counts.ronaldo, ronaldo),
        recentBallots: ballots.length ? ballots : (db.recentBallots || [])
      };
      if (hasKV) {
        db.counts.messi = messi;
        db.counts.ronaldo = ronaldo;
        saveDb();
      }
      lastGlobalFetch = Date.now();
    }
  } catch (_) {}
  isRefreshingGlobal = false;
  return cachedGlobalState;
}

// Initial warm-up
refreshGlobalState().catch(() => {});

// STRICT ONE-VOTE LIFETIME CHECK
async function checkVoterStatusAsync(ipKey, deviceId) {
  loadDb();

  // 1. Fast local check
  if (ipKey && db.voters && db.voters[ipKey]) {
    const v = db.voters[ipKey];
    return { hasVoted: true, backedCandidate: typeof v === 'object' ? v.choice : v };
  }
  if (deviceId && db.devices && db.devices[deviceId]) {
    const d = db.devices[deviceId];
    return { hasVoted: true, backedCandidate: typeof d === 'object' ? d.choice : d };
  }

  // 2. Global persistent store check (Upstash Redis)
  if (hasKV) {
    try {
      const base = kvUrl.replace(/\/+$/, '');
      const headers = { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' };
      const pipeline = [];
      if (ipKey) pipeline.push(['GET', `goat:voters:${ipKey}`]);
      if (deviceId) pipeline.push(['GET', `goat:devices:${deviceId}`]);

      if (pipeline.length > 0) {
        const res = await fetch(`${base}/pipeline`, {
          method: 'POST',
          headers,
          body: JSON.stringify(pipeline),
          signal: AbortSignal.timeout(1800)
        });

        if (res.ok) {
          const results = await res.json();
          let choice = null;
          for (const item of results) {
            if (item?.result) {
              choice = item.result;
              break;
            }
          }
          if (choice) {
            // Cache locally in memory for instant subsequent lookups
            if (ipKey) db.voters[ipKey] = choice;
            if (deviceId) db.devices[deviceId] = choice;
            return { hasVoted: true, backedCandidate: choice };
          }
        }
      }
    } catch (_) {}
  }

  return { hasVoted: false, backedCandidate: null };
}

// ATOMIC PERMANENT VOTE RECORDING
async function recordVoteAsync(ipKey, deviceId, choice, nonce) {
  loadDb();
  if (!db.devices) db.devices = {};
  if (!db.voters) db.voters = {};

  if (ipKey) db.voters[ipKey] = choice;
  if (deviceId) db.devices[deviceId] = choice;
  db.counts[choice] = (db.counts[choice] || 0) + 1;

  const ballot = {
    choice,
    proof: nonce ? ('0000' + String(nonce).slice(0, 6)) : '000000',
    timestamp: Date.now()
  };
  db.recentBallots = [ballot, ...(db.recentBallots || [])].slice(0, 15);
  saveDb();

  // Instant local memory update
  cachedGlobalState[choice] = (cachedGlobalState[choice] || 0) + 1;
  cachedGlobalState.recentBallots = [ballot, ...(cachedGlobalState.recentBallots || [])].slice(0, 10);

  // Permanent atomic commit in Upstash Redis
  if (hasKV) {
    try {
      const base = kvUrl.replace(/\/+$/, '');
      const headers = { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' };
      const pipeline = [
        ['INCR', `goat:votes:${choice}`],
        ['LPUSH', 'goat:ballots', JSON.stringify(ballot)],
        ['LTRIM', 'goat:ballots', '0', '9']
      ];
      if (ipKey) pipeline.push(['SET', `goat:voters:${ipKey}`, choice]);
      if (deviceId) pipeline.push(['SET', `goat:devices:${deviceId}`, choice]);

      fetch(`${base}/pipeline`, {
        method: 'POST',
        headers,
        body: JSON.stringify(pipeline),
        signal: AbortSignal.timeout(2500)
      }).catch(() => {});
    } catch (_) {}
  }

  return ballot;
}

// STATE RESOLVER
async function getStateAsync(ipKey, deviceId) {
  loadDb();
  const now = Date.now();

  if (hasKV) {
    if (now - lastGlobalFetch > 2500) {
      if (lastGlobalFetch === 0) {
        await Promise.race([
          refreshGlobalState(),
          new Promise(r => setTimeout(r, 1200))
        ]);
      } else {
        refreshGlobalState().catch(() => {});
      }
    }
  }

  const voterStatus = await checkVoterStatusAsync(ipKey, deviceId);

  return {
    messi: hasKV ? (cachedGlobalState.messi !== undefined ? cachedGlobalState.messi : db.counts.messi) : (db.counts.messi || 0),
    ronaldo: hasKV ? (cachedGlobalState.ronaldo !== undefined ? cachedGlobalState.ronaldo : db.counts.ronaldo) : (db.counts.ronaldo || 0),
    hasVoted: voterStatus.hasVoted,
    backedCandidate: voterStatus.backedCandidate,
    deadlineMs: db.deadlineMs,
    recentBallots: (cachedGlobalState.recentBallots && cachedGlobalState.recentBallots.length)
      ? cachedGlobalState.recentBallots
      : (db.recentBallots || [])
  };
}

// IP NORMALIZATION & EXTRACTION
function normIP(ip) {
  ip = (ip || '').split('%')[0].replace(/^::ffff:/i, '');
  if (!ip.includes(':')) return ip;
  const [a, b] = ip.split('::');
  const L = a ? a.split(':') : [], R = b ? b.split(':') : [];
  if (b !== undefined) while (L.length + R.length < 8) R.unshift('0');
  return [...L, ...R].slice(0, 4).map(x => x.padStart(4, '0')).join(':') + '/64';
}

function getIP(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  let ip = xff.length ? xff[0] : (req.headers['x-real-ip'] || req.socket?.remoteAddress || '127.0.0.1');
  return normIP(ip);
}

// RATE LIMITING & SECURITY STRIKES
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

// CRYPTOGRAPHIC PROOF-OF-WORK TOKEN GENERATION & VERIFICATION
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

// BODY PARSER
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

module.exports = {
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
  getStateAsync,
  checkVoterStatusAsync,
  recordVoteAsync,
  refreshGlobalState,
  kvUrl,
  kvToken,
  hasKV,
  cachedGlobalState
};
