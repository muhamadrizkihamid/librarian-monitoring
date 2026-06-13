#!/usr/bin/env node
/**
 * Monitor live — tampilkan aktivitas yang ter-trap secara real-time.
 * - Tail audit hooks (L2 capture+enforce) -> baris per event.
 * - Counter OTel (data/otel/logs.jsonl) & SIEM (data/siem/hec-received.jsonl).
 *
 * Pemakaian:  node scripts/watch.mjs        (Ctrl+C untuk berhenti)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'data');
const AUDIT = path.join(DATA, 'audit');
const OTEL = path.join(DATA, 'otel', 'logs.jsonl');
const SIEM = path.join(DATA, 'siem', 'hec-received.jsonl');

const SYM = { allow: '·', flag: '⚑', block: '⛔' };

function today() { return new Date().toISOString().slice(0, 10).replace(/-/g, ''); }
function auditFile() { return path.join(AUDIT, `hooks-${today()}.jsonl`); }
function size(p) { try { return fs.statSync(p).size; } catch { return 0; } }
function countLines(p) { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } }

function fmt(line) {
  let e; try { e = JSON.parse(line); } catch { return null; }
  const t = (e.timestamp || '').slice(11, 19);
  const sym = SYM[e.decision] || '?';
  const tool = e.tool_name ? ` ${e.tool_name}` : '';
  const mcp = e.mcp_invocation ? ` [MCP:${e.mcp_invocation.mcp_server}]` : '';
  const why = e.decision !== 'allow' && e.decision_reason ? `  <- ${e.decision_reason}` : '';
  return `${t}  ${sym} ${String(e.event_kind).padEnd(12)}${tool}${mcp}${why}`;
}

console.log('=== TRAPPING LIVE MONITOR ===  (Ctrl+C untuk berhenti)');
console.log(`audit: ${auditFile()}`);
console.log('legend: ·=allow  ⚑=flag  ⛔=block\n');

// tampilkan 5 event terakhir sebagai konteks
try {
  const last = fs.readFileSync(auditFile(), 'utf8').split('\n').filter(Boolean).slice(-5);
  for (const l of last) { const s = fmt(l); if (s) console.log('  ' + s); }
} catch {}

let offset = size(auditFile());
let buf = '';
let lastOtel = countLines(OTEL);
let lastSiem = countLines(SIEM);

setInterval(() => {
  // tail audit (file bisa berganti saat ganti hari)
  const f = auditFile();
  const sz = size(f);
  if (sz < offset) offset = 0; // file baru
  if (sz > offset) {
    const fd = fs.openSync(f, 'r');
    const b = Buffer.alloc(sz - offset);
    fs.readSync(fd, b, 0, b.length, offset);
    fs.closeSync(fd);
    offset = sz;
    buf += b.toString('utf8');
    const parts = buf.split('\n');
    buf = parts.pop();
    for (const line of parts) { if (!line.trim()) continue; const s = fmt(line); if (s) console.log('  ' + s); }
  }
  // counters OTel / SIEM
  const o = countLines(OTEL), s = countLines(SIEM);
  if (o !== lastOtel || s !== lastSiem) {
    console.log(`  --- telemetri: OTel logs=${o} (+${o - lastOtel})  SIEM events=${s} (+${s - lastSiem}) ---`);
    lastOtel = o; lastSiem = s;
  }
}, 800);
