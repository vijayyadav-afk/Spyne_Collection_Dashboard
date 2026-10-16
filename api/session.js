// Login cookie endpoint. POST with a Google ID token (Bearer) -> verifies it and sets a 30-day signed cookie.
// GET -> 200 if the cookie is valid, else 401. DELETE -> clears the cookie.
import { GOOGLE_CLIENT_ID, ALLOWED_DOMAIN, verifyGoogleToken, getJwks, makeCookie, clearCookie, cookieEmail, sessionEnabled } from './_sess.js';
export const config = { runtime: 'edge' };

function json(status, obj, cookie) {
  const h = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' };
  if (cookie) h['set-cookie'] = cookie;
  return new Response(JSON.stringify(obj), { status, headers: h });
}

export default async function handler(request) {
  if (request.method === 'DELETE') return json(200, { session: false }, clearCookie());
  if (request.method === 'GET') {
    const e = await cookieEmail(request);
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
  if (!(await sessionEnabled())) return json(200, { session: false, email: v.email });
  return json(200, { session: true, email: v.email }, await makeCookie(v.email));
}
