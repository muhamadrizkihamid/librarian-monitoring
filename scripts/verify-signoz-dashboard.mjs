#!/usr/bin/env node
/**
 * Verifikasi dashboard SigNoz v0.128: GET balik + jalankan tiap widget lewat
 * /api/v5/query_range (format yang dipakai UI) dan laporkan panel mana yang
 * benar-benar MENGEMBALIKAN DATA (bukan sekadar tersimpan).
 *
 * Pemakaian: node scripts/verify-signoz-dashboard.mjs <dashboard-uuid>
 */
// Kredensial WAJIB dari ENV — jangan hardcode password di sumber (repo ter-git).
const BASE = process.env.SZ_BASE || 'http://localhost:8080';
const EMAIL = process.env.SZ_EMAIL;
const PASSWORD = process.env.SZ_PASSWORD;
const ORG = process.env.SZ_ORG;
const UUID = process.argv[2];
if (!EMAIL || !PASSWORD || !ORG) {
  console.error('ERROR: set ENV SZ_EMAIL, SZ_PASSWORD, SZ_ORG dulu.');
  process.exit(1);
}

async function login() {
  const r = await fetch(`${BASE}/api/v2/sessions/email_password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, orgID: ORG }),
  });
  return (await r.json()).data.accessToken;
}
const tok = await login();
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` };

const dres = await (await fetch(`${BASE}/api/v1/dashboards/${UUID}`, { headers: H })).json();
const dash = dres.data.data;
console.log('Dashboard:', dash.title);
console.log('Widgets  :', dash.widgets.length, '| layout:', dash.layout.length);
console.log('');

const end = Date.now();
const start = end - 24 * 3600 * 1000;

function reqType(panel) {
  if (panel === 'value') return 'scalar';
  if (panel === 'table') return 'scalar';
  if (panel === 'list') return 'raw';
  return 'time_series'; // graph, bar
}

function probeData(j) {
  // bentuk respons v5: j.data.data.results[] (double "data")
  let points = 0, series = 0, rows = 0, scalar = null;
  const results = j?.data?.data?.results || [];
  for (const r of results) {
    for (const a of (r.aggregations || [])) {
      for (const s of (a.series || [])) { series++; points += (s.values || []).length; }
    }
    if (Array.isArray(r.data)) { rows += r.data.length; if (r.data.length && Array.isArray(r.data[0])) scalar = r.data[0][r.data[0].length - 1]; } // scalar/table
    if (Array.isArray(r.rows)) rows += r.rows.length; // raw list
  }
  return { series, points, rows, scalar };
}

for (const w of dash.widgets) {
  const q = w.query.builder.queryData[0];
  const signal = q.dataSource === 'metrics' ? 'metrics' : 'logs';
  // konversi groupBy/order ke format spec v5 (sama seperti yang dilakukan UI: yvt()).
  const groupBy = (q.groupBy || []).map((g) => ({ name: g.key, fieldDataType: g.dataType || '', fieldContext: g.type || '' }));
  const order = (q.orderBy || []).map((o) => ({ key: { name: o.key?.name || o.columnName || 'count()' }, direction: o.order || o.direction || 'desc' }));
  const spec = {
    name: q.queryName || 'A',
    signal,
    disabled: false,
    aggregations: q.aggregations,
    filter: q.filter,
    ...(groupBy.length ? { groupBy } : {}),
    ...(order.length ? { order } : {}),
    ...(q.limit ? { limit: q.limit } : (w.panelTypes === 'list' ? { limit: 50 } : {})),
    stepInterval: 300,
  };
  const payload = {
    schemaVersion: 'v1', start, end, requestType: reqType(w.panelTypes),
    compositeQuery: { queries: [{ type: 'builder_query', spec }] },
    formatOptions: { formatTableResultForUI: false, fillGaps: false },
  };
  try {
    const r = await fetch(`${BASE}/api/v5/query_range`, { method: 'POST', headers: H, body: JSON.stringify(payload) });
    const j = await r.json();
    if (j.status !== 'success' && r.status !== 200) {
      console.log(`  [ERR] ${w.panelTypes.padEnd(6)} ${w.title.padEnd(28)} HTTP ${r.status} ${JSON.stringify(j.error || j).slice(0, 90)}`);
      continue;
    }
    const c = probeData(j);
    const ok = c.points > 0 || c.rows > 0;
    const extra = c.scalar != null ? `value=${c.scalar}` : `series=${c.series} points=${c.points} rows=${c.rows}`;
    console.log(`  [${ok ? 'OK ' : '...'}] ${w.panelTypes.padEnd(6)} ${w.title.padEnd(28)} ${extra}`);
  } catch (e) {
    console.log(`  [ERR] ${w.title} -> ${e.message}`);
  }
}
