// Live data relay for the Collections dashboard (Vercel edge function).
// Only people signed in with a Google account on ALLOWED_DOMAIN get data: the request must carry
// a Google ID token, which is verified here (signature, audience, expiry, hosted domain).
// The sheet (tab gid 0, shared "anyone with the link") is then read, reduced to the columns the
// dashboard uses, and returned as compact JSON.
export const config = { runtime: 'edge' };

const SHEET_ID = '15CEMjqr2CEPu86ji0uEXCQ7K9qbgmOxPwzQdJ5pC1lg';
const SHEET_GID = '0';
const EPOCH = Date.UTC(2023, 0, 1);
const MS = 864e5;
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function csvParse(s) {
  const rows = [];
  let row = [], f = '', q = false, i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (q) {
      if (c === 34) {
        if (s.charCodeAt(i + 1) === 34) { f += '"'; i += 2; continue; }
        q = false; i++; continue;
      }
      f += s[i]; i++; continue;
    }
    if (c === 34) { q = true; i++; continue; }
    if (c === 44) { row.push(f); f = ''; i++; continue; }
    if (c === 10 || c === 13) {
      if (c === 13 && s.charCodeAt(i + 1) === 10) i++;
      row.push(f); f = ''; rows.push(row); row = []; i++; continue;
    }
    f += s[i]; i++;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

function num(v) {
  const x = parseFloat(String(v == null ? '' : v).replace(/[,\s]/g, ''));
  return isNaN(x) ? 0 : x;
}

function buildData(rows) {
  if (!rows.length) throw new Error('empty sheet');
  const header = rows[0].map((h) => String(h).trim());
  const col = (name) => {
    const k = header.indexOf(name);
    if (k < 0) throw new Error('missing column: ' + name);
    return k;
  };
  const cCust = col('Customer Name'), cDate = col('Date of Collection'), cInr = col('Collected Amount (INR)'),
    cOrig = col('Collected Amount'), cProd = col('Product'), cMode = col('Payment Mode'), cEnt = col('Entity'),
    cAm = col('Account Manager Name'), cAe = col('AE Name'), cDep = col('Deposit to'), cCur = col('Currency');
  const lists = { modes: [], cust: [], am: [], ae: [], dep: [], cur: [] };
  const maps = { modes: {}, cust: {}, am: {}, ae: {}, dep: {}, cur: {} };
  const ix = (k, v) => {
    const m = maps[k];
    if (m[v] === undefined) { m[v] = lists[k].length; lists[k].push(v); }
    return m[v];
  };
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const x = rows[r];
    const cust = (x[cCust] || '').trim();
    if (!cust) continue;
    const dm = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec((x[cDate] || '').trim());
    if (!dm) continue;
    const mon = MONTHS[dm[2].toLowerCase()];
    if (mon === undefined) continue;
    const day = Math.round((Date.UTC(+dm[3], mon, +dm[1]) - EPOCH) / MS);
    let mode = (x[cMode] || '').trim();
    if (/^check return$/i.test(mode)) mode = 'Bank Remittance - Check';
    let cur = (x[cCur] || '').trim();
    if (/^euro$/i.test(cur)) cur = 'EUR';
    let am = (x[cAm] || '').trim();
    if (am === '') am = '#N/A';
    out.push([
      day,
      /^vini$/i.test((x[cProd] || '').trim()) ? 1 : 0,
      ix('modes', mode),
      /^india$/i.test((x[cEnt] || '').trim()) ? 1 : 0,
      0,
      ix('cust', cust),
      Math.round(num(x[cInr])),
      ix('am', am),
      ix('ae', (x[cAe] || '').trim()),
      ix('dep', (x[cDep] || '').trim()),
      ix('cur', cur),
      Math.round(num(x[cOrig]) * 100) / 100,
    ]);
  }
  return { base: '2023-01-01', modes: lists.modes, cust: lists.cust, am: lists.am, ae: lists.ae, dep: lists.dep, cur: lists.cur, rows: out };
}

// ---- access control: Google sign-in limited to one company domain ----
const GOOGLE_CLIENT_ID = 'REPLACE_WITH_GOOGLE_CLIENT_ID';
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

// Built data is kept for 30 s inside the running isolate so one sheet read serves many viewers.
let dataCache = { t: 0, body: '' };

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
  try {
    if (!dataCache.body || Date.now() - dataCache.t > 30000) {
      const url = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/gviz/tq?tqx=out:csv&gid=' + SHEET_GID;
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error('sheet responded ' + r.status);
      dataCache = { t: Date.now(), body: JSON.stringify(buildData(csvParse(await r.text()))) };
    }
    return new Response(dataCache.body, {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' },
    });
  } catch (e) {
    return json(502, { error: 'sheet_unavailable', message: String((e && e.message) || e) });
  }
}