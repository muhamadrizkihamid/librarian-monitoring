#!/usr/bin/env node
/**
 * Generator dashboard SigNoz "Activity Trapping — Claude Code (L2 Hooks)".
 * Skema builder query sudah divalidasi empiris lewat /api/v4/query_range (v0.128).
 *
 * Output: scripts/_dashboard.json  (siap di-POST ke /api/v1/dashboards atau Import JSON via UI)
 *
 * Sumber data: OTLP logs service.name=claude-code-hook (capture_layer=hooks, dari managed-settings).
 */
import fs from 'node:fs';

const SVC = 'claude-code-hook';

// ---- helper pembentuk key/filter (typing kritikal: service.name=resource, sisanya=tag) ----
const resourceKey = (k) => ({ key: k, dataType: 'string', type: 'resource', isColumn: false, isJSON: false });
const tagKey = (k) => ({ key: k, dataType: 'string', type: 'tag', isColumn: false, isJSON: false });

const svcFilter = { key: resourceKey('service.name'), op: '=', value: SVC };

// Format query NATIVE v5 (SigNoz v0.128): aggregations[] + filter.expression string.
// Hindari migrasi v4->v5 yang merusak ekspizi filter saat operator EXISTS dipakai.
const BASE_FILTER = "service.name = 'claude-code-hook'";
function builderQuery({ name = 'A', agg = 'count()', group = [], filterExpr = BASE_FILTER, legend = '', orderBy = [], limit = null, reduceTo = 'sum' }) {
  return {
    aggregations: [{ expression: agg }],
    dataSource: 'logs',
    queryName: name,
    expression: name,
    disabled: false,
    filter: { expression: filterExpr },
    functions: [],
    groupBy: group,
    having: { expression: '' },
    legend,
    limit,
    orderBy,
    stepInterval: 60,
    reduceTo,
  };
}

function widget({ id, title, description = '', panelTypes = 'graph', queryData = [], yAxisUnit = 'none', fillSpans = false, isStacked = false }) {
  return {
    id,
    title,
    description,
    panelTypes,
    isStacked,
    fillSpans,
    opacity: '1',
    nullZeroValues: 'zero',
    timePreferance: 'GLOBAL_TIME',
    softMax: null,
    softMin: null,
    selectedLogFields: panelTypes === 'list'
      ? [ { dataType: 'string', type: '', name: 'body' }, { dataType: 'string', type: '', name: 'timestamp' } ]
      : null,
    selectedTracesFields: null,
    yAxisUnit,
    thresholds: [],
    query: {
      queryType: 'builder',
      promql: [{ name: 'A', query: '', legend: '', disabled: false }],
      clickhouse_sql: [{ name: 'A', query: '', legend: '', disabled: false }],
      id: 'qid-' + id,
      builder: { queryData, queryFormulas: [] },
    },
  };
}

// ---------- definisi panel ----------
const W = [];
const layout = [];
const uid = (s) => s; // id stabil & deskriptif

const F_TOOL = `${BASE_FILTER} AND tool_name EXISTS`;
const F_CMD = `${BASE_FILTER} AND command EXISTS`;
const F_BLOCK = `${BASE_FILTER} AND decision != 'allow'`;
const ORDER_DESC = [{ key: { name: 'count()' }, order: 'desc' }];

// Baris 0 — KPI value panels (h=2 di grid 12 kolom)
W.push(widget({ id: uid('kpi-total'), title: 'Total Hook Events', description: 'Jumlah event hook (managed-settings) pada rentang waktu terpilih.', panelTypes: 'value',
  queryData: [builderQuery({ agg: 'count()', reduceTo: 'sum' })] }));
W.push(widget({ id: uid('kpi-sessions'), title: 'Active Sessions', description: 'Sesi Claude Code unik (session.id).', panelTypes: 'value',
  queryData: [builderQuery({ agg: 'count_distinct(session.id)', reduceTo: 'max' })] }));
W.push(widget({ id: uid('kpi-users'), title: 'Active Users', description: 'User unik (user.id) yang aktivitasnya tertangkap.', panelTypes: 'value',
  queryData: [builderQuery({ agg: 'count_distinct(user.id)', reduceTo: 'max' })] }));
W.push(widget({ id: uid('kpi-blocked'), title: 'Blocked / Flagged', description: 'Keputusan policy non-allow (block/flag). Saat ini 0 = capture-only.', panelTypes: 'value',
  queryData: [builderQuery({ agg: 'count()', reduceTo: 'sum', filterExpr: F_BLOCK })] }));

// Baris 1 — Event volume over time (stacked by event_kind) + Tool usage
W.push(widget({ id: uid('ts-eventkind'), title: 'Event Volume by Kind', description: 'Aliran event per jenis (tool_call, tool_result, request, response, session_*).', panelTypes: 'graph', isStacked: true, fillSpans: true,
  queryData: [builderQuery({ group: [tagKey('event_kind')], legend: '{{event_kind}}' })] }));
W.push(widget({ id: uid('bar-tools'), title: 'Tool Usage', description: 'Distribusi pemakaian tool (Bash, Read, Edit, Write, MCP).', panelTypes: 'bar',
  queryData: [builderQuery({ group: [tagKey('tool_name')], legend: '{{tool_name}}', filterExpr: F_TOOL })] }));

// Baris 2 — Decisions over time + Top tools table
W.push(widget({ id: uid('ts-decision'), title: 'Policy Decisions over Time', description: 'Allow vs block vs flag sepanjang waktu (jejak enforcement).', panelTypes: 'graph', isStacked: true,
  queryData: [builderQuery({ group: [tagKey('decision')], legend: '{{decision}}' })] }));
W.push(widget({ id: uid('tbl-tools'), title: 'Top Tools (table)', description: 'Peringkat tool berdasarkan jumlah pemanggilan.', panelTypes: 'table',
  queryData: [builderQuery({ group: [tagKey('tool_name')], legend: '', orderBy: ORDER_DESC, filterExpr: F_TOOL })] }));

// Baris 3 — Activity by user + Top commands table
W.push(widget({ id: uid('ts-user'), title: 'Activity by User', description: 'Volume aktivitas per user.id dari waktu ke waktu.', panelTypes: 'graph', isStacked: true,
  queryData: [builderQuery({ group: [tagKey('user.id')], legend: '{{user.id}}' })] }));
W.push(widget({ id: uid('tbl-cmd'), title: 'Top Bash Commands', description: 'Perintah Bash yang paling sering dijalankan (atribut command).', panelTypes: 'table',
  queryData: [builderQuery({ group: [tagKey('command')], orderBy: ORDER_DESC, limit: 20, filterExpr: F_CMD })] }));

// Baris 4 — Live event stream (logs list). Panel list = baris mentah, BUKAN agregat:
// kosongkan aggregations, urutkan timestamp desc.
const listQuery = (() => {
  const q = builderQuery({ legend: '' });
  q.aggregations = [];
  q.orderBy = [{ columnName: 'timestamp', order: 'desc' }];
  delete q.reduceTo;
  return q;
})();
W.push(widget({ id: uid('list-events'), title: 'Live Event Stream', description: 'Aliran mentah event hook terbaru (managed-settings → OTLP → SigNoz).', panelTypes: 'list',
  queryData: [listQuery] }));

// ---------- layout (grid 12 kolom) ----------
const place = (i, x, y, w, h) => layout.push({ i, x, y, w, h });
place('kpi-total', 0, 0, 3, 2);
place('kpi-sessions', 3, 0, 3, 2);
place('kpi-users', 6, 0, 3, 2);
place('kpi-blocked', 9, 0, 3, 2);
place('ts-eventkind', 0, 2, 8, 4);
place('bar-tools', 8, 2, 4, 4);
place('ts-decision', 0, 6, 6, 4);
place('tbl-tools', 6, 6, 6, 4);
place('ts-user', 0, 10, 6, 4);
place('tbl-cmd', 6, 10, 6, 4);
place('list-events', 0, 14, 12, 5);

const dashboard = {
  title: 'Activity Trapping — Claude Code (L2 Hooks)',
  description: 'Pemantauan aktivitas Claude Code yang ditangkap lewat managed-settings hooks (capture_layer=hooks) → OTLP → SigNoz. Sumber: service.name=claude-code-hook. Bagian dari Activity Trapping Service (ML LAB / Bank Mega).',
  tags: ['claude-code', 'trapping', 'security', 'managed-settings', 'L2-hooks'],
  layout,
  widgets: W,
  variables: {},
  version: 'v4',
};

// SigNoz POST /api/v1/dashboards mengharap objek dashboard LANGSUNG (tanpa wrapper {data}).
fs.writeFileSync('scripts/_dashboard.json', JSON.stringify(dashboard, null, 2));
console.log('OK -> scripts/_dashboard.json  | widgets:', W.length, '| layout items:', layout.length);
