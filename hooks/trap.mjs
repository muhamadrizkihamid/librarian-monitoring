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

  process.exit(0); // exit 0; deny disampaikan via JSON di atas
}

main();
