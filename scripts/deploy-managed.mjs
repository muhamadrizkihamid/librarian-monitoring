#!/usr/bin/env node
/**
 * Deploy managed-settings TANPA PowerShell (pakai Node).
 * Tetap butuh hak tulis ke lokasi managed-settings OS (umumnya perlu admin/elevasi).
 *
 * Pemakaian (jalankan via cmd/terminal yang ter-elevasi bila perlu):
 *   node scripts/deploy-managed.mjs --endpoint=http://localhost:4318 [--trap-dir=C:/ProgramData/claude-trapping]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true]; }));
const ENDPOINT = args.endpoint || 'http://localhost:4318';
const platform = process.platform;
const DEFAULT_TRAP = platform === 'win32' ? 'C:/ProgramData/claude-trapping' : '/opt/claude-trapping';
const TRAP_DIR = (args['trap-dir'] || DEFAULT_TRAP).replace(/\\/g, '/');
const MD_PATH = {
  win32: 'C:/Program Files/ClaudeCode/managed-settings.json',
  darwin: '/Library/Application Support/ClaudeCode/managed-settings.json',
  linux: '/etc/claude-code/managed-settings.json',
}[platform] || '/etc/claude-code/managed-settings.json';

// 1) generate managed-settings dari template
const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'managed-settings.template.json'), 'utf8'));
delete tpl._comment;
const md = JSON.parse(JSON.stringify(tpl).replaceAll('__OTLP_ENDPOINT__', ENDPOINT).replaceAll('__TRAP_DIR__', TRAP_DIR));

function tryWrite(fn, what) {
  try { fn(); return true; }
  catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') { console.error(`\n! TIDAK ADA IZIN menulis ${what}.\n  Jalankan via terminal ter-ELEVASI (admin), atau serahkan ke IT/MDM.\n  (${e.message})`); return false; }
    throw e;
  }
}

// 2) salin hooks/ + config/ ke TRAP_DIR
let ok = tryWrite(() => {
  for (const sub of ['hooks', 'config', 'data/audit']) fs.mkdirSync(path.join(TRAP_DIR, sub), { recursive: true });
  fs.cpSync(path.join(ROOT, 'hooks'), path.join(TRAP_DIR, 'hooks'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'config'), path.join(TRAP_DIR, 'config'), { recursive: true });
}, TRAP_DIR);

// 3) pasang managed-settings ke path OS
if (ok) ok = tryWrite(() => {
  fs.mkdirSync(path.dirname(MD_PATH), { recursive: true });
  fs.writeFileSync(MD_PATH, JSON.stringify(md, null, 2) + '\n');
}, MD_PATH);

if (ok) {
  console.log('OK — managed-settings terpasang.');
  console.log('  endpoint :', ENDPOINT);
  console.log('  trap dir :', TRAP_DIR);
  console.log('  managed  :', MD_PATH);
  console.log('\nLalu: tiap user jalankan "node scripts/merge-settings.mjs --uninstall" (hindari dobel), LOGOUT & login kembali.');
} else {
  // fallback: tetap tulis dist/ agar bisa di-deploy IT/MDM
  const dist = path.join(ROOT, 'dist'); fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'managed-settings.json'), JSON.stringify(md, null, 2) + '\n');
  console.error(`\nFile tetap di-generate di dist/managed-settings.json untuk diserahkan ke IT/MDM.`);
  process.exit(2);
}
