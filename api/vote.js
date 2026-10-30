'use strict';
const lib = require('./_lib');

const BOT_UA = /bot|crawl|spider|curl|wget|python|requests|scrapy|httpclient|java\/|go-http|axios|node-fetch|undici|headless|phantom|selenium|puppeteer|playwright|postman/i;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return lib.send(res, 405, { error: 'Method not allowed' });
  }

  const ip = lib.getIP(req);
  if (lib.isBanned(ip)) {
    return lib.send(res, 403, { error: 'Temporarily blocked for suspicious activity.' });
  }

  const db = lib.getDb();
  if (Date.now() >= db.deadlineMs) {
    return lib.send(res, 400, { error: 'Referendum has concluded.' });
  }

  if (!lib.allow('v:' + ip, 6, 10 * 60e3)) {
    lib.strike(ip);
    return lib.send(res, 429, { error: 'Too many vote attempts. Try later.' });
  }

  if (!lib.allow('gv', 150, 60e3)) {
    return lib.send(res, 429, { error: 'Server is busy. Try again shortly.' });
  }

  const ua = req.headers['user-agent'] || '';
  if (!ua || BOT_UA.test(ua)) {
    lib.strike(ip, 3);
    return lib.send(res, 403, { error: 'Request rejected.' });
  }

  const body = await lib.parseBody(req);

  // Honeypot check
  if (body.website || body.official_ballot_fax_number) {
    lib.strike(ip, 8);
    return lib.send(res, 403, { error: 'Request rejected.' });
  }

  const ipKey = lib.hmac(ip);
  const bad = lib.checkToken(body.token, body.nonce, ipKey);
  if (bad) {
    lib.strike(ip, 2);
    return lib.send(res, 400, { error: 'Verification failed (' + bad + '). Please try again.' });
  }

  if (!lib.CHOICES.includes(body.choice)) {
    return lib.send(res, 400, { error: 'Invalid choice.' });
  }

  const last = db.voters[ipKey];
  if (last && Date.now() - last < lib.COOLDOWN_MS) {
    return lib.send(res, 429, { error: 'You already voted. Come back later.', ...lib.getState(ipKey) });
  }

  db.voters[ipKey] = Date.now();
  db.counts[body.choice]++;
  lib.saveDb();

  return lib.send(res, 200, { ok: true, ...lib.getState(ipKey) });
};
