#!/usr/bin/env node
/**
 * Dashboard monitoring (live, WebSocket granular + filter).
 * - Sumber: data/audit/hooks-*.jsonl (capture+enforce) & data/siem/hec-received.jsonl (SIEM).
 * - WebSocket /ws: push tiap event baru (granular) + 'meta' saat SIEM berubah. Fallback: /api/data.
 * - Filter (klien): per-user, per-tool, rentang waktu (15m/1j/24j/semua).
 * Tanpa dependensi npm. DATA_DIR & PORT via env.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DATA_DIR || path.resolve(__dirname, '..', 'data');
const AUDIT = path.join(DATA, 'audit');
const SIEM = path.join(DATA, 'siem', 'hec-received.jsonl');
const PORT = Number(process.env.PORT || 8090);
const TEST_IDS = new Set(['t', 'demo', 'demo-sess']);
const MAXEV = 3000;

const readJsonl = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean); } catch { return []; } };

function loadHooks() {
  let files = [];
  try { files = fs.readdirSync(AUDIT).filter((f) => f.startsWith('hooks-')).sort(); } catch {}
  const ev = [];
  for (const f of files) for (const line of readJsonl(path.join(AUDIT, f))) {
    try { const e = JSON.parse(line); if (!TEST_IDS.has(e.session_id)) ev.push(e); } catch {}
  }
  return ev;
}
function loadSiem() {
  const out = [];
  for (const line of readJsonl(SIEM)) {
    try { const o = JSON.parse(line); const f = o.fields || {};
      out.push({ name: f['event.name'] || o.event || '?', email: f['user.email'] || null, time: Number(o.time) || null, fields: f });
    } catch {}
  }
  return out;
}
const mapEvent = (e) => ({
  ts: Date.parse(e.timestamp) || 0, user: e.user_id || '?', kind: e.event_kind || '?',
  tool: e.tool_name || '', decision: e.decision || 'allow', reason: e.decision_reason || '',
  rule: e.policy_rule_id || '', mcp: e.mcp_invocation ? e.mcp_invocation.mcp_server : '', session: e.session_id || '',
});
function siemAggregate(siem) {
  const costPoints = [], byName = {}, emails = new Set();
  for (const s of siem) {
    byName[s.name] = (byName[s.name] || 0) + 1;
    if (s.email) emails.add(s.email);
    let c = Number(s.fields.cost_usd ?? 0); if (Number.isNaN(c)) c = 0;
    for (const [k, v] of Object.entries(s.fields)) if (k.includes('cost.usage') && typeof v === 'number') c += v;
    if (c > 0 && s.time) costPoints.push({ ts: s.time * 1000, cost: c });
  }
  return { costPoints, siemByName: byName, emails: [...emails] };
}
// Ekstrak teks dari body response API (JSON Messages) -> gabungan blok teks
function respText(body) {
  if (!body) return '';
  try { const o = JSON.parse(body); if (Array.isArray(o.content)) return o.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'); } catch {}
  return String(body);
}
// Telemetri kaya dari OTel/SIEM: korelasi prompt<->request<->response via prompt.id
function loadTelemetry(siem) {
  const byPid = {}; let tIn = 0, tOut = 0, cost = 0;
  const skills = {}, plugins = {}, commands = {};
  const get = (pid) => byPid[pid] || (byPid[pid] = { promptId: pid, ts: 0, session: '', prompt: '', response: '', model: '', tokensIn: 0, tokensOut: 0, cost: 0 });
  for (const s of siem) {
    const f = s.fields, nn = (s.name || '').replace(/^claude_code\./, ''), pid = f['prompt.id'] || ('_' + (f['session.id'] || 'x')), ts = s.time ? s.time * 1000 : 0;
    if (nn === 'user_prompt') { const r = get(pid); r.prompt = (f.prompt || r.prompt || '').slice(0, 2000); r.session = f['session.id'] || r.session; if (ts) r.ts = ts; if (f.command_name) commands[f.command_name] = (commands[f.command_name] || 0) + 1; }
    else if (nn === 'api_request') { const r = get(pid); const i = +f.input_tokens || 0, o = +f.output_tokens || 0, c = +f.cost_usd || 0; r.tokensIn += i; r.tokensOut += o; r.cost += c; r.model = f.model || r.model; if (ts) r.ts = ts; tIn += i; tOut += o; cost += c; }
    else if (nn === 'api_response_body') { const r = get(pid); r.response = (respText(f.body) || r.response || '').slice(0, 1500); if (ts) r.ts = ts; }
    else if (nn === 'skill_activated') { const k = f['skill.name'] || '?'; skills[k] = (skills[k] || 0) + 1; }
    else if (nn === 'plugin_loaded' || nn === 'plugin_installed') { const k = f['plugin.name'] || '?'; plugins[k] = (plugins[k] || 0) + 1; }
  }
  const conversations = Object.values(byPid).filter((r) => r.prompt || r.response).sort((a, b) => a.ts - b.ts).slice(-50);
  return { tokensIn: tIn, tokensOut: tOut, cost: Number(cost.toFixed(4)), skills, plugins, commands, conversations };
}
function buildData() {
  const events = loadHooks().slice(-MAXEV).map(mapEvent);
  const siem = loadSiem();
  return { generatedAt: new Date().toISOString(), events, ...siemAggregate(siem), telemetry: loadTelemetry(siem) };
}

// ---------------- WebSocket (raw RFC6455, server->client) ----------------
const wsClients = new Set();
function wsFrame(str, opcode = 0x1) {
  const payload = Buffer.from(str);
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}
function wsSend(sock, obj) { try { sock.write(wsFrame(JSON.stringify(obj))); } catch {} }
function broadcast(obj) { const f = wsFrame(JSON.stringify(obj)); for (const s of wsClients) { try { s.write(f); } catch {} } }

// ---------------- Poll loop: deteksi perubahan, push granular ----------------
let lastCount = 0, lastSiemSig = '';
const siemSig = () => { try { const st = fs.statSync(SIEM); return `${st.size}:${st.mtimeMs}`; } catch { return ''; } };
lastCount = loadHooks().length; lastSiemSig = siemSig();
setInterval(() => {
  const hooks = loadHooks();
  if (hooks.length < lastCount) { lastCount = hooks.length; broadcast({ type: 'init', data: buildData() }); lastSiemSig = siemSig(); return; }
  if (hooks.length > lastCount) {
    for (const e of hooks.slice(lastCount)) broadcast({ type: 'event', e: mapEvent(e) });
    lastCount = hooks.length;
  }
  const ss = siemSig();
  if (ss !== lastSiemSig) { lastSiemSig = ss; const siem = loadSiem(); broadcast({ type: 'meta', ...siemAggregate(siem), telemetry: loadTelemetry(siem) }); }
}, 700);
setInterval(() => { const ping = wsFrame('', 0x9); for (const s of wsClients) { try { s.write(ping); } catch {} } }, 20000);

// ---------------- HTTP + WS upgrade ----------------
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/data')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(buildData())); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
server.on('upgrade', (req, sock) => {
  if (!req.url.startsWith('/ws')) { sock.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  wsClients.add(sock);
  wsSend(sock, { type: 'init', data: buildData() });
  sock.on('close', () => wsClients.delete(sock));
  sock.on('error', () => wsClients.delete(sock));
  sock.on('data', () => {}); // abaikan frame klien (cukup deteksi close/error)
});
server.listen(PORT, () => console.log(`Trapping dashboard (WS live + filter): http://localhost:${PORT}`));

// ---------------- Halaman ----------------
const PAGE = `<!doctype html><html lang="id"><head><meta charset="utf-8">
<title>Trapping Monitor — Claude Code CLI</title>
<style>
  :root{--bg:#0f1419;--card:#1a2230;--mut:#8aa;--ok:#3fb950;--flag:#d29922;--block:#f85149;--txt:#e6edf3}
  *{box-sizing:border-box} body{margin:0;font:14px/1.4 system-ui,Segoe UI,sans-serif;background:var(--bg);color:var(--txt)}
  header{padding:14px 20px;border-bottom:1px solid #30363d;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
  h1{font-size:16px;margin:0} .sub{color:var(--mut);font-size:12px}
  .wrap{padding:16px 20px;display:grid;gap:16px}
  .bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;background:var(--card);border:1px solid #30363d;border-radius:10px;padding:10px 14px}
  .bar label{color:var(--mut);font-size:12px;margin-right:4px} select,.rbtn{background:#0f1419;color:var(--txt);border:1px solid #30363d;border-radius:7px;padding:5px 9px;font-size:12px;cursor:pointer}
  .rbtn.active{background:#1f6feb;border-color:#1f6feb;color:#fff}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
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
  #ticker{max-height:120px;overflow:auto;font-family:ui-monospace,Consolas,monospace;font-size:11.5px}
  #ticker div{padding:1px 0;border-bottom:1px solid #161d27}
</style></head><body>
<header><div><h1>🛡️ Activity Trapping — Claude Code CLI</h1><div class="sub" id="meta">memuat…</div></div>
<div class="sub" id="live">● menyambung…</div></header>
<div class="wrap">
  <div class="bar">
    <span><label>User</label><select id="fUser"><option value="">semua</option></select></span>
    <span><label>Tool</label><select id="fTool"><option value="">semua</option></select></span>
    <span><label>Rentang</label>
      <span class="rbtn" data-r="900000">15m</span><span class="rbtn" data-r="3600000">1j</span>
      <span class="rbtn" data-r="86400000">24j</span><span class="rbtn active" data-r="0">semua</span>
    </span>
    <span class="sub" id="filtinfo" style="margin-left:auto"></span>
  </div>
  <div class="cards" id="cards"></div>
  <div class="grid2">
    <div class="card"><h2>Tren event / waktu</h2><div id="chartEvents"></div><div class="muted" style="font-size:11px;margin-top:6px"><span class="ok">█</span> allow &nbsp;<span class="flag">█</span> flag &nbsp;<span class="block">█</span> block</div></div>
    <div class="card"><h2>Tren biaya / waktu</h2><div id="chartCost"></div><div class="muted" id="costLegend" style="font-size:11px;margin-top:6px"></div></div>
  </div>
  <div class="card"><h2>Live ticker (event granular via WebSocket)</h2><div id="ticker"></div></div>
  <div class="card"><h2>Telemetri OTel — prompt → response · skill / plugin / command · token</h2>
    <div class="sub" id="spc" style="margin-bottom:8px"></div>
    <table><thead><tr><th>Waktu</th><th>Model</th><th>Tok in/out</th><th>$</th><th>Prompt</th><th>Response</th></tr></thead><tbody id="conv"></tbody></table>
  </div>
  <div class="grid2">
    <div class="card"><h2>Aktivitas terbaru</h2><table><thead><tr><th>Waktu</th><th>User</th><th>Jenis</th><th>Tool</th><th>Keputusan</th></tr></thead><tbody id="recent"></tbody></table></div>
    <div class="card"><h2>Enforcement (block / flag)</h2><table><thead><tr><th>Waktu</th><th>Keputusan</th><th>Tool</th><th>Rule</th></tr></thead><tbody id="enf"></tbody></table>
      <h2 style="margin-top:14px">SIEM — event by name</h2><table><tbody id="siem"></tbody></table>
    </div>
  </div>
</div>
<script>
const t=ms=>new Date(ms).toISOString().slice(11,19);
const hhmm=ms=>new Date(ms).toISOString().slice(11,16);
let S={events:[],costPoints:[],siemByName:{},emails:[],telemetry:{tokensIn:0,tokensOut:0,cost:0,skills:{},plugins:{},commands:{},conversations:[]}};
let filt={user:'',tool:'',range:0};
const esc=s=>(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
const snip=(s,n)=>{s=(s||'').replace(/\s+/g,' ').trim();return esc(s.length>n?s.slice(0,n)+'…':s);};
const chips=o=>Object.entries(o||{}).map(([k,v])=>k+'×'+v).join(', ')||'-';

function within(ts){return !filt.range||ts>=Date.now()-filt.range;}
function fEvents(){return S.events.filter(e=>within(e.ts)&&(!filt.user||e.user===filt.user)&&(!filt.tool||e.tool===filt.tool));}
function fCost(){return S.costPoints.filter(p=>within(p.ts));}

function fillSelect(id,vals){
  const el=document.getElementById(id),cur=el.value;
  el.innerHTML='<option value="">semua</option>'+vals.filter(Boolean).sort().map(v=>'<option>'+v+'</option>').join('');
  el.value=cur;
}
function card(n,l,cls){return '<div class="card"><div class="n '+(cls||'')+'">'+n+'</div><div class="l">'+l+'</div></div>'}

function buildTS(events,cost){
  const ms=[...events.map(e=>e.ts),...cost.map(c=>c.ts)].filter(Boolean);
  if(!ms.length)return null;
  const min=Math.min(...ms),max=Math.max(...ms),span=Math.max(0,max-min);
  const bucketMs=Math.max(60000,Math.ceil((span/40)/60000)*60000);
  const n=Math.min(180,Math.floor(span/bucketMs)+1);
  const b=Array.from({length:n},(_,i)=>({t:min+i*bucketMs,allow:0,flag:0,block:0,total:0,cost:0}));
  const idx=x=>Math.min(n-1,Math.max(0,Math.floor((x-min)/bucketMs)));
  for(const e of events){const k=idx(e.ts);b[k][e.decision]=(b[k][e.decision]||0)+1;b[k].total++;}
  for(const c of cost){b[idx(c.ts)].cost+=c.cost;}
  return {bucketMs,buckets:b};
}
function renderEvents(ts){const el=document.getElementById('chartEvents');
  if(!ts){el.innerHTML='<div class="muted">belum ada data</div>';return;}
  const b=ts.buckets,W=560,H=150,p=24,n=b.length,maxT=Math.max(1,...b.map(x=>x.total));
  const bw=Math.max(2,(W-2*p)/n-2),C={allow:'#3fb950',flag:'#d29922',block:'#f85149'};let bars='';
  b.forEach((x,i)=>{let x0=p+i*((W-2*p)/n),y=H-p;for(const k of['allow','flag','block']){const h=(x[k]/maxT)*(H-2*p);if(h>0){y-=h;bars+='<rect x="'+x0.toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+h.toFixed(1)+'" fill="'+C[k]+'"/>';}}});
  const ax='<text x="'+p+'" y="'+(H-6)+'" fill="#8aa" font-size="10">'+hhmm(b[0].t)+'</text><text x="'+(W-p)+'" y="'+(H-6)+'" fill="#8aa" font-size="10" text-anchor="end">'+hhmm(b[n-1].t)+'</text><text x="'+p+'" y="14" fill="#8aa" font-size="10">max '+maxT+'/bucket</text>';
  el.innerHTML='<svg viewBox="0 0 '+W+' '+H+'" width="100%">'+bars+ax+'</svg>';}
function renderCost(ts){const el=document.getElementById('chartCost');
  if(!ts){el.innerHTML='<div class="muted">belum ada data</div>';document.getElementById('costLegend').textContent='';return;}
  const b=ts.buckets,W=560,H=150,p=24,n=b.length;let cum=0;const pts=b.map(x=>{cum+=x.cost;return cum;});
  const maxC=Math.max(0.0001,...pts),X=i=>p+i*((W-2*p)/Math.max(1,n-1)),Y=v=>H-p-(v/maxC)*(H-2*p);
  let d='';b.forEach((x,i)=>{d+=(i?'L':'M')+X(i).toFixed(1)+' '+Y(pts[i]).toFixed(1)+' ';});
  const area='<path d="'+d+'L '+X(n-1).toFixed(1)+' '+(H-p)+' L '+X(0).toFixed(1)+' '+(H-p)+' Z" fill="#1f6feb33"/>';
  const line='<path d="'+d+'" fill="none" stroke="#58a6ff" stroke-width="2"/>';
  const ax='<text x="'+p+'" y="'+(H-6)+'" fill="#8aa" font-size="10">'+hhmm(b[0].t)+'</text><text x="'+(W-p)+'" y="'+(H-6)+'" fill="#8aa" font-size="10" text-anchor="end">'+hhmm(b[n-1].t)+'</text><text x="'+p+'" y="14" fill="#8aa" font-size="10">kumulatif $'+cum.toFixed(4)+'</text>';
  el.innerHTML='<svg viewBox="0 0 '+W+' '+H+'" width="100%">'+area+line+ax+'</svg>';
  document.getElementById('costLegend').textContent='biaya kumulatif (USD) · bucket '+(ts.bucketMs/60000)+' menit';}

function render(){
  fillSelect('fUser',[...new Set(S.events.map(e=>e.user))]);
  fillSelect('fTool',[...new Set(S.events.map(e=>e.tool).filter(Boolean))]);
  const ev=fEvents(),cost=fCost();
  const dec={allow:0,flag:0,block:0};for(const e of ev)dec[e.decision]=(dec[e.decision]||0)+1;
  const cum=cost.reduce((s,c)=>s+c.cost,0);
  document.getElementById('meta').textContent=S.events.length+' event · user: '+(S.emails.join(', ')||'-');
  document.getElementById('filtinfo').textContent='menampilkan '+ev.length+' event'+(filt.user?' · user='+filt.user:'')+(filt.tool?' · tool='+filt.tool:'');
  const tel=S.telemetry||{tokensIn:0,tokensOut:0,cost:0,skills:{},plugins:{},commands:{},conversations:[]};
  document.getElementById('cards').innerHTML=[
    card(ev.length,'Event'),card(dec.allow,'Allow','ok'),card(dec.flag,'Flag','flag'),card(dec.block,'Block','block'),
    card(Object.values(S.siemByName).reduce((a,b)=>a+b,0),'Event SIEM'),
    card(tel.tokensIn+' / '+tel.tokensOut,'Token in/out'),card('$'+(tel.cost||0).toFixed(4),'Biaya total')
  ].join('');
  const ts=buildTS(ev,cost);renderEvents(ts);renderCost(ts);
  // Telemetri OTel: chips + percakapan
  document.getElementById('spc').innerHTML='Skills: '+chips(tel.skills)+' &nbsp;|&nbsp; Plugins: '+chips(tel.plugins)+' &nbsp;|&nbsp; Slash-commands: '+chips(tel.commands);
  const conv=(tel.conversations||[]).filter(c=>within(c.ts)).slice(-40).reverse();
  document.getElementById('conv').innerHTML=conv.map(c=>'<tr><td class="mono">'+t(c.ts)+'</td><td class="mono">'+(c.model||'')+'</td><td class="mono">'+c.tokensIn+'/'+c.tokensOut+'</td><td class="mono">$'+(c.cost||0).toFixed(4)+'</td><td title="'+esc(c.prompt)+'">'+snip(c.prompt,70)+'</td><td title="'+esc(c.response)+'">'+snip(c.response,70)+'</td></tr>').join('')||'<tr><td colspan=6 class=muted>belum ada percakapan (perlu sesi claude baru dgn raw bodies aktif)</td></tr>';
  document.getElementById('recent').innerHTML=ev.slice(-60).reverse().map(r=>'<tr><td class="mono">'+t(r.ts)+'</td><td>'+r.user+'</td><td>'+r.kind+'</td><td class="mono">'+(r.tool||'')+(r.mcp?' <span class=muted>['+r.mcp+']</span>':'')+'</td><td><span class="pill '+r.decision+'">'+r.decision+'</span></td></tr>').join('')||'<tr><td colspan=5 class=muted>belum ada aktivitas</td></tr>';
  document.getElementById('enf').innerHTML=ev.filter(e=>e.decision!=='allow').slice(-30).reverse().map(r=>'<tr><td class="mono">'+t(r.ts)+'</td><td><span class="pill '+r.decision+'">'+r.decision+'</span></td><td class="mono">'+r.tool+'</td><td class="mono muted">'+r.rule+'</td></tr>').join('')||'<tr><td colspan=4 class=muted>belum ada block/flag</td></tr>';
  document.getElementById('siem').innerHTML=Object.entries(S.siemByName).sort((a,b)=>b[1]-a[1]).map(([k,v])=>'<tr><td class="mono">'+k+'</td><td style="text-align:right">'+v+'</td></tr>').join('')||'<tr><td class=muted>belum ada event SIEM</td></tr>';
}
function pushTicker(e){const el=document.getElementById('ticker');const sym=e.decision==='block'?'⛔':e.decision==='flag'?'⚑':'·';
  const row=document.createElement('div');row.innerHTML='<span class="'+e.decision+'">'+sym+'</span> '+t(e.ts)+'  '+e.kind+'  '+(e.tool||'')+(e.mcp?' ['+e.mcp+']':'');
  el.prepend(row);while(el.childNodes.length>50)el.removeChild(el.lastChild);}

// filter handlers
document.getElementById('fUser').onchange=e=>{filt.user=e.target.value;render();};
document.getElementById('fTool').onchange=e=>{filt.tool=e.target.value;render();};
document.querySelectorAll('.rbtn').forEach(b=>b.onclick=()=>{document.querySelectorAll('.rbtn').forEach(x=>x.classList.remove('active'));b.classList.add('active');filt.range=Number(b.dataset.r);render();});

// koneksi: WebSocket (granular) + fallback polling
const live=document.getElementById('live');
function connectWS(){
  const proto=location.protocol==='https:'?'wss':'ws';
  const ws=new WebSocket(proto+'://'+location.host+'/ws');
  ws.onopen=()=>{live.innerHTML='<span class="ok">●</span> LIVE (WebSocket)';};
  ws.onmessage=m=>{let msg;try{msg=JSON.parse(m.data);}catch{return;}
    if(msg.type==='init'){S=msg.data;render();}
    else if(msg.type==='event'){S.events.push(msg.e);if(S.events.length>3000)S.events.shift();pushTicker(msg.e);render();}
    else if(msg.type==='meta'){S.costPoints=msg.costPoints;S.siemByName=msg.siemByName;S.emails=msg.emails;if(msg.telemetry)S.telemetry=msg.telemetry;render();}
  };
  ws.onclose=()=>{live.innerHTML='<span class="flag">●</span> menyambung ulang…';setTimeout(connectWS,2000);};
  ws.onerror=()=>ws.close();
}
if(window.WebSocket){connectWS();}
else{live.textContent='polling (browser tanpa WebSocket)';
  async function poll(){try{S=await (await fetch('/api/data')).json();render();}catch{}}poll();setInterval(poll,3000);}
</script></body></html>`;
