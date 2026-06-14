#!/usr/bin/env node
/**
 * Verifikasi dashboard #4 (campur clickhouse_sql + builder list) — jalankan tiap panel
 * lewat /api/v5/query_range dan laporkan apakah MENGEMBALIKAN DATA.
 * Untuk panel drill-down (mengandung {{.prompt_id}} / $prompt_id), pakai 1 prompt_id contoh
 * (argumen ke-2, default = prompt_id terbaru).
 *
 * Pemakaian: node scripts/verify-activity-audit.mjs <uuid> [prompt_id]
 */
const BASE = process.env.SZ_BASE || 'http://localhost:8080';
const { SZ_EMAIL: EMAIL, SZ_PASSWORD: PASSWORD, SZ_ORG: ORG } = process.env;
const UUID = process.argv[2];
let PID = process.argv[3];
if (!EMAIL || !PASSWORD || !ORG || !UUID) { console.error('ENV SZ_EMAIL/SZ_PASSWORD/SZ_ORG + arg <uuid> wajib.'); process.exit(1); }

const tok = (await (await fetch(`${BASE}/api/v2/sessions/email_password`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD, orgID: ORG }),
})).json()).data.accessToken;
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` };

const end = Date.now(), start = end - 30 * 86400 * 1000;
const post = async (b) => { const r = await fetch(`${BASE}/api/v5/query_range`, { method: 'POST', headers: H, body: JSON.stringify(b) }); const t = await r.text(); let p; try { p = JSON.parse(t); } catch { p = t; } return { status: r.status, body: p }; };

// ambil prompt_id contoh kalau tak diberikan
if (!PID) {
  const q = `SELECT attributes_string['prompt.id'] AS prompt_id FROM signoz_logs.distributed_logs_v2 WHERE attributes_string['event.name']='user_prompt' AND attributes_string['prompt.id']!='' GROUP BY prompt_id ORDER BY max(timestamp) DESC LIMIT 1`;
  const r = await post({ schemaVersion: 'v1', start, end, requestType: 'raw', compositeQuery: { queries: [{ type: 'clickhouse_sql', spec: { name: 'A', query: q } }] } });
  PID = r.body?.data?.data?.results?.[0]?.rows?.[0]?.data?.prompt_id || '';
}
console.log('prompt_id contoh:', PID || '(tak ada)');

const dres = await (await fetch(`${BASE}/api/v1/dashboards/${UUID}`, { headers: H })).json();
const dash = dres.data.data;
console.log('Dashboard:', dash.title, '| widgets:', dash.widgets.length, '\n');

const probe = (j) => {
  let rows = 0, points = 0;
  for (const r of (j?.data?.data?.results || [])) {
    if (Array.isArray(r.rows)) rows += r.rows.length;
    if (Array.isArray(r.data)) rows += r.data.length;
    for (const a of (r.aggregations || [])) for (const s of (a.series || [])) points += (s.values || []).length;
  }
  return { rows, points };
};

for (const w of dash.widgets) {
  const qt = w.query.queryType;
  let payload;
  if (qt === 'clickhouse_sql') {
    let sql = w.query.clickhouse_sql[0].query.replaceAll('{{.prompt_id}}', `'${PID}'`);
    payload = { schemaVersion: 'v1', start, end, requestType: 'raw', compositeQuery: { queries: [{ type: 'clickhouse_sql', spec: { name: 'A', query: sql } }] } };
  } else {
    const q = w.query.builder.queryData[0];
    const filter = { expression: (q.filter?.expression || '').replaceAll('$prompt_id', `'${PID}'`) };
    const order = (q.orderBy || []).map((o) => ({ key: { name: o.columnName || 'timestamp' }, direction: o.order || 'desc' }));
    const spec = { name: 'A', signal: 'logs', disabled: false, aggregations: q.aggregations || [], filter, order, limit: q.limit || 50, stepInterval: 300 };
    payload = { schemaVersion: 'v1', start, end, requestType: 'raw', compositeQuery: { queries: [{ type: 'builder_query', spec }] } };
  }
  try {
    const r = await post(payload);
    if (r.status !== 200 || r.body?.status === 'error') {
      console.log(`  [ERR] ${w.panelTypes.padEnd(5)} ${w.title.slice(0, 44).padEnd(45)} ${JSON.stringify(r.body?.error || r.body).slice(0, 120)}`);
      continue;
    }
    const c = probe(r.body);
    const ok = c.rows > 0 || c.points > 0;
    console.log(`  [${ok ? 'OK ' : '...'}] ${(qt === 'clickhouse_sql' ? 'CH' : 'BLD').padEnd(3)} ${w.panelTypes.padEnd(5)} ${w.title.slice(0, 44).padEnd(45)} rows=${c.rows} pts=${c.points}`);
  } catch (e) { console.log(`  [ERR] ${w.title} -> ${e.message}`); }
}
