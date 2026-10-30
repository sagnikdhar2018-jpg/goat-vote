'use strict';
const lib = require('./_lib');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return lib.send(res, 405, { error: 'Method not allowed' });
  }

  const ip = lib.getIP(req);
  if (lib.isBanned(ip)) {
    return lib.send(res, 403, { error: 'Temporarily blocked for suspicious activity.' });
  }

  if (!lib.allow('c:' + ip, 10, 60e3)) {
    return lib.send(res, 429, { error: 'Too many challenges.' });
  }

  const ipKey = lib.hmac(ip);
  return lib.send(res, 200, {
    token: lib.makeToken(ipKey),
    difficulty: lib.POW_BITS_HEX,
    minAgeMs: lib.MIN_AGE_MS
  });
};
