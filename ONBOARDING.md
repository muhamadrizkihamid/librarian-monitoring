# Onboarding — Activity Trapping untuk Claude Code CLI

Panduan memasang **trapping** (capture + enforcement) di mesin developer. Setelah terpasang, **setiap** prompt, tool call, dan sesi Claude Code CLI tertangkap (audit + SIEM) dan dievaluasi terhadap kebijakan keamanan.

> Repo ini = implementasi MVP dari desain `LLD-Activity-Trapping-Service.md`. Lapisan aktif: **L2 hooks (capture+enforce)**, **L2 OTel → SIEM (Splunk HEC)**. L3 proxy = stub; L4 Compliance API = N/A (Enterprise).

---

## 1. Prasyarat

| Tool | Minimal | Cek |
|---|---|---|
| Claude Code CLI | v2.1.x | `claude --version` |
| Node.js | ≥ 18 | `node --version` |
| Docker (Desktop) | aktif | `docker compose version` |

> **Windows + Docker Desktop:** bila `docker compose` gagal connect ("cannot connect to the Docker daemon"), jalankan dulu:
> ```bash
> export DOCKER_HOST="npipe:////./pipe/dockerDesktopLinuxEngine"
> ```

## 2. Pasang (one-shot)

```bash
git clone <repo-url> claude-code-trapping
cd claude-code-trapping

# Linux/macOS/Git-Bash:
./install.sh
# atau Windows PowerShell:
#   .\install.ps1
```

Installer akan: buat folder `data/`, jalankan collector + mock SIEM, lalu **merge** env OTel + hooks ke `~/.claude/settings.json` (**backup otomatis**, idempotent — aman dijalankan ulang).

Terakhir: **restart sesi Claude Code** agar hooks & telemetri berlaku.

### Atau manual / via npm

```bash
npm run up                 # docker compose up -d
npm run install:hooks:dry  # pratinjau perubahan settings (tanpa menulis)
npm run install:hooks      # merge (backup + idempotent)
```

## 3. Apa yang berubah di mesin Anda

- `~/.claude/settings.json` ditambah:
  - **`env`**: 9 variabel OpenTelemetry (telemetry on, endpoint collector lokal, mode konten FULL).
  - **`hooks`**: `trap.mjs` di 7 event (UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop, SessionStart, SessionEnd).
  - Hooks/permissions/statusLine yang sudah ada **tidak diubah** (hanya ditambah).
- Backup tersimpan: `~/.claude/settings.json.bak-<timestamp>`.
- Tidak ada perubahan system-wide / admin (scope user).

## 4. Verifikasi

```bash
# uji handler tanpa Claude
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git status"},"session_id":"x"}' | node hooks/trap.mjs

# setelah restart sesi & beberapa aksi:
cat data/audit/hooks-*.jsonl          # audit CEF v1
cat data/siem/hec-received.jsonl      # event yang masuk ke SIEM (mock)
docker compose ps                     # collector + siem-mock UP
```

## 4b. Dashboard (lihat secara visual, live)

- **http://localhost:8091** — Activity Trapping Live (satu-satunya dashboard operasional, WebSocket): live event stream, KPI, **Percakapan user → sesi → prompt** + filter user, Top 5 user token & aktivitas CLI. Sumber data: ClickHouse 30 hari → cache **Redis TTL 30 hari** (restart-safe); backup permanen di ClickHouse.
- **http://localhost:8080** — SigNoz: 4 dashboard analitis dari ClickHouse (Hooks, Telemetry & Cost, Prompt Drill-Down, Activity & Token Audit).

## 5. Pemakaian harian

- Collector & mock SIEM `restart: unless-stopped` → hidup lagi otomatis saat Docker start. Setelah reboot, pastikan Docker Desktop jalan (di Windows mungkin perlu set `DOCKER_HOST` lalu `npm run up`).
- Audit lokal: `data/audit/hooks-YYYYMMDD.jsonl`; telemetri: `data/otel/`; SIEM: `data/siem/`.
- `data/` **tidak** di-commit (berisi konten sensitif) — lihat `.gitignore`.

## 6. Kebijakan enforcement (tuning)

Edit **`config/policy.json`** (lihat `README.md` → *Enforcement*). `deny` memblokir, `flag` menandai, `allow` default. Naikkan `version` tiap perubahan. **Tidak perlu restart** — dibaca per-event. Evaluator **fail-open** (policy rusak ⇒ tool diizinkan).

> ⚠️ **Anti-tamper:** edit `settings.json`/`managed-settings.json` via tool Edit/Write diblokir kebijakan. Untuk mencabut, gunakan jalur Bash: `npm run uninstall:hooks`.

## 7. Uninstall

```bash
npm run uninstall:hooks    # cabut env + hooks kita (backup tetap dibuat; setting lain aman)
npm run down               # matikan collector + mock SIEM
# restart sesi Claude Code
```

## 8. Troubleshooting

| Gejala | Solusi |
|---|---|
| `docker compose` tak connect (Windows) | `export DOCKER_HOST="npipe:////./pipe/dockerDesktopLinuxEngine"` lalu ulangi |
| Audit kosong setelah restart | Pastikan sesi Claude Code **di-restart**; cek `node scripts/merge-settings.mjs --dry-run` menampilkan hook `trap.mjs` |
| Tidak ada data di `data/otel/` | Collector mati (`docker compose ps`), atau endpoint OTel salah di `env` settings |
| Tool sah ikut terblokir | Sesuaikan `config/policy.json` (perlonggar regex), naikkan `version` |
| `settings.json` rusak | Pulihkan dari `~/.claude/settings.json.bak-<timestamp>` |

## 9. Jalur produksi (deploy massal)

MVP ini memakai **user settings** (self-serve) + **mock SIEM**. Untuk produksi:
1. Pindahkan `env`, `hooks`, dan policy ke **`managed-settings.json`** (Windows: `C:\Program Files\ClaudeCode\managed-settings.json`) yang **di-push via MDM** — immutable, tak bisa di-override user.
2. Arahkan exporter `splunk_hec` ke **Splunk korporat** (token via secret, https + TLS verify) — lihat `README.md`.
3. Aktifkan **redaksi PII** di collector & libatkan **Legal** (UU PDP) sebelum logging konten.
4. Tambah **L3 egress proxy** (allowlist domain, paksa `ANTHROPIC_BASE_URL`) sebagai backstop kelengkapan.

## 10. Kepemilikan
Pemilik: Tim Security/Platform Bank Mega. Pertanyaan kebijakan → owner repo. Versi MVP: `0.1.0`.
