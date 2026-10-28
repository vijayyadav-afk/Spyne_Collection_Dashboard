// Shared manual remarks and expected dates for the Collection Pending dashboard.
// Stored in an Upstash Redis hash (set up from the Vercel Marketplace, which adds the REST url and token as
// environment variables). Everyone signed in with the company Google account can read, add and change values;
// only OWNER can delete (clear a value, import a file, clear everything).
import { cookieEmail, verifyGoogleToken, getJwks, GOOGLE_CLIENT_ID, ALLOWED_DOMAIN } from './_sess.js';
export const config = { runtime: 'edge' };

const OWNER = 'vijay.yadav@spyne.ai';
const HASH = 'spyne:pending:remarks';
const ALLOWED = ['Invoice Write Off', 'Need To Send Legal', 'Payment Will Receive', 'Invoice Need To Be Change'];

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' },
  });
}
const env = (k) => (typeof process !== 'undefined' && process.env && process.env[k]) || '';
// Variable names depend on the prefix chosen when the database was connected, so find them by their ending.
const findEnv = (re) => {
  const e = (typeof process !== 'undefined' && process.env) || {};
  const k = Object.keys(e).find((n) => re.test(n) && e[n]);
  return k ? e[k] : '';
};
const URL_ = () => findEnv(/(KV_REST_API_URL|REDIS_REST_URL)$/);
const TOKEN = () => findEnv(/(KV_REST_API_TOKEN|REDIS_REST_TOKEN)$/);

async function redis(cmds) {
  const r = await fetch(URL_().replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN(), 'content-type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('store ' + r.status);
  const out = await r.json();
  out.forEach((o) => { if (o && o.error) throw new Error(o.error); });
  return out.map((o) => o.result);
}
async function readAll() {
  const [arr] = await redis([['HGETALL', HASH]]);
  const notes = {};
  for (let i = 0; i + 1 < (arr || []).length; i += 2) {
    try { notes[arr[i]] = JSON.parse(arr[i + 1]).v; } catch (e) { notes[arr[i]] = arr[i + 1]; }
  }
  return notes;
}


// ---- one-time import of invoice remarks and expected dates from the team's remarks sheet (matched by invoice number) ----
const IMPORT_FLAG = 'META::import-invoice-sheet-v1';
const REMARKS_SHEET = 'https://docs.google.com/spreadsheets/d/1r9AU3T3nJomNiLEC3_jOOYP52lepXYfXZ5Ax7szQAx4/export?format=csv&gid=0';
const PENDING_SHEET = 'https://docs.google.com/spreadsheets/d/10A5kLP9hWZeMaRNbLsplLj43U0YljsreS_c0qDlgfK8/gviz/tq?tqx=out:csv&gid=0&tq='
  + encodeURIComponent('select A,C,D,E,F,G,H,K,M,N,Z,AC,AD,AE,AF,AG,AH,AI,AJ,AM,AN');
const DUMMY = new Set(['asdf', 'na', 'asdfasdf', '#1 vincue']);
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
const cln = (v) => { const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return s === '#N/A' ? '' : s; };
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y, m, d) => y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
function toDate(s) {
  s = cln(s);
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return iso(m[3], +m[2], +m[1]);
  m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (m && MON[m[2].toLowerCase()]) return iso(m[3], MON[m[2].toLowerCase()], +m[1]);
  return '';
}
async function importFromSheet(email) {
  const [claimed] = await redis([['HSETNX', HASH, IMPORT_FLAG, JSON.stringify({ v: new Date().toISOString().slice(0, 10), by: 'sheet-import' })]]);
  if (!claimed) return; // already done (or running) elsewhere
  try {
    const [pr, rr] = await Promise.all([fetch(PENDING_SHEET, { cache: 'no-store' }), fetch(REMARKS_SHEET, { cache: 'no-store' })]);
    if (!pr.ok || !rr.ok) throw new Error('sheets ' + pr.status + '/' + rr.status);
    const pg = csvParse(await pr.text()), rg = csvParse(await rr.text());
    const ph = pg[0].map((c) => cln(c).toLowerCase());
    const iInv = ph.findIndex((c) => ['invoice_number', 'invoice number', 'invoice no', 'invoice no.'].includes(c));
    const iCus = ph.findIndex((c) => ['customer_name', 'customer name', 'customer'].includes(c));
    if (iInv < 0 || iCus < 0) throw new Error('pending columns not found');
    const byInv = new Map();
    for (let i = 1; i < pg.length; i++) {
      const inv = cln(pg[i][iInv]), cus = cln(pg[i][iCus]);
      if (!inv || !cus || DUMMY.has(cus.toLowerCase())) continue;
      let s = byInv.get(inv); if (!s) byInv.set(inv, s = new Set()); s.add(cus);
    }
    let hi = -1;
    for (let i = 0; i < Math.min(rg.length, 10); i++) {
      const low = rg[i].map((c) => cln(c).toLowerCase());
      if (low.includes('invoice') && low.includes('manual remark')) { hi = i; break; }
    }
    if (hi < 0) throw new Error('remarks header not found');
    const low = rg[hi].map((c) => cln(c).toLowerCase());
    const iI = low.indexOf('invoice'), iR = low.indexOf('manual remark'), iD = low.indexOf('expected date');
    const now = new Date().toISOString(), args = [];
    for (let i = hi + 1; i < rg.length; i++) {
      const inv = cln(rg[i][iI] || ''); if (!inv) continue;
      const custs = byInv.get(inv); if (!custs) continue;
      const rem = cln(rg[i][iR] || ''), dt = iD > -1 ? toDate(rg[i][iD] || '') : '';
      custs.forEach((c) => {
        if (ALLOWED.includes(rem)) args.push('INV::' + inv + '|' + c, JSON.stringify({ v: rem, by: 'sheet-import', at: now }));
        if (dt) args.push('EXP::INV::' + inv + '|' + c, JSON.stringify({ v: dt, by: 'sheet-import', at: now }));
      });
    }
    if (args.length) await redis([['HSET', HASH, ...args]]);
  } catch (e) {
    await redis([['HDEL', HASH, IMPORT_FLAG]]).catch(() => {}); // let the next visit try again
  }
}
async function who(request) {
  const c = await cookieEmail(request);
  if (c) return c.toLowerCase();
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  if (!m) return null;
  try {
    const v = await verifyGoogleToken(m[1], await getJwks(), { clientId: GOOGLE_CLIENT_ID, domain: ALLOWED_DOMAIN });
    return v.ok ? v.email.toLowerCase() : null;
  } catch (e) { return null; }
}

export default async function handler(request) {
  if (!URL_() || !TOKEN()) return json(501, { error: 'storage_not_configured' });
  const email = await who(request);
  if (!email) return json(401, { error: 'unauthorized' });
  const owner = email === OWNER;
  try {
    if (request.method === 'GET') {
      let notes = await readAll();
      if (!notes[IMPORT_FLAG]) {
        try { await importFromSheet(email); notes = await readAll(); } catch (e) { /* never block reading the remarks */ }
      }
      return json(200, { notes, owner });
    }
    if (request.method !== 'POST') return json(405, { error: 'method' });
    let body;
    try { body = await request.json(); } catch (e) { return json(400, { error: 'bad_json' }); }
    const cmds = [];
    const now = new Date().toISOString();
    if (body.clearAll) {
      if (!owner) return json(403, { error: 'owner_only' });
      cmds.push(['DEL', HASH]);
      cmds.push(['HSET', HASH, IMPORT_FLAG, JSON.stringify({ v: now.slice(0, 10), by: 'clear-all' })]); // clearing must not trigger the one-time sheet import again
    }
    const set = body.set && typeof body.set === 'object' ? Object.entries(body.set).slice(0, 2000) : [];
    const dels = Array.isArray(body.del) ? body.del.slice(0, 2000) : [];
    if (dels.length) {
      if (!owner) return json(403, { error: 'owner_only' });
      cmds.push(['HDEL', HASH, ...dels.map(String)]);
    }
    const args = [];
    for (const [k, raw] of set) {
      const v = String(raw == null ? '' : raw).slice(0, 300);
      if (!k || String(k).length > 400) continue;
      if (!v) {
        if (!owner) continue;
        cmds.push(['HDEL', HASH, String(k)]);
        continue;
      }
      if (!owner) {
        const isDate = String(k).startsWith('EXP::');
        if (isDate ? !/^\d{4}-\d{2}-\d{2}$/.test(v) : !ALLOWED.includes(v)) continue;
      }
      args.push(String(k), JSON.stringify({ v, by: email, at: now }));
    }
    if (args.length) cmds.push(['HSET', HASH, ...args]);
    if (cmds.length) await redis(cmds);
    return json(200, { ok: true, notes: await readAll() });
  } catch (e) {
    return json(502, { error: 'store_unavailable', message: String((e && e.message) || e) });
  }
}
