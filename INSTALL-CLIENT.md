# Install di Laptop Client — Activity Trapping (Claude Code CLI)

Panduan memasang **trapping** (capture + enforcement) di **laptop client / end-user**, lewat
**managed-settings** (immutable, tak bisa di-override user), mengarah ke **collector pusat**.

> ⚠️ **Laptop client kantor hanya pakai `cmd` (TANPA PowerShell) dan TANPA Docker.**
> Semua langkah di bawah memakai **Command Prompt (cmd)** + **Node.js**. Script `*.ps1`
> (`deploy-managed.ps1`, `uninstall-managed.ps1`) **JANGAN dipakai di client** — itu untuk admin server.

---

## 0. Arsitektur: server pusat vs laptop client

```
                         ┌───────────────────────────── SERVER PUSAT (1x) ─────────────────────────────┐
  Laptop client #1 ─┐    │  OTel Collector (0.0.0.0:4318)  →  SigNoz (ClickHouse + UI :8080)            │
  Laptop client #2 ─┼──► │  (Docker compose: collector + signoz + clickhouse)                          │
  Laptop client #N ─┘    │  endpoint yang dipakai client: http(s)://otel.bankmega.internal:4318        │
                         └─────────────────────────────────────────────────────────────────────────────┘

  Di LAPTOP CLIENT cuma ada:  hooks/trap.mjs  +  managed-settings.json (OTLP -> collector pusat)
  TIDAK ada Docker / collector / SigNoz di laptop client.
```

- **Server pusat** = mesin yang sudah menjalankan collector + SigNoz (sudah ada sekarang).
  Pastikan collector-nya **terekspos ke jaringan** (lihat §6) supaya laptop client bisa kirim data.
- **Laptop client** = hanya menerima file `hooks/` + `config/` + `managed-settings.json`.
  Claude Code di laptop akan otomatis menjalankan hook dan mengirim telemetry ke collector pusat.

---

## 1. Prasyarat laptop client

| Item | Cek di cmd | Catatan |
|---|---|---|
| **Node.js ≥ 18** | `node --version` | WAJIB — hook dijalankan `node trap.mjs`. Tanpa Node, hook tidak jalan. |
| **Claude Code CLI** | `claude --version` | v2.1.x+ |
| **Akses jaringan** ke collector pusat | `curl -s -o NUL -w "%{http_code}" http://otel.bankmega.internal:4318/v1/logs` | harus bisa connect (mis. balas `400/405` = nyambung; timeout = firewall) |
| **Hak Administrator** (sekali, saat install) | — | untuk menulis ke `C:\Program Files\ClaudeCode` |
| ~~Docker~~ | — | **TIDAK perlu** di client |
| ~~PowerShell~~ | — | **TIDAK dipakai** |

> Jika `curl` tak ada di laptop, lewati cek jaringan; nanti diverifikasi lewat SigNoz pusat (§5).

---

## 2. Apa yang dipasang di laptop client

| File/Folder | Tujuan di laptop | Isi |
|---|---|---|
| `hooks\` (`trap.mjs`, `policy.mjs`) | `C:\ProgramData\claude-trapping\hooks\` | handler hook capture+enforce |
| `config\` (`policy.json`, dll) | `C:\ProgramData\claude-trapping\config\` | kebijakan enforcement |
| `managed-settings.json` | `C:\Program Files\ClaudeCode\managed-settings.json` | env OTel + hooks (immutable) |

`managed-settings.json` mengunci: telemetry ON, OTLP endpoint = **collector pusat**, dan `trap.mjs`
di 7 event (UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop, SessionStart, SessionEnd).

---

## 3. CARA A — Install manual per-laptop (cmd, Administrator)

Cocok untuk uji / jumlah kecil. **Butuh folder repo `trapping-mvp` tersedia di laptop**
(copy via USB / network share). Setelah install, repo boleh dihapus.

### Langkah

1. **Buka Command Prompt sebagai Administrator**
   Start → ketik `cmd` → klik kanan **Command Prompt** → **Run as administrator**.

2. **Masuk ke folder repo** (sesuaikan lokasinya):
   ```cmd
   cd /d C:\path\ke\trapping-mvp
   ```

3. **Jalankan installer Node** (satu perintah — generate + salin hooks/config + pasang managed-settings).
   Ganti endpoint dengan **collector pusat** Anda:
   ```cmd
   node scripts\deploy-managed.mjs --endpoint=http://otel.bankmega.internal:4318
   ```
   Installer akan:
   - generate `managed-settings.json` (endpoint terisi),
   - salin `hooks\` + `config\` ke `C:\ProgramData\claude-trapping`,
   - pasang `managed-settings.json` ke `C:\Program Files\ClaudeCode`.

   Output sukses berakhir dengan `OK — managed-settings terpasang.`

4. **Tutup SEMUA sesi/jendela Claude Code, lalu buka lagi** (managed-settings dibaca saat start).
   Paling pasti: **logout Windows & login kembali**.

> Jika muncul `TIDAK ADA IZIN menulis ...` → cmd belum elevated. Tutup, buka ulang **Run as administrator**.
> Jika tetap gagal (kebijakan korporat), installer tetap menulis `dist\managed-settings.json`
> untuk diserahkan ke IT/MDM (lihat Cara B).

### Fallback fully-manual (kalau `deploy-managed.mjs` tak bisa elevate)

Di cmd Administrator, dari folder repo:
```cmd
node scripts\build-managed-settings.mjs --endpoint=http://otel.bankmega.internal:4318

md "C:\ProgramData\claude-trapping\hooks"
md "C:\ProgramData\claude-trapping\config"
md "C:\ProgramData\claude-trapping\data\audit"
xcopy /E /I /Y "hooks"  "C:\ProgramData\claude-trapping\hooks"
xcopy /E /I /Y "config" "C:\ProgramData\claude-trapping\config"

md "C:\Program Files\ClaudeCode"
copy /Y "dist\managed-settings.json" "C:\Program Files\ClaudeCode\managed-settings.json"
```
Lalu logout & login.

---

## 4. CARA B — Rollout massal via MDM / Intune (disarankan untuk produksi)

Tidak perlu menyentuh tiap laptop manual. **Rakit paket sekali**, lalu push lewat MDM (Intune/SCCM/GPO).

### Langkah 1 — rakit paket (di mesin admin, sekali)
```cmd
cd /d C:\path\ke\trapping-mvp
node scripts\build-client-package.mjs --endpoint=https://otel.bankmega.internal:4318
```
Hasil: folder **`dist\client-package\`** yang sudah lengkap & siap di-zip:
```
dist\client-package\
  ├─ hooks\                 (trap.mjs, policy.mjs)
  ├─ config\policy.json     (kebijakan enforcement)
  ├─ managed-settings.json  (endpoint collector PUSAT sudah ter-embed)
  ├─ deploy-client.cmd      (installer)
  ├─ uninstall-client.cmd   (uninstaller)
  └─ README.txt
```
> Endpoint di-set di sini (saat rakit). Untuk produksi pakai **HTTPS** + DNS internal Anda.
> Tanpa `--endpoint`, dipakai placeholder `otel.bankmega.internal` (script akan memberi peringatan).

### Langkah 2 — push & jalankan via MDM
- **Zip** isi `dist\client-package\` → distribusikan ke laptop (mis. ke `%ProgramData%\trapping-pkg\`).
- MDM menjalankan **`deploy-client.cmd`** sebagai **SYSTEM** (otomatis punya izin tulis `Program Files`, tak ada prompt admin). Script sudah: cek Node.js → salin `hooks\`+`config\` ke `C:\ProgramData\claude-trapping` → pasang `managed-settings.json` ke `C:\Program Files\ClaudeCode`. Mengembalikan **exit code** (0 sukses; 2 = Node.js tak ada; 4 = tak ada izin) untuk pelaporan MDM.
- **Remediation/uninstall** MDM: jalankan **`uninstall-client.cmd`**.

### Prasyarat Node.js (MDM)
Hook menjalankan `node`. Pastikan **Node.js LTS ter-install system-wide & ada di `PATH`** sebelum
`deploy-client.cmd` (script akan exit code 2 bila Node.js tak ada). Sertakan paket MSI Node LTS sebagai
dependensi deploy bila perlu.

---

## 5. Verifikasi (cmd)

1. **Uji handler tanpa Claude** (harus exit tanpa error, dan menulis audit lokal):
   ```cmd
   echo {"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git status"},"session_id":"uji"}| node "C:\ProgramData\claude-trapping\hooks\trap.mjs"
   ```

2. **Cek audit lokal muncul:**
   ```cmd
   dir "C:\ProgramData\claude-trapping\data\audit"
   ```
   Harus ada file `hooks-YYYYMMDD.jsonl`.

3. **Pakai Claude Code seperti biasa** (setelah restart sesi), lalu **cek di SigNoz pusat**:
   - Buka `http://<server-pusat>:8080` → **Logs** → Logs Explorer → filter `service.name = claude-code-hook`.
   - Atau buka dashboard **"Activity Trapping — Claude Code (L2 Hooks)"** → harus muncul `user.id`
     dari laptop client tersebut.

> Belum muncul? Lihat §7 Troubleshooting.

---

## 6. Sisi server: ekspos collector ke jaringan (sekali saja)

Agar laptop client bisa kirim data, collector pusat harus menerima koneksi dari jaringan
(bukan cuma `localhost`):

- Collector sudah listen di `0.0.0.0:4318` (HTTP) dan `0.0.0.0:4317` (gRPC) — lihat `docker-compose.yml`.
- Buka **firewall** server untuk port **4318** (HTTP/protobuf) dari subnet kantor.
- Pakai **hostname/DNS internal** yang sama dengan `--endpoint` di atas (mis. `otel.bankmega.internal`).
- **Produksi:** pakai **HTTPS + TLS** (`https://...:4318`) dan sertifikat internal; jangan kirim konten
  prompt/response polos lewat jaringan tanpa TLS.

---

## 7. Troubleshooting (cmd)

| Gejala | Solusi |
|---|---|
| `node` tidak dikenali | Node.js belum ter-install / tidak di PATH. Install Node LTS, buka cmd baru. |
| `TIDAK ADA IZIN menulis` saat deploy | cmd belum **Run as administrator**. |
| Audit kosong / data tak muncul di SigNoz | (a) sesi Claude **belum di-restart**; (b) endpoint salah — cek isi `C:\Program Files\ClaudeCode\managed-settings.json`; (c) firewall/port 4318 ke server tertutup. |
| Event **dobel** di SigNoz | Laptop itu dulu pernah self-install user-settings. Jalankan (sebagai user biasa, dari repo): `node scripts\merge-settings.mjs --uninstall` lalu logout/login. |
| Cek endpoint terpasang benar | `type "C:\Program Files\ClaudeCode\managed-settings.json"` → lihat `OTEL_EXPORTER_OTLP_ENDPOINT`. |
| Tes koneksi ke collector | `curl -s -o NUL -w "%{http_code}" http://otel.bankmega.internal:4318/v1/logs` (balas 400/405 = nyambung). |

---

## 8. Uninstall di laptop client (cmd, Administrator)

Tidak ada `.ps1` yang dipakai. Cukup hapus filenya:
```cmd
del /F /Q "C:\Program Files\ClaudeCode\managed-settings.json"
rmdir /S /Q "C:\ProgramData\claude-trapping"
```
Lalu **logout & login** (atau tutup semua sesi Claude Code) agar perubahan berlaku.

> Untuk MDM: bungkus dua perintah di atas jadi `uninstall-client.cmd` dan push sebagai remediation.

---

## 9. Catatan keamanan

- `managed-settings.json` **immutable bagi user** (`disableBypassPermissionsMode: true`) — user tak bisa
  mematikan trapping dari `~/.claude/settings.json`.
- Konten prompt/response dikirim dalam mode FULL; **redaksi PII** (password/token/secret, email, telepon)
  dilakukan **di collector pusat** (`otel-collector-config.yaml`, processor `transform/pii`) — pastikan
  aktif sebelum rollout luas, dan libatkan **Legal/UU PDP**.
- Audit lokal `C:\ProgramData\claude-trapping\data\audit\*.jsonl` berisi konten sensitif — atur retensi/
  pembersihan sesuai kebijakan.

---

**Pemilik:** Tim Security/Platform Bank Mega · Versi: client-install 0.1.0 · Lihat juga `ONBOARDING.md` (mode developer self-serve) & `README.md`.
