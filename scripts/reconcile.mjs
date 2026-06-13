#!/usr/bin/env node
/**
 * Reconciler (MVP) — bukti kelengkapan sederhana (LLD §7.2).
 * Membandingkan jumlah aktivitas yang tertangkap di dua lapisan:
 *   - L2 hooks  : data/audit/hooks-*.jsonl  (CEF v1)
 *   - L2 OTel   : data/otel/logs.jsonl      (OTLP file export dari collector)
 * Selisih signifikan => kandidat gap (mis. telemetri mati saat hook jalan, atau
 * sebaliknya). Rekonsiliasi vs billing vendor (L4) = manual untuk MVP.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'data');

function readLines(p) {
  try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean); }
  catch { return []; }
}

// --- L2 hooks ---
const auditDir = path.join(DATA, 'audit');
let hookFiles = [];
try { hookFiles = fs.readdirSync(auditDir).filter(f => f.startsWith('hooks-')); } catch {}
const hookCounts = {};
for (const f of hookFiles) {
  for (const line of readLines(path.join(auditDir, f))) {
    try { const e = JSON.parse(line); hookCounts[e.event_kind] = (hookCounts[e.event_kind] || 0) + 1; }
    catch {}
  }
}
const hookToolResults = hookCounts['tool_result'] || 0;
const hookRequests = hookCounts['request'] || 0;

// --- L2 OTel: parse OTLP JSON, hitung per-logRecord berdasarkan atribut event.name ---
const otelLines = readLines(path.join(DATA, 'otel', 'logs.jsonl'));
const otelPresent = otelLines.length > 0;
const otelCounts = {};
function attrStr(attrs, key) {
  const a = (attrs || []).find(x => x.key === key);
  return a && a.value ? (a.value.stringValue ?? null) : null;
}
for (const line of otelLines) {
  let doc;
  try { doc = JSON.parse(line); } catch { continue; }
  for (const rl of doc.resourceLogs || []) {
    for (const sl of rl.scopeLogs || []) {
      for (const rec of sl.logRecords || []) {
        // Claude Code menamai event lewat atribut event.name; fallback ke body.
        const name = attrStr(rec.attributes, 'event.name')
          || (rec.body && rec.body.stringValue) || 'unknown';
        otelCounts[name] = (otelCounts[name] || 0) + 1;
      }
    }
  }
}
const otelToolResults = otelCounts['claude_code.tool_result'] || 0;
const otelUserPrompts = otelCounts['claude_code.user_prompt'] || 0;
const otelApiReq = otelCounts['claude_code.api_request'] || 0;

function row(label, a, b) {
  const diff = a - b;
  const flag = Math.abs(diff) > Math.max(2, 0.2 * Math.max(a, b)) ? '  ⚠ GAP' : '';
  return `${label.padEnd(28)} hooks=${String(a).padStart(5)}  otel=${String(b).padStart(5)}  Δ=${String(diff).padStart(5)}${flag}`;
}

console.log('=== Reconciler (MVP) — L2 hooks vs L2 OTel ===');
console.log(`hook files       : ${hookFiles.length} (${auditDir})`);
console.log(`otel logs present: ${otelPresent ? 'yes' : 'no'} (data/otel/logs.jsonl)`);
console.log('');
console.log(row('tool results', hookToolResults, otelToolResults));
console.log(row('user prompts / requests', hookRequests, otelUserPrompts));
console.log('');
console.log(`OTel api_request events: ${otelApiReq}`);
console.log('hook event_kind breakdown:', JSON.stringify(hookCounts));
console.log('');
console.log('Catatan: rekonsiliasi vs billing vendor (OpenAI/Anthropic usage API) = manual untuk MVP.');
console.log('Δ besar => investigasi: telemetri klien mati, hook gagal, atau jalur tak terpantau.');
