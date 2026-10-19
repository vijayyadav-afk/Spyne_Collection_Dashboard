// Shared helpers for the 30-day login cookie (files starting with "_" are not public routes).
// After one Google sign-in, /api/session sets a signed, HttpOnly cookie so the dashboards keep working
// without signing in again. The signing key is the SESSION_SECRET environment variable (Vercel settings);
// when it is missing the cookie is simply not used and the dashboards fall back to the Google token.
export const GOOGLE_CLIENT_ID = '706399438904-1ijn6ih2tq6svot6iguosob7nf68no5o.apps.googleusercontent.com';
export const ALLOWED_DOMAIN = 'spyne.ai';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const NAME = 'spyne_sess';
const DAYS = 400;

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
export async function verifyGoogleToken(token, jwks, opts) {
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
export async function getJwks() {
  if (jwksCache.v && Date.now() - jwksCache.t < 3600000) return jwksCache.v;
  const r = await fetch(JWKS_URL);
  if (!r.ok) throw new Error('jwks ' + r.status);
  jwksCache = { t: Date.now(), v: await r.json() };
  return jwksCache.v;
}

const enc = new TextEncoder();
function toB64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmacKey() {
  const s = (typeof process !== 'undefined' && process.env && process.env.SESSION_SECRET) || '';
  if (s.length < 32) return null;
  return crypto.subtle.importKey('raw', enc.encode(s), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function sessionEnabled() { return !!(await hmacKey()); }

// Set-Cookie value for a signed session, or null when no secret is configured.
export async function makeCookie(email) {
  const key = await hmacKey();
  if (!key) return null;
  const body = toB64url(enc.encode(JSON.stringify({ e: email, x: Math.floor(Date.now() / 1000) + DAYS * 86400 })));
  const sig = toB64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body))));
  return NAME + '=' + body + '.' + sig + '; Max-Age=' + DAYS * 86400 + '; Path=/; HttpOnly; Secure; SameSite=Lax';
}
export function clearCookie() { return NAME + '=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax'; }

// Email of a valid, unexpired session cookie on the request, else null.
export async function cookieEmail(request) {
  try {
    const key = await hmacKey();
    if (!key) return null;
    const m = new RegExp('(?:^|;\s*)' + NAME + '=([^;]+)').exec(request.headers.get('cookie') || '');
    if (!m) return null;
    const [body, sig] = m[1].split('.');
    if (!body || !sig) return null;
    const ok = await crypto.subtle.verify('HMAC', key, b64urlToBytes(sig), enc.encode(body));
    if (!ok) return null;
    const p = b64urlToJson(body);
    if (!p.x || p.x < Date.now() / 1000) return null;
    return String(p.e || '').toLowerCase().endsWith('@' + ALLOWED_DOMAIN) ? p.e : null;
  } catch (e) { return null; }
}

// ---- who has signed in (kept in the same Redis store as the shared remarks) ----
const findEnv = (re) => {
  const e = (typeof process !== 'undefined' && process.env) || {};
  const k = Object.keys(e).find((n) => re.test(n) && e[n]);
  return k ? e[k] : '';
};
export async function logUser(email, isLogin) {
  try {
    const url = findEnv(/(KV_REST_API_URL|REDIS_REST_URL)$/), tok = findEnv(/(KV_REST_API_TOKEN|REDIS_REST_TOKEN)$/);
    if (!url || !tok || !email) return;
    const now = new Date().toISOString(), em = String(email).toLowerCase();
    const cmds = [['HSETNX', 'spyne:users:first', em, now], ['HSET', 'spyne:users:last', em, now]];
    if (isLogin) cmds.push(['HINCRBY', 'spyne:users:logins', em, 1]);
    await fetch(url.replace(/\/$/, '') + '/pipeline', {
      method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: JSON.stringify(cmds),
    });
  } catch (e) { /* the log must never block a sign-in */ }
}
export async function readUsers() {
  const url = findEnv(/(KV_REST_API_URL|REDIS_REST_URL)$/), tok = findEnv(/(KV_REST_API_TOKEN|REDIS_REST_TOKEN)$/);
  if (!url || !tok) return null;
  const r = await fetch(url.replace(/\/$/, '') + '/pipeline', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'content-type': 'application/json' },
    body: JSON.stringify([['HGETALL', 'spyne:users:first'], ['HGETALL', 'spyne:users:last'], ['HGETALL', 'spyne:users:logins']]),
  });
  const out = await r.json();
  const toMap = (a) => { const m = {}; for (let i = 0; i + 1 < (a || []).length; i += 2) m[a[i]] = a[i + 1]; return m; };
  const first = toMap(out[0].result), last = toMap(out[1].result), logins = toMap(out[2].result);
  return Object.keys(first).map((e) => ({ email: e, first_seen: first[e], last_seen: last[e] || first[e], sign_ins: +(logins[e] || 0) }))
    .sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));
}
