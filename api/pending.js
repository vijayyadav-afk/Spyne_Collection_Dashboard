// Protected relay for the Item Level Collection Pending dashboard (Vercel edge function).
// Only people signed in with a Google account on ALLOWED_DOMAIN get data: the request must carry
// a Google ID token, which is verified here. The sheet id and column list live only on the server,
// so the page no longer contains the sheet address.
// NOTE: the sign-in check below is a copy of the one in api/sheet.js; keep the two in step.
export const config = { runtime: 'edge' };

const SHEET_ID = '10A5kLP9hWZeMaRNbLsplLj43U0YljsreS_c0qDlgfK8';
const GID = '0';
const BASE = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID;
// The 20 columns the dashboard uses (positional); "full" is the whole-sheet fallback.
const COLS = 'select A,C,D,E,F,G,H,K,M,Z,AC,AD,AE,AF,AG,AH,AI,AJ,AM,AN';
const SOURCES = {
  data: BASE + '/gviz/tq?tqx=out:csv&gid=' + GID + '&tq=' + encodeURIComponent(COLS),
  full: BASE + '/export?format=csv&gid=' + GID,
  probe: BASE + '/gviz/tq?tqx=out:csv&gid=' + GID + '&tq=' + encodeURIComponent('select count(E), sum(AH)'),
};
// ---- access control: Google sign-in limited to one company domain ----
const GOOGLE_CLIENT_ID = '706399438904-1ijn6ih2tq6svot6iguosob7nf68no5o.apps.googleusercontent.com';
const ALLOWED_DOMAIN = 'spyne.ai';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

function b64urlToBytes(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToJson(s) { return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))); }

// Returns { ok: true, email } or { ok: false, reason }.
async function verifyGoogleToken(token, jwks, opts) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return { ok: false, reason: 'format' };
    const header = b64urlToJson(parts[0]);
    const payload = b64urlToJson(parts[1]);
    if (header.alg !== 'RS256') return { ok: false, reason: 'alg' };
    const jwk = ((jwks && jwks.keys) || []).find((k) => k.kid === header.kid);
    if (!jwk) return { ok: false, reason: 'key' };
    const key = await crypto.subtle.importKey(
      'jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const okSig = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]),
      new TextEncoder().encode(parts[0] + '.' + parts[1]));
    if (!okSig) return { ok: false, reason: 'signature' };
    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') return { ok: false, reason: 'issuer' };
    if (payload.aud !== opts.clientId) return { ok: false, reason: 'audience' };
    if (!payload.exp || payload.exp < now - 30) return { ok: false, reason: 'expired' };
    const email = String(payload.email || '').toLowerCase();
    if (payload.email_verified !== true && payload.email_verified !== 'true') return { ok: false, reason: 'unverified' };
    if (payload.hd !== opts.domain || !email.endsWith('@' + opts.domain)) return { ok: false, reason: 'domain' };
    return { ok: true, email };
  } catch (e) {
    return { ok: false, reason: 'error' };
  }
}

let jwksCache = { t: 0, v: null };
async function getJwks() {
  if (jwksCache.v && Date.now() - jwksCache.t < 3600000) return jwksCache.v;
  const r = await fetch(JWKS_URL);
  if (!r.ok) throw new Error('jwks ' + r.status);
  jwksCache = { t: Date.now(), v: await r.json() };
  return jwksCache.v;
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' },
  });
}

export default async function handler(request) {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  if (!m) return json(401, { error: 'unauthorized' });
  let v;
  try {
    v = await verifyGoogleToken(m[1], await getJwks(), { clientId: GOOGLE_CLIENT_ID, domain: ALLOWED_DOMAIN });
  } catch (e) {
    return json(503, { error: 'auth_unavailable' });
  }
  if (!v.ok) return json(v.reason === 'domain' || v.reason === 'unverified' ? 403 : 401, { error: v.reason === 'domain' || v.reason === 'unverified' ? 'domain' : 'unauthorized' });
  const kind = new URL(request.url).searchParams.get('kind') || 'data';
  const src = SOURCES[kind];
  if (!src) return json(400, { error: 'bad_kind' });
  try {
    const r = await fetch(src, { cache: 'no-store' });
    if (!r.ok) throw new Error('sheet responded ' + r.status);
    return new Response(r.body, {
      status: 200,
      headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' },
    });
  } catch (e) {
    return json(502, { error: 'sheet_unavailable', message: String((e && e.message) || e) });
  }
}