# System Design: HLD & LLD — AI Centric Bank Mega

**Dua Platform LLM** — Chatbot (GPT, pay-as-you-go) & Claude Code. Organisasi 150 developer.

> **Versi 1.1 — Juni 2026.**
> Catatan: contoh konfigurasi (env var, JSON, config) bersifat **ILUSTRATIF** untuk komunikasi desain — verifikasi nama field/kunci terhadap dokumentasi resmi sebelum implementasi.
>
> Perubahan v1.1: menambahkan **ML LAB** (zona data sensitif internal) + **MCP Server** sebagai komponen pertama-kelas, menyelaraskan dokumen dengan diagram LLD, dan menambahkan **Aturan Emas** sebagai prinsip arsitektur.

---

## Prinsip Arsitektur (Aturan Emas)

> 🔒 **ATURAN EMAS:** Data nasabah dan output model bank (scoring, fraud, dll.) **TIDAK keluar** ke OpenAI/Claude — keduanya tetap berada di sisi internal di belakang **batas MCP**. GPT/Claude hanya berperan sebagai **orkestrator**: mereka memanggil tool melalui MCP dengan **parameter referensi**, bukan data mentah, dan menerima hasil yang sudah dikurasi/di-de-identifikasi di sisi internal.

Konsekuensi desain dari prinsip ini:
- Model eksternal **tidak pernah** menerima PII nasabah maupun bobot/output mentah model bank.
- Semua akses ke data/model sensitif terjadi **di dalam ML LAB**, dimediasi MCP Server dengan authz per model.
- Hanya konten **non-sensitif** (mis. E-DOC publik internal, potongan kode dari SCM yang diizinkan) yang boleh melintasi egress proxy menuju LLM eksternal.

---

# BAGIAN A — HIGH-LEVEL DESIGN (HLD)

HLD adalah **ringkasan LLD**, disusun sebagai alur **kiri → kanan**:

```
PLATFORM  ──▶  SERVICES  ──▶  KNOWLEDGE  ──▶  LLM
```

| Lapisan | Isi | Peran |
|---|---|---|
| **PLATFORM** | Mega Chatbot, Claude Code, **ML LAB** | Titik masuk pengguna & sumber model/data bank |
| **SERVICES** | Gateway, Audit Trail, Monitoring, Governance | Lapisan kontrol korporat (enforcement, observability) |
| **KNOWLEDGE** | Non-Sensitive Data (E-DOC, SCM), **Sensitive Data** (model bank, data nasabah) | Sumber pengetahuan, terklasifikasi |
| **LLM** | External LLM (OpenAI GPT), SaaS LLM (Anthropic Claude) | Penyedia model eksternal |

**Aturan alur antar lapisan:**
- Mega Chatbot & Claude Code → **Gateway/Services** → boleh menuju **LLM eksternal** (hanya konten non-sensitif).
- ML LAB → **Sensitive Data** melalui **MCP**; jalur ini **berhenti** di batas internal — **tidak** diteruskan ke LLM.

## A.1 System Context

Sistem menghubungkan 150 developer ke dua layanan LLM eksternal (OpenAI untuk chatbot, Anthropic untuk Claude Code) melalui lapisan kontrol milik organisasi. **Tidak ada aktor yang memanggil model eksternal secara langsung** — semua melewati zona korporat yang menegakkan identitas, kebijakan, logging, dan egress.

Di sisi internal terdapat **ML LAB**: zona data sensitif berisi model khusus bank (scoring, fraud) dan data nasabah, yang diakses **hanya** melalui **MCP Server** (tool gateway dengan authz per model). LLM eksternal bertindak sebagai orkestrator yang memanggil tool MCP, bukan sebagai pemegang data.

**Aktor & sistem eksternal**
- **Developer (150)** — pengguna kedua platform.
- **Admin/Security/Compliance** — mengelola kebijakan, memantau, mengaudit.
- **OpenAI API** — penyedia model chatbot (pay-as-you-go).
- **Anthropic/Claude** — penyedia Claude Code (Team/Enterprise).
- **Lapisan Identitas** — **LDAP API** (jalur Chatbot) dan **LDAP + SAML** (jalur Claude Code), dijembatani ke API auth internal (user+pass → OK/gagal).

## A.2 Topologi Deployment (Zona)

| Zona | Komponen | Kepemilikan & sifat |
|---|---|---|
| **Zona 1: Perangkat pengguna** | Browser (chatbot UI, claude.ai), Claude Code CLI/IDE, DLP endpoint, agen MDM | Dikelola via MDM; managed-settings di-push ke sini |
| **Zona 2: Korporat / VPC (kontrol)** | IdP/SAML bridge, LLM Gateway, OTel Collector, Secrets Vault, Compliance API client, SIEM, DLP, audit store, BI, egress proxy | Self-managed; titik kontrol utama |
| **Zona 3: ML LAB (data sensitif internal)** | **MCP Server**, Model registry / serving (MLOps), model bank (scoring/fraud), data nasabah | Self-managed; **tidak boleh egress**; akses via MCP + authz per model |
| **Zona 4: Data internal non-sensitif** | E-DOC, SCM | Self-managed; boleh dirujuk LLM bila lolos klasifikasi |
| **Zona 5: SaaS eksternal** | OpenAI API, Anthropic/Claude | Pihak ketiga; diakses hanya via egress proxy |

## A.3 Inventaris Komponen & Tanggung Jawab

| Komponen | Tanggung jawab | Pilihan teknologi |
|---|---|---|
| IdP / SAML bridge | Autentikasi, terbitkan SAML assertion, MFA, jembatan ke API auth internal (LDAP) | Keycloak / Authentik / WorkOS |
| LLM Gateway | Pintu tunggal ke OpenAI; **MCP client**; logging, virtual key, budget, redaksi PII, guardrail | LiteLLM / Portkey / Kong AI |
| **MCP Server (ML LAB)** | **Tool gateway ke model & data bank; authz per model; menerima parameter referensi, bukan data mentah; audit setiap invocation** | MCP server kustom (mTLS) |
| **Model registry / serving** | Hosting & versioning model bank (MLOps) | MLflow / KServe / Seldon |
| OTel Collector | Terima telemetri Claude Code; filter/redaksi; route ke sink | OpenTelemetry Collector |
| Compliance API client | Tarik/hapus konten chat web Claude (Enterprise) | Service kustom + DLP |
| Secrets Vault | Simpan & rotasi kunci API | HashiCorp Vault / AWS/Azure KMS |
| SIEM | Korelasi, deteksi, alert lintas platform (join: `user_id`) | Splunk / Sentinel / Elastic |
| DLP engine | Klasifikasi & penegakan data sensitif | Purview / Forcepoint / Netskope |
| Audit store | Simpan log immutable, retensi, forensik; **audit invocation model** | Object store WORM / append-only |
| BI / cost | Dashboard biaya/token per user, chargeback; **utilisasi model bank** | Grafana / Metabase / Looker |
| Egress proxy / CASB | Gerbang keluar ke model eksternal; inspeksi | Squid / Zscaler / Cloudflare |

## A.4 Integrasi & Protokol

| Jalur | Protokol | Catatan |
|---|---|---|
| Developer → IdP | HTTPS + SAML 2.0 / OIDC | SSO enforced, MFA |
| IdP bridge → API auth internal | HTTPS/REST (LDAP) | Validasi kredensial server-to-server |
| App chatbot → Gateway | HTTPS/REST | Bawa identitas user, bukan API key |
| **Gateway → MCP Server** | **MCP over mTLS** | **Authz per model; kirim parameter referensi, bukan data nasabah** |
| **MCP Server → model/registry/data** | gRPC/REST internal | Tetap di dalam ML LAB; tidak egress |
| Gateway → OpenAI | HTTPS via egress proxy | Key dari Vault; **hanya konten non-sensitif** |
| Claude Code CLI → Collector | OTLP/HTTP(S) | Auth bearer token |
| Collector/Gateway → SIEM | Syslog/HTTP/OTLP | Format ternormalisasi |
| Compliance API client → Claude | HTTPS/REST | Compliance access key (Enterprise) |

## A.5 Non-Functional Requirements (NFR)

| Atribut | Target / pendekatan |
|---|---|
| Ketersediaan | Gateway, collector & **MCP Server** HA (min 2 instance, load-balanced); degradasi anggun bila model eksternal down |
| Skalabilitas | Horizontal scaling gateway/collector/MCP; sizing untuk 150 user konkuren + burst |
| Latensi | Overhead gateway < ~100 ms p95 di luar waktu model |
| Keamanan | Zero trust, least privilege, enkripsi in-transit (TLS 1.2+) & at-rest; **mTLS pada batas MCP** |
| Auditability | 100% request terlog; audit store immutable; jejak akses admin; **audit setiap invocation model bank** |
| Biaya | Budget per virtual key (GPT) & spend limit per user (Claude); dashboard chargeback |
| Privasi/Compliance | Data minimization, redaksi PII, retensi terdefinisi, UU PDP; **Aturan Emas ditegakkan di batas MCP** |
| **Model Risk** | **Tata kelola model bank: versioning, approval, monitoring drift; kebijakan data lintas platform** |

---

# BAGIAN B — LOW-LEVEL DESIGN (LLD)

## B.1 Identitas — SAML/LDAP Bridge ke API Auth Internal

Lapisan identitas melayani dua jalur: **LDAP API** untuk Chatbot dan **LDAP + SAML** untuk Claude Code.

**Alur (SP-initiated)**
1. Claude/aplikasi (SP) redirect ke SSO URL IdP bridge dengan `SAMLRequest`.
2. IdP bridge menampilkan halaman login; user submit user+pass.
3. Bridge memanggil API auth internal / LDAP (server-to-server); tunggu OK/gagal.
4. **OK**: bridge membangun SAML Response (signed) berisi `NameID` = email korporat + atribut; POST ke ACS URL.
5. **Gagal**: tampilkan error; tidak ada assertion diterbitkan.

**Atribut SAML assertion (ilustratif)**
```
NameID            : user@perusahaan.co.id   (format: emailAddress)
Attribute groups  : ["engineering","team-backend"]
Attribute dept    : "Engineering"
Conditions        : NotBefore / NotOnOrAfter (mis. 5 menit)
Signature         : RSA-SHA256 (private key IdP bridge)
```

**Kontrol kunci**
- Validasi signature, audience, replay (assertion ID sekali pakai), clock skew.
- MFA (TOTP/WebAuthn) di lapisan bridge — API internal tidak perlu diubah.
- SCIM (Enterprise) untuk provisioning; Team: JIT + skrip offboarding.
- Gunakan library SAML teruji (samlify / python3-saml) — jangan tulis protokol manual.

## B.2 LLM Gateway (Platform Chatbot)

**Request lifecycle (pseudocode)**
```
POST /v1/chat  (Authorization: Bearer <user-session>)
1. authN/authZ  -> resolve user, virtual_key
2. budget/rate  -> if over_limit: 429 + alert
3. guardrail_in -> moderation, prompt-injection check
4. pii_redact   -> Presidio: mask NIK/card/email
5. log_request  -> {id,user,ts,model,prompt_hash,tokens_in}
6. route        -> if butuh data/model bank: panggil MCP (lihat B.9), JANGAN kirim data ke LLM
7. call_openai  -> via egress proxy, key from Vault (hanya konten non-sensitif)
8. guardrail_out-> validate response
9. log_response -> {id,tokens_out,latency,cost}
10. emit_event  -> SIEM + BI + audit store
11. return      -> response to app
```

**Model virtual key (ilustratif)**
```
virtual_key: vk_eng_userA
owner: userA@perusahaan.co.id
budget_month_usd: 150
rate_limit_rpm: 60
allowed_models: [gpt-4o, gpt-4o-mini]
alert_threshold_pct: 80
```

**Pipeline redaksi PII** — Deteksi entitas (regex + NER) → tokenisasi/masking → simpan peta token bila perlu de-identifikasi terbalik di sisi internal (**jangan kirim peta ke model**).

## B.3 Claude Code — Managed Settings, OTel, Hooks

**`managed-settings.json` (ilustratif — verifikasi kunci ke docs)**
```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "https://otel.internal:4318",
    "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Bearer <token>",
    "ANTHROPIC_BASE_URL": "https://proxy.internal/anthropic"
  },
  "permissions": { "allowedTools": ["..."], "deniedTools": ["..."] },
  "mcpServers": { "allow": ["internal-db", "docs"] },
  "hooks": { "PreToolUse": "/opt/guard/pretool.sh" }
}
```
Di-deploy via MDM ke lokasi managed system; **tidak dapat di-override developer**.

**OTel Collector pipeline (ilustratif)**
```yaml
receivers:  { otlp: { protocols: { http: {} } } }
processors:
  attributes/redact: { actions: [ { key: prompt, action: delete } ] }
  batch: {}
exporters:
  splunk_hec: { endpoint: "..." }       # SIEM
  prometheusremotewrite: { ... }        # metrics/BI
  file/audit: { path: /worm/audit }     # arsip immutable
service:
  pipelines:
    metrics: { receivers: [otlp], processors: [batch], exporters: [prometheusremotewrite] }
    logs:    { receivers: [otlp], processors: [redact, batch], exporters: [splunk_hec, file/audit] }
```
> **Keputusan kunci:** processor `redact` menentukan apakah konten prompt diteruskan. Mengaktifkan logging konten adalah keputusan privasi & legal yang disengaja.

**Skema bukti hook (per event)**
```json
{ "event_type": "...", "tool_name": "...", "command_normalized": "...",
  "paths_changed": ["..."], "mcp_server": "...", "repo": "...", "branch": "...",
  "user": "...", "policy_version": "...",
  "decision": "allow|block|flag", "reason": "...", "ts": "..." }
```

## B.4 Compliance API Integration (Enterprise)

1. Primary Owner aktifkan API & buat Compliance Access Key (Organization settings).
2. Service client menarik chat/file/project secara terjadwal atau on-demand.
3. Konten dipindai DLP, di-index ke SIEM; arsip ke audit store.
4. Aksi delete on-demand untuk remediasi insiden.

Sifat **out-of-band (reaktif)** — bukan blocking real-time. Retensi sisi vendor terbatas (~180 hari, verifikasi) — arsipkan sendiri untuk forensik panjang.

## B.5 Skema Data Log Terpadu (Common Event Format)

Semua sumber dinormalisasi ke satu skema umum dengan `user_id` (dari IdP) sebagai **kunci join lintas platform**. Field inti: `event_id`, `timestamp`, `user_id`, `platform` (`chatbot_gpt`|`claude_code`), `model`, `tokens_in/out`, `cost_usd`, `decision` (`allow`|`block`|`flag`), `mcp_invocation` (akses model bank), `content_ref`.

> **Sumber kebenaran skema:** definisi lengkap & otoritatif ada di **`LLD-Activity-Trapping-Service.md` §5 (Common Event Format v1)**. Jangan duplikasi skema penuh di sini — rujuk dokumen tersebut agar tidak ada dua sumber yang bisa melenceng.

## B.6 Jaringan & Keamanan (detail)

- **Egress:** hanya gateway & collector yang boleh keluar; allowlist domain (`api.openai.com`, `api.anthropic.com`); TLS 1.2+; mTLS internal bila memungkinkan.
- **Segmentasi:** zona governance & **ML LAB** terisolasi; akses audit store/SIEM/ML LAB via RBAC, jump host, dan login teraudit.
- **Secrets:** tidak ada plaintext di mesin developer; token collector & key API hanya di Vault; rotasi terjadwal.
- **Sandbox:** Claude Code untuk repo sensitif berjalan di dev container dengan filesystem/network terbatas.
- **Batas MCP:** ML LAB hanya menerima koneksi dari LLM Gateway via mTLS; **tidak ada rute egress** dari ML LAB ke internet.

## B.7 Sequence Ringkas

**Chatbot — happy path (tanpa data sensitif)**
```
User    -> App:      pesan
App     -> Gateway:  /v1/chat (+user)
Gateway -> Gateway:  budget, guardrail, redact, log
Gateway -> Proxy -> OpenAI: request (non-sensitif)
OpenAI  -> Gateway:  response
Gateway -> SIEM/BI/Audit: event
Gateway -> App -> User: response
```

**Chatbot — perlu data/model bank (via MCP, Aturan Emas)**
```
User     -> App -> Gateway: pesan (mis. "cek skor risiko nasabah X")
Gateway  -> OpenAI:  orkestrasi — LLM memutuskan perlu tool "scoring"
OpenAI   -> Gateway: tool_call(scoring, ref=nasabah_X)   # parameter referensi
Gateway  -> MCP (mTLS): invoke scoring(ref=nasabah_X)     # authz per model
MCP      -> Model/Data bank: jalankan di ML LAB           # data TIDAK keluar
MCP      -> Gateway: hasil terkurasi/de-identifikasi
MCP      -> Audit:   audit invocation model
Gateway  -> OpenAI:  tool_result (ringkas, non-sensitif)
OpenAI   -> Gateway -> App -> User: response
```

## B.8 Sizing Awal (indikatif, untuk 150 user)

| Komponen | Sizing awal |
|---|---|
| LLM Gateway | 2–3 instance HA di belakang LB; autoscale by RPM |
| OTel Collector | 2 instance HA; sizing by event rate |
| IdP bridge | 2 instance HA; sesi cache |
| **MCP Server** | **2 instance HA; sizing by invocation rate model bank** |
| Audit store | Object store WORM; estimasi volume dari rata-rata event/hari × retensi |
| SIEM | Lisensi by ingest GB/hari — hitung dari volume log gabungan |

## B.9 MCP Server / ML LAB (Batas Data Sensitif) — *baru*

Komponen inti yang menegakkan **Aturan Emas**. MCP Server adalah satu-satunya pintu antara orkestrator LLM dan aset sensitif bank.

**Tanggung jawab**
- **Tool gateway** — mengekspos model bank (scoring, fraud, dll.) dan query data nasabah sebagai *tool* MCP yang ter-skema.
- **Authz per model** — setiap tool punya kebijakan akses sendiri (siapa/role apa boleh memanggil model mana).
- **Parameter referensi, bukan data mentah** — pemanggil (Gateway/LLM) mengirim *reference id* (mis. `customer_ref`, `account_ref`), bukan PII. Resolusi ref → data nyata terjadi **di dalam** ML LAB.
- **De-identifikasi keluaran** — hasil yang dikembalikan ke Gateway sudah diringkas/di-mask; tidak membawa PII atau bobot model.
- **Audit invocation** — setiap pemanggilan dicatat ke Audit Store (immutable): model, pemanggil, ref-params (hash), keputusan authz, timestamp.

**Kontrak tool (ilustratif)**
```json
{
  "tool": "scoring.credit_risk",
  "authz": { "allowed_roles": ["risk-analyst", "chatbot-orchestrator"] },
  "input_schema": {
    "customer_ref": "string (opaque id, BUKAN NIK/nama)",
    "product": "enum[kpr, kta, cc]"
  },
  "output_schema": {
    "risk_band": "enum[low, medium, high]",
    "explanation": "string (sudah di-de-identifikasi)"
  },
  "egress": "DENY",                 // hasil tidak boleh dikirim mentah ke LLM eksternal
  "audit": "REQUIRED"
}
```

**Aturan penegakan**
- Koneksi masuk hanya dari **LLM Gateway** via **mTLS**; tidak menerima koneksi dari internet.
- **Tidak ada rute egress** dari ML LAB ke OpenAI/Claude — diperkuat di egress proxy & firewall zona.
- Validasi bahwa payload yang dikembalikan ke Gateway **bebas PII** sebelum boleh masuk ke prompt LLM (guardrail_out + DLP).
- Setiap invocation menghasilkan record `mcp_invocation` pada Common Event Format (B.5).

---

## Lampiran — Hal yang Wajib Diverifikasi

1. Nama field/kunci `managed-settings.json`, env var OTel, dan endpoint Compliance API terhadap dokumentasi resmi terkini.
2. Cakupan enforcement managed settings & metrik biaya per-user di Team vs Enterprise.
3. Retensi data sisi vendor & opsi **data residency** untuk Indonesia.
4. Keterlibatan **Legal** sebelum mengaktifkan logging konten prompt (UU PDP).
5. Daftar domain egress final & kebijakan proxy korporat.
6. **Skema parameter referensi MCP** & mekanisme de-identifikasi keluaran model bank (review oleh tim Model Risk & Security).
7. Kebijakan **authz per model** di MCP Server dan pemetaannya ke role IdP.

---

## Lampiran B — As-Built MVP (Juni 2026)

> **Penting:** BAGIAN A & B di atas = **desain target** (aspirasional, dua platform penuh). Lampiran ini meringkas **apa yang benar-benar dibangun** pada MVP lokal (repo `trapping-mvp`). Detail lengkap (delta per-komponen, arsitektur ingest, container/port) ada di **`LLD-Activity-Trapping-Service.md` §11** — di sini hanya ringkasan; jangan duplikasi agar tidak ada dua sumber yang melenceng. Lihat juga tab **"Actual LLD"** di `Final-Architecture-Chatbot-MLLAB-ClaudeCode.drawio`.

**Cakupan yang dibangun:** hanya **lapisan L2** (Claude Code: OTel + Hooks). Platform Chatbot/GPT, MCP/ML LAB, dan seluruh penegakan in-band lain **tidak** dibangun di MVP.

**Ringkasan delta desain → aktual:**

| Aspek desain (A/B) | Status MVP | Aktual |
|---|---|---|
| L1 LLM Gateway (Chatbot) | ❌ | Di luar scope MVP |
| L2 OTel + Hooks (Claude Code) | ✅ | `managed-settings.json` + `hooks/trap.mjs` → OTLP collector; verified live |
| MCP Server / ML LAB (Aturan Emas) | ❌ | Tidak dibangun |
| Egress proxy / DLP / CASB (backstop) | ❌ | Stub kebijakan saja |
| Compliance API (Enterprise) | ❌ | Butuh Claude Enterprise |
| Ingest queue durable + Normalizer(CEF)/Enricher/Router | 🟡 | Diringkas jadi **satu OTel Collector** (redaksi PII + fan-out); skema native OTel, bukan CEF v1 penuh |
| SIEM | ❌ | Dihapus dari MVP |
| Audit Store WORM + hash-chain | 🟡 | Hanya `data/otel/*.jsonl` (append, **tanpa** WORM/hash-chain) |
| Reconciler (anti shadow-usage) | ❌ | Tidak dibangun |
| BI / Cost / Observability | ✅ (lebih kaya) | ClickHouse/SigNoz (store permanen) + 4 dashboard SigNoz + dashboard live `:8091` (`trapping-live`, WebSocket, poll ClickHouse 30h → cache Redis TTL 30 hari) |

**⚠️ Kelengkapan BELUM terbukti.** §7 LLD (anti-bypass / pembuktian kelengkapan) **tidak** terpenuhi: tidak ada **L3 egress backstop** dan tidak ada **rekonsiliasi vs billing vendor**. MVP hanya menangkap telemetri klien **L2** yang secara teori bisa dimatikan/di-bypass — sehingga klaim "menangkap **semua** aktivitas" **belum terbukti**. Untuk kelengkapan sesuai desain, **L3 + Reconciler wajib** ditambahkan, dan audit lokal perlu ditingkatkan ke WORM/hash-chain.
