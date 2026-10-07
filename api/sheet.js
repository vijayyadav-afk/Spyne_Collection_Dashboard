// Live data relay for the Collections dashboard.
// Reads the Google Sheet (tab gid 0, shared "anyone with the link"), keeps only the
// columns the dashboard uses, and returns them as compact JSON. Runs on Vercel's edge.
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

export default async function handler() {
  const url = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/gviz/tq?tqx=out:csv&gid=' + SHEET_GID;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('sheet responded ' + r.status);
    const data = buildData(csvParse(await r.text()));
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, s-maxage=30, stale-while-revalidate=60',
        'x-robots-tag': 'noindex, nofollow',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'sheet_unavailable', message: String((e && e.message) || e) }), {
      status: 502,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
}
