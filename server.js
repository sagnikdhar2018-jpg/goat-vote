'use strict';
// Zero-dependency production vote server. Run: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const handleChallenge = require('./api/challenge');
const handleState = require('./api/state');
const handleVote = require('./api/vote');

const PORT = +process.env.PORT || 3000;

// Security headers
const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'; img-src 'self' https: data: blob:; font-src 'self' https: data:; connect-src 'self' https:; frame-ancestors 'none'"
};

function send(res, code, body, type = 'application/json', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...HEADERS, ...extra });
  res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
}

// Hot-reload template reader
let indexCache = null, indexCacheAt = 0;
function getIndex() {
  const now = Date.now();
  if (!indexCache || now - indexCacheAt > 1500) {
    const p1 = path.join(__dirname, 'index.html');
    const p2 = path.join(__dirname, 'public', 'index.html');
    const target = fs.existsSync(p1) ? p1 : p2;
    indexCache = fs.readFileSync(target, 'utf8');
    indexCacheAt = now;
  }
  return indexCache;
}

async function handleRequest(req, res) {
  const url = (req.url || '').split('?')[0];

  try {
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      return send(res, 200, getIndex(), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && url === '/api/state') {
      return handleState(req, res);
    }

    if (req.method === 'GET' && url === '/api/challenge') {
      return handleChallenge(req, res);
    }

    if (req.method === 'POST' && url === '/api/vote') {
      return handleVote(req, res);
    }

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    send(res, 500, { error: 'Internal server error' });
  }
}

if (require.main === module) {
  http.createServer(handleRequest).listen(PORT, () => {
    console.log(`Vote server running on http://localhost:${PORT}`);
  });
}

module.exports = handleRequest;
