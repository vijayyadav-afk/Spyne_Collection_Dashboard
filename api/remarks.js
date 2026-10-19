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
const URL_ = () => env('UPSTASH_REDIS_REST_URL') || env('KV_REST_API_URL');
const TOKEN = () => env('UPSTASH_REDIS_REST_TOKEN') || env('KV_REST_API_TOKEN');

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
    if (request.method === 'GET') return json(200, { notes: await readAll(), owner });
    if (request.method !== 'POST') return json(405, { error: 'method' });
    let body;
    try { body = await request.json(); } catch (e) { return json(400, { error: 'bad_json' }); }
    const cmds = [];
    const now = new Date().toISOString();
    if (body.clearAll) {
      if (!owner) return json(403, { error: 'owner_only' });
      cmds.push(['DEL', HASH]);
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
