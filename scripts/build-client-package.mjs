#!/usr/bin/env node
/**
 * Rakit PAKET deploy untuk laptop client (MDM/Intune) — cmd, tanpa PowerShell, tanpa Docker.
 *
 * Output: dist/client-package/  (siap di-zip & push via MDM)
 *   ├─ hooks/                 (trap.mjs, policy.mjs)
 *   ├─ config/                (policy.json, dll)
 *   ├─ managed-settings.json  (endpoint collector PUSAT sudah ter-embed)
 *   ├─ deploy-client.cmd      (pasang — jalankan sbg Administrator/SYSTEM)
 *   ├─ uninstall-client.cmd   (cabut)
 *   └─ README.txt
 *
 * Pemakaian:
 *   node scripts/build-client-package.mjs --endpoint=http://otel.bankmega.internal:4318
 *   node scripts/build-client-package.mjs --endpoint=https://otel.bankmega.internal:4318 --trap-dir=C:/ProgramData/claude-trapping
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));

// Endpoint collector PUSAT. WAJIB diisi untuk produksi — default ini hanya placeholder.
const ENDPOINT = args.endpoint || 'http://otel.bankmega.internal:4318';
const TRAP_DIR = (args['trap-dir'] || 'C:/ProgramData/claude-trapping').replace(/\\/g, '/');
const isPlaceholder = ENDPOINT.includes('otel.bankmega.internal') && !args.endpoint;

// 1) generate managed-settings.json dari template (isi placeholder)
const tplRaw = fs.readFileSync(path.join(ROOT, 'config', 'managed-settings.template.json'), 'utf8');
const tpl = JSON.parse(tplRaw); delete tpl._comment;
const managed = JSON.parse(JSON.stringify(tpl)
  .replaceAll('__OTLP_ENDPOINT__', ENDPOINT)
  .replaceAll('__TRAP_DIR__', TRAP_DIR));

// 2) siapkan folder paket (bersih)
const PKG = path.join(ROOT, 'dist', 'client-package');
fs.rmSync(PKG, { recursive: true, force: true });
fs.mkdirSync(PKG, { recursive: true });

// 3) salin hooks/ + HANYA config/policy.json (template & snippet tak dipakai client)
fs.cpSync(path.join(ROOT, 'hooks'), path.join(PKG, 'hooks'), { recursive: true });
fs.mkdirSync(path.join(PKG, 'config'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'config', 'policy.json'), path.join(PKG, 'config', 'policy.json'));

// 4) tulis managed-settings.json + salin script cmd
fs.writeFileSync(path.join(PKG, 'managed-settings.json'), JSON.stringify(managed, null, 2) + '\n');
fs.copyFileSync(path.join(__dirname, 'deploy-client.cmd'), path.join(PKG, 'deploy-client.cmd'));
fs.copyFileSync(path.join(__dirname, 'uninstall-client.cmd'), path.join(PKG, 'uninstall-client.cmd'));

// 5) README ringkas di dalam paket
const readme = [
  'Activity Trapping - Paket deploy laptop CLIENT (cmd, tanpa PowerShell/Docker)',
  '==============================================================================',
  '',
  'Endpoint collector pusat : ' + ENDPOINT,
  'Trap dir (di laptop)     : ' + TRAP_DIR,
  '',
  'PRASYARAT laptop client:',
  '  - Node.js >= 18 ter-install & ada di PATH (hook dijalankan oleh node)',
  '  - Claude Code CLI ter-install',
  '  - Akses jaringan ke endpoint collector pusat di atas',
  '',
  'PASANG (Command Prompt sebagai Administrator, atau MDM sebagai SYSTEM):',
  '  deploy-client.cmd',
  '',
  'CABUT:',
  '  uninstall-client.cmd',
  '',
  'Setelah pasang/cabut: tutup semua sesi Claude Code, logout lalu login kembali.',
  'Lihat INSTALL-CLIENT.md (repo) untuk detail, verifikasi, dan troubleshooting.',
  '',
].join('\r\n'); // CRLF untuk Notepad Windows
fs.writeFileSync(path.join(PKG, 'README.txt'), readme);

// 6) ringkasan
console.log('OK -> ' + PKG);
console.log('  endpoint :', ENDPOINT);
console.log('  trap dir :', TRAP_DIR);
console.log('  isi      : hooks/ config/ managed-settings.json deploy-client.cmd uninstall-client.cmd README.txt');
if (isPlaceholder) {
  console.log('\n  ! PERINGATAN: endpoint masih placeholder default (otel.bankmega.internal).');
  console.log('    Set endpoint ASLI: node scripts/build-client-package.mjs --endpoint=https://<collector-pusat>:4318');
}
console.log('\nLangkah berikut: zip folder client-package/ lalu push via MDM,');
console.log('atau salin ke laptop & jalankan deploy-client.cmd sebagai Administrator.');
