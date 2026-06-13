#!/usr/bin/env node
/**
 * Merge konfigurasi trapping ke ~/.claude/settings.json (scope user) dengan AMAN:
 * - backup dulu, lalu deep-merge `env` + append entri `hooks` kita (idempotent).
 * - TIDAK menimpa hooks/permissions/statusLine yang sudah ada.
 *
 * Pemakaian:
 *   node scripts/merge-settings.mjs            # pasang
 *   node scripts/merge-settings.mjs --dry-run  # tampilkan rencana, tanpa menulis
 *   node scripts/merge-settings.mjs --uninstall# cabut entri kita
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRAP = path.resolve(__dirname, '..', 'hooks', 'trap.mjs').replace(/\\/g, '/');
const TRAP_CMD = `node "${TRAP}"`;

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const UNINSTALL = args.has('--uninstall');

const cfgDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const settingsPath = path.join(cfgDir, 'settings.json');

const TRAP_ENV = {
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_METRICS_EXPORTER: 'otlp',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
  OTEL_LOG_USER_PROMPTS: '1',     // teks prompt penuh
  OTEL_LOG_TOOL_DETAILS: '1',     // command/MCP/skill/plugin/slash-command names
  OTEL_LOG_RAW_API_BODIES: '1',   // body request+response (TEKS RESPONSE Claude). Sangat sensitif & besar (trunc ~60KB). Review Legal utk produksi.
  OTEL_METRIC_EXPORT_INTERVAL: '10000',
  OTEL_LOGS_EXPORT_INTERVAL: '2000',
};

const HOOK_EVENTS = [
  'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'Stop', 'SessionStart', 'SessionEnd',
];

function load() {
  if (!fs.existsSync(settingsPath)) return {};
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch (e) { console.error(`! settings.json tidak valid JSON: ${e.message}`); process.exit(1); }
}

function hasTrap(entryArr) {
  return (entryArr || []).some(e => (e.hooks || []).some(h => (h.command || '').includes('trap.mjs')));
}

function install(cfg) {
  cfg.env = cfg.env || {};
  for (const [k, v] of Object.entries(TRAP_ENV)) cfg.env[k] = v;

  cfg.hooks = cfg.hooks || {};
  for (const ev of HOOK_EVENTS) {
    cfg.hooks[ev] = cfg.hooks[ev] || [];
    if (!hasTrap(cfg.hooks[ev])) {
      cfg.hooks[ev].push({ hooks: [{ type: 'command', command: TRAP_CMD }] });
    }
  }
  return cfg;
}

function uninstall(cfg) {
  if (cfg.env) for (const k of Object.keys(TRAP_ENV)) delete cfg.env[k];
  if (cfg.hooks) {
    for (const ev of HOOK_EVENTS) {
      if (!cfg.hooks[ev]) continue;
      cfg.hooks[ev] = cfg.hooks[ev].filter(
        e => !(e.hooks || []).some(h => (h.command || '').includes('trap.mjs'))
      );
      if (cfg.hooks[ev].length === 0) delete cfg.hooks[ev];
    }
  }
  return cfg;
}

const before = load();
const after = (UNINSTALL ? uninstall : install)(JSON.parse(JSON.stringify(before)));

console.log(`settings : ${settingsPath}`);
console.log(`trap hook: ${TRAP_CMD}`);
console.log(`mode     : ${UNINSTALL ? 'UNINSTALL' : 'INSTALL'}${DRY ? ' (dry-run)' : ''}`);
console.log(`hooks env: ${Object.keys(TRAP_ENV).length} var, events: ${HOOK_EVENTS.join(', ')}`);

if (DRY) {
  console.log('\n--- settings.json (hasil, tidak ditulis) ---');
  console.log(JSON.stringify(after, null, 2));
  process.exit(0);
}

if (fs.existsSync(settingsPath)) {
  const bak = `${settingsPath}.bak-${Date.now()}`;
  fs.copyFileSync(settingsPath, bak);
  console.log(`backup   : ${bak}`);
}
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(after, null, 2) + '\n');
console.log('OK — settings.json diperbarui. Restart sesi Claude Code agar berlaku.');
