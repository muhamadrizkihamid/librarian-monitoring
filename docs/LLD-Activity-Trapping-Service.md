# LLD — Activity Trapping Service (Dua Platform)

**Service penangkap aktivitas lintas platform** — Chatbot (GPT) & Claude Code.
Pelengkap dari `HLD-LLD-System-Design-Dua-Platform.md`. Organisasi 150 developer.

> **Versi 0.1 — Juni 2026 (draft).**
> Tujuan dokumen: menspesifikasikan *bagaimana* lapisan SERVICES menangkap, menormalkan, menyimpan, dan menegakkan kebijakan atas **seluruh** aktivitas kedua platform — termasuk cara membuktikan tidak ada aktivitas yang lolos.
> Contoh konfigurasi bersifat **ILUSTRATIF** — verifikasi ke dokumentasi resmi sebelum implementasi.

---

## 1. Tujuan & Definisi "Trapping"

**Trap** = setiap aktivitas LLM dari kedua platform **(a) terdeteksi, (b) tercatat ternormalisasi, (c) dapat ditegakkan kebijakan**, dan (d) **terbukti lengkap** (tidak ada *shadow usage*).

Aktivitas yang ditangkap (minimal):
- Prompt request & response (metadata; konten hanya bila kebijakan & Legal mengizinkan).
- Tool call / MCP invocation (termasuk akses model bank di ML LAB).
- Konsumsi token & biaya.
- Keputusan guardrail/hook (`allow|block|flag`) + alasan.
- Identitas aktor (`user_id` dari IdP) & surface (`api|cli|ide|web|desktop`).

**Non-tujuan:** service ini bukan penyimpan model/data bank (itu ML LAB), bukan IdP, bukan egress proxy itu sendiri — ia *meng-orkestrasi* sinyal dari komponen-komponen tersebut.

---

## 2. Empat Lapisan Penangkapan (defense in depth)

Tidak ada satu titik tunggal yang cukup. Kelengkapan dijamin oleh empat lapisan yang saling menambal:

| # | Lapisan | Platform | Sifat | Jaminan | Celah bila sendirian |
|---|---|---|---|---|---|
| L1 | **LLM Gateway** (inline proxy) | Chatbot | In-band, **blocking** | Sangat kuat — di jalur, tak terlewati | — (selama UI hanya tahu endpoint gateway) |
| L2 | **OTel + Hooks** (klien) | Claude Code | Telemetri klien, hook bisa block | Kaya konteks (tool, repo, paths) | Bergantung managed-settings; bisa di-bypass jika tak terkunci |
| L3 | **Egress Proxy / DLP** (jaringan) | **Keduanya** | In-band di L3/L7 jaringan | **Backstop** — semua trafik ke vendor wajib lewat | Tidak tahu konteks aplikasi (user/tool) tanpa korelasi |
| L4 | **Compliance API** (vendor) | Claude Code (Enterprise) | Out-of-band, **reaktif** | Sumber kebenaran sisi vendor; remediasi/delete | Tertunda (~poll), retensi vendor terbatas |

**Prinsip kunci:** L1 & L2 memberi *konteks kaya* (siapa, tool apa, repo mana); L3 memberi *kelengkapan* (tidak ada yang lolos); L4 memberi *verifikasi independen* + remediasi. Korelasi keempatnya = trapping yang benar-benar utuh.

> **Catatan penting soal Claude Code:** karena `ANTHROPIC_BASE_URL` diarahkan ke `proxy.internal/anthropic`, proxy ini adalah **penangkap in-band utama** untuk konten prompt/response Claude Code — *bukan* sekadar backstop. Artinya, meski telemetri OTel (L2) dimatikan, lalu lintas konten tetap melintasi proxy korporat secara inline. L2 menambah konteks aplikasi (tool/repo/paths); L3 menjamin konten & kelengkapan.

---

## 3. Arsitektur Ingest

```
                 ┌──────────────────────── Activity Trapping Service ───────────────────────┐
 Chatbot UI ─▶ L1 Gateway ──(event)──┐                                                       │
 Claude Code ─▶ L2 OTel/Hooks ──────┐│                                                       │
 (jaringan)  ─▶ L3 Egress/DLP ─────┐││   ┌─────────┐   ┌──────────┐   ┌─────────┐            │
 Anthropic   ─▶ L4 Compliance ────┐│││──▶│ Ingest  │─▶ │Normalizer│─▶│ Enricher │─▶ Router ──┼─▶ SIEM
                                  ││││   │ (queue) │   │ (CEF v1) │   │(user/idP)│           │  ├─▶ Audit (WORM)
                                  ││││   └─────────┘   └──────────┘   └─────────┘            │  ├─▶ BI/Cost
                                  ││││                                       │               │  └─▶ Alerting
                                  ││││                                 ┌─────▼──────┐        │
                                  └┴┴┴────────────────────────────────│Reconciler  │ (§7)   │
                                                                       └────────────┘        │
                                                                       └─────────────────────┘
```

**Komponen internal:**
- **Ingest queue** — buffer tahan-lonjakan (Kafka / NATS / cloud queue); back-pressure aman, *at-least-once*.
- **Normalizer** — petakan tiap sumber ke **Common Event Format v1** (§5); idempotent via `event_id`.
- **Enricher** — lengkapi `user_id` (resolusi dari token/sesi via IdP), `policy_version`, klasifikasi data (DLP verdict), estimasi `cost_usd`.
- **Router** — fan-out ke sink: SIEM (deteksi), Audit Store (WORM), BI (biaya), Alerting.
- **Reconciler** — proses berkala yang membandingkan jumlah event antar lapisan & vs billing vendor untuk mendeteksi *shadow usage* (§7).

---

## 4. Mekanisme Penangkapan per Platform

### 4.1 Chatbot (GPT) — L1 inline
- Semua trafik UI → **hanya** ke Gateway (UI tidak pernah tahu kunci/endpoint OpenAI).
- Tiap request memancarkan **dua** event: `request` (sebelum call) & `response` (sesudah) dengan `event_id` berkorelasi → memastikan request yang gagal/timeout tetap tertangkap.
- Emit ke ingest queue **sebelum** balas ke user (atau async dengan jaminan durable-write) agar tidak ada event hilang saat crash.

### 4.2 Claude Code — L2 telemetri klien
- `managed-settings.json` (via MDM, **read-only bagi developer**): aktifkan `CLAUDE_CODE_ENABLE_TELEMETRY`, arahkan `OTEL_EXPORTER_OTLP_ENDPOINT` ke collector internal, set `ANTHROPIC_BASE_URL` ke proxy internal.
- **Hooks** (`PreToolUse`/`PostToolUse`) mengirim *bukti hook* (skema di system design B.3) — menangkap tool, command, paths_changed, decision.
- Collector OTel menormalkan & meneruskan ke ingest queue yang sama.

### 4.3 Keduanya — L3 egress backstop
- Firewall zona: **hanya** Gateway & Collector (dan proxy) yang punya rute keluar; mesin developer **tidak** boleh konek langsung ke domain vendor.
- Egress proxy mencatat tiap koneksi keluar (domain, byte, mTLS client id, timestamp) → event L3.
- DLP inline memindai payload non-sensitif yang keluar; verdict masuk sebagai `decision`.

### 4.4 Claude Code — L4 reaktif
- Compliance API client menarik chat/file/project terjadwal; di-index ke SIEM, arsip ke Audit Store; mendukung `delete` on-demand untuk remediasi.

---

## 5. Skema Event — Common Event Format v1

Memperluas B.5 di system design. Semua sumber → satu skema; `user_id` = join key.

| Field | Tipe | Sumber | Keterangan |
|---|---|---|---|
| `event_id` | uuid | semua | Idempotency key |
| `correlation_id` | uuid | L1/L2 | Mengikat request↔response↔tool call |
| `timestamp` | datetime | semua | UTC, ISO-8601 |
| `capture_layer` | enum | service | `gateway` \| `otel` \| `egress` \| `compliance` |
| `user_id` | string | enricher | Email korporat (join key) |
| `platform` | enum | semua | `chatbot_gpt` \| `claude_code` |
| `surface` | enum | semua | `api` \| `cli` \| `ide` \| `web` \| `desktop` |
| `event_kind` | enum | semua | `request` \| `response` \| `tool_call` \| `mcp_invocation` \| `egress_conn` \| `compliance_pull` |
| `model` | string | L1/L2/L4 | Model yang dipakai |
| `tokens_in/out` | int | L1/L2 | Konsumsi token |
| `cost_usd` | decimal | enricher | Estimasi biaya event |
| `decision` | enum | L1/L2/L3 | `allow` \| `block` \| `flag` |
| `decision_reason` | string | L1/L2/L3 | Alasan guardrail/hook/DLP |
| `policy_version` | string | enricher | Versi kebijakan saat keputusan |
| `data_class` | enum | DLP | `public` \| `internal` \| `sensitive` |
| `content_ref` | string\|null | L1/L2 | Pointer konten (jika dilog) / null |
| `mcp_invocation` | object\|null | MCP | model, authz, ref-params (hash) — akses ML LAB |
| `egress` | object\|null | L3 | domain, bytes, mtls_client_id |

---

## 6. Kebijakan Enforcement (per platform)

| Kondisi | Chatbot (L1) | Claude Code (L2/L3) |
|---|---|---|
| PII terdeteksi di prompt keluar | **block/redact** sebelum call | hook **block** + DLP backstop di L3 |
| Over budget / rate | `429` + alert | spend limit + alert |
| Prompt-injection / model tak diizinkan | **block** | hook **block** (deniedTools) |
| Akses data/model bank | route ke **MCP** (parameter referensi) | route ke **MCP**; data tak keluar |
| Tujuan egress di luar allowlist | tak relevan (gateway fix) | **block** di egress proxy |
| Telemetri klien mati / tak ter-manage | — | **deteksi & alert** (lihat §7), perlakukan sebagai pelanggaran |

Enforcement nyata (blocking) hanya di lapisan **in-band** (L1, L2-hook, L3). L4 bersifat remediasi setelah fakta.

---

## 7. Anti-Bypass & Pembuktian Kelengkapan *(bagian paling kritikal)*

"Menangkap **semua** aktivitas" hanya benar bila kita bisa **membuktikan** tidak ada yang lolos. Tiga mekanisme:

**Threat model — risikonya asimetris.** Chatbot/GPT terkunci *by construction*: tidak ada kunci vendor di klien, UI hanya tahu endpoint Gateway → shadow usage praktis mustahil. **Vektor bypass nyata ada di Claude Code:**
- **Personal `ANTHROPIC_API_KEY`** milik developer (bukan dari Vault korporat).
- **Sesi browser claude.ai pribadi** — jalur termudah, lewat web bukan API/CLI.
- **Instalasi tak ter-manage** (di luar MDM) yang mengabaikan `managed-settings.json`.

Ketiganya **tetap tertangkap** oleh backstop L3 *asalkan* firewall/egress memaksa semua trafik ke `api.anthropic.com` **dan `claude.ai`** melewati proxy/CASB. → **Wajib pastikan domain web `claude.ai` (bukan hanya API) masuk scope egress/CASB.**

**7.1 Penguncian jalur (preventif)**
- Mesin developer **tidak punya rute** ke `api.openai.com` / `api.anthropic.com` / **`claude.ai`** kecuali via proxy korporat (firewall egress allowlist; CASB untuk trafik web).
- `managed-settings.json` di lokasi *managed system* (read-only) — tidak bisa di-override; MDM memverifikasi kepatuhan endpoint secara berkala.
- API key vendor korporat **tidak pernah** ada di mesin developer (hanya di Vault, dipakai Gateway/proxy); kunci personal diblokir di lapisan egress.

**7.2 Rekonsiliasi silang (detektif)** — *Reconciler* berjalan periodik:
- **L3 vs L1+L2:** jumlah **request** ke domain vendor pada **log L7 proxy** (bukan koneksi TCP — keepalive/streaming/retry membuat koneksi ≠ request) harus ≈ jumlah event request dari Gateway+OTel pada jendela waktu yang sama. Selisih ⇒ kandidat *shadow usage* (klien yang men-bypass telemetri tapi tetap lewat proxy).
- **Vendor billing/usage (L4 & dashboard vendor) vs internal:** total token/biaya sisi vendor harus ≈ agregat internal. Selisih persisten ⇒ ada jalur keluar tak terpantau.
- **Per-user gap:** developer aktif di MDM tapi nihil event ⇒ investigasi (telemetri mati / pakai jalur lain).

**7.3 Heartbeat & tamper-evidence**
- Tiap klien Claude Code yang ter-manage mengirim heartbeat; hilangnya heartbeat dari mesin aktif = alert.
- Audit Store **WORM/append-only**; hash-chain antar batch agar penghapusan/penyuntingan terdeteksi.

> **Catatan jujur:** kelengkapan 100% absolut tidak bisa dijamin oleh telemetri klien saja (L2 selalu bisa dimatikan secara teori). Karena itu **L3 (egress) adalah backstop wajib** dan **rekonsiliasi vs billing vendor adalah pemeriksaan akhir kebenaran**. Tanpa keduanya, klaim "semua aktivitas tertangkap" tidak terbukti.

---

## 8. Penyimpanan, Retensi, Akses

- **Audit Store**: object store WORM/append-only; retensi sesuai regulasi (UU PDP / kebijakan internal); hash-chain.
- **SIEM**: hot storage untuk korelasi & deteksi (mis. 90 hari), lalu rollover.
- **BI/Cost**: agregat token/biaya per user/tim untuk chargeback.
- **Akses**: RBAC + jump host + login teraudit; konten sensitif (bila dilog) terenkripsi & akses berbasis tiket.

---

## 9. NFR & Sizing (indikatif, 150 user)

| Komponen | Target / sizing |
|---|---|
| Ingest queue | HA, partisi by `platform`/`user_id`; retensi buffer ≥ 24 jam |
| Normalizer/Enricher | Horizontal scale by event rate; idempotent (dedup `event_id`) |
| Latensi overhead | Emit event tak menambah > ~100 ms p95 pada jalur user (L1) |
| Durability | At-least-once dari sumber → queue; no-loss saat sink down |
| Reconciler | Job periodik (mis. tiap 15 menit + harian); alert ke SIEM |
| Availability | Gateway/Collector/queue min 2 instance HA |

---

## 10. Hal yang Wajib Diverifikasi

1. Field/env var OTel & `managed-settings.json` ke dokumentasi resmi terkini; cakupan enforcement Team vs Enterprise.
2. Ketersediaan & granularitas **vendor usage/billing API** untuk rekonsiliasi (OpenAI & Anthropic).
3. Retensi sisi vendor (Compliance API ~180 hari?) & data residency Indonesia.
4. Keterlibatan **Legal** sebelum logging konten prompt (UU PDP).
5. Daftar domain egress final & kemampuan proxy korporat mencatat per-koneksi dengan mTLS client id.
6. Apakah klien Claude Code dapat dipaksa memakai `ANTHROPIC_BASE_URL` proxy via MDM tanpa celah override.

---

## 11. Implementasi Aktual (As-Built / MVP) — Juni 2026

> §1–§10 = **desain target** (aspirasional). Bagian ini = **apa yang benar-benar dibangun** pada MVP lokal (repo `trapping-mvp`). Lihat juga tab **"Actual LLD"** di `Final-Architecture-Chatbot-MLLAB-ClaudeCode.drawio`.

### 11.1 Cakupan: hanya L2 + pipeline disederhanakan
MVP mengimplementasikan **lapisan L2 saja** (Claude Code OTel + Hooks). "Ingest pipeline" diringkas jadi **satu OTel Collector** (bukan queue durable + normalizer/enricher/router terpisah).

```
Claude Code CLI (managed-settings.json + hooks/trap.mjs)
   │ OTLP :4317/:4318
   ▼
OTel Collector (trapping-otel-collector)
   processors: transform/pii (redaksi PII + secret) → batch
   exporters (fan-out):
     ├─ file/logs, file/metrics → data/otel/*.jsonl   (audit lokal JSONL, append)
     ├─ splunk_hec/live  → trapping-live :8091         (pemicu refresh dashboard)
     └─ otlp/signoz      → ClickHouse (SigNoz)          (store permanen / source of truth)
```

### 11.2 Delta desain → aktual

| Komponen desain | Status | Keterangan as-built |
|---|---|---|
| L1 LLM Gateway (Chatbot) | ❌ tidak dibangun | Platform Chatbot di luar scope MVP |
| **L2 OTel + Hooks (Claude Code)** | ✅ **dibangun** | `managed-settings.json` + `hooks/trap.mjs` → OTLP collector; verified live |
| L3 Egress/DLP/CASB | ❌ tidak dibangun | Stub kebijakan saja (`config/settings.snippet.json`) |
| L4 Compliance API | ❌ tidak dibangun | Butuh Claude Enterprise |
| Ingest Queue durable (Kafka/NATS) | ❌ diganti | OTel Collector in-memory (retry/drop), bukan queue durable |
| Normalizer (CEF v1) | 🟡 parsial | Skema native OTel Claude Code, BUKAN CEF v1 penuh; redaksi PII di collector |
| Enricher (user_id, cost, DLP) | 🟡 parsial | `user.email` & `cost_usd` dari telemetry native; tanpa DLP/IdP-resolve |
| Router fan-out | ✅ disederhanakan | fan-out = daftar exporter collector |
| Reconciler (anti shadow-usage) | ❌ tidak dibangun | `scripts/reconcile.mjs` dihapus; tak ada rekonsiliasi billing vendor |
| SIEM | ❌ dihapus | `siem-mock` (placeholder) dihapus; Splunk asli belum ada |
| Audit Store WORM/hash-chain | 🟡 parsial | hanya `data/otel/*.jsonl` (append, **TANPA** WORM/hash-chain) |
| BI/Cost + Observability | ✅ dibangun (lebih kaya) | ClickHouse + 4 dashboard SigNoz + dashboard live :8091 |

### 11.3 Tambahan di luar desain
- **ClickHouse (SigNoz)** = store permanen / source of truth (logs + metrics).
- **Redis** (`trapping-redis` :6379) = hot store dashboard, **TTL 30 hari** (backup permanen tetap di ClickHouse).
- **Dashboard live `:8091`** (`trapping-live`, WebSocket): poll ClickHouse 30 hari → cache Redis → render pohon **user → sesi → prompt**, filter **active/idle/closed** + date range, KPI token/biaya, status sesi (aktif/idle/closed via hook `SessionEnd` + timeout).
- **4 dashboard SigNoz** (:8080): Activity Trapping (L2 Hooks), Telemetry & Cost, Prompt Drill-Down, Activity & Token Audit (30 hari).

### 11.4 Container & port
| Port | Container | Peran |
|---|---|---|
| 4317/4318 | `trapping-otel-collector` | ingest OTLP + redaksi PII + fan-out |
| 8091 | `trapping-live` | dashboard live (WebSocket) |
| 6379 | `trapping-redis` | hot store dashboard (TTL 30 hari) |
| 8080/8123 | `signoz` / `signoz-clickhouse` | UI analitis + store permanen |

Jalankan: `docker compose up -d` (collector + redis + live). Detail: `trapping-mvp/README.md`, `trapping-mvp/ONBOARDING.md`.

### 11.5 ⚠️ Kelengkapan BELUM terbukti (gap kritikal vs §7)
§7 (anti-bypass / pembuktian kelengkapan) **TIDAK** terpenuhi di MVP: **tidak ada L3 egress backstop** dan **tidak ada rekonsiliasi vs billing vendor**. Maka klaim "menangkap **semua** aktivitas" **belum terbukti** — MVP hanya menangkap telemetri klien **L2** yang secara teori bisa dimatikan/di-bypass. Untuk kelengkapan sesuai desain, **L3 + Reconciler wajib** ditambahkan; audit lokal juga belum WORM/hash-chain.
