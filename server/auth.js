import crypto from 'crypto';

const AUTH_SCHEME = 'Bearer ';

function timingSafeStringEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''));
  const expectedBuffer = Buffer.from(String(expected || ''));
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function requireLocalApiAuth(req, res, next) {
  if (req.path === '/api/health') return next();

  const token = process.env.LOCAL_API_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'LOCAL_API_TOKEN is required before using the API.' });
  }

  const header = String(req.get('authorization') || '');
  const provided = header.toLowerCase().startsWith(AUTH_SCHEME.toLowerCase())
    ? header.slice(AUTH_SCHEME.length)
    : '';

  if (!provided || !timingSafeStringEqual(provided, token)) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  return next();
}
