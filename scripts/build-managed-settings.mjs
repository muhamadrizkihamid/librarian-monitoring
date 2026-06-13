#!/usr/bin/env node
/**
 * Generate managed-settings.json untuk rollout (MDM). Immutable, mengunci env+hooks
 * trapping ke seluruh developer, mengarah ke collector pusat.
 *
 * Pemakaian:
 *   node scripts/build-managed-settings.mjs --endpoint=https://otel.bankmega.internal:4318 [--trap-dir=C:/ProgramData/claude-trapping]
 * Output: dist/managed-settings.json (siap di-deploy ke path managed-settings OS).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const ENDPOINT = args.endpoint || 'http://localhost:4318';
const TRAP_DIR = (args['trap-dir'] || 'C:/ProgramData/claude-trapping').replace(/\\/g, '/');

const tpl = fs.readFileSync(path.join(ROOT, 'config', 'managed-settings.template.json'), 'utf8');
const obj = JSON.parse(tpl);
delete obj._comment;
const out = JSON.parse(JSON.stringify(obj)
  .replaceAll('__OTLP_ENDPOINT__', ENDPOINT)
  .replaceAll('__TRAP_DIR__', TRAP_DIR));

const distDir = path.join(ROOT, 'dist');
fs.mkdirSync(distDir, { recursive: true });
const outPath = path.join(distDir, 'managed-settings.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');

const PATHS = {
  windows: 'C:\\Program Files\\ClaudeCode\\managed-settings.json',
  macos: '/Library/Application Support/ClaudeCode/managed-settings.json',
  linux: '/etc/claude-code/managed-settings.json',
};
console.log('OK ->', outPath);
console.log('endpoint :', ENDPOINT);
console.log('trap dir :', TRAP_DIR, '(deploy hooks/ + config/ ke sini di tiap mesin)');
console.log('\nDeploy managed-settings ke (butuh admin):');
for (const [os, p] of Object.entries(PATHS)) console.log(`  ${os.padEnd(8)} ${p}`);
console.log('\nLangkah per mesin (via MDM):');
console.log('  1) salin folder hooks/ dan config/ repo ini ke', TRAP_DIR);
console.log('  2) salin dist/managed-settings.json ke path managed-settings OS di atas');
console.log('  3) pastikan Node.js + akses ke', ENDPOINT, '(collector pusat)');
console.log('  4) developer yang sudah pasang user-settings: jalankan "node scripts/merge-settings.mjs --uninstall" agar tak dobel');
