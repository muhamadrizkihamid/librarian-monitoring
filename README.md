# Activity Trapping Service — MVP (Claude Code CLI)

Implementasi nyata dari `LLD-Activity-Trapping-Service.md`, di-scope untuk **men-trap CLI Claude Code di mesin ini**. Simulasi korporat penuh (hooks + OTel collector + stub proxy), konfigurasi dipasang di **user settings** (tanpa admin), **konten penuh** (prompt + command).

> 🚀 **Baru di tim? Mulai dari [`ONBOARDING.md`](./ONBOARDING.md)** — panduan pasang langkah demi langkah.

## Lapisan yang aktif di MVP ini

| Lapisan | Status | Komponen |
|---|---|---|
| **L2 hooks (capture)** | ✅ aktif | `hooks/trap.mjs` → **OTLP ke collector** (+ audit JSONL lokal) |
| **L2 enforcement (block)** | ✅ aktif | `PreToolUse` + `config/policy.json` → deny/flag/allow |
| **L2 OTel** | ✅ aktif | Claude Code telemetry → `otel-collector` lokal → file + **SIEM (Splunk HEC)** |
| **SIEM** | ✅ mock | `siem-mock/` (Splunk HEC tiruan) → `data/siem/hec-received.jsonl`. Ganti ke Splunk korporat saat siap. |
| **L3 egress/proxy** | 🟡 stub | `config/settings.snippet.json._proxy_stub_L3` (aktifkan saat proxy ada) |
| **L4 compliance** | ⛔ N/A | butuh Enterprise + Compliance API key |

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
```

## Cabut (uninstall)

```bash
node scripts/merge-settings.mjs --uninstall   # hapus env + hooks kita (backup tetap dibuat)
docker compose down
```

## Dashboard monitoring

Dua lapis monitoring:

- **`:8091` — Activity Trapping Live** (SATU-SATUNYA dashboard operasional; `live/server.mjs`, container `trapping-live`). **POLL ClickHouse (30 hari) → cache Redis (TTL 30 hari) → WebSocket** (`/ws`, raw RFC6455, tanpa dependensi). Liveness: tiap event HEC dari collector memicu refresh (debounce ~0.8s) + safety poll 5s. **Restart-safe** (rehydrate dari Redis). Panel: live event stream (hook/tool), KPI (token in/out, biaya, block/flag), **Percakapan user → sesi → prompt** + **filter user**, **Top 5 User · Usage Token**, **Top 5 User · Aktivitas CLI**.
- **SigNoz** (`http://localhost:8080`) — dashboard analitis dari ClickHouse: #1 Activity Trapping (L2 Hooks), #2 Telemetry & Cost, #3 Prompt Drill-Down, #4 Activity & Token Audit (30 hari). Generator `scripts/build-signoz-*.mjs`, JSON importable `dashboard/*.json`.

```bash
docker compose up -d   # collector + redis + live(:8091) + siem-mock
```

> **Penyimpanan:** ClickHouse = backup permanen / source of truth; Redis = hot store dashboard (TTL 30 hari). :8091 ikut network eksternal `signoz-net` untuk query ClickHouse (`http://signoz-clickhouse:8123`).
> **Identitas:** aktivitas hook memakai `session.id`→`user.email` (dipetakan via event api_request); user tak terpetakan dikelompokkan `?`. Data laptop/IP tidak ditangkap telemetry CLI (hanya terminal/OS).

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

## Redaksi PII (UU PDP)

Collector menjalankan processor `transform/pii` pada pipeline **logs**: mask **NIK / no. kartu (13–19 digit), email, no. telepon ID** di field **konten** (`prompt`, `body`/response, `command`, `full_command`, `tool_input`) **sebelum** diekspor ke sink. `user.email` (join key identitas) **sengaja tidak** di-mask. Tuning pola di `otel-collector-config.yaml` → `processors.transform/pii`.

## Satu sumber OTel → SigNoz (live)

Semua data menyatu di **collector kita** (telemetri native Claude Code **+** event hooks via OTLP), di-redaksi PII, lalu di-forward ke **SigNoz**. UI: **http://localhost:8080**.

**Deploy SigNoz (sekali):**
1. Di luar repo ini: `git clone --depth 1 https://github.com/SigNoz/signoz.git`
2. Hindari bentrok port dgn collector kita — di `signoz/deploy/docker/docker-compose.yaml` remap collector SigNoz: `4317:4317`→`4319:4317`, `4318:4318`→`4320:4318`.
3. `cd signoz/deploy/docker && docker compose up -d`
4. **WAJIB onboarding**: buka `http://localhost:8080`, buat akun admin/organisasi. **Tanpa organisasi, collector SigNoz menolak provisioning** (opamp: *"cannot create agent without orgId"*) → tidak ada ingest. Alternatif via API: `POST /api/v1/register {name,orgName,email,password}`.
5. Collector kita sudah di-set forward ke `host.docker.internal:4319` (env `SIGNOZ_OTLP_ENDPOINT` di `docker-compose.yml`). `docker compose up -d` (stack kita) → data mengalir.

**Lihat data**: SigNoz → Logs / Metrics, filter `service.name` = `claude-code` (native) atau `claude-code-hook` (hooks). Event `claude_code.hook.*`, `user_prompt`, `api_request(_body)`, dll.

**Banyak pengguna → 1 OTel**: arahkan `OTEL_EXPORTER_OTLP_ENDPOINT` (Claude Code) & `TRAP_OTLP_ENDPOINT` (hooks) tiap developer ke **satu collector pusat** (via managed-settings) → redaksi PII di sana → **satu SigNoz**.

## Rollout via managed-settings (MDM, banyak pengguna)

MVP memakai **user-settings** (per developer, bisa di-override). Untuk produksi/banyak pengguna gunakan **managed-settings** — **immutable**, di-push via MDM, semua dev mengirim ke **satu collector pusat**.

```bash
# generate managed-settings.json (arahkan ke collector pusat)
npm run build:managed -- --endpoint=https://otel.bankmega.internal:4318 --trap-dir=C:/ProgramData/claude-trapping
# hasil: dist/managed-settings.json
```

**Paket deploy Windows (1 perintah, PowerShell sebagai Administrator):**
```powershell
.\scripts\deploy-managed.ps1 -Endpoint http://localhost:4318          # uji lokal
.\scripts\deploy-managed.ps1 -Endpoint https://otel.bankmega.internal:4318   # produksi/pusat
```
Skrip ini: generate managed-settings → salin `hooks/`+`config/` ke `C:\ProgramData\claude-trapping` → pasang `managed-settings.json` ke `C:\Program Files\ClaudeCode`. Cabut: `.\scripts\uninstall-managed.ps1` (admin).

Deploy per mesin (via MDM):
1. Salin folder **`hooks/`** dan **`config/`** ke `__TRAP_DIR__` (mis. `C:\ProgramData\claude-trapping`).
2. Salin `dist/managed-settings.json` ke path managed-settings OS (**butuh admin**):
   - Windows: `C:\Program Files\ClaudeCode\managed-settings.json`
   - macOS: `/Library/Application Support/ClaudeCode/managed-settings.json`
   - Linux/WSL: `/etc/claude-code/managed-settings.json`
3. Pastikan **Node.js** terpasang & mesin bisa akses collector pusat.
4. Developer yang sudah pasang user-settings: `npm run uninstall:hooks` agar tidak dobel.

Managed-settings **tidak bisa di-override user** (env, hooks, `disableBypassPermissionsMode`). Hooks managed **digabung** dengan hooks user lain (mis. GSD) sesuai precedence. Collector pusat menjalankan redaksi PII lalu ekspor ke **satu SigNoz**.

## Skema event
Audit JSONL mengikuti **Common Event Format v1** (`LLD-Activity-Trapping-Service.md §5`): `event_id, correlation_id, timestamp, capture_layer, user_id, platform, surface, event_kind, tool_name, tool_input, decision, mcp_invocation, ...`.

## ⚠️ Keamanan & privasi
- Mode **FULL** menangkap **isi prompt, command, dan TEKS RESPONSE Claude** (`OTEL_LOG_RAW_API_BODIES=1`, body ~60KB) → `data/` berisi data sangat sensitif. Sudah di-`.gitignore`; jangan commit/keluarkan. Body mentah API juga ke SIEM.
- `user_id` dari hook = username mesin (placeholder). `user_id` otoritatif (email korporat) datang dari OTel (`user.email`) / IdP.
- Untuk **produksi**: pindahkan config ke **managed-settings** (`C:\Program Files\ClaudeCode\managed-settings.json`, butuh admin, immutable), aktifkan redaksi PII di collector, arahkan exporter ke SIEM/WORM, dan libatkan **Legal** (UU PDP) sebelum logging konten.
- **L3 proxy** sengaja tidak diaktifkan: mengarahkan `ANTHROPIC_BASE_URL` ke proxy yang belum ada akan memutus CLI.

## Catatan
Contoh konfigurasi mengacu dokumentasi Claude Code per 2026-06. Verifikasi nama env/field bila versi berubah.
