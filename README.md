# Spyne Collection Dashboard

A single-page rebuild of the Looker Studio **Collection Dashboard**, deployable as a static site.
It reads the source Google Sheet **live in the browser** on every page load, so the figures are
whatever the sheet says right now.

> **Internal only.** This page shows dealer customer names, outstanding amounts, collection
> remarks and receipt-level cash. Turn on Vercel Deployment Protection before sharing the URL —
> see [Protect the deployment](#protect-the-deployment). A Vercel URL is public by default.

---

## Files

| File | What it is |
|---|---|
| `spoc-collections-dashboard.html` | The whole dashboard — markup, styling, logic and a dated fallback snapshot. No dependencies, no build step. |
| `vercel.json` | Serves the dashboard at `/`, and tells Vercel not to cache it or let search engines index it. |

There is deliberately no build, no `package.json` and no framework. It is one HTML file.

## Deploy on Vercel

1. **Vercel → Add New → Project → Import** this repository.
2. Application Preset **Other**. Root Directory `./`. Leave Build Command, Install Command and Output Directory **empty**.
3. **Deploy.** The dashboard is then at your project URL — `/` serves it via the rewrite in `vercel.json`.

Every push to `main` redeploys automatically. Because the data is read live from the sheet, you only
need to redeploy when the *dashboard itself* changes — not when the numbers do.

### Protect the deployment

Project **Settings → Deployment Protection**:

- **Vercel Authentication** — restricts the URL to members of your Vercel team. The right default here.
- **Password Protection** — a shared password instead; a paid add-on on some plans.

Do this before circulating the link. Without it, anyone with the URL sees the full collections book,
and the sheet id is readable in page source.

## How the live data works

The page fetches two tabs of **Collection Projections - Working** directly from Google:

| Page | Tab | Endpoint |
|---|---|---|
| Collections Pending, Never Received Payment, Payment Recurring, SPOC Aging | `SPOC wise invoice amount` (gid `1780682586`) | `/export?format=csv&gid=…` |
| Collected Amount | `Collection` | `/gviz/tq?tqx=out:csv&sheet=Collection` |

Google's CSV export sends CORS headers, so the browser reads it from any origin — no server, API key
or service account involved. Verified from a third-party origin: every column resolves and the totals
match the Looker report.

**This depends on the sheet staying "anyone with the link can view."** If sharing is tightened the
live read fails, the page falls back to its embedded snapshot, and a red message says so. The two
manual **Load … CSV** buttons remain as a fallback — download the tab as CSV and load it.

The sheet id is set near the bottom of the HTML:

```js
const SHEET_ID = '1F9A2F5Me0ZR-ZlrBebFtD6xGQM0axDtdHLl1eaGvtXA';
```

## The five pages

| Page | Mirrors the Looker page | Filter it reproduces |
|---|---|---|
| **Collections Pending** | *Collections pending without auto pay* | balance ≠ 0 **and** `Mapping` ≠ Active; day buckets on **TAT** ≤30 / 31-60 / >60 |
| **Never Received Payment** | *Never Received Any Payment* | balance ≠ 0 **and** `Payment Received Status` = No |
| **Payment Recurring** | *Payment recurring status* | `Zoho Service Type` = Subscription Based; recurring status from `Mapping`; ARR in **USD** |
| **Collected Amount** | *Collected Amount* | every dated receipt in the `Collection` tab, converted to INR |
| **SPOC Aging** | — (added) | the full book incl. auto-pay, aged by the sheet's own `0-30 / 30-60 / 60-90 / >90` columns |

Verified against the Looker report to the rupee on 16 Sep 2026: pending total ₹50,985,977, TAT buckets
11,814,748 / 10,501,508 / 28,669,721, and MTD / QTD / YTD collections 31,384,837 / 141,556,116 / 436,784,048.

### Two known differences from Looker

- **All-time collected.** Looker's *Total Collection* scorecard reads 1.13bn; the `Collection` tab itself
  sums to 979.43m, so that scorecard blends another source. Every date-scoped figure matches exactly.
  The page shows the tab's own figure and says so.
- **Payment Recurring counts.** Looker reports 843 customers / $4.93m ARR against 936 table rows; this
  tab's subscription rows give 904 / $4.83m, so that Looker page reads from a different tab.

## Manual remarks

The **Manual remark** column in each details table is free text you type, keyed to the customer name so
it survives sorting, filtering and a data refresh. It is stored in **your browser only** — never written
back to the sheet, never committed here.

Because it is per-browser and per-origin, remarks typed on the Vercel URL are separate from remarks typed
on a local copy. Move them with **Save remarks** → **Load remarks**.

## Provenance

All figures come from an internal, **unaudited** Spyne collections sheet. This is not NADA, Cox, NIADA,
Kerrigan or any other audited industry source, and nothing here should be quoted externally as though it
were. Pending amounts are the sheet's INR-converted values; the `Actual currency` column is the
original-currency figure at mixed rates, so read it per row and never sum it.
