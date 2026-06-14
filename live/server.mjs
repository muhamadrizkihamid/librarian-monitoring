#!/usr/bin/env node
/**
 * trapping-live — Live Activity Dashboard (single dashboard, gabungan dari eks-:8789).
 *
 * Arsitektur:
 *   Claude CLI -> OTel Collector ─┬─> ClickHouse (SigNoz)  = BACKUP PERMANEN / source of truth
 *                                 └─> trapping-live: pemicu refresh (HEC)
 *   trapping-live: POLL ClickHouse (30 hari) -> cache Redis (TTL 30 hari) -> render -> WebSocket.
 *   Liveness: tiap event HEC dari collector memicu refresh (debounce ~0.8s) + safety poll REFRESH_MS.
 *   Restart-safe: rehydrate dari Redis saat start (tak tergantung ClickHouse untuk paint pertama).
 *
 * ENV: PORT(8091) CH_URL(http://signoz-clickhouse:8123) REDIS_HOST(redis) REDIS_PORT(6379)
 *      WINDOW_DAYS(30) REFRESH_MS(5000) TTL_SECONDS(2592000)
 */
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 8091);
const CH_URL = process.env.CH_URL || 'http://signoz-clickhouse:8123';
const REDIS_HOST = process.env.REDIS_HOST || 'redis';
const REDIS_PORT = Number(process.env.REDIS_PORT || 6379);
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 30);
const REFRESH_MS = Number(process.env.REFRESH_MS || 5000);
const TTL = Number(process.env.TTL_SECONDS || 2592000);   // 30 hari
const ACTIVE_MIN = Number(process.env.ACTIVE_MIN || 30);  // sesi "active" = aktif <= N menit & belum SessionEnd
const MAXEV = 800, MAXCONV = 400;
// kolom `timestamp` = UInt64 NANODETIK -> filter via DateTime64; epoch-ms via intDiv.
const WINDOW = `fromUnixTimestamp64Nano(timestamp) > now() - INTERVAL ${WINDOW_DAYS} DAY`;
const MS = (e) => `intDiv(${e}, 1000000)`;
const SNAP_KEY = 'live:snapshot';

// ---------------- Redis (RESP, zero-dep) ----------------
class Redis {
  constructor(h, p) { this.h = h; this.p = p; this.q = []; this.buf = Buffer.alloc(0); this.ready = false; this.connect(); }
  connect() {
    this.s = net.connect(this.p, this.h);
    this.s.on('connect', () => { this.ready = true; });
    this.s.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
    this.s.on('error', (e) => { this.ready = false; process.stdout.write(`[redis] ${e.message}\n`); });
    this.s.on('close', () => { this.ready = false; setTimeout(() => this.connect(), 1500); });
  }
  async waitReady(ms = 5000) { const t = Date.now(); while (!this.ready && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 150)); return this.ready; }
  cmd(...a) {
    return new Promise((resolve, reject) => {
      if (!this.ready) return reject(new Error('redis not ready'));
      let s = `*${a.length}\r\n`; for (const x of a) { const v = String(x); s += `$${Buffer.byteLength(v)}\r\n${v}\r\n`; }
      this.q.push({ resolve, reject }); this.s.write(s);
    });
  }
  parse(b, o) {
    if (o >= b.length) return null; const t = String.fromCharCode(b[o]); const nl = b.indexOf('\r\n', o); if (nl < 0) return null;
    const line = b.toString('utf8', o + 1, nl); const a = nl + 2;
    if (t === '+') return [line, a]; if (t === '-') return [new Error(line), a]; if (t === ':') return [Number(line), a];
    if (t === '$') { const n = Number(line); if (n === -1) return [null, a]; if (a + n + 2 > b.length) return null; return [b.toString('utf8', a, a + n), a + n + 2]; }
    if (t === '*') { const n = Number(line); if (n === -1) return [null, a]; const arr = []; let p = a; for (let i = 0; i < n; i++) { const r = this.parse(b, p); if (!r) return null; arr.push(r[0]); p = r[1]; } return [arr, p]; }
    return [null, a];
  }
  drain() { while (this.q.length) { const r = this.parse(this.buf, 0); if (!r) break; this.buf = this.buf.subarray(r[1]); const { resolve, reject } = this.q.shift(); if (r[0] instanceof Error) reject(r[0]); else resolve(r[0]); } }
}
const redis = new Redis(REDIS_HOST, REDIS_PORT);

// ---------------- ClickHouse HTTP ----------------
async function ch(sql) {
  const r = await fetch(`${CH_URL}/?default_format=JSON`, { method: 'POST', body: sql });
  if (!r.ok) throw new Error(`CH ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return (await r.json()).data || [];
}
const N = (x) => Number(x || 0);
function respText(body) {
  if (!body) return '';
  try { const o = typeof body === 'string' ? JSON.parse(body) : body; if (Array.isArray(o.content)) return o.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'); } catch {}
  return String(body);
}

// ---------------- state (dibangun dari ClickHouse, di-cache di Redis) ----------------
let STATE = { events: [], totals: { cost: 0, tokensIn: 0, tokensOut: 0, events: 0, blocked: 0, users: 0 }, conversations: [], agg: { tool: {}, decision: {}, kind: {}, user: {}, userTokens: {} }, sessionEnds: {} };

// Bangun state 30 hari dari ClickHouse -> bentuk yang dipakai klien :8091.
async function buildState(scope = {}) {
  const T = 'signoz_logs.distributed_logs_v2';
  const S = (k) => `attributes_string['${k}']`;
  const [sessRows, apiRows, promptRows, respRows, hookRows, endRows] = await Promise.all([
    ch(`SELECT ${S('session.id')} sid, anyIf(${S('user.email')}, ${S('user.email')}!='') user, ${MS('min(timestamp)')} first_ms, ${MS('max(timestamp)')} last_ms FROM ${T} WHERE resources_string['service.name']='claude-code' AND ${S('session.id')}!='' AND ${WINDOW} GROUP BY sid`),
    ch(`SELECT ${S('session.id')} sid, ${S('prompt.id')} pid, anyIf(${S('model')},${S('model')}!='') model, toUInt64(sum(attributes_number['input_tokens'])) tin, toUInt64(sum(attributes_number['output_tokens'])) tout, toUInt64(sum(attributes_number['cache_creation_tokens']+attributes_number['cache_read_tokens'])) tcache, round(sum(attributes_number['cost_usd']),4) cost, ${MS('max(timestamp)')} ts FROM ${T} WHERE ${S('event.name')}='api_request' AND ${S('prompt.id')}!='' AND ${WINDOW} GROUP BY sid,pid`),
    ch(`SELECT ${S('session.id')} sid, ${S('prompt.id')} pid, ${MS('max(timestamp)')} ts, argMax(${S('prompt')},timestamp) prompt FROM ${T} WHERE ${S('event.name')}='user_prompt' AND ${S('prompt.id')}!='' AND ${WINDOW} GROUP BY sid,pid`),
    ch(`SELECT ${S('prompt.id')} pid, argMax(${S('body')},timestamp) body FROM ${T} WHERE ${S('event.name')}='api_response_body' AND ${S('prompt.id')}!='' AND ${WINDOW} GROUP BY pid`),
    ch(`SELECT ${MS('timestamp')} ts, ${S('session.id')} sid, ${S('event_kind')} kind, ${S('tool_name')} tool, ${S('decision')} decision, substring(${S('command')},1,200) command, ${S('policy_rule_id')} rule, substring(${S('decision_reason')},1,200) reason FROM ${T} WHERE resources_string['service.name']='claude-code-hook' AND ${WINDOW} ORDER BY timestamp DESC LIMIT ${MAXEV}`),
    ch(`SELECT ${S('session.id')} sid, ${MS('max(timestamp)')} end_ms FROM ${T} WHERE ${S('event.name')}='claude_code.hook.SessionEnd' AND ${S('session.id')}!='' AND ${WINDOW} GROUP BY sid`),
  ]);

  const sessUser = new Map(); for (const r of sessRows) if (r.user) sessUser.set(r.sid, r.user);
  const userOf = (sid) => sessUser.get(sid) || '';

  // Sesi berakhir EKSPLISIT = hook SessionEnd (graceful). Kill/close manual TIDAK kirim event.
  const sessionEnds = {}; for (const r of endRows) sessionEnds[r.sid] = N(r.end_ms);
  // aktivitas terakhir per sesi (lintas semua event) -> ACTIVE = belum SessionEnd & aktif <= ACTIVE_MIN menit
  const sessionLast = new Map();
  const bump = (sid, ts) => { if (sid && ts) { const c = sessionLast.get(sid) || 0; if (ts > c) sessionLast.set(sid, ts); } };
  for (const r of sessRows) bump(r.sid, N(r.last_ms));
  for (const r of apiRows) bump(r.sid, N(r.ts));
  for (const r of promptRows) bump(r.sid, N(r.ts));
  for (const r of hookRows) bump(r.sid, N(r.ts));
  const NOWMS = Date.now(), ACTIVE_MS = ACTIVE_MIN * 60000, IDLE_MS = 24 * 3600 * 1000;
  // bucket sesi: active (≤ACTIVE_MIN) / idle (≤1 hari, belum SessionEnd) / closed (SessionEnd ATAU >1 hari = kill/close manual)
  const bucket = (sid) => { if (sessionEnds[sid]) return 'closed'; const age = NOWMS - (sessionLast.get(sid) || 0); return age <= ACTIVE_MS ? 'active' : (age <= IDLE_MS ? 'idle' : 'closed'); };
  const isActive = (sid) => !!sid && bucket(sid) === 'active';
  // scope: active selalu termasuk; idle/closed opsional + filter rentang tanggal (scope.from/to = epoch ms)
  const inScope = (sid) => {
    if (!sid) return false; const b = bucket(sid); if (b === 'active') return true;
    const ref = sessionEnds[sid] || sessionLast.get(sid) || 0;
    const inRange = (!scope.from || ref >= scope.from) && (!scope.to || ref <= scope.to);
    if (b === 'idle') return !!scope.idle && inRange;
    if (b === 'closed') return !!scope.closed && inRange;
    return false;
  };

  const agg = { tool: {}, decision: {}, kind: {}, user: {}, userTokens: {} };
  const inc = (m, k) => { if (k) m[k] = (m[k] || 0) + 1; };
  let tokensIn = 0, tokensOut = 0, cost = 0; const usersSet = new Set();

  for (const r of apiRows) { if (!inScope(r.sid)) continue; const u = userOf(r.sid); tokensIn += N(r.tin); tokensOut += N(r.tout); cost += N(r.cost); if (u) { agg.userTokens[u] = (agg.userTokens[u] || 0) + N(r.tin) + N(r.tout) + N(r.tcache); usersSet.add(u); } }

  // percakapan per prompt
  const resp = new Map(respRows.map((r) => [r.pid, respText(r.body)]));
  const api = new Map(apiRows.map((r) => [r.pid, r]));
  const pidMeta = new Map();
  for (const r of promptRows) pidMeta.set(r.pid, { sid: r.sid, ts: N(r.ts), prompt: r.prompt || '' });
  for (const r of apiRows) if (!pidMeta.has(r.pid)) pidMeta.set(r.pid, { sid: r.sid, ts: N(r.ts), prompt: '' });
  const conversations = [];
  for (const [pid, m] of pidMeta) {
    if (!inScope(m.sid)) continue;
    const a = api.get(pid); const u = userOf(m.sid); if (u) usersSet.add(u);
    conversations.push({ promptId: pid, ts: N(a?.ts || m.ts), session: m.sid, user: u, prompt: m.prompt, response: resp.get(pid) || '', model: a?.model || '', tokensIn: N(a?.tin), tokensOut: N(a?.tout), cost: N(a?.cost) });
  }
  conversations.sort((x, y) => x.ts - y.ts);

  // ticker event (hook) + agg + blocked
  const events = []; let blocked = 0;
  for (const r of hookRows.slice().reverse()) { // lama -> baru
    if (!inScope(r.sid)) continue;
    const u = userOf(r.sid); if (u) usersSet.add(u);
    const dec = r.decision || 'allow';
    events.push({ ts: N(r.ts), user: u || '?', email: u || '', kind: r.kind || '', tool: r.tool || '', decision: dec, reason: r.reason || '', session: r.sid || '', command: r.command || '', mode: '', rule: r.rule || '' });
    inc(agg.tool, r.tool); inc(agg.decision, dec); inc(agg.kind, r.kind); inc(agg.user, u || '?');
    if (dec === 'block' || dec === 'flag' || dec === 'deny') blocked++;
  }

  const totals = { cost, tokensIn, tokensOut, events: events.length, blocked, users: usersSet.size };
  const activeCount = [...sessionLast.keys()].filter(isActive).length;
  return { events, totals, conversations: conversations.slice(-MAXCONV), agg, sessionEnds, activeCount };
}

// ---------------- persist / rehydrate Redis (TTL 30 hari; backup permanen di ClickHouse) ----------------
async function persist(s) { try { await redis.cmd('SET', SNAP_KEY, JSON.stringify(s), 'EX', TTL); } catch {} }
async function rehydrate() {
  try { const v = await redis.cmd('GET', SNAP_KEY); if (v) { STATE = JSON.parse(v); process.stdout.write(`[trapping-live] rehydrate Redis: ${STATE.events.length} event, ${STATE.conversations.length} prompt\n`); } }
  catch (e) { process.stdout.write(`[trapping-live] rehydrate skip: ${e.message}\n`); }
}

// ---------------- WebSocket (raw RFC6455) ----------------
const wsClients = new Set();
function wsFrame(str, opcode = 0x1) {
  const payload = Buffer.from(str); const len = payload.length; let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}
const wsSend = (sock, obj) => { try { sock.write(wsFrame(JSON.stringify(obj))); } catch {} };
function broadcast(obj) { const fr = wsFrame(JSON.stringify(obj)); for (const s of wsClients) { try { s.write(fr); } catch {} } }

// refresh: bangun dari ClickHouse -> cache Redis -> broadcast (debounce dari pemicu HEC + safety poll)
let refreshing = false, dirty = false, debounce = null;
async function refresh() {
  if (refreshing) { dirty = true; return; }
  refreshing = true;
  try { const s = await buildState(); STATE = s; await persist(s); broadcast({ type: 'snapshot', ...s }); }
  catch (e) { process.stdout.write(`[trapping-live] refresh err: ${e.message}\n`); }
  finally { refreshing = false; if (dirty) { dirty = false; refresh(); } }
}
function scheduleRefresh() { if (debounce) return; debounce = setTimeout(() => { debounce = null; refresh(); }, 800); }
setInterval(() => { const ping = wsFrame('', 0x9); for (const s of wsClients) { try { s.write(ping); } catch {} } }, 20000);

// ---------------- HTTP: HEC ingest + dashboard ----------------
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.includes('/services/collector') && req.url.includes('health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"text":"HEC is healthy","code":17}');
  }
  if (req.method === 'POST' && req.url.includes('/services/collector')) {
    // Event dari collector hanya jadi PEMICU refresh; data sebenarnya dibaca dari ClickHouse->Redis.
    let body = ''; req.on('data', (c) => (body += c));
    req.on('end', () => { scheduleRefresh(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"text":"Success","code":0}'); });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/api/scope')) {
    // GET data dengan scope: ?include=idle,closed&from=YYYY-MM-DD&to=YYYY-MM-DD (active selalu termasuk)
    try {
      const u = new URL(req.url, 'http://x'); const inc = (u.searchParams.get('include') || '').split(',');
      const pd = (s, end) => { if (!s) return null; const d = new Date(s + 'T00:00:00Z'); return isNaN(d) ? null : (end ? d.getTime() + 86400000 - 1 : d.getTime()); };
      const scope = { idle: inc.includes('idle'), closed: inc.includes('closed'), from: pd(u.searchParams.get('from')), to: pd(u.searchParams.get('to'), true) };
      buildState(scope).then((s) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(s)); }).catch((e) => { res.writeHead(500); res.end(String(e.message)); });
    } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    return;
  }
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(HTML);
  }
  if (req.method === 'GET' && req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  res.writeHead(404); res.end('not found');
});

server.on('upgrade', (req, sock) => {
  if (!req.url.startsWith('/ws')) { sock.destroy(); return; }
  const key = (req.headers['sec-websocket-key'] || '').trim();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  wsClients.add(sock);
  wsSend(sock, { type: 'snapshot', ...STATE });
  sock.on('close', () => wsClients.delete(sock));
  sock.on('error', () => wsClients.delete(sock));
  sock.on('data', () => {});
});

server.listen(PORT, async () => {
  process.stdout.write(`[trapping-live] :${PORT} | CH=${CH_URL} | Redis=${REDIS_HOST}:${REDIS_PORT} | window=${WINDOW_DAYS}d (ClickHouse->Redis, live via pemicu HEC)\n`);
  await redis.waitReady(5000);
  await rehydrate();                              // tampilkan data lama segera (restart-safe)
  broadcast({ type: 'snapshot', ...STATE });
  await refresh();                               // tarik segar dari ClickHouse
  setInterval(refresh, REFRESH_MS);
});

// ---------------- Dashboard HTML (LIGHT theme, live via WebSocket) ----------------
const HTML = `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Activity Trapping — Live</title><style>
:root{--bg:#f4f6fb;--card:#ffffff;--line:#e4e9f2;--line2:#eef2f8;--ink:#1e293b;--ink2:#475569;--mut:#7c8aa3;
--brand:#3b5bdb;--brand-soft:#eef2ff;--ok:#15803d;--ok-bg:#e7f6ec;--flag:#b45309;--flag-bg:#fdf2dc;--block:#b91c1c;--block-bg:#fdecec;--accent:#6741d9}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--ink);font:13px/1.55 ui-sans-serif,system-ui,"Segoe UI",Roboto,Arial}
header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:11px 20px;background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:20;box-shadow:0 1px 3px rgba(16,30,70,.04)}
.brand{display:flex;flex-direction:column;line-height:1.15}.brand b{font-size:15px;font-weight:700}.brand span{font-size:11px;color:var(--mut)}
.live{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:600;padding:4px 11px;border-radius:999px;border:1px solid var(--line);color:var(--ink2);background:#fff}
.live .dot{width:8px;height:8px;border-radius:50%;background:#cbd5e1}.live.on{color:var(--ok);border-color:#bbe7c7;background:var(--ok-bg)}.live.on .dot{background:var(--ok);box-shadow:0 0 0 3px rgba(21,128,61,.15);animation:pulse 1.6s infinite}
.live.off{color:var(--block);background:var(--block-bg);border-color:#f3c2c2}.live.off .dot{background:var(--block)}
@keyframes pulse{50%{opacity:.45}}.spacer{flex:1}
.ctl{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
input.search{border:1px solid var(--line);background:#fff;border-radius:8px;padding:7px 11px;font-size:12px;width:230px;color:var(--ink);outline:none}
input.search:focus{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
.chip{cursor:pointer;user-select:none;font-size:11.5px;font-weight:600;padding:5px 11px;border-radius:999px;border:1px solid var(--line);background:#fff;color:var(--ink2)}
.chip.active{background:var(--brand);border-color:var(--brand);color:#fff}
.btn{cursor:pointer;font-size:11.5px;font-weight:600;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:#fff;color:var(--ink2)}
.btn:hover{background:#f6f8fc}.btn.warn{color:var(--flag);border-color:#f0d8a8}
.wrap{padding:16px 20px;display:grid;gap:14px;grid-template-columns:repeat(12,1fr)}
.kpi{grid-column:span 2}.col8{grid-column:span 8}.col4{grid-column:span 4}.col12{grid-column:span 12}
@media(max-width:1100px){.kpi{grid-column:span 4}.col8,.col4{grid-column:span 12}}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:0 1px 2px rgba(16,30,70,.03)}
.card .hd{display:flex;align-items:center;justify-content:space-between;padding:11px 14px;border-bottom:1px solid var(--line2)}
.card .hd h2{font-size:12px;margin:0;font-weight:700;color:var(--ink2);text-transform:uppercase;letter-spacing:.4px}
.card .hd .cnt{font-size:11px;color:var(--mut)}.bd{padding:10px 14px}
.kpi .bd{padding:13px 15px}.kpi .l{font-size:11px;color:var(--mut);font-weight:600;text-transform:uppercase;letter-spacing:.4px}
.kpi .v{font-size:25px;font-weight:800;margin-top:3px;letter-spacing:-.5px}.kpi .v small{font-size:13px;font-weight:600;color:var(--mut)}
.kpi.alert .v{color:var(--block)}
.scroll{max-height:420px;overflow:auto}.scroll.sm{max-height:320px}
table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:6px 10px;text-align:left;border-bottom:1px solid var(--line2);vertical-align:top}
th{position:sticky;top:0;background:#fafbfe;color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.3px;z-index:1}
tbody tr:hover{background:#fafbff}tr.row{cursor:pointer}tr.new td{animation:hl 1.3s ease-out}@keyframes hl{from{background:#eaf0ff}to{background:transparent}}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:11px}.mut{color:var(--mut)}.snip{max-width:1px}
td.snip{max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{display:inline-block;padding:1.5px 8px;border-radius:6px;font-size:10.5px;font-weight:700;text-transform:capitalize}
.b-allow{background:var(--ok-bg);color:var(--ok)}.b-block{background:var(--block-bg);color:var(--block)}.b-flag{background:var(--flag-bg);color:var(--flag)}
.tag{display:inline-block;padding:1px 7px;border-radius:5px;background:#eef2f8;color:var(--ink2);font-size:11px;font-weight:600}
.bar{display:flex;align-items:center;gap:9px;margin:6px 0}.bar .nm{width:90px;font-size:11.5px;color:var(--ink2);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar .tk{flex:1;height:9px;background:#eef1f7;border-radius:5px;overflow:hidden}.bar .tk i{display:block;height:100%;border-radius:5px;background:linear-gradient(90deg,#5b7cfa,#3b5bdb)}
.bar .vl{width:42px;text-align:right;font-size:11px;color:var(--mut);font-weight:600}
.det{background:#fafbff}.det td{padding:0}.det .inner{padding:10px 14px;border-bottom:1px solid var(--line2)}
.kv{display:grid;grid-template-columns:120px 1fr;gap:3px 12px;font-size:11.5px}.kv b{color:var(--mut);font-weight:600}
.empty{padding:26px;text-align:center;color:var(--mut)}.pre{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Consolas,monospace;font-size:11px;background:#f7f9fc;border:1px solid var(--line2);border-radius:7px;padding:8px;max-height:240px;overflow:auto}
.userf{border:1px solid var(--line);background:#fff;border-radius:8px;padding:5px 9px;font-size:12px;color:var(--ink);outline:none;max-width:240px}
.userf:focus{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
.cv-user{margin-bottom:14px}
.cv-uhd{font-weight:700;color:var(--ink);font-size:13px;padding:5px 2px;border-bottom:1px solid var(--line2)}
.cv-utok{float:right;color:var(--brand);font-weight:600;font-size:11.5px}
details.sess{border:1px solid var(--line);border-radius:8px;margin:7px 0;background:#fff}
details.sess>summary{cursor:pointer;padding:7px 11px;font-size:12px;color:var(--ink2);list-style:none;position:sticky;top:29px;z-index:2;background:#fff;display:flex;align-items:center;gap:6px}
.sess-r{margin-left:auto;color:var(--mut);font-weight:600;font-size:11px;white-space:nowrap}
details.sess>summary::-webkit-details-marker{display:none}
details.sess>summary:before{content:"▸ ";color:var(--mut)}
details.sess[open]>summary:before{content:"▾ "}
details.sess>summary b{color:var(--ink)}
details.sess[open]>summary{border-bottom:1px solid var(--line2)}
.sess-evs{padding:6px 11px}
.cv-ev{padding:6px 0;border-bottom:1px dashed var(--line2)}.cv-ev:last-child{border-bottom:none}
.cv-meta{color:var(--mut);font-size:11px;font-family:ui-monospace,Consolas,monospace}
.cv-prompt{color:var(--ink);margin:2px 0;font-size:12px;word-break:break-word}
.cv-resp{color:var(--ink2);font-size:11.5px;white-space:pre-wrap;word-break:break-word}
.st-act{color:var(--ok);font-weight:700}.st-end{color:var(--mut);font-weight:600}.st-idle{color:var(--flag);font-weight:600}.st-closed{color:var(--block);font-weight:600}
.filterbox{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--line);border-radius:8px;padding:4px 8px;background:#fff;color:var(--mut)}
.fsel{border:none;outline:none;background:transparent;font-size:12px;color:var(--ink);cursor:pointer}
.dt{border:1px solid var(--line);border-radius:8px;padding:5px 7px;font-size:11.5px;color:var(--ink2);background:#fff}
.sesfilter{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--brand);background:var(--brand-soft);border:1px solid #cdd9ff;border-radius:999px;padding:3px 10px;cursor:pointer}
.fpanel{position:absolute;top:calc(100% + 6px);left:0;z-index:40;background:#fff;border:1px solid var(--line);border-radius:10px;box-shadow:0 8px 28px rgba(16,30,70,.14);padding:12px;display:grid;gap:9px;min-width:240px}
.fpanel[hidden]{display:none}
.fpanel label{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:12px;color:var(--ink2)}
.fpanel select,.fpanel input{border:1px solid var(--line);border-radius:7px;padding:5px 7px;font-size:12px;color:var(--ink);background:#fff}
details.cv-user-d{margin-bottom:10px;border:1px solid var(--line);border-radius:10px;background:#fff}
details.cv-user-d>summary.cv-uhd{cursor:pointer;list-style:none;padding:6px 12px;border-bottom:none;position:sticky;top:0;z-index:3;background:#fff;border-radius:10px 10px 0 0}
details.cv-user-d>summary.cv-uhd::-webkit-details-marker{display:none}
details.cv-user-d>summary.cv-uhd:before{content:"▸ ";color:var(--mut)}
details.cv-user-d[open]>summary.cv-uhd:before{content:"▾ "}
details.cv-user-d[open]>summary.cv-uhd{border-bottom:1px solid var(--line2)}
details.cv-user-d>details.sess{margin:7px 11px}
</style></head><body>
<header>
 <div class="brand"><b>Activity Trapping</b><span>Live · default sesi AKTIF · atur di tombol Filter · Redis 30h + ClickHouse</span></div>
 <span class="live" id="live"><span class="dot"></span><span id="liveTxt">menyambung…</span></span>
 <div class="spacer"></div>
 <div class="ctl">
  <input class="search" id="q" placeholder="cari user / tool / perintah…"/>
  <span style="position:relative;display:inline-flex">
   <button class="btn" id="filterBtn" title="Filter & lingkup data"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px"><path d="M3 5h18l-7 8v5l-4 2v-7z"/></svg> Filter <span id="filterDot" style="display:none;color:var(--brand)">●</span></button>
   <div class="fpanel" id="filterPanel" hidden>
    <label>Keputusan <select class="fsel2" id="decFilter"><option value="all">Semua</option><option value="allow">Allow</option><option value="flag">Flag</option><option value="block">Block</option></select></label>
    <label>Lingkup <select class="fsel2" id="scopeSel"><option value="active">Hanya aktif</option><option value="idle">+ idle</option><option value="closed">+ idle + closed</option></select></label>
    <label>Dari <input type="date" id="from"></label>
    <label>Sampai <input type="date" id="to"></label>
   </div>
  </span>
  <button class="btn" id="pause">⏸ Pause</button>
  <button class="btn warn" id="clear">Bersihkan</button>
 </div>
</header>
<div class="wrap">
 <div class="card kpi"><div class="bd"><div class="l">Events</div><div class="v" id="k-ev">0</div></div></div>
 <div class="card kpi"><div class="bd"><div class="l">Users aktif</div><div class="v" id="k-us">0</div></div></div>
 <div class="card kpi"><div class="bd"><div class="l">Tool calls</div><div class="v" id="k-tc">0</div></div></div>
 <div class="card kpi alert"><div class="bd"><div class="l">Block / Flag</div><div class="v" id="k-bl">0</div></div></div>
 <div class="card kpi"><div class="bd"><div class="l">Tokens in/out</div><div class="v" id="k-tok" style="font-size:18px">0 / 0</div></div></div>
 <div class="card kpi"><div class="bd"><div class="l">Biaya (USD)</div><div class="v" id="k-cost" style="font-size:20px">$0</div></div></div>

 <div class="card col8">
  <div class="hd"><h2>Live Event Stream</h2><span class="cnt" id="evCnt">0 ditampilkan</span></div>
  <div class="scroll"><table><thead><tr><th style="width:150px">Waktu</th><th>User</th><th>Jenis</th><th>Tool</th><th>Keputusan</th><th>Perintah / Sesi</th></tr></thead><tbody id="ev"></tbody></table></div>
 </div>

 <div class="col4" style="display:grid;gap:14px;align-content:start">
  <div class="card"><div class="hd"><h2>Top Tools</h2></div><div class="bd" id="b-tool"></div></div>
  <div class="card"><div class="hd"><h2>Top 5 User · Usage Token</h2></div><div class="bd" id="b-dec"></div></div>
  <div class="card"><div class="hd"><h2>Top 5 User · Aktivitas CLI</h2></div><div class="bd" id="b-user"></div></div>
 </div>

 <div class="card col12">
  <div class="hd"><h2>Percakapan — User → Sesi → Prompt</h2>
   <span style="display:flex;gap:10px;align-items:center">
    <span class="sesfilter" id="sesFilter" style="display:none"></span>
    <select class="userf" id="userFilter"><option value="all">semua user</option></select>
    <span class="cnt" id="cvCnt">0</span></span></div>
  <div class="scroll sm" style="padding:0 14px 8px"><div id="cv" style="padding-top:8px"></div></div>
 </div>
</div>
<script>
const $=s=>document.querySelector(s);
let S={events:[],totals:{},conversations:[],agg:{tool:{},decision:{},kind:{},user:{},userTokens:{}}};
let buf=[];            // semua event (cap 800)
let filt={q:'',d:'all',user:'all',session:null};let paused=false;let liveMode=true;let _sf=null;
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const tm=ms=>{if(!ms)return'';return new Date(ms).toLocaleString('id-ID',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).replace(',','');};
const snip=(s,n)=>{s=String(s||'');return s.length>n?s.slice(0,n)+'…':s};
const badge=d=>'<span class="badge b-'+(d==='block'?'block':d==='flag'?'flag':'allow')+'">'+esc(d||'allow')+'</span>';
const num=n=>Number(n||0).toLocaleString('id-ID');
function match(e){if(filt.d!=='all'&&(e.decision||'allow')!==filt.d)return false;
 if(filt.q){const q=filt.q.toLowerCase();return((e.email||'')+' '+(e.user||'')+' '+(e.tool||'')+' '+(e.kind||'')+' '+(e.command||'')+' '+(e.prompt||'')+' '+(e.session||'')).toLowerCase().includes(q)}return true}
function rowEv(e){const last=e.command||e.prompt||e.session||'';
 return '<tr class="row" data-sid="'+esc(e.session||'')+'" data-user="'+esc(e.email||e.user||'')+'" title="klik: filter Percakapan ke sesi ini"><td class="mono">'+tm(e.ts)+'</td><td class="mono">'+esc(snip(e.email||e.user,24))+'</td><td><span class="tag">'+esc(e.kind)+'</span></td><td class="mono">'+esc(e.tool||'—')+'</td><td>'+badge(e.decision)+'</td><td class="snip mono" title="'+esc(last)+'">'+esc(last)+'</td></tr>'}
function renderEv(){const list=buf.filter(match);const tb=$('#ev');
 tb.innerHTML=list.slice(-300).reverse().map((e)=>rowEv(e)).join('')||'<tr><td colspan=6 class=empty>menunggu event…</td></tr>';
 $('#evCnt').textContent=list.length+' / '+buf.length+' event';}
function bars(el,obj,n){const arr=Object.entries(obj||{}).filter(x=>x[0]&&x[0]!=='undefined').sort((a,b)=>b[1]-a[1]).slice(0,n);
 const mx=Math.max(1,...arr.map(x=>x[1]));
 el.innerHTML=arr.map(([k,v])=>'<div class="bar"><div class="nm" title="'+esc(k)+'">'+esc(k)+'</div><div class="tk"><i style="width:'+(v/mx*100)+'%"></i></div><div class="vl">'+num(v)+'</div></div>').join('')||'<div class="mut" style="font-size:11px">—</div>';}
// isi dropdown filter user dari percakapan (pertahankan pilihan saat ini)
function syncUserFilter(){const sel=$('#userFilter');if(!sel)return;const cur=sel.value||'all';
 const usersList=[...new Set((S.conversations||[]).map(c=>c.user).filter(Boolean))].sort();
 sel.innerHTML='<option value="all">semua user</option>'+usersList.map(u=>'<option value="'+esc(u)+'">'+esc(u)+'</option>').join('');
 sel.value=[...sel.options].some(o=>o.value===cur)?cur:'all';filt.user=sel.value;}
// render pohon percakapan: user -> sesi -> prompt (pertahankan <details> yg terbuka)
function renderConv(){const cv=$('#cv');if(!cv)return;
 const open=new Set([...cv.querySelectorAll('details.sess[open]')].map(x=>x.dataset.sid));
 const openU=new Set([...cv.querySelectorAll('details.cv-user-d[open]')].map(x=>x.dataset.u));
 const q=filt.q.toLowerCase();
 const convs=(S.conversations||[]).filter(c=>{
   if(filt.session&&(c.session||'')!==filt.session)return false;
   if(filt.user!=='all'&&(c.user||'')!==filt.user)return false;
   if(filt.q&&!(((c.user||'')+' '+(c.model||'')+' '+(c.prompt||'')+' '+(c.response||'')).toLowerCase().includes(q)))return false;
   return true;});
 const sf=$('#sesFilter');if(sf){if(filt.session){sf.style.display='';sf.innerHTML='sesi '+esc(String(filt.session).slice(0,8))+' ✕';}else sf.style.display='none';}
 const byUser=new Map();
 for(const c of convs){const u=c.user||'(tanpa user)';if(!byUser.has(u))byUser.set(u,new Map());const sm=byUser.get(u);const sid=c.session||'(tanpa sesi)';if(!sm.has(sid))sm.set(sid,[]);sm.get(sid).push(c);}
 const blocks=[];
 const umax=e=>{let m=0;for(const arr of e[1].values())for(const c of arr)if((c.ts||0)>m)m=c.ts;return m;};
 for(const [user,sm] of [...byUser.entries()].sort((a,b)=>umax(b)-umax(a))){
   let utok=0;const sessHtml=[];
   const sessSorted=[...sm.entries()].sort((a,b)=>Math.max(...b[1].map(x=>x.ts||0))-Math.max(...a[1].map(x=>x.ts||0)));
   for(const [sid,arr] of sessSorted){
     arr.sort((a,b)=>(b.ts||0)-(a.ts||0));
     const sessLast=Math.max(0,...arr.map(c=>c.ts||0));
     const stok=arr.reduce((n,c)=>n+(c.tokensIn||0)+(c.tokensOut||0),0);utok+=stok;
     const scost=arr.reduce((n,c)=>n+(c.cost||0),0);
     const items=arr.map(c=>'<div class="cv-ev"><div class="cv-meta">'+tm(c.ts)+' · '+esc(c.model||'?')+' · '+num(c.tokensIn)+'/'+num(c.tokensOut)+' tok · $'+Number(c.cost||0).toFixed(4)+'</div><div class="cv-prompt">'+esc(snip(c.prompt||'(tanpa teks prompt)',220))+'</div>'+(c.response?'<div class="cv-resp">'+esc(snip(c.response,320))+'</div>':'')+'</div>').join('');
     const ended=(S.sessionEnds||{})[sid];const age=Date.now()-sessLast;
     const st=ended?'<span class="st-closed">■ closed '+tm(ended)+'</span>':(age<=30*60000?'<span class="st-act">● aktif</span>':(age<=24*3600*1000?'<span class="st-idle">○ idle</span>':'<span class="st-closed">■ closed</span>'));
     sessHtml.push('<details class="sess" data-sid="'+esc(sid)+'"'+((open.has(sid)||filt.session)?' open':'')+'><summary><b>sesi '+esc(String(sid).slice(0,8))+'</b> · '+st+'<span class="sess-r">'+arr.length+' prompt · '+num(stok)+' tok · $'+scost.toFixed(2)+'</span></summary><div class="sess-evs">'+items+'</div></details>');
   }
   if(sessHtml.length) blocks.push('<details class="cv-user-d" data-u="'+esc(user)+'"'+((openU.has(user)||filt.session)?' open':'')+'><summary class="cv-uhd">👤 '+esc(user)+' <span class="cv-utok">'+sessHtml.length+' sesi · '+num(utok)+' tok</span></summary>'+sessHtml.join('')+'</details>');
 }
 cv.innerHTML=blocks.join('')||'<div class="empty">belum ada percakapan</div>';
 $('#cvCnt').textContent=convs.length+' prompt';}
function renderMeta(){const T=S.totals||{};
 $('#k-ev').textContent=num(T.events);$('#k-us').textContent=num(T.users);
 $('#k-tc').textContent=num(Object.values(S.agg.tool||{}).reduce((a,b)=>a+b,0));
 $('#k-bl').textContent=num(T.blocked);
 $('#k-tok').innerHTML=num(T.tokensIn)+' <small>/ '+num(T.tokensOut)+'</small>';
 $('#k-cost').textContent='$'+Number(T.cost||0).toFixed(4);
 bars($('#b-tool'),S.agg.tool,8);bars($('#b-dec'),S.agg.userTokens,5);bars($('#b-user'),S.agg.user,5);
 syncUserFilter();renderConv();}
function renderAll(){buf=S.events.slice(-800);renderEv();renderMeta();}
function applyState(d){S=d;S.agg=S.agg||{tool:{},decision:{},kind:{},user:{},userTokens:{}};S.agg.userTokens=S.agg.userTokens||{};S.sessionEnds=S.sessionEnds||{};buf=(S.events||[]).slice(-800);if(!paused)renderEv();renderMeta();}
// GET data dengan scope (active default; +idle / +closed by date range). active = live WS; selain itu = fetch.
async function fetchScope(){const v=$('#scopeSel').value;const inc=v==='idle'?'idle':(v==='closed'?'idle,closed':'');
 const qs=new URLSearchParams();if(inc)qs.set('include',inc);const f=$('#from').value,t=$('#to').value;if(f)qs.set('from',f);if(t)qs.set('to',t);
 try{const r=await fetch('/api/scope?'+qs.toString());if(!r.ok)return;applyState(await r.json());}catch(e){}}
function applyScope(){liveMode=($('#scopeSel').value==='active');fetchScope();}
function scheduleScopeFetch(){if(_sf)return;_sf=setTimeout(()=>{_sf=null;if(!liveMode)fetchScope();},1200);}
// interaksi
$('#q').addEventListener('input',e=>{filt.q=e.target.value.trim();renderEv();renderConv()});
$('#userFilter').addEventListener('change',e=>{filt.user=e.target.value;renderConv()});
$('#decFilter').addEventListener('change',e=>{filt.d=e.target.value;renderEv();updateFilterDot()});
$('#scopeSel').addEventListener('change',()=>{applyScope();updateFilterDot()});$('#from').addEventListener('change',()=>{updateFilterDot();if(!liveMode)fetchScope()});$('#to').addEventListener('change',()=>{updateFilterDot();if(!liveMode)fetchScope()});
$('#filterBtn').addEventListener('click',e=>{e.stopPropagation();$('#filterPanel').hidden=!$('#filterPanel').hidden;});
document.addEventListener('click',e=>{const p=$('#filterPanel');if(!p||p.hidden)return;if(!e.target.closest('#filterPanel')&&!e.target.closest('#filterBtn'))p.hidden=true;});
function updateFilterDot(){const on=($('#decFilter').value!=='all')||($('#scopeSel').value!=='active')||$('#from').value||$('#to').value;$('#filterDot').style.display=on?'':'none';}
$('#pause').addEventListener('click',()=>{paused=!paused;$('#pause').textContent=paused?'▶ Lanjut':'⏸ Pause';$('#pause').style.color=paused?'var(--block)':''});
$('#clear').addEventListener('click',()=>{buf=[];renderEv()});
// klik baris Live Event Stream -> filter Percakapan ke sesi (& user) baris itu
$('#ev').addEventListener('click',e=>{const tr=e.target.closest('tr.row');if(!tr)return;const sid=tr.dataset.sid;if(!sid)return;filt.session=sid;const u=tr.dataset.user;if(u){const sel=$('#userFilter');if(sel&&[...sel.options].some(o=>o.value===u)){sel.value=u;filt.user=u;}}renderConv();});
$('#sesFilter').addEventListener('click',()=>{filt.session=null;renderConv();});
// websocket
function conn(){const L=$('#live'),T=$('#liveTxt');const proto=location.protocol==='https:'?'wss':'ws';const ws=new WebSocket(proto+'://'+location.host+'/ws');
 ws.onopen=()=>{L.className='live on';T.textContent='LIVE'};
 ws.onmessage=m=>{let msg;try{msg=JSON.parse(m.data)}catch{return}
  if(msg.type==='snapshot'||msg.type==='init'){if(liveMode){applyState(msg);}else{scheduleScopeFetch();}}};
 ws.onclose=()=>{L.className='live off';T.textContent='menyambung ulang…';setTimeout(conn,2000)};
 ws.onerror=()=>ws.close();}
conn();
</script></body></html>`;
