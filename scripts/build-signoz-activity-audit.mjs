#!/usr/bin/env node
/**
 * Generator dashboard SigNoz #4 — "Claude Code — Activity & Token Audit (30 hari)".
 *
 * Jawaban untuk kebutuhan: lihat SEMUA aktivitas user (default 30 hari), telusuri tiap
 * prompt sampai detail (hook, command, tool call, response), dan lihat pemakaian token
 * gaya "header detail" — 1 prompt habis berapa token + rincian tiap komponen.
 *
 * Sumber & teknik (terverifikasi live 2026-06-14):
 *   - Token/biaya per-prompt = LOGS event `api_request` (`attributes_number`:
 *     input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd),
 *     berkorelasi via `attributes_string['prompt.id']`. METRICS tak punya prompt.id.
 *   - Panel agregasi pakai queryType `clickhouse_sql` (BUKAN builder) — query_range v5
 *     menerima `{type:'clickhouse_sql',spec:{name,query}}`, menghindari jebakan migrasi
 *     builder v4->v5. Time-picker tersubstitusi via {{.start_timestamp_nano}}/{{.end_timestamp_nano}};
 *     variabel dashboard via {{.prompt_id}} (auto-quote string).
 *   - Panel daftar event mentah (timeline/tool/response) pakai builder raw-list + $prompt_id
 *     (pola yang sudah terbukti di dashboard drill-down sebelumnya).
 *   - Event hook-layer (service.name=claude-code-hook) TIDAK ber-prompt.id; hanya session.id.
 *     Maka panel hook di drill-down memetakan via session dari prompt terpilih (subquery).
 *
 * Catatan WAKTU: SigNoz menyimpan timestamp dalam UInt64 nanodetik; ClickHouse tampil UTC.
 * Kolom waktu ditampilkan WIB via toTimeZone(...,'Asia/Jakarta'). Menit ClickHouse = %i (%M = nama bulan).
 *
 * Catatan "30 hari": SigNoz v0.128 TIDAK menyimpan default rentang waktu per-dashboard.
 * Semua panel menghormati time-picker global -> set picker ke "Last 30 days" saat membuka.
 *
 * Output: scripts/_dash4.json  (POST ke /api/v1/dashboards atau Import JSON via UI)
 */
import fs from 'node:fs';

// ====== filter dasar (dipakai berulang di SQL) ======
const API = "attributes_string['event.name']='api_request'";
const TIME = 'timestamp BETWEEN {{.start_timestamp_nano}} AND {{.end_timestamp_nano}}';
const TOK_SUM =
  "attributes_number['input_tokens']+attributes_number['output_tokens']+" +
  "attributes_number['cache_creation_tokens']+attributes_number['cache_read_tokens']";

// ====== widget builders ======
function chWidget({ id, title, description = '', panelTypes = 'table', sql, yAxisUnit = 'none' }) {
  return {
    id, title, description, panelTypes, isStacked: false, fillSpans: false,
    opacity: '1', nullZeroValues: 'zero', timePreferance: 'GLOBAL_TIME',
    softMax: null, softMin: null, selectedLogFields: null, selectedTracesFields: null,
    yAxisUnit, thresholds: [],
    query: {
      queryType: 'clickhouse_sql',
      promql: [{ name: 'A', query: '', legend: '', disabled: false }],
      clickhouse_sql: [{ name: 'A', query: sql, legend: '', disabled: false }],
      id: 'qid-' + id,
      builder: { queryData: [], queryFormulas: [] },
    },
  };
}

// builder raw-list (event mentah) — pola terbukti dari dashboard drill-down
function logRaw({ filterExpr, limit = 100, orderAsc = false }) {
  return {
    aggregations: [], dataSource: 'logs', queryName: 'A', expression: 'A', disabled: false,
    filter: { expression: filterExpr }, functions: [], groupBy: [], having: { expression: '' },
    legend: '', limit, orderBy: [{ columnName: 'timestamp', order: orderAsc ? 'asc' : 'desc' }], stepInterval: 60,
  };
}
function listWidget({ id, title, description = '', logFields, queryData }) {
  return {
    id, title, description, panelTypes: 'list', isStacked: false, fillSpans: false,
    opacity: '1', nullZeroValues: 'zero', timePreferance: 'GLOBAL_TIME', softMax: null, softMin: null,
    selectedLogFields: logFields, selectedTracesFields: null, yAxisUnit: 'none', thresholds: [],
    query: {
      queryType: 'builder',
      promql: [{ name: 'A', query: '', legend: '', disabled: false }],
      clickhouse_sql: [{ name: 'A', query: '', legend: '', disabled: false }],
      id: 'qid-' + id,
      builder: { queryData, queryFormulas: [] },
    },
  };
}
const tsField = { dataType: 'string', type: '', name: 'timestamp' };
const tag = (n) => ({ dataType: 'string', type: 'tag', name: n });
const bodyField = { dataType: 'string', type: '', name: 'body' };

const PID = 'attribute.prompt.id = $prompt_id';
const W = [];
const layout = [];
const place = (i, x, y, w, h) => layout.push({ i, x, y, w, h });

// =================== BARIS 0 — KPI ringkas (30 hari, semua user) ===================
W.push(chWidget({ id: 'kpi-prompts', title: 'Total Prompt', panelTypes: 'value',
  description: 'Jumlah prompt unik (prompt.id) pada rentang waktu.',
  sql: `SELECT count(DISTINCT attributes_string['prompt.id']) AS v FROM signoz_logs.distributed_logs_v2 WHERE ${API} AND attributes_string['prompt.id']!='' AND ${TIME}` }));
W.push(chWidget({ id: 'kpi-tokens', title: 'Total Token', panelTypes: 'value',
  description: 'Total token (input+output+cacheCreate+cacheRead) dari event api_request.',
  sql: `SELECT toUInt64(sum(${TOK_SUM})) AS v FROM signoz_logs.distributed_logs_v2 WHERE ${API} AND ${TIME}` }));
W.push(chWidget({ id: 'kpi-cost', title: 'Total Biaya (USD)', panelTypes: 'value',
  description: 'Akumulasi cost_usd dari event api_request.',
  sql: `SELECT round(sum(attributes_number['cost_usd']),4) AS v FROM signoz_logs.distributed_logs_v2 WHERE ${API} AND ${TIME}` }));
W.push(chWidget({ id: 'kpi-users', title: 'User Aktif', panelTypes: 'value',
  description: 'Jumlah user.email unik yang ber-aktivitas.',
  sql: `SELECT count(DISTINCT attributes_string['user.email']) AS v FROM signoz_logs.distributed_logs_v2 WHERE ${API} AND ${TIME}` }));
W.push(chWidget({ id: 'kpi-tools', title: 'Tool Calls', panelTypes: 'value',
  description: 'Jumlah hasil tool (event tool_result).',
  sql: `SELECT count() AS v FROM signoz_logs.distributed_logs_v2 WHERE attributes_string['event.name']='tool_result' AND ${TIME}` }));
W.push(chWidget({ id: 'kpi-apireq', title: 'API Requests', panelTypes: 'value',
  description: 'Jumlah panggilan API model (event api_request).',
  sql: `SELECT count() AS v FROM signoz_logs.distributed_logs_v2 WHERE ${API} AND ${TIME}` }));

// =================== BARIS 1 — tren harian ===================
W.push(chWidget({ id: 'ts-tokens', title: 'Token per Hari', panelTypes: 'bar', description: 'Total token per hari (WIB).',
  sql: `SELECT toStartOfDay(toTimeZone(fromUnixTimestamp64Nano(timestamp),'Asia/Jakarta')) AS ts, toUInt64(sum(${TOK_SUM})) AS total_token FROM signoz_logs.distributed_logs_v2 WHERE ${API} AND ${TIME} GROUP BY ts ORDER BY ts` }));
W.push(chWidget({ id: 'ts-cost', title: 'Biaya per Hari (USD)', panelTypes: 'bar', description: 'Total cost_usd per hari (WIB).',
  sql: `SELECT toStartOfDay(toTimeZone(fromUnixTimestamp64Nano(timestamp),'Asia/Jakarta')) AS ts, round(sum(attributes_number['cost_usd']),4) AS cost_usd FROM signoz_logs.distributed_logs_v2 WHERE ${API} AND ${TIME} GROUP BY ts ORDER BY ts` }));

// =================== BARIS 2 — rekap per user ===================
W.push(chWidget({ id: 'tbl-user', title: 'Rekap per User (token & biaya)', panelTypes: 'table',
  description: 'Per user.email: jumlah prompt, rincian token, total token, dan biaya.',
  sql: `SELECT attributes_string['user.email'] AS user, count(DISTINCT attributes_string['prompt.id']) AS prompts, toUInt64(sum(attributes_number['input_tokens'])) AS input, toUInt64(sum(attributes_number['output_tokens'])) AS output, toUInt64(sum(attributes_number['cache_creation_tokens'])) AS cache_create, toUInt64(sum(attributes_number['cache_read_tokens'])) AS cache_read, toUInt64(sum(${TOK_SUM})) AS total_token, round(sum(attributes_number['cost_usd']),4) AS cost_usd FROM signoz_logs.distributed_logs_v2 WHERE ${API} AND ${TIME} GROUP BY user ORDER BY total_token DESC` }));

// =================== BARIS 3 — TABEL AUDIT per-prompt (inti "header detail") ===================
const AUDIT = `
SELECT
  formatDateTime(toTimeZone(fromUnixTimestamp64Nano(r.last_ts),'Asia/Jakarta'),'%Y-%m-%d %H:%i') AS waktu_wib,
  r.user AS user, r.model AS model, r.api_calls AS api_calls,
  r.input AS input, r.output AS output, r.cache_create AS cache_create, r.cache_read AS cache_read,
  (r.input + r.output + r.cache_create + r.cache_read) AS total_token,
  r.cost_usd AS cost_usd,
  substring(p.prompt, 1, 140) AS prompt,
  r.prompt_id AS prompt_id
FROM (
  SELECT attributes_string['prompt.id'] AS prompt_id, max(timestamp) AS last_ts,
    any(attributes_string['user.email']) AS user, any(attributes_string['model']) AS model, count() AS api_calls,
    toUInt64(sum(attributes_number['input_tokens'])) AS input,
    toUInt64(sum(attributes_number['output_tokens'])) AS output,
    toUInt64(sum(attributes_number['cache_creation_tokens'])) AS cache_create,
    toUInt64(sum(attributes_number['cache_read_tokens'])) AS cache_read,
    round(sum(attributes_number['cost_usd']),4) AS cost_usd
  FROM signoz_logs.distributed_logs_v2
  WHERE ${API} AND attributes_string['prompt.id']!='' AND ${TIME}
  GROUP BY prompt_id
) r
LEFT JOIN (
  SELECT attributes_string['prompt.id'] AS prompt_id, argMax(attributes_string['prompt'], timestamp) AS prompt
  FROM signoz_logs.distributed_logs_v2 WHERE attributes_string['event.name']='user_prompt' GROUP BY prompt_id
) p ON r.prompt_id = p.prompt_id
ORDER BY r.last_ts DESC
LIMIT 300`;
W.push(chWidget({ id: 'tbl-audit', title: 'Audit per Prompt — token & biaya (klik prompt_id lalu pakai di drill-down)', panelTypes: 'table',
  description: 'Satu baris per prompt: waktu (WIB), user, model, jumlah api_call, rincian token (input/output/cacheCreate/cacheRead), TOTAL token, biaya, cuplikan teks prompt, dan prompt_id untuk drill-down.',
  sql: AUDIT }));

// =================== DRILL-DOWN (variabel $prompt_id / {{.prompt_id}}) ===================
// ① picker prompt terbaru
W.push(listWidget({ id: 'dd-picker', title: '① Pilih Prompt — daftar prompt terbaru (cocokkan prompt.id ke dropdown atas)',
  description: 'Daftar user_prompt terbaru beserta prompt.id. Salin prompt.id ke variabel "prompt_id" di atas untuk drill-down.',
  logFields: [tsField, tag('user.email'), tag('prompt'), tag('prompt.id')],
  queryData: [logRaw({ filterExpr: "attribute.event.name = 'user_prompt'", limit: 50 })] }));

// ② HEADER DETAIL token untuk prompt terpilih (1 baris)
W.push(chWidget({ id: 'dd-header', title: '② Header Detail Token — prompt terpilih', panelTypes: 'table',
  description: 'Rincian token untuk prompt terpilih: input, output, cacheCreate, cacheRead, TOTAL, biaya, jumlah api_call, model.',
  sql: `SELECT any(attributes_string['user.email']) AS user, any(attributes_string['model']) AS model, count() AS api_calls, toUInt64(sum(attributes_number['input_tokens'])) AS input, toUInt64(sum(attributes_number['output_tokens'])) AS output, toUInt64(sum(attributes_number['cache_creation_tokens'])) AS cache_create, toUInt64(sum(attributes_number['cache_read_tokens'])) AS cache_read, toUInt64(sum(${TOK_SUM})) AS total_token, round(sum(attributes_number['cost_usd']),4) AS cost_usd FROM signoz_logs.distributed_logs_v2 WHERE ${API} AND attributes_string['prompt.id']={{.prompt_id}} AND ${TIME}` }));
// KPI besar prompt terpilih
W.push(chWidget({ id: 'dd-kpi-total', title: 'Total Token (prompt terpilih)', panelTypes: 'value',
  description: 'Total token prompt terpilih.',
  sql: `SELECT toUInt64(sum(${TOK_SUM})) AS v FROM signoz_logs.distributed_logs_v2 WHERE ${API} AND attributes_string['prompt.id']={{.prompt_id}} AND ${TIME}` }));
W.push(chWidget({ id: 'dd-kpi-cost', title: 'Biaya (prompt terpilih)', panelTypes: 'value',
  description: 'Biaya USD prompt terpilih.',
  sql: `SELECT round(sum(attributes_number['cost_usd']),4) AS v FROM signoz_logs.distributed_logs_v2 WHERE ${API} AND attributes_string['prompt.id']={{.prompt_id}} AND ${TIME}` }));

// ③ Linimasa semua event native prompt terpilih
W.push(listWidget({ id: 'dd-timeline', title: '③ Linimasa — semua aksi prompt terpilih (urut waktu)',
  description: 'Seluruh event native (request, response, tool_decision, tool_result) untuk prompt terpilih, kronologis.',
  logFields: [tsField, tag('event.name'), tag('tool_name'), tag('decision'), bodyField],
  queryData: [logRaw({ filterExpr: PID, limit: 300, orderAsc: true })] }));

// ④ Tool actions + ⑤ Model responses
W.push(listWidget({ id: 'dd-tools', title: '④ Tool Actions (decision + result)',
  description: 'Aksi tool untuk prompt terpilih: nama tool, keputusan, input/hasil.',
  logFields: [tsField, tag('event.name'), tag('tool_name'), tag('decision'), tag('tool_input')],
  queryData: [logRaw({ filterExpr: `${PID} AND tool_name EXISTS`, limit: 150, orderAsc: true })] }));
W.push(listWidget({ id: 'dd-resp', title: '⑤ Model Responses (isi jawaban Claude)',
  description: 'Isi response API model (api_response_body) untuk prompt terpilih.',
  logFields: [tsField, tag('model'), bodyField],
  queryData: [logRaw({ filterExpr: `${PID} AND attribute.event.name = 'api_response_body'`, limit: 50, orderAsc: true })] }));

// ⑥ Hook & command layer (per-SESI dari prompt terpilih — hook tak ber-prompt.id)
const SESSION_HOOKS = `
SELECT
  formatDateTime(toTimeZone(fromUnixTimestamp64Nano(timestamp),'Asia/Jakarta'),'%Y-%m-%d %H:%i:%S') AS waktu_wib,
  attributes_string['event_kind'] AS hook, attributes_string['tool_name'] AS tool,
  attributes_string['decision'] AS decision, attributes_string['policy_rule_id'] AS rule,
  substring(attributes_string['command'], 1, 160) AS command,
  substring(attributes_string['tool_input'], 1, 200) AS tool_input
FROM signoz_logs.distributed_logs_v2
WHERE resources_string['service.name']='claude-code-hook'
  AND attributes_string['session.id'] IN (
    SELECT attributes_string['session.id'] FROM signoz_logs.distributed_logs_v2
    WHERE attributes_string['prompt.id']={{.prompt_id}} AND attributes_string['session.id']!='' )
  AND ${TIME}
ORDER BY timestamp ASC LIMIT 300`;
W.push(chWidget({ id: 'dd-hooks', title: '⑥ Hook & Command (layer kebijakan — per sesi prompt terpilih)', panelTypes: 'table',
  description: 'Event hook-layer (PreToolUse/PostToolUse/UserPromptSubmit dll) untuk SESI yang memuat prompt terpilih. Hook tidak ber-prompt.id, dipetakan via session.id. Menampilkan keputusan kebijakan, command, dan tool_input mentah.',
  sql: SESSION_HOOKS }));

// =================== layout ===================
place('kpi-prompts', 0, 0, 2, 2); place('kpi-tokens', 2, 0, 2, 2); place('kpi-cost', 4, 0, 2, 2);
place('kpi-users', 6, 0, 2, 2); place('kpi-tools', 8, 0, 2, 2); place('kpi-apireq', 10, 0, 2, 2);
place('ts-tokens', 0, 2, 6, 4); place('ts-cost', 6, 2, 6, 4);
place('tbl-user', 0, 6, 12, 5);
place('tbl-audit', 0, 11, 12, 9);
place('dd-picker', 0, 20, 12, 6);
place('dd-header', 0, 26, 8, 3); place('dd-kpi-total', 8, 26, 2, 3); place('dd-kpi-cost', 10, 26, 2, 3);
place('dd-timeline', 0, 29, 12, 8);
place('dd-tools', 0, 37, 6, 7); place('dd-resp', 6, 37, 6, 7);
place('dd-hooks', 0, 44, 12, 7);

// =================== variabel prompt_id ===================
const VKEY = 'var-prompt-id';
const variables = {
  [VKEY]: {
    id: VKEY, name: 'prompt_id',
    description: 'Pilih prompt.id untuk drill-down (panel ②–⑥). Cocokkan dengan tabel audit / picker ①.',
    type: 'QUERY',
    queryValue:
      "SELECT attributes_string['prompt.id'] AS prompt_id FROM signoz_logs.distributed_logs_v2 " +
      "WHERE attributes_string['event.name']='user_prompt' AND attributes_string['prompt.id']!='' " +
      'GROUP BY prompt_id ORDER BY max(timestamp) DESC LIMIT 100',
    customValue: '', textboxValue: '', multiSelect: false, showALLOption: false,
    sort: 'DISABLED', order: 0, modificationUUID: VKEY, selectedValue: '',
  },
};

const dashboard = {
  title: 'Claude Code — Activity & Token Audit (30 hari)',
  description: 'Audit aktivitas Claude Code: rekap 30 hari semua user, tabel per-prompt "header detail" (total token + rincian input/output/cacheCreate/cacheRead + biaya), dan drill-down per prompt (linimasa native, tool actions, response, serta hook/command per sesi). Token/biaya bersumber dari LOGS api_request (ber-prompt.id), bukan metrics. SET TIME-PICKER KE "Last 30 days". Bagian Activity Trapping Service (ML LAB / Bank Mega).',
  tags: ['claude-code', 'audit', 'token', 'cost', 'drill-down', '30d'],
  layout, widgets: W, variables, version: 'v4',
};

fs.writeFileSync('scripts/_dash4.json', JSON.stringify(dashboard, null, 2));
console.log('OK -> scripts/_dash4.json | widgets:', W.length, '| panels clickhouse + builder-list | variable: prompt_id');
