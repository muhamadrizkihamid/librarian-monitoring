#!/usr/bin/env node
/**
 * Activity Trapping Service — Hook Capture (L2)
 *
 * Universal Claude Code hook handler. Dipanggil oleh berbagai hook event
 * (UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop,
 * SessionStart, SessionEnd). Membaca payload JSON dari stdin, menormalkan
 * ke Common Event Format v1 (lihat LLD-Activity-Trapping-Service.md §5),
 * lalu append ke audit log JSONL lokal.
 *
 * Prinsip: CAPTURE-ONLY untuk MVP. Tidak pernah memblokir / menggagalkan
 * tool call — apa pun yang terjadi, exit 0 agar CLI tidak terganggu.
 * (Enforcement/block ditambahkan kemudian secara sadar.)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { evaluate, policyVersion } from './policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_DIR = path.resolve(__dirname, '..', 'data', 'audit');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// hook_event_name -> event_kind (CEF v1)
function mapKind(ev) {
  switch (ev) {
    case 'UserPromptSubmit': return 'request';
    case 'PreToolUse': return 'tool_call';
    case 'PostToolUse': return 'tool_result';
    case 'PostToolUseFailure': return 'tool_result';
    case 'Stop':
    case 'StopFailure': return 'response';
    case 'SessionStart': return 'session_start';
    case 'SessionEnd': return 'session_end';
    default: return (ev || 'unknown').toLowerCase();
  }
}

// Tandai akses tool MCP (akses model/data bank lewat batas ML LAB)
function mcpInvocation(toolName, toolInput) {
  if (typeof toolName === 'string' && toolName.startsWith('mcp__')) {
    const parts = toolName.split('__'); // mcp__<server>__<tool>
    return {
      mcp_server: parts[1] || null,
      tool: parts.slice(2).join('__') || null,
      // hash ref-params (jangan simpan nilai mentah di field ini)
      ref_params_hash: crypto
        .createHash('sha256')
        .update(JSON.stringify(toolInput || {}))
        .digest('hex')
        .slice(0, 16),
    };
  }
  return null;
}

// Kirim event hook sebagai OTLP log ke collector (unifikasi: semua data -> 1 OTel)
function emitOtlp(cef, done) {
  try {
    const base = (process.env.TRAP_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318').replace(/\/$/, '');
    const url = new URL(base + '/v1/logs');
    const attr = (k, v) => ({ key: k, value: { stringValue: String(v) } });
    const attrs = [
      attr('event.name', 'claude_code.hook.' + cef.hook_event_name),
      attr('capture_layer', cef.capture_layer), attr('platform', cef.platform), attr('surface', cef.surface),
      attr('user.id', cef.user_id), attr('session.id', cef.session_id || ''), attr('event_kind', cef.event_kind),
      attr('decision', cef.decision), attr('policy_version', cef.policy_version || ''),
    ];
    if (cef.tool_name) attrs.push(attr('tool_name', cef.tool_name));
    if (cef.decision_reason) attrs.push(attr('decision_reason', cef.decision_reason));
    if (cef.policy_rule_id) attrs.push(attr('policy_rule_id', cef.policy_rule_id));
    if (cef.tool_input && typeof cef.tool_input.command === 'string') attrs.push(attr('command', cef.tool_input.command));
    if (cef.tool_input != null) attrs.push(attr('tool_input', JSON.stringify(cef.tool_input)));
    if (cef.mcp_invocation) attrs.push(attr('mcp_server', cef.mcp_invocation.mcp_server || ''));
    const payload = JSON.stringify({ resourceLogs: [{ resource: { attributes: [attr('service.name', 'claude-code-hook')] },
      scopeLogs: [{ logRecords: [{ timeUnixNano: `${Date.now()}000000`, body: { stringValue: 'claude_code.hook.' + cef.event_kind }, attributes: attrs }] }] }] });
    const req = http.request({ hostname: url.hostname, port: url.port || 80, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 600 },
      (res) => { res.on('data', () => {}); res.on('end', done); });
    req.on('error', done); req.on('timeout', () => { req.destroy(); done(); });
    req.write(payload); req.end();
  } catch { done(); }
}

function main() {
  let inp = {};
  try { inp = JSON.parse(readStdin() || '{}'); } catch { inp = {}; }

  const ev = inp.hook_event_name || 'unknown';
  const toolName = inp.tool_name || null;
  const failed = ev === 'PostToolUseFailure';

  // --- Enforcement: hanya PreToolUse yang bisa memblokir ---
  let verdict = { action: 'allow' };
  if (ev === 'PreToolUse') {
    verdict = evaluate(toolName, inp.tool_input);
  }

  const cef = {
    event_id: crypto.randomUUID(),
    correlation_id: inp.session_id || null, // MVP: korelasi per sesi (prompt.id ada di OTel)
    timestamp: new Date().toISOString(),
    capture_layer: 'hooks', // L2
    // Hook payload TIDAK membawa email korporat; user_id otoritatif dari OTel (user.email)/IdP.
    user_id: process.env.USERNAME || process.env.USER || os.userInfo().username || 'unknown',
    platform: 'claude_code',
    surface: 'cli',
    event_kind: mapKind(ev),
    hook_event_name: ev,
    session_id: inp.session_id || null,
    cwd: inp.cwd || null,
    permission_mode: inp.permission_mode || null,
    tool_name: toolName,
    tool_use_id: inp.tool_use_id || null,
    tool_input: inp.tool_input ?? null,      // konten penuh (mode FULL)
    tool_response_ok: failed ? false : (ev === 'PostToolUse' ? true : null),
    decision: verdict.action === 'deny' ? 'block' : verdict.action, // allow|block|flag
    decision_reason: verdict.reason || null,
    policy_rule_id: verdict.rule_id || null,
    policy_version: policyVersion,
    mcp_invocation: mcpInvocation(toolName, inp.tool_input),
  };

  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const day = cef.timestamp.slice(0, 10).replace(/-/g, '');
    const file = path.join(AUDIT_DIR, `hooks-${day}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(cef) + '\n');
  } catch {
    // jangan pernah mengganggu CLI karena masalah logging
  }

  // Enforcement: keluarkan keputusan deny (JSON di stdout, exit 0).
  if (ev === 'PreToolUse' && verdict.action === 'deny') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `[trapping/policy:${policyVersion}] ${verdict.reason}`,
      },
    }));
  }

  // Kirim ke OTel (unifikasi 1 sumber), lalu keluar. Selalu exit 0 walau gagal.
  let exited = false;
  const finish = () => { if (!exited) { exited = true; process.exit(0); } };
  setTimeout(finish, 800); // jaga-jaga: jangan menggantung CLI
  emitOtlp(cef, finish);
}

main();
