// Send Reminders (Friendly Reminder only): one consolidated email per customer listing every outstanding invoice,
// with each invoice PDF attached and a Pay Now link, sent from Gmail. Zoho Books supplies the PDFs and payment links.
//
//   GET  /api/reminders           -> { me, canSend, ready, rows: [...] }   any signed-in @spyne.ai user (read-only)
//   POST /api/reminders           -> { dry: true, items }                  preview only, nothing is sent
//   POST /api/reminders {confirm} -> { results }                           sends for real
//
// Only emails in REMINDER_SENDERS (comma list; OWNER is always allowed) may send.
// Environment (Vercel):
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORG_ID, ZOHO_DC (com|in|eu|com.au, default com)
//     scope: ZohoBooks.invoices.READ
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN  (refresh token of the sending mailbox, scope gmail.send)
//   GMAIL_SENDER (default finance@spyne.ai), GMAIL_FROM_NAME (default "Spyne Finance")
import { cookieEmail, verifyGoogleToken, getJwks, GOOGLE_CLIENT_ID, ALLOWED_DOMAIN } from './_sess.js';
export const config = { runtime: 'edge' };

const OWNER = 'vijay.yadav@spyne.ai';
const SHEET = 'https://docs.google.com/spreadsheets/d/1pY_hPKVa8A-d6kbCnsuRdns4CiuRTh1QaIJRf5-ppOI/gviz/tq?tqx=out:csv';
const LOG_HASH = 'spyne:reminders:log';
const BLOCK_DAYS = 3;      // a customer reminded within this many days needs an explicit "send again"
const MAX_CUSTOMERS = 10;  // per request, so one call stays inside the function time limit
const MAX_BYTES = 20 * 1024 * 1024; // Gmail's limit is 25 MB including encoding

// Sheet1 has blank headers on the money and date columns, so they are read by position (0 = column A).
// If the sheet layout changes this is the one place to fix; the page shows the parsed values so a wrong mapping is visible.
const COL = {
  entity: 0, ent: 1, customer: 2, status: 3, invoice: 5, invDate: 7, dueDate: 8, email: 9, country: 10, currency: 12,
  total: 13, balance: 14, csm: 22, csmEmail: 23, ccEmail: 24, spoc: 25, daysOver: 26, bucket: 27, invStatus: 30,
};
const IDX = [0, 1, 2, 3, 5, 7, 8, 9, 10, 12, 13, 14, 22, 23, 24, 25, 26, 27, 30];
const LETTERS = ['A', 'B', 'C', 'D', 'F', 'H', 'I', 'J', 'K', 'M', 'N', 'O', 'W', 'X', 'Y', 'Z', 'AA', 'AB', 'AE'];
const POS = Object.fromEntries(IDX.map((c, i) => [c, i]));

const env = (k) => (typeof process !== 'undefined' && process.env && process.env[k]) || '';
const findEnv = (re) => {
  const e = (typeof process !== 'undefined' && process.env) || {};
  const k = Object.keys(e).find((n) => re.test(n) && e[n]);
  return k ? e[k] : '';
};
function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' },
  });
}

// ---------- csv ----------
function csvParse(s) {
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const num = (s) => { const n = parseFloat(String(s || '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };
const emails = (s) => [...new Set(String(s || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[^@\s,<>"]+@[^@\s,<>"]+\.[^@\s,<>"]+$/.test(x)))];

async function sheet(tab, query) {
  const r = await fetch(SHEET + '&sheet=' + encodeURIComponent(tab) + '&tq=' + encodeURIComponent(query), { cache: 'no-store' });
  if (!r.ok) throw new Error('sheet ' + tab + ' responded ' + r.status);
  return csvParse(await r.text());
}

// ---------- redis (send log) ----------
const store = () => ({ url: findEnv(/(KV_REST_API_URL|REDIS_REST_URL)$/), tok: findEnv(/(KV_REST_API_TOKEN|REDIS_REST_TOKEN)$/) });
async function redis(cmds) {
  const { url, tok } = store();
  if (!url || !tok) return null;
  const r = await fetch(url.replace(/\/$/, '') + '/pipeline', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('store ' + r.status);
  return (await r.json()).map((o) => o.result);
}
async function readLog() {
  try {
    const out = await redis([['HGETALL', LOG_HASH]]);
    const m = {};
    const a = (out && out[0]) || [];
    for (let i = 0; i + 1 < a.length; i += 2) { try { m[a[i]] = JSON.parse(a[i + 1]); } catch (e) { /* skip */ } }
    return m;
  } catch (e) { return {}; }
}

// ---------- Zoho Books (PDF + payment link) ----------
const dc = () => env('ZOHO_DC') || 'com';
const zohoReady = () => !!(env('ZOHO_CLIENT_ID') && env('ZOHO_CLIENT_SECRET') && env('ZOHO_REFRESH_TOKEN') && env('ZOHO_ORG_ID'));
let zTok = { v: '', exp: 0 };
async function zohoToken() {
  if (zTok.v && Date.now() < zTok.exp - 60000) return zTok.v;
  const p = new URLSearchParams({ refresh_token: env('ZOHO_REFRESH_TOKEN'), client_id: env('ZOHO_CLIENT_ID'), client_secret: env('ZOHO_CLIENT_SECRET'), grant_type: 'refresh_token' });
  const j = await (await fetch('https://accounts.zoho.' + dc() + '/oauth/v2/token', { method: 'POST', body: p })).json();
  if (!j.access_token) throw new Error('Zoho sign-in failed: ' + (j.error || 'no token'));
  zTok = { v: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return zTok.v;
}
async function zohoFetch(path, extra) {
  const sep = path.includes('?') ? '&' : '?';
  return fetch('https://www.zohoapis.' + dc() + '/books/v3' + path + sep + 'organization_id=' + env('ZOHO_ORG_ID') + (extra || ''), {
    headers: { Authorization: 'Zoho-oauthtoken ' + (await zohoToken()) },
  });
}
async function zohoJson(path) {
  const r = await zohoFetch(path);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.code !== undefined && j.code !== 0)) throw new Error('Zoho: ' + (j.message || r.status));
  return j;
}
const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
// Zoho invoice id, live balance, payment link and (optionally) the PDF for one invoice number.
async function zohoInvoice(number, wantPdf, wantLink) {
  const list = await zohoJson('/invoices?invoice_number=' + encodeURIComponent(number));
  const inv = (list.invoices || []).find((x) => x.invoice_number === number);
  if (!inv) throw new Error(number + ': not found in Zoho Books');
  if (!(inv.balance > 0) || ['paid', 'void', 'draft'].includes(inv.status)) throw new Error(number + ': Zoho shows ' + inv.status + ', balance ' + inv.balance);
  let link = '', pdf = null;
  if (wantLink) {
    try {
      const exp = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      const pl = await zohoJson('/share/paymentlink?transaction_id=' + inv.invoice_id + '&transaction_type=invoice&link_type=public&expiry_time=' + exp);
      link = (pl.data && pl.data.payment_link) || pl.payment_link || '';
    } catch (e) { /* payment links may be off for this org; fall back to the invoice view link */ }
    if (!link) { try { link = ((await zohoJson('/invoices/' + inv.invoice_id)).invoice || {}).invoice_url || ''; } catch (e) { /* none */ } }
  }
  if (wantPdf) {
    const r = await zohoFetch('/invoices/' + inv.invoice_id, '&accept=pdf');
    if (!r.ok) throw new Error(number + ': could not download the PDF (' + r.status + ')');
    pdf = new Uint8Array(await r.arrayBuffer());
  }
  return { number, balance: inv.balance, currency: inv.currency_code, link, pdf };
}

// ---------- Gmail ----------
const gmailReady = () => !!(env('GMAIL_CLIENT_ID') && env('GMAIL_CLIENT_SECRET') && env('GMAIL_REFRESH_TOKEN'));
const sender = () => env('GMAIL_SENDER') || 'finance@spyne.ai';
let gTok = { v: '', exp: 0 };
async function gmailToken() {
  if (gTok.v && Date.now() < gTok.exp - 60000) return gTok.v;
  const p = new URLSearchParams({ client_id: env('GMAIL_CLIENT_ID'), client_secret: env('GMAIL_CLIENT_SECRET'), refresh_token: env('GMAIL_REFRESH_TOKEN'), grant_type: 'refresh_token' });
  const j = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: p })).json();
  if (!j.access_token) throw new Error('Gmail sign-in failed: ' + (j.error || 'no token'));
  gTok = { v: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return gTok.v;
}
const hdrSafe = (s) => String(s).replace(/[\r\n]+/g, ' ');
const enc2047 = (s) => (/^[\x20-\x7e]*$/.test(s) ? hdrSafe(s) : '=?UTF-8?B?' + b64(new TextEncoder().encode(hdrSafe(s))) + '?=');
const wrap76 = (s) => s.replace(/(.{76})/g, '$1\r\n');
function mime({ to, cc, subject, html, attachments }) {
  const bnd = 'b_' + crypto.randomUUID().replace(/-/g, '');
  const from = '"' + enc2047(env('GMAIL_FROM_NAME') || 'Spyne Finance').replace(/"/g, '') + '" <' + sender() + '>';
  const lines = [
    'From: ' + from, 'To: ' + to.join(', '), cc.length ? 'Cc: ' + cc.join(', ') : null, 'Reply-To: ' + sender(),
    'Subject: ' + enc2047(subject), 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="' + bnd + '"', '',
    '--' + bnd, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap76(b64(new TextEncoder().encode(html))),
  ].filter((x) => x !== null);
  for (const a of attachments) {
    lines.push('--' + bnd, 'Content-Type: application/pdf; name="' + a.name + '"', 'Content-Disposition: attachment; filename="' + a.name + '"', 'Content-Transfer-Encoding: base64', '', wrap76(b64(a.bytes)));
  }
  lines.push('--' + bnd + '--', '');
  return lines.join('\r\n');
}
async function gmailSend(raw) {
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { Authorization: 'Bearer ' + (await gmailToken()), 'content-type': 'application/json' },
    body: JSON.stringify({ raw: b64(new TextEncoder().encode(raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Gmail: ' + ((j.error && j.error.message) || r.status));
  return j.id;
}

// ---------- the email ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (v, cur) => (cur ? cur + ' ' : '') + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// The four templates. Friendly / Urgent / Final are collection reminders and skip auto-pay customers;
// Subscription Invoice is the one that goes to auto-pay customers (an invoice notice, not a chase).
const TEMPLATES = {
  friendly: { label: 'Friendly Reminder', autopay: false, color: '#0b6b4a', head: 'Friendly Reminder', subject: 'Friendly Reminder: Outstanding Invoices',
    intro: (n, t) => 'This is a friendly reminder that the invoice' + (n > 1 ? 's' : '') + ' below ' + (n > 1 ? 'are' : 'is') + ' still outstanding, totalling <b>' + t + '</b>.',
    close: 'If payment has already been made, please share the remittance details and ignore this note. If anything on an invoice needs correcting, just reply and we will sort it out.' },
  urgent: { label: 'Urgent Reminder', autopay: false, color: '#b57e00', head: 'Urgent: Payment Overdue', subject: 'Urgent: Overdue Invoices',
    intro: (n, t) => 'Our records show the invoice' + (n > 1 ? 's' : '') + ' below ' + (n > 1 ? 'are' : 'is') + ' now overdue, with <b>' + t + '</b> outstanding. We would appreciate payment within the next few days.',
    close: 'If payment is already on its way, please send us the remittance advice. If there is a dispute or a problem with an invoice, reply to this email today so we can resolve it quickly.' },
  final: { label: 'Final Reminder', autopay: false, color: '#c63b50', head: 'Final Reminder', subject: 'Final Reminder: Overdue Invoices',
    intro: (n, t) => 'Despite our earlier reminders, the invoice' + (n > 1 ? 's' : '') + ' below ' + (n > 1 ? 'remain' : 'remains') + ' unpaid, with <b>' + t + '</b> outstanding. This is our final reminder before we escalate the account.',
    close: 'Please arrange payment immediately, or reply with the payment date and remittance details. Continued non-payment may lead to a suspension of services.' },
  subscription: { label: 'Subscription Invoice', autopay: true, color: '#5566c9', head: 'Your Subscription Invoice', subject: 'Subscription Invoice',
    intro: (n, t) => 'Please find your subscription invoice' + (n > 1 ? 's' : '') + ' below, with <b>' + t + '</b> due. Your account is set up for auto-pay, so no action is needed if your payment method on file is valid.',
    close: 'If your card or bank details have changed, or you would like to pay manually, use the link above or reply to this email.' },
};
function render(tpl, customer, items, note, who) {
  const byCur = {};
  items.forEach((i) => { byCur[i.currency] = (byCur[i.currency] || 0) + i.balance; });
  const totals = Object.keys(byCur).map((c) => fmt(byCur[c], c)).join(' + ');
  const cell = 'padding:8px 10px;border-bottom:1px solid #e3e8ef;';
  const rows = items.map((i) => '<tr><td style="' + cell + '">' + esc(i.number) + '</td><td style="' + cell + '">' + esc(i.dueDate || '') + '</td>'
    + '<td style="' + cell + 'text-align:right">' + esc(fmt(i.balance, i.currency)) + '</td>'
    + '<td style="' + cell + '">' + (i.link ? '<a href="' + esc(i.link) + '" style="background:#0b6b4a;color:#fff;padding:6px 12px;border-radius:5px;text-decoration:none">Pay now</a>' : '') + '</td></tr>').join('');
  const subject = tpl.subject + ' – ' + customer;
  const html = '<div style="font:14px/1.5 Arial,Helvetica,sans-serif;color:#1b2430;max-width:640px">'
    + '<div style="background:' + tpl.color + ';color:#fff;padding:16px 20px;font-size:18px;font-weight:bold">' + esc(tpl.head) + '</div>'
    + '<div style="padding:20px;border:1px solid #e3e8ef;border-top:0">'
    + '<p>Hello ' + esc(customer) + ' team,</p>'
    + '<p>' + tpl.intro(items.length, esc(totals)) + '</p>'
    + '<table style="border-collapse:collapse;width:100%;font-size:13px"><tr style="background:#f3f6fa;text-align:left"><th style="' + cell + '">Invoice</th><th style="' + cell + '">Due date</th><th style="' + cell + 'text-align:right">Balance</th><th style="' + cell + '"></th></tr>' + rows + '</table>'
    + (note ? '<p>' + esc(note).replace(/\n/g, '<br>') + '</p>' : '')
    + '<p>' + (items.some((i) => i.hasPdf) ? 'The invoice PDF' + (items.length > 1 ? 's are' : ' is') + ' attached. ' : '') + tpl.close + '</p>'
    + '<p>Thank you,<br>Spyne Finance</p></div></div>';
  return { subject, html };
}

// ---------- auth ----------
async function who(request) {
  const c = await cookieEmail(request);
  if (c) return String(c).toLowerCase();
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  if (!m) return null;
  try {
    const v = await verifyGoogleToken(m[1], await getJwks(), { clientId: GOOGLE_CLIENT_ID, domain: ALLOWED_DOMAIN });
    return v.ok ? v.email.toLowerCase() : null;
  } catch (e) { return null; }
}
const senders = () => new Set([OWNER, ...String(env('REMINDER_SENDERS')).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)]);

// ---------- rows ----------
async function loadRows() {
  const [main, auto] = await Promise.all([
    sheet('Sheet1', 'select ' + LETTERS.join(',') + ' where F is not null'),
    sheet('Customs on Auto-pay', 'select A').catch(() => []),
  ]);
  const autopay = new Set(auto.slice(1).map((r) => (r[0] || '').trim().toLowerCase()).filter(Boolean));
  const g = (r, c) => (r[POS[c]] || '').trim();
  const rows = [];
  for (const r of main.slice(1)) {
    const invoice = g(r, COL.invoice);
    const balance = num(g(r, COL.balance));
    const status = g(r, COL.invStatus).toLowerCase();
    if (!invoice || !(balance > 0) || g(r, COL.status).toLowerCase() !== 'receivable' || !['overdue', 'sent'].includes(status)) continue;
    const ent = g(r, COL.ent);
    rows.push({
      invoice, ent, customer: g(r, COL.customer), entity: g(r, COL.entity), currency: g(r, COL.currency), total: num(g(r, COL.total)), balance,
      invDate: g(r, COL.invDate), dueDate: g(r, COL.dueDate), daysOver: parseInt(g(r, COL.daysOver), 10) || 0, bucket: g(r, COL.bucket),
      status, csm: g(r, COL.csm), csmEmail: emails(g(r, COL.csmEmail)), to: emails(g(r, COL.email)), cc: emails(g(r, COL.ccEmail)),
      autopay: autopay.has(ent.toLowerCase()),
    });
  }
  return rows;
}

export default async function handler(request) {
  const me = await who(request);
  if (!me) return json(401, { error: 'unauthorized' });
  const canSend = senders().has(me);

  if (request.method === 'GET') {
    try {
      const [rows, log] = await Promise.all([loadRows(), readLog()]);
      return json(200, { me, canSend, from: sender(), ready: { zoho: zohoReady(), gmail: gmailReady(), log: !!store().url }, blockDays: BLOCK_DAYS, log, rows });
    } catch (e) {
      return json(502, { error: 'sheet_unavailable', message: String((e && e.message) || e) });
    }
  }

  if (request.method !== 'POST') return json(405, { error: 'method' });
  if (!canSend) return json(403, { error: 'executor_only', message: 'Only executors can send reminders.' });
  let body;
  try { body = await request.json(); } catch (e) { return json(400, { error: 'bad_json' }); }
  const dry = !body.confirm;
  const tplKey = Object.prototype.hasOwnProperty.call(TEMPLATES, body.template) ? body.template : 'friendly';
  const tpl = TEMPLATES[tplKey];
  if (!zohoReady() && (body.attachPdf || body.paymentLinks)) return json(503, { error: 'zoho_not_configured', message: 'Zoho Books credentials are not set on the server.' });
  if (!dry && !gmailReady()) return json(503, { error: 'gmail_not_configured', message: 'Gmail credentials are not set on the server.' });
  const want = [...new Set((body.customers || []).map(String))].slice(0, MAX_CUSTOMERS);
  if (!want.length) return json(400, { error: 'nothing_selected' });
  const rc = body.recipients || {};
  const extra = emails(rc.other);
  const note = String(body.note || '').slice(0, 1000);

  // The browser says only WHICH customers; recipients, amounts and invoices come from the sheet and Zoho on the server.
  const [rows, log] = await Promise.all([loadRows(), readLog()]);
  const out = [];
  for (const ent of want) {
    const mine = rows.filter((r) => r.ent === ent);
    const name = (mine[0] && mine[0].customer) || ent;
    try {
      if (!mine.length) throw new Error('no outstanding invoices in the sheet');
      if (mine[0].autopay && !tpl.autopay) throw new Error('customer is on auto-pay: use the Subscription Invoice template');
      if (!mine[0].autopay && tpl.autopay) throw new Error('Subscription Invoice is only for auto-pay customers');
      const l = log['ent:' + ent + ':' + tplKey];
      if (!body.force && l && l.ok && Date.now() - Date.parse(l.at) < BLOCK_DAYS * 86400000) throw new Error('already reminded ' + l.at.slice(0, 10) + ' (tick "send again" to override)');
      const to = rc.customer === false ? [] : [...new Set(mine.flatMap((r) => r.to))];
      const cc = [...new Set([...mine.flatMap((r) => r.cc), ...(rc.csm ? mine.flatMap((r) => r.csmEmail) : []), ...(rc.finance ? [sender()] : []), ...extra])].filter((x) => !to.includes(x));
      if (!to.length && !cc.length) throw new Error('no recipient: no customer email in the sheet');
      const toList = to.length ? to : cc.splice(0, cc.length);
      const items = [];
      let bytes = 0;
      const attachments = [];
      for (const r of mine) {
        const z = zohoReady() ? await zohoInvoice(r.invoice, !!body.attachPdf && !dry, !!body.paymentLinks) : { balance: r.balance, currency: r.currency, link: '', pdf: null };
        items.push({ number: r.invoice, dueDate: r.dueDate, balance: z.balance, currency: z.currency || r.currency, link: z.link, hasPdf: !!body.attachPdf });
        if (z.pdf) { bytes += z.pdf.length; attachments.push({ name: r.invoice.replace(/[^A-Za-z0-9._-]/g, '_') + '.pdf', bytes: z.pdf }); }
      }
      if (bytes > MAX_BYTES) throw new Error('attachments are too large for one email (' + Math.round(bytes / 1048576) + ' MB)');
      const { subject, html } = render(tpl, name, items, note, me);
      if (dry) { out.push({ ent, customer: name, ok: true, to: toList, cc, subject, html, invoices: items.length }); continue; }
      const id = await gmailSend(mime({ to: toList, cc, subject, html, attachments }));
      await redis([['HSET', LOG_HASH, 'ent:' + ent + ':' + tplKey, JSON.stringify({ at: new Date().toISOString(), by: me, ok: true, to: toList, invoices: items.map((i) => i.number), msg: id })]]).catch(() => {});
      out.push({ ent, customer: name, ok: true, to: toList, cc, invoices: items.length });
    } catch (e) {
      out.push({ ent, customer: name, ok: false, error: String((e && e.message) || e) });
    }
  }
  return json(200, dry ? { dry: true, items: out } : { results: out });
}
