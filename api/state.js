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

  if (!lib.allow('g:' + ip, 120, 60e3)) {
    lib.strike(ip);
    return lib.send(res, 429, { error: 'Too many requests. Slow down.' });
  }

  const ipKey = lib.hmac(ip);
  let deviceId = null;
  try {
    const urlObj = new URL(req.url, 'http://localhost');
    deviceId = urlObj.searchParams.get('deviceId');
  } catch (_) {}
  if (!deviceId && req.headers) {
    deviceId = req.headers['x-device-id'] || null;
  }
  if (typeof deviceId === 'string') {
    deviceId = deviceId.trim().slice(0, 64);
  } else {
    deviceId = null;
  }

  const st = await lib.getStateAsync(ipKey, deviceId);
  return lib.send(res, 200, st);
};
