/**
 * http -> https upgrade for deployments where TLS terminates at a proxy.
 *
 * Extracted from server.js so it can be exercised directly: booting the real
 * server needs a database, but this rule does not, and a mis-wired redirect is
 * exactly the kind of bug that only shows up once the app is public.
 *
 * Why two status codes: 301 rewrites a POST into a GET and drops the body, so
 * a login attempt arriving over http would fail with a confusing 405 instead of
 * just working over https. 308 re-issues the identical request.
 */
export function forceHttps({ trustProxy } = {}) {
  // Plain HTTP with no proxy in front (dev laptop, docker network) means req.secure
  // is never true, so only trust X-Forwarded-Proto when a proxy is expected.
  if (!trustProxy) {
    throw new Error(
      '[https] FORCE_HTTPS is set but TRUST_PROXY is not - the redirect would loop forever, ' +
        'because the app cannot see that TLS already terminated upstream. Set TRUST_PROXY=1 ' +
        '(implied by NODE_ENV=production) or unset FORCE_HTTPS.'
    );
  }

  // The container health check curls plain http://127.0.0.1:PORT/api/health, and
  // Socket.IO transport upgrades must not be bounced mid-handshake.
  const EXEMPT = /^\/(api\/health|socket\.io)/;

  return (req, res, next) => {
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') return next();
    if (EXEMPT.test(req.path)) return next();
    const host = req.headers.host;
    if (!host) return next();
    const status = req.method === 'GET' || req.method === 'HEAD' ? 301 : 308;
    return res.redirect(status, `https://${host}${req.originalUrl}`);
  };
}

export default forceHttps;
