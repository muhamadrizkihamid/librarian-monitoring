#!/usr/bin/env node
/**
 * Generator dashboard SigNoz #3 — "Claude Code — Prompt Drill-Down".
 * Pilih 1 prompt (variable $prompt_id) -> SEMUA request/response/tool action utk prompt itu tampil.
 *
 * Korelasi: atribut `prompt.id` (ada di user_prompt, api_request/_body, api_response_body,
 * tool_decision, tool_result). Filter expr v5: `attribute.prompt.id = $prompt_id`.
 * Token substitusi variabel = $namaVar (terbukti resolve via /api/v5/query_range).
 *
 * Output: scripts/_dash3.json
 */
import fs from 'node:fs';

const PID_FILTER = 'attribute.prompt.id = $prompt_id';

function logQuery({ filterExpr, group = [], legend = '', raw = false, limit = null, orderAsc = false }) {
  const q = {
    aggregations: raw ? [] : [{ expression: 'count()' }],
    dataSource: 'logs', queryName: 'A', expression: 'A', disabled: false,
    filter: { expression: filterExpr }, functions: [], groupBy: group,
    having: { expression: '' }, legend, limit, orderBy: [], stepInterval: 60,
  };
  if (raw) q.orderBy = [{ columnName: 'timestamp', order: orderAsc ? 'asc' : 'desc' }];
  else q.reduceTo = 'sum';
  return q;
}

function widget({ id, title, description = '', panelTypes = 'list', queryData = [], logFields = null, yAxisUnit = 'none' }) {
  return {
    id, title, description, panelTypes, isStacked: false, fillSpans: false,
    opacity: '1', nullZeroValues: 'zero', timePreferance: 'GLOBAL_TIME',
    softMax: null, softMin: null,
    selectedLogFields: panelTypes === 'list'
      ? (logFields || [{ dataType: 'string', type: '', name: 'timestamp' }, { dataType: 'string', type: '', name: 'body' }])
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

const tagField = (n) => ({ dataType: 'string', type: 'tag', name: n });
const tsField = { dataType: 'string', type: '', name: 'timestamp' };

const W = [];
const layout = [];
const place = (i, x, y, w, h) => layout.push({ i, x, y, w, h });

// KPI per prompt terpilih
W.push(widget({ id: 'kpi-events', title: 'Total Events (prompt)', panelTypes: 'value', description: 'Jumlah seluruh event untuk prompt terpilih.',
  queryData: [logQuery({ filterExpr: PID_FILTER })] }));
W.push(widget({ id: 'kpi-tools', title: 'Tool Calls', panelTypes: 'value', description: 'Jumlah hasil tool (tool_result) untuk prompt terpilih.',
  queryData: [logQuery({ filterExpr: `${PID_FILTER} AND tool_name EXISTS` })] }));
W.push(widget({ id: 'kpi-resp', title: 'Model Responses', panelTypes: 'value', description: 'Jumlah response API model (api_response_body).',
  queryData: [logQuery({ filterExpr: `${PID_FILTER} AND attribute.event.name = 'api_response_body'` })] }));
W.push(widget({ id: 'kpi-tldecn', title: 'Tool Decisions', panelTypes: 'value', description: 'Jumlah keputusan tool (tool_decision: accept/deny).',
  queryData: [logQuery({ filterExpr: `${PID_FILTER} AND attribute.event.name = 'tool_decision'` })] }));

// ① Picker — daftar prompt terbaru (TIDAK difilter prompt_id) untuk mencocokkan teks <-> prompt.id di dropdown
W.push(widget({ id: 'list-picker', title: '① Prompt terbaru — cocokkan teks dgn prompt.id di dropdown atas', panelTypes: 'list',
  description: 'Daftar user_prompt terbaru. Lihat prompt.id-nya, lalu pilih di dropdown "prompt_id" di atas.',
  logFields: [tsField, tagField('user.email'), tagField('prompt'), tagField('prompt.id')],
  queryData: [logQuery({ filterExpr: "attribute.event.name = 'user_prompt'", raw: true, limit: 50 })] }));

// ② Linimasa SEMUA event prompt terpilih (urut waktu asc)
W.push(widget({ id: 'list-timeline', title: '② Linimasa — semua aksi prompt terpilih (urut waktu)', panelTypes: 'list',
  description: 'Seluruh event (request, response, tool) untuk prompt terpilih, urut kronologis.',
  logFields: [tsField, tagField('event.name'), tagField('tool_name'), tagField('decision'), { dataType: 'string', type: '', name: 'body' }],
  queryData: [logQuery({ filterExpr: PID_FILTER, raw: true, limit: 200, orderAsc: true })] }));

// ③ Tool actions (decision + result)
W.push(widget({ id: 'list-tools', title: '③ Tool Actions (decision + result)', panelTypes: 'list',
  description: 'Aksi tool untuk prompt terpilih: nama tool, keputusan, input/hasil.',
  logFields: [tsField, tagField('event.name'), tagField('tool_name'), tagField('decision'), { dataType: 'string', type: 'tag', name: 'tool_input' }],
  queryData: [logQuery({ filterExpr: `${PID_FILTER} AND tool_name EXISTS`, raw: true, limit: 100, orderAsc: true })] }));

// ④ Model responses (isi jawaban)
W.push(widget({ id: 'list-resp', title: '④ Model Responses (isi jawaban)', panelTypes: 'list',
  description: 'Isi response API model (api_response_body) untuk prompt terpilih.',
  logFields: [tsField, tagField('model'), { dataType: 'string', type: '', name: 'body' }],
  queryData: [logQuery({ filterExpr: `${PID_FILTER} AND attribute.event.name = 'api_response_body'`, raw: true, limit: 50, orderAsc: true })] }));

// layout
place('kpi-events', 0, 0, 3, 2); place('kpi-tools', 3, 0, 3, 2); place('kpi-resp', 6, 0, 3, 2); place('kpi-tldecn', 9, 0, 3, 2);
place('list-picker', 0, 2, 12, 6);
place('list-timeline', 0, 8, 12, 7);
place('list-tools', 0, 15, 6, 6);
place('list-resp', 6, 15, 6, 6);

// ---- variable prompt_id (type QUERY, raw ClickHouse) ----
const VKEY = 'var-prompt-id';
const variables = {
  [VKEY]: {
    id: VKEY,
    name: 'prompt_id',
    description: 'Pilih prompt (prompt.id) untuk di-drill-down. Cocokkan dengan tabel ① di bawah.',
    type: 'QUERY',
    queryValue:
      "SELECT attributes_string['prompt.id'] AS prompt_id " +
      'FROM signoz_logs.distributed_logs_v2 ' +
      "WHERE attributes_string['event.name'] = 'user_prompt' AND attributes_string['prompt.id'] != '' " +
      'GROUP BY prompt_id ORDER BY max(timestamp) DESC LIMIT 50',
    customValue: '',
    textboxValue: '',
    multiSelect: false,
    showALLOption: false,
    sort: 'DISABLED',
    order: 0,
    modificationUUID: VKEY,
    selectedValue: '',
  },
};

const dashboard = {
  title: 'Claude Code — Prompt Drill-Down',
  description: 'Pilih satu prompt (dropdown prompt_id) untuk melihat SELURUH request, response, dan tool action Claude CLI pada siklus prompt itu. Korelasi via atribut prompt.id (telemetry native OTel). Bagian Activity Trapping Service (ML LAB / Bank Mega).',
  tags: ['claude-code', 'drill-down', 'prompt', 'telemetry'],
  layout, widgets: W, variables, version: 'v4',
};

fs.writeFileSync('scripts/_dash3.json', JSON.stringify(dashboard, null, 2));
console.log('OK -> scripts/_dash3.json | widgets:', W.length, '| variables: prompt_id (QUERY)');
