#!/usr/bin/env node
/**
 * Dashboard monitoring ringan (tanpa dependensi).
 * Membaca data/audit/hooks-*.jsonl (L2 capture+enforce) & data/siem/hec-received.jsonl (SIEM),
 * menyajikan ringkasan di http://localhost:8090 (auto-refresh tiap 3 dtk via /api/summary).
 *
 * Pemakaian: node dashboard/server.mjs   (PORT override: PORT=9000 node dashboard/server.mjs)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'data');
const AUDIT = path.join(DATA, 'audit');
const SIEM = path.join(DATA, 'siem', 'hec-received.jsonl');
const PORT = Number(process.env.PORT || 8090);
const TEST_IDS = new Set(['t', 'demo', 'demo-sess']);

const readJsonl = (p) => {
  try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean); }
  catch { return []; }
};

function loadHooks() {
  let files = [];
  try { files = fs.readdirSync(AUDIT).filter((f) => f.startsWith('hooks-')).sort(); } catch {}
  const ev = [];
  for (const f of files) {
    for (const line of readJsonl(path.join(AUDIT, f))) {
      try {
        const e = JSON.parse(line);
        if (TEST_IDS.has(e.session_id)) continue;
        ev.push(e);
      } catch {}
    }
  }
  return ev;
}

function loadSiem() {
  const out = [];
  for (const line of readJsonl(SIEM)) {
    try {
      const o = JSON.parse(line);
      const f = o.fields || {};
      out.push({ name: f['event.name'] || o.event || '?', email: f['user.email'] || null, time: Number(o.time) || null, fields: f });
    } catch {}
  }
  return out;
}

function summary() {
  const hooks = loadHooks();
  const siem = loadSiem();

  const byDecision = { allow: 0, flag: 0, block: 0 };
  const byKind = {}, byTool = {}, users = new Set(), sessions = new Set();
  for (const e of hooks) {
    byDecision[e.decision] = (byDecision[e.decision] || 0) + 1;
    byKind[e.event_kind] = (byKind[e.event_kind] || 0) + 1;
    if (e.tool_name) byTool[e.tool_name] = (byTool[e.tool_name] || 0) + 1;
    if (e.user_id) users.add(e.user_id);
    if (e.session_id) sessions.add(e.session_id);
  }
  const recent = hooks.slice(-60).reverse().map((e) => ({
    ts: e.timestamp, user: e.user_id, kind: e.event_kind, tool: e.tool_name || '',
    decision: e.decision, reason: e.decision_reason || '', rule: e.policy_rule_id || '',
    mcp: e.mcp_invocation ? e.mcp_invocation.mcp_server : '',
  }));
  const enforcement = hooks
    .filter((e) => e.decision === 'block' || e.decision === 'flag')
    .slice(-30).reverse()
    .map((e) => ({ ts: e.timestamp, decision: e.decision, tool: e.tool_name || '', rule: e.policy_rule_id || '', reason: e.decision_reason || '' }));

  // SIEM
  const siemByName = {}, emails = new Set();
  let costUsd = 0, apiReq = 0;
  for (const s of siem) {
    siemByName[s.name] = (siemByName[s.name] || 0) + 1;
    if (s.email) emails.add(s.email);
    if (s.name === 'claude_code.api_request' || s.name === 'api_request') apiReq++;
    const c = Number(s.fields.cost_usd ?? s.fields['cost_usd'] ?? 0);
    if (!Number.isNaN(c)) costUsd += c;
    for (const [k, v] of Object.entries(s.fields)) {
      if (k.includes('cost.usage') && typeof v === 'number') costUsd += v;
    }
  }

  // --- deret waktu (event & biaya per bucket) ---
  const costPts = [];
  for (const s of siem) {
    let c = Number(s.fields.cost_usd ?? 0); if (Number.isNaN(c)) c = 0;
    for (const [k, v] of Object.entries(s.fields)) if (k.includes('cost.usage') && typeof v === 'number') c += v;
    if (c > 0 && s.time) costPts.push({ ms: s.time * 1000, c });
  }
  const allMs = [
    ...hooks.map((e) => Date.parse(e.timestamp)).filter((n) => !Number.isNaN(n)),
    ...costPts.map((p) => p.ms).filter(Boolean),
  ];
  let timeseries = null;
  if (allMs.length) {
    const min = Math.min(...allMs), max = Math.max(...allMs);
    const span = Math.max(0, max - min);
    const bucketMs = Math.max(60000, Math.ceil((span / 40) / 60000) * 60000); // >=1 menit, ~40 bucket
    const n = Math.min(180, Math.floor(span / bucketMs) + 1);
    const b = Array.from({ length: n }, (_, i) => ({ t: min + i * bucketMs, allow: 0, flag: 0, block: 0, total: 0, cost: 0 }));
    const idx = (ms) => Math.min(n - 1, Math.max(0, Math.floor((ms - min) / bucketMs)));
    for (const e of hooks) { const ms = Date.parse(e.timestamp); if (Number.isNaN(ms)) continue; const k = idx(ms); b[k][e.decision] = (b[k][e.decision] || 0) + 1; b[k].total++; }
    for (const p of costPts) { b[idx(p.ms)].cost += p.c; }
    timeseries = { bucketMs, buckets: b.map((x) => ({ t: x.t, allow: x.allow, flag: x.flag, block: x.block, total: x.total, cost: Number(x.cost.toFixed(4)) })) };
  }

  return {
    generatedAt: new Date().toISOString(),
    timeseries,
    hooks: {
      total: hooks.length, byDecision, byKind, byTool,
      users: [...users], sessions: sessions.size, recent, enforcement,
    },
    siem: {
      total: siem.length, byName: siemByName, emails: [...emails],
      apiRequests: apiReq, costUsd: Number(costUsd.toFixed(4)),
    },
  };
}

const PAGE = `<!doctype html><html lang="id"><head><meta charset="utf-8">
<title>Trapping Monitor — Claude Code CLI</title>
<style>
  :root{--bg:#0f1419;--card:#1a2230;--mut:#8aa;--ok:#3fb950;--flag:#d29922;--block:#f85149;--txt:#e6edf3}
  *{box-sizing:border-box} body{margin:0;font:14px/1.4 system-ui,Segoe UI,sans-serif;background:var(--bg);color:var(--txt)}
  header{padding:14px 20px;border-bottom:1px solid #30363d;display:flex;justify-content:space-between;align-items:center}
  h1{font-size:16px;margin:0} .sub{color:var(--mut);font-size:12px}
  .wrap{padding:16px 20px;display:grid;gap:16px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
  .card{background:var(--card);border:1px solid #30363d;border-radius:10px;padding:14px}
  .card .n{font-size:26px;font-weight:700} .card .l{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  .ok{color:var(--ok)} .flag{color:var(--flag)} .block{color:var(--block)}
  .grid2{display:grid;grid-template-columns:1.6fr 1fr;gap:16px} @media(max-width:900px){.grid2{grid-template-columns:1fr}}
  table{width:100%;border-collapse:collapse;font-size:12.5px} th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #222b38}
  th{color:var(--mut);font-weight:600} tbody tr:hover{background:#10161f}
  .pill{padding:1px 7px;border-radius:999px;font-size:11px;font-weight:600}
  .pill.allow{background:#1c3026;color:var(--ok)} .pill.flag{background:#3a2f10;color:var(--flag)} .pill.block{background:#3a1316;color:var(--block)}
  .mono{font-family:ui-monospace,Consolas,monospace} .muted{color:var(--mut)}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);margin:0 0 8px}
</style></head><body>
<header><div><h1>🛡️ Activity Trapping — Claude Code CLI</h1><div class="sub" id="meta">memuat…</div></div>
<div class="sub">auto-refresh 3s · sumber: data/audit + data/siem</div></header>
<div class="wrap">
  <div class="cards" id="cards"></div>
  <div class="grid2">
    <div class="card"><h2>Tren event / waktu</h2><div id="chartEvents"></div><div class="muted" style="font-size:11px;margin-top:6px"><span class="ok">█</span> allow &nbsp;<span class="flag">█</span> flag &nbsp;<span class="block">█</span> block</div></div>
    <div class="card"><h2>Tren biaya / waktu</h2><div id="chartCost"></div><div class="muted" id="costLegend" style="font-size:11px;margin-top:6px"></div></div>
  </div>
  <div class="grid2">
    <div class="card"><h2>Aktivitas terbaru (hooks)</h2><table><thead><tr><th>Waktu</th><th>User</th><th>Jenis</th><th>Tool</th><th>Keputusan</th></tr></thead><tbody id="recent"></tbody></table></div>
    <div class="card"><h2>Enforcement (block / flag)</h2><table><thead><tr><th>Waktu</th><th>Keputusan</th><th>Tool</th><th>Rule</th></tr></thead><tbody id="enf"></tbody></table>
      <h2 style="margin-top:14px">SIEM — event by name</h2><table><tbody id="siem"></tbody></table>
    </div>
  </div>
</div>
<script>
const t=s=>(s||'').slice(11,19);
function card(n,l,cls){return '<div class="card"><div class="n '+(cls||'')+'">'+n+'</div><div class="l">'+l+'</div></div>'}
const hhmm=ms=>new Date(ms).toISOString().slice(11,16);
function renderEvents(ts){
  const el=document.getElementById('chartEvents');
  if(!ts||!ts.buckets.length){el.innerHTML='<div class="muted">belum ada data</div>';return;}
  const b=ts.buckets,W=560,H=150,p=24,n=b.length;
  const maxT=Math.max(1,...b.map(x=>x.total));
  const bw=Math.max(2,(W-2*p)/n-2), C={allow:'#3fb950',flag:'#d29922',block:'#f85149'};
  let bars='';
  b.forEach((x,i)=>{ let x0=p+i*((W-2*p)/n), y=H-p;
    for(const k of ['allow','flag','block']){ const h=(x[k]/maxT)*(H-2*p); if(h>0){ y-=h; bars+='<rect x="'+x0.toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+h.toFixed(1)+'" fill="'+C[k]+'"/>'; } }
  });
  const ax='<text x="'+p+'" y="'+(H-6)+'" fill="#8aa" font-size="10">'+hhmm(b[0].t)+'</text><text x="'+(W-p)+'" y="'+(H-6)+'" fill="#8aa" font-size="10" text-anchor="end">'+hhmm(b[n-1].t)+'</text><text x="'+p+'" y="14" fill="#8aa" font-size="10">max '+maxT+'/bucket</text>';
  el.innerHTML='<svg viewBox="0 0 '+W+' '+H+'" width="100%">'+bars+ax+'</svg>';
}
function renderCost(ts){
  const el=document.getElementById('chartCost');
  if(!ts||!ts.buckets.length){el.innerHTML='<div class="muted">belum ada data</div>';return;}
  const b=ts.buckets,W=560,H=150,p=24,n=b.length;
  let cum=0; const pts=b.map(x=>{cum+=x.cost;return cum;});
  const maxC=Math.max(0.0001,...pts);
  const X=i=>p+i*((W-2*p)/Math.max(1,n-1)), Y=v=>H-p-(v/maxC)*(H-2*p);
  let d=''; b.forEach((x,i)=>{ d+=(i?'L':'M')+X(i).toFixed(1)+' '+Y(pts[i]).toFixed(1)+' '; });
  const area='<path d="'+d+'L '+X(n-1).toFixed(1)+' '+(H-p)+' L '+X(0).toFixed(1)+' '+(H-p)+' Z" fill="#1f6feb33"/>';
  const line='<path d="'+d+'" fill="none" stroke="#58a6ff" stroke-width="2"/>';
  const ax='<text x="'+p+'" y="'+(H-6)+'" fill="#8aa" font-size="10">'+hhmm(b[0].t)+'</text><text x="'+(W-p)+'" y="'+(H-6)+'" fill="#8aa" font-size="10" text-anchor="end">'+hhmm(b[n-1].t)+'</text><text x="'+p+'" y="14" fill="#8aa" font-size="10">kumulatif $'+cum.toFixed(4)+'</text>';
  el.innerHTML='<svg viewBox="0 0 '+W+' '+H+'" width="100%">'+area+line+ax+'</svg>';
  document.getElementById('costLegend').textContent='biaya kumulatif (USD) · bucket '+(ts.bucketMs/60000)+' menit';
}
async function tick(){
  let d; try{ d=await (await fetch('/api/summary')).json() }catch{ return }
  const h=d.hooks,s=d.siem;
  document.getElementById('meta').textContent='diperbarui '+t(d.generatedAt)+' · '+h.sessions+' sesi · user: '+(s.emails.join(', ')||h.users.join(', ')||'-');
  document.getElementById('cards').innerHTML=[
    card(h.total,'Event hooks'),
    card(h.byDecision.allow||0,'Allow','ok'),
    card(h.byDecision.flag||0,'Flag','flag'),
    card(h.byDecision.block||0,'Block','block'),
    card(s.total,'Event SIEM'),
    card(s.apiRequests,'API request'),
    card('$'+(s.costUsd||0),'Est. biaya'),
  ].join('');
  document.getElementById('recent').innerHTML=h.recent.map(r=>'<tr><td class="mono">'+t(r.ts)+'</td><td>'+(r.user||'')+'</td><td>'+r.kind+'</td><td class="mono">'+(r.tool||'')+(r.mcp?' <span class=muted>['+r.mcp+']</span>':'')+'</td><td><span class="pill '+r.decision+'">'+r.decision+'</span></td></tr>').join('')||'<tr><td colspan=5 class=muted>belum ada aktivitas — login claude & lakukan aksi</td></tr>';
  document.getElementById('enf').innerHTML=h.enforcement.map(r=>'<tr><td class="mono">'+t(r.ts)+'</td><td><span class="pill '+r.decision+'">'+r.decision+'</span></td><td class="mono">'+r.tool+'</td><td class="mono muted" title="'+(r.reason||'').replace(/"/g,'')+'">'+r.rule+'</td></tr>').join('')||'<tr><td colspan=4 class=muted>belum ada block/flag</td></tr>';
  document.getElementById('siem').innerHTML=Object.entries(s.byName).sort((a,b)=>b[1]-a[1]).map(([k,v])=>'<tr><td class="mono">'+k+'</td><td style="text-align:right">'+v+'</td></tr>').join('')||'<tr><td class=muted>belum ada event SIEM (perlu sesi claude baru)</td></tr>';
  renderEvents(d.timeseries); renderCost(d.timeseries);
}
tick(); setInterval(tick,3000);
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/summary')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(summary()));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
server.listen(PORT, () => console.log(`Trapping dashboard: http://localhost:${PORT}`));
