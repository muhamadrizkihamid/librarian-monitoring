#!/usr/bin/env node
/**
 * Helper SigNoz API (v0.128) — login + util request.
 * Dipakai untuk membuat & memvalidasi dashboard Activity Trapping di SigNoz.
 *
 * Pemakaian:
 *   node scripts/signoz-api.mjs login
 *   node scripts/signoz-api.mjs get /api/v1/dashboards
 *   node scripts/signoz-api.mjs post /api/v1/dashboards <file.json>
 *   node scripts/signoz-api.mjs query <queryfile.json>   # POST ke query_range (auto-deteksi versi)
 *
 * ENV: SZ_BASE (default http://localhost:8080), SZ_EMAIL, SZ_PASSWORD, SZ_ORG
 */
import fs from 'node:fs';

// Kredensial WAJIB dari ENV — jangan pernah hardcode password di sumber (repo ini ter-git).
//   SZ_EMAIL=admin@bankmega.local SZ_PASSWORD=*** SZ_ORG=<uuid> node scripts/signoz-api.mjs ...
const BASE = process.env.SZ_BASE || 'http://localhost:8080';
const EMAIL = process.env.SZ_EMAIL;
const PASSWORD = process.env.SZ_PASSWORD;
const ORG = process.env.SZ_ORG;
if (!EMAIL || !PASSWORD || !ORG) {
  console.error('ERROR: set ENV SZ_EMAIL, SZ_PASSWORD, SZ_ORG dulu (jangan hardcode kredensial).');
  process.exit(1);
}

async function login() {
  const r = await fetch(`${BASE}/api/v2/sessions/email_password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, orgID: ORG }),
  });
  const j = await r.json();
  if (!j?.data?.accessToken) throw new Error('login failed: ' + JSON.stringify(j).slice(0, 300));
  return j.data.accessToken;
}

async function req(method, path, body, tok) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

const [cmd, a1, a2] = process.argv.slice(2);
const tok = await login();

if (cmd === 'login') {
  console.log('OK token len', tok.length);
} else if (cmd === 'get') {
  const res = await req('GET', a1, null, tok);
  console.log(JSON.stringify(res, null, 2).slice(0, 4000));
} else if (cmd === 'post') {
  // post <apiPath> <file.json>
  const res = await req('POST', a1, JSON.parse(fs.readFileSync(a2, 'utf8')), tok);
  console.log('HTTP', res.status);
  if (typeof res.body === 'string') { console.log(res.body.slice(0, 600)); }
  else {
    const D = res.body.data || {};
    console.log('status:', res.body.status);
    if (res.body.error) console.log('ERR:', JSON.stringify(res.body.error).slice(0, 600));
    console.log('uuid:', D.uuid || D.id || '(none)', '| title:', (D.data && D.data.title) || D.title || '');
  }
} else if (cmd === 'delete') {
  const res = await req('DELETE', a1, null, tok);
  console.log('HTTP', res.status, JSON.stringify(res.body).slice(0, 300));
} else if (cmd === 'query') {
  // coba versi query_range yang tersedia
  const payload = JSON.parse(fs.readFileSync(a1, 'utf8'));
  for (const v of ['v4', 'v3', 'v5']) {
    const res = await req('POST', `/api/${v}/query_range`, payload, tok);
    const isSpa = typeof res.body === 'string' && res.body.startsWith('<');
    console.log(`--- ${v} -> HTTP ${res.status} ${isSpa ? '(SPA, route absent)' : ''}`);
    if (!isSpa) { console.log(JSON.stringify(res.body, null, 2).slice(0, 3000)); break; }
  }
}
