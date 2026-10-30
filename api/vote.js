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
    return lib.send(res, 400, { error: 'The 10-day official referendum has concluded. Voting is permanently closed.' });
  }

  if (!lib.allow('v:' + ip, 10, 10 * 60e3)) {
    lib.strike(ip);
    return lib.send(res, 429, { error: 'Too many vote attempts. Try later.' });
  }

  if (!lib.allow('gv', 3000, 60e3)) {
    return lib.send(res, 429, { error: 'Server is receiving extraordinary traffic. Please try again in a few seconds.' });
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
  const deviceId = (typeof body.deviceId === 'string' && body.deviceId.length >= 8 && body.deviceId.length <= 64)
    ? body.deviceId.trim()
    : null;

  // STRICT LIFETIME RESTRICTION: One ballot per device / network forever
  const voterStatus = await lib.checkVoterStatusAsync(ipKey, deviceId);
  if (voterStatus.hasVoted) {
    return lib.send(res, 403, {
      error: 'Your chance ran out.',
      hasVoted: true,
      backedCandidate: voterStatus.backedCandidate
    });
  }

  // Cryptographic Proof-of-Work verification
  const bad = lib.checkToken(body.token, body.nonce, ipKey);
  if (bad) {
    lib.strike(ip, 2);
    return lib.send(res, 400, { error: 'Verification failed (' + bad + '). Please try again.' });
  }

  if (!lib.CHOICES.includes(body.choice)) {
    return lib.send(res, 400, { error: 'Invalid choice.' });
  }

  // Atomic permanent commit to ledger
  await lib.recordVoteAsync(ipKey, deviceId, body.choice, body.nonce);

  const finalSt = await lib.getStateAsync(ipKey, deviceId);
  return lib.send(res, 200, {
    ok: true,
    hasVoted: true,
    backedCandidate: body.choice,
    messi: finalSt.messi,
    ronaldo: finalSt.ronaldo,
    recentBallots: finalSt.recentBallots,
    deadlineMs: finalSt.deadlineMs
  });
};
