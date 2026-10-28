// Login cookie endpoint. POST with a Google ID token (Bearer) -> verifies it and sets a long-lived signed cookie.
// GET -> 200 if the cookie (or the X-Session header fallback) is valid, else 401. DELETE -> clears the cookie.
import { GOOGLE_CLIENT_ID, ALLOWED_DOMAIN, verifyGoogleToken, getJwks, makeCookie, makeSessionValue, clearCookie, cookieEmail, sessionEnabled, logUser } from './_sess.js';
export const config = { runtime: 'edge' };

function json(status, obj, cookie) {
  const h = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' };
  if (cookie) h['set-cookie'] = cookie;
  return new Response(JSON.stringify(obj), { status, headers: h });
}

// The sign-in log is bookkeeping: do it after the response is sent when the platform allows, never make a page wait for it.
function later(context, promise) {
  if (context && typeof context.waitUntil === 'function') context.waitUntil(promise);
  return promise;
}

export default async function handler(request, context) {
  if (request.method === 'DELETE') return json(200, { session: false }, clearCookie());
  if (request.method === 'GET') {
    if (new URL(request.url).searchParams.get('diag') === '1') return json(200, { secretSet: await sessionEnabled() });
    const e = await cookieEmail(request);
    if (e) later(context, logUser(e, false));
    return e ? json(200, { session: true, email: e }) : json(401, { session: false });
  }
  if (request.method !== 'POST') return json(405, { error: 'method' });
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  if (!m) return json(401, { error: 'unauthorized' });
  let v;
  try {
    v = await verifyGoogleToken(m[1], await getJwks(), { clientId: GOOGLE_CLIENT_ID, domain: ALLOWED_DOMAIN });
  } catch (e) { return json(503, { error: 'auth_unavailable' }); }
  if (!v.ok) return json(v.reason === 'domain' || v.reason === 'unverified' ? 403 : 401, { error: 'unauthorized' });
  await logUser(v.email, true);
  if (!(await sessionEnabled())) return json(200, { session: false, email: v.email });
  return json(200, { session: true, email: v.email, token: await makeSessionValue(v.email) }, await makeCookie(v.email));
}
