# Activity Trapping Service — MVP (Claude Code CLI)

Implementasi nyata dari `LLD-Activity-Trapping-Service.md`, di-scope untuk **men-trap CLI Claude Code di mesin ini**. Simulasi korporat penuh (hooks + OTel collector + stub proxy), konfigurasi dipasang di **user settings** (tanpa admin), **konten penuh** (prompt + command).

> 🚀 **Baru di tim? Mulai dari [`ONBOARDING.md`](./ONBOARDING.md)** — panduan pasang langkah demi langkah.

## Lapisan yang aktif di MVP ini

| Lapisan | Status | Komponen |
|---|---|---|
| **L2 hooks (capture)** | ✅ aktif | `hooks/trap.mjs` → audit JSONL (CEF v1) |
| **L2 enforcement (block)** | ✅ aktif | `PreToolUse` + `config/policy.json` → deny/flag/allow |
| **L2 OTel** | ✅ aktif | Claude Code telemetry → `otel-collector` lokal → file + **SIEM (Splunk HEC)** |
| **SIEM** | ✅ mock | `siem-mock/` (Splunk HEC tiruan) → `data/siem/hec-received.jsonl`. Ganti ke Splunk korporat saat siap. |
| **L3 egress/proxy** | 🟡 stub | `config/settings.snippet.json._proxy_stub_L3` (aktifkan saat proxy ada) |
| **L4 compliance** | ⛔ N/A | butuh Enterprise + Compliance API key |
| **Reconciler** | ✅ MVP | `scripts/reconcile.mjs` (L2 hooks vs L2 OTel) |

## Prasyarat
- Claude Code CLI (terdeteksi: v2.1.177), Node.js, Docker (terdeteksi: v28.3.3).

## Pasang

> **Docker daemon di mesin ini:** jika `docker compose` gagal connect ("cannot connect to the Docker daemon"), set context Docker Desktop Linux engine dulu:
> ```bash
> export DOCKER_HOST="npipe:////./pipe/dockerDesktopLinuxEngine"
> ```

```bash
# 1) Siapkan folder output + jalankan collector (4317/4318) & mock SIEM (8088)
mkdir -p data/otel data/audit data/siem
docker compose up -d

# 2) Pratinjau perubahan settings (aman, tidak menulis)
node scripts/merge-settings.mjs --dry-run

# 3) Pasang: backup ~/.claude/settings.json lalu merge env + hooks kita
node scripts/merge-settings.mjs

# 4) Restart sesi Claude Code agar env & hooks berlaku
```

Setelah itu, **setiap** prompt, tool call, dan sesi tertangkap di dua lapisan:
- Hooks → `data/audit/hooks-YYYYMMDD.jsonl`
- OTel  → `data/otel/logs.jsonl` & `data/otel/metrics.jsonl`

## Verifikasi

```bash
# uji hook handler tanpa Claude (kirim payload contoh)
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git status"},"session_id":"demo","cwd":"/tmp"}' | node hooks/trap.mjs
cat data/audit/hooks-*.jsonl

# cek collector hidup
docker compose ps
docker compose logs --tail=20 otel-collector

# rekonsiliasi kelengkapan
node scripts/reconcile.mjs
```

## Cabut (uninstall)

```bash
node scripts/merge-settings.mjs --uninstall   # hapus env + hooks kita (backup tetap dibuat)
docker compose down
```

## Dashboard monitoring (Docker, live, WebSocket)

Berjalan sebagai **container** (`trapping-dashboard`) — ikut naik dengan `docker compose up -d`. Buka **http://localhost:8090**.

- **Live via WebSocket** (`/ws`, raw RFC6455, tanpa dependensi) — server mendeteksi event baru (~0.7 dtk) lalu **push per-event granular** ke browser (live ticker). Indikator **● LIVE (WebSocket)**. Fallback otomatis: polling `/api/data` bila WS tak tersedia.
- **Filter**: per-**user**, per-**tool**, dan **rentang waktu** (15m / 1j / 24j / semua) — semua tampilan (kartu, grafik, tabel) mengikuti filter.
- Menampilkan: kartu ringkasan (event, allow/flag/block, event SIEM, biaya rentang), **grafik tren event & biaya per waktu** (SVG inline), **live ticker**, **aktivitas terbaru**, **enforcement (block/flag)**, **SIEM event by name**.
- Container mount `data/` **read-only**; tanpa dependensi npm.

```bash
docker compose up -d dashboard      # atau seluruh stack: docker compose up -d
# dev lokal (opsional, tanpa docker): node dashboard/server.mjs  [PORT=9000]
```

> Catatan identitas: filter **user** memakai `user_id` hook (username mesin); biaya/SIEM memakai `user.email` (OTel). Korelasi username↔email adalah gap yang ditutup di produksi via IdP (lihat LLD §B.5).

## Enforcement / Block (PreToolUse)

Kebijakan ada di **`config/policy.json`** (ber-`version`), dievaluasi oleh `hooks/policy.mjs` saat `PreToolUse`. Tiap keputusan (`allow`/`block`/`flag`) ikut tercatat di audit dengan `policy_rule_id`, `decision_reason`, `policy_version`.

| action | Efek |
|---|---|
| `deny` | Tool call **diblokir** (Claude menerima alasan); audit `decision=block` |
| `flag` | Tool call **diizinkan** tapi **ditandai** untuk audit; `decision=flag` |
| `allow` | Default bila tak ada rule cocok |

Aturan default:
- `rm` rekursif/paksa, fork bomb, `mkfs`/`dd if=`/`shutdown`/`reboot`/`format` → **deny**
- Edit/Write ke `managed-settings.json` / `.claude/settings.json` → **deny** (**anti-tamper**: cegah trapping dimatikan diam-diam)
- Baca `.credentials.json`/`id_rsa`/`.env`/`.pem`/`secrets.yml` → **flag**

**Menyesuaikan:** edit `config/policy.json` (tambah rule `tool`/`field`/`regex`|`contains`/`action`/`reason`), naikkan `version`. Tak perlu restart sesi — policy dibaca per-event.

**Desain aman:** evaluator **fail-open** — bila `policy.json` hilang/rusak atau error, tool **diizinkan** (CLI tidak rusak). Hanya rule `deny` eksplisit yang memblokir.

> ⚠️ **Anti-tamper & escape hatch:** karena edit `settings.json` via tool Edit/Write diblokir, untuk mencabut trapping gunakan jalur Bash (bukan Edit): `node scripts/merge-settings.mjs --uninstall` (script ini menulis via Node fs, bukan tool Edit, jadi tidak terkena anti-tamper). Untuk produksi, pindahkan policy & settings ke `managed-settings.json` (immutable) agar enforcement benar-benar tak bisa dilewati user.

## Arahkan ke SIEM nyata (Splunk)

Saat endpoint korporat siap, edit `otel-collector-config.yaml` bagian `splunk_hec/siem`:

```yaml
  splunk_hec/siem:
    token: "${env:SPLUNK_HEC_TOKEN}"                 # jangan hardcode; lewat env
    endpoint: "https://splunk.corp.local:8088/services/collector"
    index: "claude_code_audit"
    disable_compression: false                        # aktifkan gzip ke Splunk nyata
    tls:
      insecure_skip_verify: false                     # verifikasi sertifikat
      ca_file: /etc/ssl/corp-ca.pem
```

Set token via env collector (mis. di `docker-compose.yml` `environment: [SPLUNK_HEC_TOKEN=...]` dari secret), lalu `docker compose up -d && docker compose restart otel-collector`. Hapus service `siem-mock` bila tak lagi dipakai.

Untuk **Elastic / Azure Sentinel**: ganti exporter ke `elasticsearch` / `azuremonitor` (OTel Collector contrib mendukung keduanya) — minta saya bila perlu.

Verifikasi mock SIEM sekarang:
```bash
cat data/siem/hec-received.jsonl    # event format Splunk HEC (event, fields, source, sourcetype, index, time)
```

## Skema event
Audit JSONL mengikuti **Common Event Format v1** (`LLD-Activity-Trapping-Service.md §5`): `event_id, correlation_id, timestamp, capture_layer, user_id, platform, surface, event_kind, tool_name, tool_input, decision, mcp_invocation, ...`.

## ⚠️ Keamanan & privasi
- Mode **FULL** menangkap **isi prompt & command** → `data/` berisi data sensitif. Sudah di-`.gitignore`; jangan commit/keluarkan.
- `user_id` dari hook = username mesin (placeholder). `user_id` otoritatif (email korporat) datang dari OTel (`user.email`) / IdP.
- Untuk **produksi**: pindahkan config ke **managed-settings** (`C:\Program Files\ClaudeCode\managed-settings.json`, butuh admin, immutable), aktifkan redaksi PII di collector, arahkan exporter ke SIEM/WORM, dan libatkan **Legal** (UU PDP) sebelum logging konten.
- **L3 proxy** sengaja tidak diaktifkan: mengarahkan `ANTHROPIC_BASE_URL` ke proxy yang belum ada akan memutus CLI.

## Catatan
Contoh konfigurasi mengacu dokumentasi Claude Code per 2026-06. Verifikasi nama env/field bila versi berubah.
