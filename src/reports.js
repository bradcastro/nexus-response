// Report builder: catalog, run, saved reports (+ built-in templates), duplicate, export, simulated schedules, share snapshot.
// Mounted at /api/report-builder/* (the public share-link route stays /api/reports/:token). Everything is synthetic demo data.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const roster = require('./roster');
const DS = require('./datasets');
const { round } = require('./util');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const DAY = 86400000;
const MAX_ROWS = 5000, MAX_EXPORT = 20000, DEFAULT_LIMIT = 500, MAX_SAVED = 200, MAX_SCHEDULES = 100;
const LABEL = 'Synthetic demo data';
const CHART_TYPES = ['table', 'bar', 'line', 'area', 'pie', 'stacked_bar', 'scatter'];
const PRESETS = [{ id: '7d', label: 'Last 7 days' }, { id: '30d', label: 'Last 30 days' }, { id: '90d', label: 'Last 90 days' }, { id: 'ytd', label: 'Year to date' }, { id: 'all', label: 'All time' }, { id: 'custom', label: 'Custom range' }];
const BUCKETS = ['none', 'day', 'week', 'month'];
const FILTER_OPS = { string: ['eq', 'neq', 'contains', 'in'], number: ['eq', 'gt', 'gte', 'lt', 'lte', 'between'], date: ['gte', 'lte', 'between'], enum: ['eq', 'neq', 'in'], boolean: ['eq'] };
const AGG_LABEL = { count: 'Count', sum: 'Sum', avg: 'Average', min: 'Minimum', max: 'Maximum', median: 'Median', p90: '90th percentile', rate: 'Rate' };
const AREA_IDS = DS.AREAS.map((a) => a.id);
const TPL_STAMP = '2026-01-01T00:00:00.000Z';

class ApiError extends Error { constructor(status, error, message, field) { super(message); this.status = status; this.error = error; this.field = field; } }
const bad = (field, message, error = 'invalid_request') => new ApiError(400, error, message, field);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// ---------- catalog ----------
function catalog() {
  return {
    areas: DS.AREAS.map((a) => ({
      ...a,
      datasets: Object.values(DS.DATASETS).filter((d) => d.areas.includes(a.id)).map((d) => ({
        id: d.id, label: d.label, description: d.description, dateField: d.dateField, idField: d.idField,
        fields: d.fields.map((x) => { const o = { ...x }; if (o.type === 'boolean') delete o.rateByValue; return o; }), defaultColumns: d.defaultColumns, defaultMetrics: d.defaultMetrics,
      })),
    })),
    chartTypes: CHART_TYPES, dateRangePresets: PRESETS, timeBuckets: BUCKETS, filterOps: FILTER_OPS, aggregations: Object.keys(AGG_LABEL),
    limits: { defaultLimit: DEFAULT_LIMIT, maxRows: MAX_ROWS, maxExportRows: MAX_EXPORT }, meta: { synthetic: true, label: LABEL },
  };
}

// ---------- validation ----------
const dateOf = (v, endOfDay) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return NaN;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(v); const t = +new Date(v);
  return Number.isNaN(t) ? NaN : dateOnly && endOfDay ? t + DAY - 1 : t;
};
function fieldOf(ds, id, path) { const fl = ds.fields.find((x) => x.id === id); if (!fl) throw bad(path, `Unknown field "${id}" for dataset ${ds.id}`, 'invalid_field'); return fl; }
function coerce(fl, v, path, op) {
  const one = (x) => {
    if (fl.type === 'number') { const n = typeof x === 'string' && x.trim() !== '' ? Number(x) : x; if (typeof n !== 'number' || !Number.isFinite(n)) throw bad(path, `Value for ${fl.id} must be a number`, 'invalid_value'); return n; }
    if (fl.type === 'date') { const t = dateOf(x, op === 'lte' || op === 'between'); if (t == null || Number.isNaN(t)) throw bad(path, `Value for ${fl.id} must be an ISO date`, 'invalid_value'); return t; }
    if (fl.type === 'boolean') { if (x === true || x === 'true') return true; if (x === false || x === 'false') return false; throw bad(path, `Value for ${fl.id} must be true or false`, 'invalid_value'); }
    if (typeof x !== 'string' && typeof x !== 'number') throw bad(path, `Value for ${fl.id} must be a string`, 'invalid_value');
    const s = String(x);
    if (fl.type === 'enum' && fl.enumValues && !fl.enumValues.includes(s)) throw bad(path, `"${s}" is not a valid ${fl.id}; expected one of ${fl.enumValues.join(', ')}`, 'invalid_value');
    return s;
  };
  if (op === 'in') { if (!Array.isArray(v) || !v.length || v.length > 100) throw bad(path, 'Operator "in" needs a non-empty array (max 100)', 'invalid_value'); return v.map(one); }
  if (op === 'between') { if (!Array.isArray(v) || v.length !== 2) throw bad(path, 'Operator "between" needs [low, high]', 'invalid_value'); const [a, b] = v.map((x, k) => (fl.type === 'date' ? (() => { const t = dateOf(x, k === 1); if (t == null || Number.isNaN(t)) throw bad(path, `Value for ${fl.id} must be an ISO date`, 'invalid_value'); return t; })() : one(x))); return [a, b]; }
  return one(v);
}

// Normalise + validate a run request. Throws ApiError(400). `loose` skips nothing; fleet existence is checked at run time.
function normalize(req) {
  if (!isObj(req)) throw bad(null, 'Request body must be a JSON object');
  const ds = typeof req.dataset === 'string' && Object.prototype.hasOwnProperty.call(DS.DATASETS, req.dataset) ? DS.DATASETS[req.dataset] : null;
  if (!ds) throw bad('dataset', `Unknown dataset "${req.dataset}". Valid: ${Object.keys(DS.DATASETS).join(', ')}`, 'invalid_dataset');
  const q = { dataset: ds.id, fleetIds: [], dateRange: { preset: 'all' }, filters: [], groupBy: [], timeBucket: 'none', metrics: [], columns: [], sort: [], limit: DEFAULT_LIMIT, offset: 0, compareTo: null };
  const notes = [];
  if (req.fleetIds != null) {
    if (!Array.isArray(req.fleetIds) || req.fleetIds.length > 50 || req.fleetIds.some((x) => typeof x !== 'string' || !x)) throw bad('fleetIds', 'fleetIds must be an array of fleet id strings (max 50)');
    q.fleetIds = [...new Set(req.fleetIds)];
  }
  if (req.dateRange != null) {
    const dr = req.dateRange; if (!isObj(dr)) throw bad('dateRange', 'dateRange must be an object');
    const out = {};
    if (dr.preset != null) { if (!PRESETS.some((p) => p.id === dr.preset)) throw bad('dateRange.preset', `Unknown preset "${dr.preset}"; expected ${PRESETS.map((p) => p.id).join(', ')}`, 'invalid_value'); out.preset = dr.preset; }
    for (const k of ['from', 'to']) if (dr[k] != null && dr[k] !== '') { const t = dateOf(dr[k], k === 'to'); if (Number.isNaN(t)) throw bad('dateRange.' + k, `dateRange.${k} must be an ISO date`, 'invalid_value'); out[k] = dr[k]; }
    if ((out.preset === 'custom' || !out.preset) && (out.from || out.to)) out.preset = 'custom';
    if (out.preset === 'custom' && !out.from && !out.to) throw bad('dateRange', 'preset "custom" needs from and/or to', 'invalid_value');
    if (out.from && out.to && dateOf(out.from) > dateOf(out.to, true)) throw bad('dateRange', 'dateRange.from is after dateRange.to', 'invalid_value');
    if (dr.field != null) { const fl = fieldOf(ds, dr.field, 'dateRange.field'); if (fl.type !== 'date') throw bad('dateRange.field', `${dr.field} is not a date field`, 'invalid_field'); out.field = dr.field; }
    q.dateRange = { preset: out.preset || 'all', ...out };
  }
  q.dateRange.field = q.dateRange.field || ds.dateField || null;
  if (req.filters != null) {
    if (!Array.isArray(req.filters) || req.filters.length > 25) throw bad('filters', 'filters must be an array (max 25)');
    q.filters = req.filters.map((f, k) => {
      const p = `filters[${k}]`;
      if (!isObj(f)) throw bad(p, 'Each filter must be {field, op, value}');
      const fl = fieldOf(ds, f.field, p + '.field'); if (!fl.filterable) throw bad(p + '.field', `Field ${fl.id} is not filterable`, 'invalid_field');
      if (!FILTER_OPS[fl.type].includes(f.op)) throw bad(p + '.op', `Operator "${f.op}" is not valid for ${fl.type} field ${fl.id}; expected ${FILTER_OPS[fl.type].join(', ')}`, 'invalid_op');
      return { field: fl.id, op: f.op, value: coerce(fl, f.value, p + '.value', f.op) };
    });
  }
  if (req.groupBy != null) {
    if (!Array.isArray(req.groupBy) || req.groupBy.length > 3) throw bad('groupBy', 'groupBy must be an array of up to 3 field ids');
    q.groupBy = req.groupBy.map((g, k) => { const fl = fieldOf(ds, g, `groupBy[${k}]`); if (!fl.groupable) throw bad(`groupBy[${k}]`, `Field ${g} cannot be grouped`, 'invalid_field'); return g; });
    if (new Set(q.groupBy).size !== q.groupBy.length) throw bad('groupBy', 'groupBy has duplicate fields');
  }
  if (req.timeBucket != null) {
    if (!BUCKETS.includes(req.timeBucket)) throw bad('timeBucket', `timeBucket must be one of ${BUCKETS.join(', ')}`, 'invalid_value');
    q.timeBucket = req.timeBucket;
  }
  if (q.timeBucket !== 'none' && !q.dateRange.field) throw bad('timeBucket', `Dataset ${ds.id} has no date field to bucket; set dateRange.field`, 'invalid_value');
  if (req.metrics != null) {
    if (!Array.isArray(req.metrics) || req.metrics.length > 12) throw bad('metrics', 'metrics must be an array (max 12)');
    q.metrics = req.metrics.map((m, k) => {
      const p = `metrics[${k}]`;
      if (!isObj(m)) throw bad(p, 'Each metric must be {field, agg}');
      if (!Object.keys(AGG_LABEL).includes(m.agg)) throw bad(p + '.agg', `Unknown aggregation "${m.agg}"; expected ${Object.keys(AGG_LABEL).join(', ')}`, 'invalid_agg');
      const out = { field: m.field, agg: m.agg };
      if (m.field === '*') { if (m.agg !== 'count') throw bad(p + '.field', '"*" can only be used with count', 'invalid_agg'); }
      else {
        const fl = fieldOf(ds, m.field, p + '.field');
        if (m.agg === 'rate' && m.value !== undefined && m.value !== null) { if (!fl.rateByValue) throw bad(p + '.value', `rate with a value needs an enum or string field`, 'invalid_agg'); out.value = coerce(fl, m.value, p + '.value', 'eq'); }
        else if (!fl.aggregations.includes(m.agg)) throw bad(p + '.agg', `Aggregation "${m.agg}" is not valid for ${fl.type} field ${fl.id}; expected ${fl.aggregations.join(', ')}${fl.rateByValue ? ' (or rate with value)' : ''}`, 'invalid_agg');
      }
      if (m.label != null) { if (typeof m.label !== 'string' || m.label.length > 80) throw bad(p + '.label', 'label must be a string up to 80 characters'); out.label = m.label; }
      return out;
    });
  }
  if (req.columns != null) {
    if (!Array.isArray(req.columns) || req.columns.length > 40) throw bad('columns', 'columns must be an array of field ids (max 40)');
    q.columns = req.columns.map((c, k) => fieldOf(ds, c, `columns[${k}]`).id);
  }
  if (req.sort != null) {
    if (!Array.isArray(req.sort) || req.sort.length > 3) throw bad('sort', 'sort must be an array (max 3)');
    q.sort = req.sort.map((s, k) => { if (!isObj(s) || typeof s.field !== 'string') throw bad(`sort[${k}]`, 'Each sort must be {field, dir}'); if (s.dir != null && !['asc', 'desc'].includes(s.dir)) throw bad(`sort[${k}].dir`, 'dir must be asc or desc', 'invalid_value'); return { field: s.field, dir: s.dir || 'asc' }; });
  }
  if (req.limit != null) { if (!Number.isInteger(req.limit) || req.limit < 1) throw bad('limit', 'limit must be a positive integer'); q.limit = req.limit; }
  if (req.offset != null) { if (!Number.isInteger(req.offset) || req.offset < 0) throw bad('offset', 'offset must be an integer >= 0'); q.offset = req.offset; }
  if (req.compareTo != null) { if (req.compareTo !== 'previous_period') throw bad('compareTo', 'compareTo must be "previous_period"', 'invalid_value'); q.compareTo = 'previous_period'; }
  // output-shape dependent checks
  const agg = q.metrics.length > 0 || q.groupBy.length > 0 || q.timeBucket !== 'none';
  q.mode = agg ? 'aggregate' : 'detail';
  if (agg && !q.metrics.length) q.metrics = [{ field: '*', agg: 'count' }];
  if (agg && q.columns.length) notes.push('columns is ignored for grouped/aggregated results');
  q.sort.forEach((s, k) => {
    if (agg) { const ids = outputIds(ds, q); if (!ids.includes(s.field)) throw bad(`sort[${k}].field`, `Cannot sort by "${s.field}"; sortable output columns: ${ids.join(', ')}`, 'invalid_field'); }
    else { const fl = fieldOf(ds, s.field, `sort[${k}].field`); if (!fl.sortable) throw bad(`sort[${k}].field`, `Field ${s.field} is not sortable`, 'invalid_field'); }
  });
  return { q, ds, notes };
}

function metricColId(m, used) {
  let id = m.field === '*' ? 'count' : m.agg === 'rate' && m.value !== undefined ? `rate_${m.field}_${String(m.value).replace(/[^\w]+/g, '_')}` : `${m.agg}_${m.field}`;
  let base = id, n = 2; while (used.has(id)) id = `${base}_${n++}`; used.add(id); return id;
}
function outputIds(ds, q) {
  const used = new Set(); const ids = [];
  if (q.timeBucket !== 'none') ids.push('bucket');
  ids.push(...q.groupBy);
  q.metrics.forEach((m) => ids.push(metricColId(m, used)));
  return ids;
}

// ---------- evaluation ----------
function periodOf(dr, now) {
  const p = dr.preset || 'all';
  if (p === 'all') return { from: null, to: null };
  if (p === 'ytd') return { from: Date.UTC(new Date(now).getUTCFullYear(), 0, 1), to: now };
  if (p === 'custom') return { from: dr.from ? dateOf(dr.from) : null, to: dr.to ? dateOf(dr.to, true) : null };
  const days = { '7d': 7, '30d': 30, '90d': 90 }[p];
  return { from: now - days * DAY, to: now };
}
function matchFilter(row, f) {
  const v = row[f.field];
  switch (f.op) {
    case 'eq': return f.value === true || f.value === false ? v === f.value : v != null && (typeof f.value === 'number' ? v === f.value : String(v).toLowerCase() === String(f.value).toLowerCase());
    case 'neq': return v == null || String(v).toLowerCase() !== String(f.value).toLowerCase();
    case 'contains': return v != null && String(v).toLowerCase().includes(String(f.value).toLowerCase());
    case 'in': return v != null && f.value.some((x) => String(x).toLowerCase() === String(v).toLowerCase());
    case 'gt': return v != null && v > f.value; case 'lt': return v != null && v < f.value;
    case 'gte': return v != null && v >= f.value; case 'lte': return v != null && v <= f.value;
    case 'between': return v != null && v >= f.value[0] && v <= f.value[1];
    default: return false;
  }
}
function applyFilters(rows, ds, q, period, fleetSet) {
  const dateFilters = q.filters.map((f) => (ds.fields.find((x) => x.id === f.field).type === 'date' ? { ...f, _date: true } : f));
  const df = q.dateRange.field;
  return rows.filter((r) => {
    if (fleetSet && r.fleetId != null && !fleetSet.has(r.fleetId)) return false;
    if (df && (period.from != null || period.to != null)) { const t = r[df] ? +new Date(r[df]) : null; if (t == null || (period.from != null && t < period.from) || (period.to != null && t > period.to)) return false; }
    for (const f of dateFilters) {
      if (f._date) { const g = { ...r, [f.field]: r[f.field] ? +new Date(r[f.field]) : null }; if (!matchFilter(g, f)) return false; }
      else if (!matchFilter(r, f)) return false;
    }
    return true;
  });
}
function bucketKey(t, bucket) {
  const d = new Date(t);
  if (bucket === 'month') return d.toISOString().slice(0, 7);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (bucket === 'week') return new Date(day - ((new Date(day).getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
  return new Date(day).toISOString().slice(0, 10);
}
const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const idx = (s.length - 1) * p; const lo = Math.floor(idx), hi = Math.ceil(idx); return s[lo] + (s[hi] - s[lo]) * (idx - lo); };
function aggregate(rows, m, fl) {
  if (m.agg === 'count') return m.field === '*' ? rows.length : rows.filter((r) => r[m.field] != null).length;
  const vals = rows.map((r) => r[m.field]).filter((v) => v != null);
  if (m.agg === 'rate') {
    if (!vals.length) return null;
    const hit = m.value !== undefined ? vals.filter((v) => String(v).toLowerCase() === String(m.value).toLowerCase()).length : vals.filter((v) => v === true).length;
    return round((100 * hit) / vals.length, 1);
  }
  if (fl && fl.type === 'date') { if (!vals.length) return null; const t = vals.map((v) => +new Date(v)); return new Date(m.agg === 'min' ? Math.min(...t) : Math.max(...t)).toISOString(); }
  const nums = vals.filter((v) => typeof v === 'number'); if (!nums.length) return null;
  switch (m.agg) {
    case 'sum': return round(nums.reduce((a, b) => a + b, 0), 2);
    case 'avg': return round(nums.reduce((a, b) => a + b, 0) / nums.length, 2);
    case 'min': return Math.min(...nums); case 'max': return Math.max(...nums);
    case 'median': return round(pct(nums, 0.5), 2); case 'p90': return round(pct(nums, 0.9), 2);
  }
  return null;
}
const cmp = (a, b) => (a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : typeof a === 'number' && typeof b === 'number' ? a - b : typeof a === 'boolean' ? (a === b ? 0 : a ? 1 : -1) : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

function evaluate(ds, q, rows, period, fleetSet, now) {
  const filtered = applyFilters(rows, ds, q, period, fleetSet);
  const fieldMap = Object.fromEntries(ds.fields.map((x) => [x.id, x]));
  if (q.mode === 'detail') {
    const cols = (q.columns.length ? q.columns : ds.defaultColumns).map((id) => fieldMap[id]);
    const sort = q.sort.length ? q.sort : ds.defaultSort || [];
    const sorted = [...filtered].sort((a, b) => { for (const s of sort) { const c = cmp(a[s.field], b[s.field]); if (c) return s.dir === 'desc' ? -c : c; } return cmp(a[ds.idField], b[ds.idField]); });
    const columns = cols.map((c) => ({ id: c.id, label: c.label, type: c.type, ...(c.unit ? { unit: c.unit } : {}) }));
    const keep = new Set([...cols.map((c) => c.id), 'incidentId', 'claimId', 'fleetId', 'vehicleId', 'driverId']);
    const all = sorted.map((r) => { const o = {}; for (const k of keep) if (k in r) o[k] = r[k]; return o; });
    return { columns, all, totals: { records: filtered.length }, metricCols: [], filteredCount: filtered.length };
  }
  const used = new Set(); const mcols = q.metrics.map((m) => {
    const fl = m.field === '*' ? null : fieldMap[m.field]; const id = metricColId(m, used);
    const label = m.label || (m.field === '*' ? 'Count' : m.agg === 'rate' ? `${fl.label}${m.value !== undefined ? ' = ' + m.value : ''} rate` : `${AGG_LABEL[m.agg]} ${fl.label}`);
    return { m, fl, id, label, unit: m.agg === 'rate' ? '%' : m.agg === 'count' ? undefined : fl && fl.type === 'date' ? undefined : fl && fl.unit };
  });
  const dim = (r) => {
    const parts = [];
    if (q.timeBucket !== 'none') { const t = r[q.dateRange.field]; parts.push(t ? bucketKey(t, q.timeBucket) : null); }
    for (const g of q.groupBy) { const v = r[g]; parts.push(v == null ? null : v); }
    return parts;
  };
  const groups = new Map();
  for (const r of filtered) {
    const d = dim(r); if (q.timeBucket !== 'none' && d[0] == null) continue; // rows without a date cannot be bucketed
    const k = JSON.stringify(d); let g = groups.get(k); if (!g) groups.set(k, g = { d, rows: [] }); g.rows.push(r);
  }
  const dimIds = [...(q.timeBucket !== 'none' ? ['bucket'] : []), ...q.groupBy];
  const rowsOut = [...groups.values()].map((g) => {
    const o = {}; dimIds.forEach((id, k) => { o[id] = g.d[k] == null ? 'Unknown' : g.d[k]; });
    for (const mc of mcols) o[mc.id] = aggregate(g.rows, mc.m, mc.fl);
    o._n = g.rows.length; return o;
  });
  const sort = q.sort.length ? q.sort : (q.timeBucket !== 'none' ? dimIds.map((id) => ({ field: id, dir: 'asc' })) : [{ field: mcols[0].id, dir: 'desc' }, ...dimIds.map((id) => ({ field: id, dir: 'asc' }))]);
  rowsOut.sort((a, b) => { for (const s of sort) { const c = cmp(a[s.field], b[s.field]); if (c) return s.dir === 'desc' ? -c : c; } for (const id of dimIds) { const c = cmp(a[id], b[id]); if (c) return c; } return 0; });
  const columns = [
    ...(q.timeBucket !== 'none' ? [{ id: 'bucket', label: { day: 'Day', week: 'Week (Mon)', month: 'Month' }[q.timeBucket], type: 'string' }] : []),
    ...q.groupBy.map((g) => ({ id: g, label: fieldMap[g].label, type: fieldMap[g].type })),
    ...mcols.map((mc) => ({ id: mc.id, label: mc.label, type: mc.fl && mc.fl.type === 'date' && mc.m.agg !== 'count' ? 'date' : 'number', ...(mc.unit ? { unit: mc.unit } : {}) })),
  ];
  const totals = { records: filtered.length }; for (const mc of mcols) totals[mc.id] = aggregate(filtered, mc.m, mc.fl);
  return { columns, all: rowsOut, totals, metricCols: mcols.map((mc) => mc.id), dimIds, filteredCount: filtered.length };
}
function suggestChart(q, ev) {
  if (q.mode === 'detail') return { suggested: 'table', x: ev.columns[0] && ev.columns[0].id, series: [] };
  const series = ev.metricCols;
  if (q.timeBucket !== 'none') return { suggested: q.groupBy.length ? 'line' : 'line', x: 'bucket', series, ...(q.groupBy.length ? { seriesBy: q.groupBy[0] } : {}) };
  if (q.groupBy.length >= 2) return { suggested: 'stacked_bar', x: q.groupBy[0], series, seriesBy: q.groupBy[1] };
  const n = ev.all.length;
  return { suggested: series.length === 1 && n <= 6 && ev.columns.find((c) => c.id === q.groupBy[0]) && ev.columns.find((c) => c.id === q.groupBy[0]).type === 'enum' ? 'pie' : 'bar', x: q.groupBy[0], series };
}

async function ensureFleets(ids, ctx) {
  if (!ids.length) return null;
  const known = new Set([...roster.all().map((f) => f.id), ...ctx.incidents.map((i) => i.fleetId)]);
  const miss = ids.find((x) => !known.has(x));
  if (miss) throw bad('fleetIds', `Unknown fleet id "${miss}"`, 'invalid_fleet');
  return new Set(ids);
}

async function runQuery(body, { maxLimit = MAX_ROWS, ctx: ctx0 } = {}) {
  const { q, ds, notes } = normalize(body);
  const ctx = ctx0 || await DS.loadCtx();
  const fleetSet = await ensureFleets(q.fleetIds, ctx);
  const rows = await ds.rows(ctx);
  const period = periodOf(q.dateRange, ctx.now);
  if (q.dateRange.preset !== 'all' && !q.dateRange.field) notes.push(`Dataset ${ds.id} has no event date; the date range was not applied (choose dateRange.field to filter by a date column)`);
  const ev = evaluate(ds, q, rows, period, fleetSet, ctx.now);
  let limit = q.limit; if (limit > maxLimit) { notes.push(`limit capped at ${maxLimit}`); limit = maxLimit; }
  const page = ev.all.slice(q.offset, q.offset + limit);
  const out = {
    columns: ev.columns, rows: page.map(({ _n, ...r }) => r), totals: ev.totals, rowCount: ev.all.length, returned: page.length, truncated: q.offset + page.length < ev.all.length,
    chart: suggestChart(q, ev),
    meta: { dataset: ds.id, generatedAt: new Date(ctx.now).toISOString(), period: { from: period.from != null ? new Date(period.from).toISOString() : null, to: period.to != null ? new Date(period.to).toISOString() : null }, synthetic: true, label: LABEL, mode: q.mode, sourceRows: rows.length, matchedRecords: ev.filteredCount, limit, offset: q.offset, query: publicQuery(q), notes },
  };
  if (q.compareTo) {
    if (period.from == null || period.to == null) throw bad('compareTo', 'compareTo "previous_period" needs a bounded dateRange (preset 7d/30d/90d/ytd or custom with from and to)', 'invalid_value');
    const len = period.to - period.from;
    const pq = { ...q, dateRange: { ...q.dateRange, preset: 'custom', from: new Date(period.from - len - 1).toISOString(), to: new Date(period.from - 1).toISOString() } };
    const pev = evaluate(ds, pq, rows, { from: period.from - len - 1, to: period.from - 1 }, fleetSet, ctx.now);
    const delta = {};
    for (const id of ['records', ...ev.metricCols]) {
      const cur = ev.totals[id], prev = pev.totals[id];
      delta[id] = { current: cur, previous: prev, delta: typeof cur === 'number' && typeof prev === 'number' ? round(cur - prev, 2) : null, pctChange: typeof cur === 'number' && typeof prev === 'number' && prev !== 0 ? round((100 * (cur - prev)) / Math.abs(prev), 1) : null };
    }
    out.comparison = { period: { from: new Date(period.from - len - 1).toISOString(), to: new Date(period.from - 1).toISOString() }, rows: pev.all.slice(0, limit).map(({ _n, ...r }) => r), totals: pev.totals, rowCount: pev.all.length, deltaByMetric: delta };
  }
  return out;
}
const publicQuery = (q) => { const { mode, ...rest } = q; return rest; };

// ---------- CSV ----------
function csvCell(v, isNumeric) {
  if (v == null) return '';
  let s = typeof v === 'string' ? v : String(v);
  if (!isNumeric && typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula-injection guard for text cells
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(result) {
  const cols = result.columns;
  const lines = [cols.map((c) => csvCell(c.label + (c.unit ? ` (${c.unit})` : ''), false)).join(',')];
  for (const r of result.rows) lines.push(cols.map((c) => csvCell(r[c.id], typeof r[c.id] === 'number' || typeof r[c.id] === 'boolean')).join(','));
  return lines.join('\r\n') + '\r\n';
}

// ---------- templates ----------
const M = (field, agg, label, value) => ({ field, agg, label, ...(value !== undefined ? { value } : {}) });
const TPL = (id, area, name, description, config, chart) => ({ id: 'tpl_' + id, name, area, description, config, chart, isTemplate: true, readOnly: true, createdAt: TPL_STAMP, updatedAt: TPL_STAMP, lastRunAt: null });
const TEMPLATES = [
  TPL('incident_volume_type_week', 'dispatch', 'Incident volume by type and week', 'Incidents per week split by event type.', { dataset: 'incidents', dateRange: { preset: '90d' }, groupBy: ['eventType'], timeBucket: 'week', metrics: [M('*', 'count', 'Incidents')] }, { type: 'stacked_bar', x: 'bucket', series: ['count'], options: { seriesBy: 'eventType' } }),
  TPL('response_by_provider', 'dispatch', 'Response time by provider', 'Promised ETA vs actual dispatch-to-on-scene minutes for each tow / roadside provider.', { dataset: 'tow_providers', dateRange: { preset: 'all' }, groupBy: ['providerName'], metrics: [M('*', 'count', 'Jobs'), M('promisedEtaMin', 'avg', 'Avg promised ETA (min)'), M('actualArrivalMin', 'avg', 'Avg actual arrival (min)'), M('actualArrivalMin', 'p90', 'P90 arrival (min)')], sort: [{ field: 'count', dir: 'desc' }] }, { type: 'bar', x: 'providerName', series: ['avg_promisedEtaMin', 'avg_actualArrivalMin'] }),
  TPL('false_positive_rate', 'dispatch', 'False-positive rate', 'Share of events the camera AI classified as false positives, by telematics vendor.', { dataset: 'incidents', dateRange: { preset: 'all' }, groupBy: ['vendor'], metrics: [M('*', 'count', 'Events'), M('isFalsePositive', 'rate', 'False-positive rate (%)')], sort: [{ field: 'rate_isFalsePositive', dir: 'desc' }] }, { type: 'bar', x: 'vendor', series: ['rate_isFalsePositive'] }),
  TPL('open_incident_aging', 'dispatch', 'Open incident aging', 'Currently open incidents grouped by how long they have been open.', { dataset: 'incidents', dateRange: { preset: 'all' }, filters: [{ field: 'isOpen', op: 'eq', value: true }], groupBy: ['ageBucket'], metrics: [M('*', 'count', 'Open incidents')], sort: [{ field: 'ageBucket', dir: 'asc' }] }, { type: 'bar', x: 'ageBucket', series: ['count'] }),
  TPL('dispatch_to_scene', 'dispatch', 'Dispatch to on-scene time by severity', 'Median and P90 minutes from dispatch to on scene.', { dataset: 'response_times', dateRange: { preset: 'all' }, groupBy: ['severity'], metrics: [M('*', 'count', 'Incidents'), M('dispatchToOnSceneMin', 'median', 'Median (min)'), M('dispatchToOnSceneMin', 'p90', 'P90 (min)')] }, { type: 'bar', x: 'severity', series: ['median_dispatchToOnSceneMin', 'p90_dispatchToOnSceneMin'] }),
  TPL('sop_completion', 'dispatch', 'SOP step completion', 'Completion rate of each SOP checklist step.', { dataset: 'sop', dateRange: { preset: 'all' }, filters: [{ field: 'required', op: 'eq', value: true }], groupBy: ['stepLabel'], metrics: [M('*', 'count', 'Steps'), M('done', 'rate', 'Completion (%)')], sort: [{ field: 'rate_done', dir: 'asc' }] }, { type: 'bar', x: 'stepLabel', series: ['rate_done'] }),
  TPL('comms_by_channel_week', 'dispatch', 'Communications by channel and week', 'Simulated messages logged per week by channel.', { dataset: 'comms', dateRange: { preset: 'all' }, groupBy: ['channel'], timeBucket: 'week', metrics: [M('*', 'count', 'Messages')] }, { type: 'stacked_bar', x: 'bucket', series: ['count'], options: { seriesBy: 'channel' } }),
  TPL('safety_events_by_type', 'fleet', 'Driver safety events by type', 'Safety events by behavior type, excluding camera false positives.', { dataset: 'safety_events', dateRange: { preset: '90d' }, filters: [{ field: 'isFalsePositive', op: 'eq', value: false }], groupBy: ['eventType'], metrics: [M('*', 'count', 'Events')] }, { type: 'bar', x: 'eventType', series: ['count'] }),
  TPL('top_drivers_events', 'fleet', 'Drivers with the most safety events', 'Top 25 drivers by safety event count.', { dataset: 'safety_events', dateRange: { preset: '90d' }, filters: [{ field: 'isFalsePositive', op: 'eq', value: false }], groupBy: ['driverName'], metrics: [M('*', 'count', 'Events'), M('eventScore', 'avg', 'Avg event score')], limit: 25 }, { type: 'bar', x: 'driverName', series: ['count'] }),
  TPL('collisions_by_month', 'fleet', 'Collisions by month', 'Collision and rollover events per month.', { dataset: 'safety_events', dateRange: { preset: 'all' }, filters: [{ field: 'eventType', op: 'in', value: ['collision', 'rollover'] }, { field: 'isFalsePositive', op: 'eq', value: false }], timeBucket: 'month', metrics: [M('*', 'count', 'Collisions')] }, { type: 'bar', x: 'bucket', series: ['count'] }),
  TPL('vehicles_fault_leaders', 'fleet', 'Vehicles with the most fault codes', 'Vehicle list sorted by fault-code events.', { dataset: 'vehicles', columns: ['unit', 'fleetName', 'make', 'model', 'year', 'odometerMi', 'faultEvents', 'breakdowns', 'events'], sort: [{ field: 'faultEvents', dir: 'desc' }], limit: 25 }, { type: 'table', x: 'unit', series: [] }),
  TPL('camera_verified_by_event_type', 'fleet', 'Camera-verified share by event type', 'How often each event type is camera-verified.', { dataset: 'safety_events', dateRange: { preset: 'all' }, groupBy: ['eventType'], metrics: [M('*', 'count', 'Events'), M('cameraVerified', 'rate', 'Camera-verified (%)')] }, { type: 'bar', x: 'eventType', series: ['rate_cameraVerified'] }),
  TPL('fleet_risk_trend', 'insurer', 'Fleet risk trend', 'Weekly rolling 30-day risk score per fleet.', { dataset: 'risk_snapshots', dateRange: { preset: 'all' }, filters: [{ field: 'entityType', op: 'eq', value: 'fleet' }, { field: 'windowComplete', op: 'eq', value: true }], groupBy: ['entityName'], timeBucket: 'week', metrics: [M('riskScore', 'avg', 'Risk score')] }, { type: 'line', x: 'bucket', series: ['avg_riskScore'], options: { seriesBy: 'entityName' } }),
  TPL('drive_score_distribution', 'insurer', 'Drive Score distribution', 'Drivers by Drive Score band.', { dataset: 'drivers', groupBy: ['band'], metrics: [M('*', 'count', 'Drivers'), M('driveScore', 'avg', 'Avg Drive Score')], sort: [{ field: 'avg_driveScore', dir: 'desc' }] }, { type: 'pie', x: 'band', series: ['count'] }),
  TPL('camera_verified_by_vendor', 'insurer', 'Camera-verified share by vendor', 'Share of events that are camera-verified, by telematics vendor.', { dataset: 'fleet_portfolio', groupBy: ['vendor'], metrics: [M('*', 'count', 'Fleets'), M('verifiedEventPct', 'avg', 'Camera-verified events (%)'), M('cameraCoveragePct', 'avg', 'Camera coverage (%)')] }, { type: 'bar', x: 'vendor', series: ['avg_verifiedEventPct', 'avg_cameraCoveragePct'] }),
  TPL('portfolio_by_fleet', 'insurer', 'Portfolio risk by fleet', 'Current 30-day risk, tier and trend for every fleet.', { dataset: 'fleet_portfolio', sort: [{ field: 'riskScore', dir: 'desc' }] }, { type: 'table', x: 'fleetName', series: [] }),
  TPL('events_per_1k_by_vendor', 'insurer', 'Events per 1,000 miles by vendor', 'Weekly fleet snapshots averaged by telematics vendor (estimated exposure).', { dataset: 'risk_snapshots', dateRange: { preset: 'all' }, filters: [{ field: 'entityType', op: 'eq', value: 'fleet' }], groupBy: ['vendor'], metrics: [M('eventsPer1kMi', 'avg', 'Events per 1k mi'), M('cameraVerifiedShare', 'avg', 'Camera-verified share (%)')] }, { type: 'bar', x: 'vendor', series: ['avg_eventsPer1kMi'] }),
  TPL('warranty_recovery_oem', 'claims', 'Warranty recovery by OEM', 'Estimated vs recovered dollars by OEM (simulated OEM responses).', { dataset: 'warranty_claims', dateRange: { preset: 'all' }, groupBy: ['oem'], metrics: [M('*', 'count', 'Claims'), M('estimatedAmount', 'sum', 'Estimated $'), M('recoveredAmount', 'sum', 'Recovered $')], sort: [{ field: 'sum_estimatedAmount', dir: 'desc' }] }, { type: 'bar', x: 'oem', series: ['sum_estimatedAmount', 'sum_recoveredAmount'] }),
  TPL('claim_status_pipeline', 'claims', 'Claim status pipeline', 'Claims and dollars at each lifecycle status.', { dataset: 'warranty_claims', dateRange: { preset: 'all' }, groupBy: ['status'], metrics: [M('*', 'count', 'Claims'), M('estimatedAmount', 'sum', 'Estimated $')] }, { type: 'bar', x: 'status', series: ['count'] }),
  TPL('denial_reasons', 'claims', 'Denial reasons', 'Claims denied at any point, grouped by the OEM-stated reason.', { dataset: 'warranty_claims', dateRange: { preset: 'all' }, filters: [{ field: 'wasDenied', op: 'eq', value: true }], groupBy: ['denialReason'], metrics: [M('*', 'count', 'Claims'), M('estimatedAmount', 'sum', 'Estimated $')] }, { type: 'bar', x: 'denialReason', series: ['count'] }),
  TPL('open_claim_aging', 'claims', 'Open claim aging by status', 'Average and maximum age of open claims.', { dataset: 'warranty_claims', dateRange: { preset: 'all' }, filters: [{ field: 'isOpen', op: 'eq', value: true }], groupBy: ['status'], metrics: [M('*', 'count', 'Open claims'), M('ageDays', 'avg', 'Avg age (days)'), M('ageDays', 'max', 'Oldest (days)')] }, { type: 'bar', x: 'status', series: ['avg_ageDays', 'max_ageDays'] }),
  TPL('claims_by_month', 'claims', 'Claims submitted by month', 'Claim count and dollars by month of submission.', { dataset: 'warranty_claims', dateRange: { preset: 'all' }, timeBucket: 'month', metrics: [M('*', 'count', 'Claims'), M('estimatedAmount', 'sum', 'Estimated $')] }, { type: 'line', x: 'bucket', series: ['count'] }),
  TPL('days_to_decision_oem', 'claims', 'Days to OEM decision', 'Median and P90 days from submission to first OEM decision, by OEM.', { dataset: 'warranty_claims', dateRange: { preset: 'all' }, groupBy: ['oem'], metrics: [M('daysToDecision', 'median', 'Median days'), M('daysToDecision', 'p90', 'P90 days'), M('*', 'count', 'Claims')] }, { type: 'bar', x: 'oem', series: ['median_daysToDecision', 'p90_daysToDecision'] }),
];
const TPL_BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

// ---------- saved reports ----------
const newId = (p) => p + crypto.randomBytes(6).toString('hex');
function validChart(c) {
  if (c == null) return { type: 'table', x: null, series: [], options: {} };
  if (!isObj(c)) throw bad('chart', 'chart must be an object {type, x, series, options}');
  const type = c.type == null ? 'table' : c.type;
  if (!CHART_TYPES.includes(type)) throw bad('chart.type', `chart.type must be one of ${CHART_TYPES.join(', ')}`, 'invalid_value');
  if (c.x != null && typeof c.x !== 'string') throw bad('chart.x', 'chart.x must be a column id');
  if (c.series != null && (!Array.isArray(c.series) || c.series.some((s) => typeof s !== 'string'))) throw bad('chart.series', 'chart.series must be an array of column ids');
  if (c.options != null && !isObj(c.options)) throw bad('chart.options', 'chart.options must be an object');
  return { type, x: c.x || null, series: c.series || [], options: c.options || {} };
}
function validSavedBody(b, partial, current) {
  if (!isObj(b)) throw bad(null, 'Body must be a JSON object');
  const out = {};
  if (!partial || b.name !== undefined) { if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 120) throw bad('name', 'name is required (1-120 characters)'); out.name = b.name.trim(); }
  if (!partial || b.area !== undefined) { if (!AREA_IDS.includes(b.area)) throw bad('area', `area must be one of ${AREA_IDS.join(', ')}`, 'invalid_value'); out.area = b.area; }
  if (b.description !== undefined) { if (b.description !== null && (typeof b.description !== 'string' || b.description.length > 500)) throw bad('description', 'description must be a string up to 500 characters'); out.description = b.description || ''; }
  if (!partial || b.config !== undefined) { normalize(b.config); out.config = JSON.parse(JSON.stringify(b.config)); }
  if (!partial || b.chart !== undefined) out.chart = validChart(b.chart);
  return out;
}
const pubSaved = (d) => ({ id: d.id, name: d.name, area: d.area, description: d.description || '', config: d.config, chart: d.chart, isTemplate: !!d.isTemplate, readOnly: !!d.isTemplate, createdAt: d.createdAt, updatedAt: d.updatedAt, lastRunAt: d.lastRunAt || null, simulated: false, meta: { synthetic: true, label: LABEL } });
async function getSaved(id) { return TPL_BY_ID.get(id) || (await db.get('saved_report', id)); }
const nf = (what) => new ApiError(404, 'not_found', `${what} not found`);
const ro = () => new ApiError(409, 'template_readonly', 'Built-in templates are read-only; duplicate the template to edit it');

// ---------- schedules (simulated: stored, never sent) ----------
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const CADENCE = ['daily', 'weekly', 'monthly'];
function nextRun(cad, from = Date.now()) { const d = new Date(from); d.setUTCHours(13, 0, 0, 0); if (d.getTime() <= from) d.setUTCDate(d.getUTCDate() + 1); if (cad === 'weekly') { while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1); } if (cad === 'monthly') { d.setUTCDate(1); if (d.getTime() <= from) d.setUTCMonth(d.getUTCMonth() + 1); } return d.toISOString(); }
const SCHED_NOTE = 'Scheduling is simulated: no email is sent';
const pubSched = (s) => ({ ...s, simulated: true, status: 'stored_not_sent', note: SCHED_NOTE });

// ---------- share snapshot (used by POST /api/insurer/reports kind=builder) ----------
async function freeze(refId, body) {
  let saved = null, config;
  if (refId) { saved = await getSaved(refId); if (!saved) return { status: 404, error: 'not_found', message: 'Saved report not found', field: 'refId' }; config = saved.config; }
  else if (body.config) config = body.config; else return { status: 400, error: 'invalid_request', message: 'refId (saved report id) or config is required', field: 'refId' };
  try {
    const cfg = { ...config }; if (Array.isArray(body.fleetIds)) cfg.fleetIds = body.fleetIds;
    cfg.limit = Math.min(Number.isInteger(cfg.limit) ? cfg.limit : 1000, 1000); cfg.offset = 0;
    const result = await runQuery(cfg, { maxLimit: 1000 });
    const name = (saved && saved.name) || body.title || `Report on ${config.dataset}`;
    return {
      title: `Report - ${name}`, fleetId: result.meta.query.fleetIds.length === 1 ? result.meta.query.fleetIds[0] : null,
      snapshot: { name, area: saved ? saved.area : null, savedId: saved ? saved.id : null, config: cfg, chart: saved ? saved.chart : validChart(body.chart), result, frozenAt: new Date().toISOString(), frozen: true, synthetic: true, label: LABEL, note: 'Frozen snapshot of the result at share time; it does not update.' },
    };
  } catch (e) { if (e instanceof ApiError) return { status: e.status, error: e.error, message: e.message, field: e.field }; throw e; }
}

// ---------- router ----------
const router = express.Router();
router.use((req, res, next) => { res.set('X-Nexus-Data', 'synthetic'); next(); });
router.get('/catalog', (req, res) => res.json(catalog()));
router.post('/run', wrap(async (req, res) => res.json(await runQuery(req.body))));
router.post('/export', wrap(async (req, res) => {
  const b = req.body || {}; const format = b.format == null ? 'csv' : b.format;
  if (!['csv', 'json'].includes(format)) throw bad('format', 'format must be csv or json', 'invalid_value');
  let cfg = b;
  if (b.savedId) { const s = await getSaved(b.savedId); if (!s) throw nf('Saved report'); cfg = { ...s.config, ...(Array.isArray(b.fleetIds) ? { fleetIds: b.fleetIds } : {}) }; }
  const { format: _f, savedId: _s, ...req2 } = cfg; if (req2.limit == null) req2.limit = MAX_EXPORT;
  const result = await runQuery(req2, { maxLimit: MAX_EXPORT });
  const date = new Date().toISOString().slice(0, 10);
  const name = `nexus-${result.meta.dataset}-${date}-SYNTHETIC.${format}`;
  res.set('Content-Disposition', `attachment; filename="${name}"`).set('X-Nexus-Filename', name);
  if (format === 'csv') return res.type('text/csv; charset=utf-8').send(toCsv(result));
  res.type('application/json').send(JSON.stringify({ meta: { ...result.meta, filename: name, note: 'Synthetic demo data. Not real fleet, driver, claim or insurer information.' }, columns: result.columns, rows: result.rows, totals: result.totals, rowCount: result.rowCount, truncated: result.truncated }, null, 2));
}));

router.get('/saved', wrap(async (req, res) => {
  const { area, scope } = req.query;
  if (area && !AREA_IDS.includes(area)) throw bad('area', `area must be one of ${AREA_IDS.join(', ')}`, 'invalid_value');
  if (scope && !['all', 'templates', 'mine'].includes(scope)) throw bad('scope', 'scope must be all, templates or mine', 'invalid_value');
  const mine = scope === 'templates' ? [] : await db.list('saved_report', { limit: 1000 });
  const tpl = scope === 'mine' ? [] : TEMPLATES;
  const all = [...tpl, ...mine.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))].filter((r) => !area || r.area === area);
  res.json(all.map(pubSaved));
}));
router.get('/saved/:id', wrap(async (req, res) => { const s = await getSaved(req.params.id); if (!s) throw nf('Saved report'); res.json(pubSaved(s)); }));
router.post('/saved', wrap(async (req, res) => {
  const v = validSavedBody(req.body, false);
  if ((await db.list('saved_report', { limit: 1000 })).length >= MAX_SAVED) throw new ApiError(409, 'limit_reached', `At most ${MAX_SAVED} saved reports`);
  const now = new Date().toISOString();
  const doc = { id: newId('rpt_'), ...v, description: v.description || '', isTemplate: false, createdAt: now, updatedAt: now, lastRunAt: null };
  await db.put('saved_report', doc); res.status(201).json(pubSaved(doc));
}));
router.put('/saved/:id', wrap(async (req, res) => {
  const cur = await getSaved(req.params.id); if (!cur) throw nf('Saved report'); if (cur.isTemplate) throw ro();
  const v = validSavedBody(req.body, true, cur);
  const doc = { ...cur, ...v, updatedAt: new Date().toISOString() }; await db.put('saved_report', doc); res.json(pubSaved(doc));
}));
router.delete('/saved/:id', wrap(async (req, res) => {
  const cur = await getSaved(req.params.id); if (!cur) throw nf('Saved report'); if (cur.isTemplate) throw ro();
  await db.del('saved_report', cur.id);
  for (const s of await db.list('schedule', { limit: 1000 })) if (s.savedId === cur.id) await db.del('schedule', s.id);
  res.json({ deleted: true, id: cur.id });
}));
router.post('/saved/:id/duplicate', wrap(async (req, res) => {
  const cur = await getSaved(req.params.id); if (!cur) throw nf('Saved report');
  if ((await db.list('saved_report', { limit: 1000 })).length >= MAX_SAVED) throw new ApiError(409, 'limit_reached', `At most ${MAX_SAVED} saved reports`);
  const name = req.body && req.body.name != null ? req.body.name : `${cur.name} (copy)`; if (typeof name !== 'string' || !name.trim() || name.length > 120) throw bad('name', 'name must be 1-120 characters');
  const now = new Date().toISOString();
  const doc = { id: newId('rpt_'), name: name.trim(), area: cur.area, description: cur.description || '', config: JSON.parse(JSON.stringify(cur.config)), chart: JSON.parse(JSON.stringify(cur.chart)), isTemplate: false, createdAt: now, updatedAt: now, lastRunAt: null, duplicatedFrom: cur.id };
  await db.put('saved_report', doc); res.status(201).json(pubSaved(doc));
}));
router.post('/saved/:id/run', wrap(async (req, res) => {
  const cur = await getSaved(req.params.id); if (!cur) throw nf('Saved report');
  const o = req.body || {}; const cfg = { ...cur.config };
  for (const k of ['fleetIds', 'dateRange', 'compareTo', 'limit', 'offset']) if (o[k] !== undefined) cfg[k] = o[k];
  const result = await runQuery(cfg);
  if (!cur.isTemplate) { cur.lastRunAt = new Date().toISOString(); await db.put('saved_report', cur); }
  res.json({ saved: pubSaved(cur), result });
}));

router.get('/schedules', wrap(async (req, res) => {
  const rows = (await db.list('schedule', { limit: 1000 })).filter((s) => !req.query.savedId || s.savedId === req.query.savedId);
  res.json({ schedules: rows.map(pubSched), simulated: true, note: SCHED_NOTE, meta: { synthetic: true, label: LABEL } });
}));
router.post('/schedules', wrap(async (req, res) => {
  const b = req.body; if (!isObj(b)) throw bad(null, 'Body must be a JSON object');
  const saved = typeof b.savedId === 'string' ? await getSaved(b.savedId) : null;
  if (typeof b.savedId !== 'string' || !b.savedId) throw bad('savedId', 'savedId is required');
  if (!saved) throw nf('Saved report');
  if (!CADENCE.includes(b.cadence)) throw bad('cadence', `cadence must be one of ${CADENCE.join(', ')}`, 'invalid_value');
  if (!Array.isArray(b.recipients) || !b.recipients.length || b.recipients.length > 10 || b.recipients.some((e) => typeof e !== 'string' || e.length > 200 || !EMAIL_RE.test(e))) throw bad('recipients', 'recipients must be 1-10 valid email addresses');
  const format = b.format == null ? 'csv' : b.format; if (!['csv', 'json'].includes(format)) throw bad('format', 'format must be csv or json', 'invalid_value');
  if ((await db.list('schedule', { limit: 1000 })).length >= MAX_SCHEDULES) throw new ApiError(409, 'limit_reached', `At most ${MAX_SCHEDULES} schedules`);
  const doc = { id: newId('sch_'), savedId: saved.id, savedName: saved.name, cadence: b.cadence, recipients: [...new Set(b.recipients.map((e) => e.trim()))], format, createdAt: new Date().toISOString(), nextRunAt: nextRun(b.cadence), lastRunAt: null };
  await db.put('schedule', doc); res.status(201).json(pubSched(doc));
}));
router.delete('/schedules/:id', wrap(async (req, res) => { const s = await db.get('schedule', req.params.id); if (!s) throw nf('Schedule'); await db.del('schedule', s.id); res.json({ deleted: true, id: s.id, simulated: true }); }));

router.use((req, res) => res.status(404).json({ error: 'not_found', message: `No report-builder route ${req.method} ${req.originalUrl}` }));
router.use((err, req, res, next) => {
  if (err instanceof ApiError) return res.status(err.status).json({ error: err.error, message: err.message, ...(err.field ? { field: err.field } : {}) });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON' });
  next(err);
});

module.exports = { router, catalog, runQuery, normalize, toCsv, freeze, TEMPLATES, MAX_ROWS };
