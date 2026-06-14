#!/usr/bin/env node
/**
 * Generator dashboard SigNoz #2 — "Claude Code — Telemetry & Cost (Native OTel)".
 * Menyamai kekayaan dashboard :8090: biaya, token in/out, user prompt, prompt->response.
 *
 * Sumber (SATU pipa OTel, beda signal):
 *   - METRICS (signoz_metrics): claude_code.cost.usage, claude_code.token.usage,
 *     claude_code.active_time.total, claude_code.lines_of_code.count  (Delta/Sum)
 *   - LOGS (signoz_logs, service.name=claude-code): user_prompt, api_response_body
 *
 * Output: scripts/_dash2.json  (POST/PUT ke /api/v1/dashboards atau Import JSON via UI)
 */
import fs from 'node:fs';

const tagKey = (k) => ({ key: k, dataType: 'string', type: 'tag', isColumn: false, isJSON: false });

// ---- metric builder (v5 native: aggregations[{metricName,temporality,timeAggregation,spaceAggregation}]) ----
function metricQuery({ metric, group = [], filterExpr = '', legend = '', reduceTo = 'sum', timeAgg = 'sum', spaceAgg = 'sum' }) {
  return {
    aggregations: [{ metricName: metric, temporality: 'Delta', timeAggregation: timeAgg, spaceAggregation: spaceAgg }],
    dataSource: 'metrics',
    queryName: 'A', expression: 'A', disabled: false,
    filter: { expression: filterExpr },
    functions: [], groupBy: group, having: { expression: '' },
    legend, limit: null, orderBy: [], stepInterval: 60, reduceTo,
  };
}

// ---- log builder (native claude-code feed) ----
function logQuery({ filterExpr, group = [], legend = '', orderBy = [], limit = null, raw = false }) {
  const q = {
    aggregations: raw ? [] : [{ expression: 'count()' }],
    dataSource: 'logs', queryName: 'A', expression: 'A', disabled: false,
    filter: { expression: filterExpr }, functions: [], groupBy: group,
    having: { expression: '' }, legend, limit, orderBy, stepInterval: 60,
  };
  if (raw) q.orderBy = [{ columnName: 'timestamp', order: 'desc' }];
  else q.reduceTo = 'sum';
  return q;
}

function widget({ id, title, description = '', panelTypes = 'graph', queryData = [], yAxisUnit = 'none', isStacked = false, fillSpans = false, logFields = null }) {
  return {
    id, title, description, panelTypes, isStacked, fillSpans,
    opacity: '1', nullZeroValues: 'zero', timePreferance: 'GLOBAL_TIME',
    softMax: null, softMin: null,
    selectedLogFields: panelTypes === 'list'
      ? (logFields || [{ dataType: 'string', type: '', name: 'body' }, { dataType: 'string', type: '', name: 'timestamp' }])
      : null,
    selectedTracesFields: null, yAxisUnit, thresholds: [],
    query: {
      queryType: 'builder',
      promql: [{ name: 'A', query: '', legend: '', disabled: false }],
      clickhouse_sql: [{ name: 'A', query: '', legend: '', disabled: false }],
      id: 'qid-' + id,
      builder: { queryData, queryFormulas: [] },
    },
  };
}

const COST = 'claude_code.cost.usage';
const TOKEN = 'claude_code.token.usage';
const ACTIVE = 'claude_code.active_time.total';
const LOC = 'claude_code.lines_of_code.count';
// Key atribut ber-titik (event.name) WAJIB diawali qualifier `attribute.` di expression v5,
// kalau tidak parser memecah 'event.name' -> error "key `name` not found".
const L_PROMPT = "attribute.event.name = 'user_prompt'";
const L_RESP = "attribute.event.name = 'api_response_body'";

const W = [];
const layout = [];
const place = (i, x, y, w, h) => layout.push({ i, x, y, w, h });

// Baris 0 — KPI
W.push(widget({ id: 'kpi-cost', title: 'Total Cost (USD)', description: 'Akumulasi biaya API Claude Code (metric claude_code.cost.usage).', panelTypes: 'value', yAxisUnit: 'none',
  queryData: [metricQuery({ metric: COST, reduceTo: 'sum' })] }));
W.push(widget({ id: 'kpi-tokens', title: 'Total Tokens', description: 'Total token (input+output+cache) — claude_code.token.usage.', panelTypes: 'value',
  queryData: [metricQuery({ metric: TOKEN, reduceTo: 'sum' })] }));
W.push(widget({ id: 'kpi-active', title: 'Active Time (s)', description: 'Total waktu aktif sesi — claude_code.active_time.total.', panelTypes: 'value',
  queryData: [metricQuery({ metric: ACTIVE, reduceTo: 'sum' })] }));
W.push(widget({ id: 'kpi-loc', title: 'Lines of Code', description: 'Baris kode ditambah/diubah — claude_code.lines_of_code.count.', panelTypes: 'value',
  queryData: [metricQuery({ metric: LOC, reduceTo: 'sum' })] }));

// Baris 1 — Cost over time + Token by type
W.push(widget({ id: 'ts-cost', title: 'Cost over Time (USD)', description: 'Biaya per interval waktu.', panelTypes: 'graph', fillSpans: true, yAxisUnit: 'none',
  queryData: [metricQuery({ metric: COST, legend: 'cost' })] }));
W.push(widget({ id: 'ts-token-type', title: 'Token Usage by Type', description: 'input / output / cacheRead / cacheCreation dari waktu ke waktu.', panelTypes: 'graph', isStacked: true,
  queryData: [metricQuery({ metric: TOKEN, group: [tagKey('type')], legend: '{{type}}' })] }));

// Baris 2 — Cost by model + Cost by user
W.push(widget({ id: 'tbl-cost-model', title: 'Cost by Model', description: 'Biaya dipecah per model.', panelTypes: 'table',
  queryData: [metricQuery({ metric: COST, group: [tagKey('model')], legend: '{{model}}' })] }));
W.push(widget({ id: 'tbl-cost-user', title: 'Cost by User', description: 'Biaya dipecah per user.email.', panelTypes: 'table',
  queryData: [metricQuery({ metric: COST, group: [tagKey('user.email')], legend: '{{user.email}}' })] }));

// Baris 3 — Token by user (graph) + Prompts/min-ish (count user_prompt over time)
W.push(widget({ id: 'ts-token-user', title: 'Token Usage by User', description: 'Konsumsi token per user.email.', panelTypes: 'graph', isStacked: true,
  queryData: [metricQuery({ metric: TOKEN, group: [tagKey('user.email')], legend: '{{user.email}}' })] }));
W.push(widget({ id: 'ts-prompts', title: 'User Prompts over Time', description: 'Jumlah prompt user (log event.name=user_prompt).', panelTypes: 'graph', fillSpans: true,
  queryData: [logQuery({ filterExpr: L_PROMPT, legend: 'prompts' })] }));

// Baris 4 — User prompts (list) — teks prompt + email
W.push(widget({ id: 'list-prompts', title: 'User Prompts (latest)', description: 'Teks prompt user terbaru beserta user.email (redaksi PII aktif).', panelTypes: 'list',
  logFields: [
    { dataType: 'string', type: '', name: 'timestamp' },
    { dataType: 'string', type: 'tag', name: 'user.email' },
    { dataType: 'string', type: 'tag', name: 'prompt' },
  ],
  queryData: [logQuery({ filterExpr: L_PROMPT, raw: true, limit: 50 })] }));

// Baris 5 — API responses (list) — isi response model
W.push(widget({ id: 'list-resp', title: 'Model Responses (latest)', description: 'Isi response API model (api_response_body) terbaru.', panelTypes: 'list',
  logFields: [
    { dataType: 'string', type: '', name: 'timestamp' },
    { dataType: 'string', type: 'tag', name: 'body' },
  ],
  queryData: [logQuery({ filterExpr: L_RESP, raw: true, limit: 50 })] }));

// layout grid 12 kolom
place('kpi-cost', 0, 0, 3, 2); place('kpi-tokens', 3, 0, 3, 2); place('kpi-active', 6, 0, 3, 2); place('kpi-loc', 9, 0, 3, 2);
place('ts-cost', 0, 2, 6, 4); place('ts-token-type', 6, 2, 6, 4);
place('tbl-cost-model', 0, 6, 6, 4); place('tbl-cost-user', 6, 6, 6, 4);
place('ts-token-user', 0, 10, 6, 4); place('ts-prompts', 6, 10, 6, 4);
place('list-prompts', 0, 14, 12, 5);
place('list-resp', 0, 19, 12, 5);

const dashboard = {
  title: 'Claude Code — Telemetry & Cost (Native OTel)',
  description: 'Biaya, token, dan percakapan (prompt→response) Claude Code dari telemetry native OTel (service.name=claude-code + metrics claude_code.*). Sumber sama dgn dashboard :8090 — satu collector OTel, beda signal (logs vs metrics). Bagian Activity Trapping Service (ML LAB / Bank Mega).',
  tags: ['claude-code', 'telemetry', 'cost', 'tokens', 'native-otel'],
  layout, widgets: W, variables: {}, version: 'v4',
};

fs.writeFileSync('scripts/_dash2.json', JSON.stringify(dashboard, null, 2));
console.log('OK -> scripts/_dash2.json | widgets:', W.length, '| layout:', layout.length);
