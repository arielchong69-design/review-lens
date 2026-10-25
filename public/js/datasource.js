// 数据层：实时（经 /api/fuyao 代理）→ 失败时退回离线快照 → 仍失败则明确标记缺失。
// 每一次调用都写入 callLog，供“数据状态”面板展示与追溯。
import { normalizeBars, normalizeEvents } from './core/context.js';
import { addDays, dateToMs, todayShanghai, parseUpstreamTime, msToDate } from './core/dates.js';

export const BENCHMARK = { thscode: '000300.SH', name: '沪深300' };

export const state = {
  mode: 'auto',            // auto | snapshot | live
  simulate: new Set(),     // 故障演练：kline | events | bench | ai | all
  callLog: [],
  snapshot: null,
};

export function resetLog() { state.callLog = []; }

async function loadSnapshot() {
  if (state.snapshot !== null) return state.snapshot;
  try {
    const r = await fetch('data/snapshot.json', { cache: 'no-cache' });
    state.snapshot = r.ok ? await r.json() : { entries: {} };
  } catch { state.snapshot = { entries: {} }; }
  return state.snapshot;
}

function simulated(kind) {
  return state.simulate.has('all') || state.simulate.has(kind);
}

async function liveCall(path, params, kind) {
  if (simulated(kind)) {
    return { ok: false, code: 5003, message: '故障演练：模拟数据源不可用（code=5003）', data: null, fetched_at: new Date().toISOString(), simulated: true };
  }
  const qs = new URLSearchParams(params).toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(`api/fuyao/${path}?${qs}`, { signal: ctrl.signal });
    if (!r.ok) return { ok: false, code: `HTTP_${r.status}`, message: `代理返回 HTTP ${r.status}`, data: null, fetched_at: new Date().toISOString() };
    return await r.json();
  } catch (e) {
    return { ok: false, code: 'NETWORK', message: e.name === 'AbortError' ? '请求超时' : `网络错误：${e.message}`, data: null, fetched_at: new Date().toISOString() };
  } finally { clearTimeout(timer); }
}

function snapKey(path, thscode, extra = '') { return [path, thscode, extra].filter(Boolean).join('|'); }

// 原始响应留存：用于“导出数据快照”（离线兜底 + 审计复现）
state.raw = {};
function recordRaw(key, path, params, res) {
  const prev = state.raw[key];
  const entry = { path, params, request_id: res.request_id, fetched_at: res.fetched_at, data: structuredClone(res.data) };
  if (path === 'news/anomaly/analysis') {
    const items = (res.data?.items || []).map(x => ({ ...x }));
    if (prev) { const ids = new Set(prev.data.items.map(i => i.analysis_id)); prev.data.items.push(...items.filter(i => !ids.has(i.analysis_id))); prev.request_ids = [...(prev.request_ids || [prev.request_id]), res.request_id]; return; }
    entry.data = { items, was_truncated: !!res.data?.was_truncated };
  } else if (prev && Array.isArray(prev.data?.item)) {
    const seen = new Set(prev.data.item.map(b => b.date_ms ?? b.thscode));
    prev.data.item.push(...(res.data?.item || []).filter(b => !seen.has(b.date_ms ?? b.thscode)));
    prev.data.item.sort((a, b) => (a.date_ms || 0) - (b.date_ms || 0));
    prev.request_ids = [...(prev.request_ids || [prev.request_id]), res.request_id];
    return;
  }
  state.raw[key] = entry;
}

export function exportSnapshot() {
  return { generated_at: new Date().toISOString(), note: '由复盘镜导出的扶摇接口原始响应，用于离线兜底与结论复现', entries: state.raw };
}

/**
 * 统一取数。返回 { ok, mode, data, meta }，meta 进入 callLog。
 * snapshotPick(entry) -> data：从快照中截取需要的区间
 */
async function getData({ path, params, kind, snapshotKey, snapshotPick, label }) {
  const t0 = performance.now();
  let res = null, mode = null;
  if (state.mode !== 'snapshot') {
    res = await liveCall(path, params, kind);
    mode = 'live';
  }
  let fallbackReason = null;
  if ((!res || !res.ok) && state.mode !== 'live') {
    fallbackReason = res ? res.message : '已选择“仅快照”模式';
    const snap = await loadSnapshot();
    const entry = snap?.entries?.[snapshotKey];
    if (entry && !simulated('snapshot')) {
      const data = snapshotPick ? snapshotPick(entry) : entry.data;
      res = { ok: true, code: 0, message: 'snapshot', request_id: entry.request_id, data, fetched_at: entry.fetched_at, snapshot_generated_at: snap.generated_at };
      mode = 'snapshot';
    } else if (res) {
      res = { ...res, message: `${res.message}；离线快照中也没有该数据` };
    } else {
      res = { ok: false, code: 'NO_SNAPSHOT', message: '离线快照中没有该数据', data: null, fetched_at: null };
    }
  }
  if (res.ok && mode === 'live') recordRaw(snapshotKey, path, params, res);
  const meta = {
    label, api: `/api/${path}`, params, kind, ok: !!res.ok, mode: res.ok ? mode : 'failed', code: res.code, message: res.message,
    request_id: res.request_id || null, fetched_at: res.fetched_at || null, latency_ms: res.latency_ms ?? Math.round(performance.now() - t0),
    fallback_reason: res.ok && mode === 'snapshot' ? fallbackReason : null,
  };
  state.callLog.push(meta);
  return { ok: !!res.ok, data: res.data, meta };
}

function sliceItems(entry, startMs, endMs) {
  const items = (entry.data?.item || []).filter(b => b.date_ms >= startMs && b.date_ms <= endMs);
  return { ...entry.data, item: items };
}

export async function fetchBars(thscode, startDate, endDate, adjust) {
  const start = dateToMs(startDate), end = dateToMs(endDate);
  const path = 'a-share/prices/historical';
  const r = await getData({
    path, params: { thscode, interval: '1d', start, end, adjust }, kind: 'kline', label: `${thscode} 日K（${adjust === 'none' ? '不复权' : '前复权'}）`,
    snapshotKey: snapKey(path, thscode, adjust), snapshotPick: e => sliceItems(e, start, end),
  });
  const bars = r.ok ? normalizeBars(r.data?.item) : [];
  if (r.ok && !bars.length) { r.meta.ok = false; r.meta.mode = 'failed'; r.meta.message = '返回成功但区间内没有K线（可能停牌、未上市或代码有误）'; }
  r.meta.count = bars.length;
  r.meta.as_of = bars.length ? bars[bars.length - 1].date : null;
  return { bars, meta: r.meta };
}

export async function fetchIndexBars(thscode, startDate, endDate) {
  const start = dateToMs(startDate), end = dateToMs(endDate);
  const path = 'a-share-index/prices/historical';
  const r = await getData({
    path, params: { thscode, interval: '1d', start, end }, kind: 'bench', label: `${thscode} 指数日K`,
    snapshotKey: snapKey(path, thscode), snapshotPick: e => sliceItems(e, start, end),
  });
  const bars = r.ok ? normalizeBars(r.data?.item) : [];
  r.meta.count = bars.length;
  r.meta.as_of = bars.length ? bars[bars.length - 1].date : null;
  return { bars, meta: r.meta };
}

/** 事件：单次最多 365 天，按区间切片后合并去重 */
export async function fetchEvents(thscode, startDate, endDate) {
  const path = 'news/anomaly/analysis';
  const chunks = [];
  let s = startDate;
  while (s <= endDate) {
    const e = addDays(s, 364) < endDate ? addDays(s, 364) : endDate;
    chunks.push([s, e]);
    s = addDays(e, 1);
  }
  const all = [], metas = [];
  let truncated = false;
  for (const [b, e] of chunks) {
    const r = await getData({
      path, params: { begin_date: b, end_date: e, thscode }, kind: 'events', label: `${thscode} 异动解读 ${b}~${e}`,
      snapshotKey: snapKey(path, thscode),
      snapshotPick: en => ({ ...en.data, items: (en.data?.items || []).filter(x => { const t = parseUpstreamTime(x.first_publish_time ?? x.create_time).ms; if (t == null) return true; const d = msToDate(t); return d >= b && d <= e; }) }),
    });
    metas.push(r.meta);
    if (r.ok) {
      const src = { request_id: r.meta.request_id, fetched_at: r.meta.fetched_at, mode: r.meta.mode };
      all.push(...normalizeEvents(r.data?.items, src));
      if (r.data?.was_truncated) truncated = true;
      r.meta.count = (r.data?.items || []).length;
    }
  }
  const seen = new Set();
  const events = all.filter(e => (seen.has(e.id) ? false : (seen.add(e.id), true))).sort((a, b) => (a.time_ms || 0) - (b.time_ms || 0));
  const ok = metas.some(m => m.ok);
  return { events, meta: { ok, mode: metas.find(m => m.ok)?.mode || 'failed', message: ok ? (metas.every(m => m.ok) ? 'success' : '部分区间失败') : metas[0]?.message, was_truncated: truncated, partial: ok && !metas.every(m => m.ok) } };
}

/** 为一组交易准备全部市场数据 */
export async function loadMarketForTrades(trades, onProgress = () => {}) {
  const today = todayShanghai();
  const codes = [...new Set(trades.map(t => t.thscode))];
  const dates = trades.map(t => t.date).sort();
  const result = { byCode: {}, bench: null };
  let step = 0;
  const total = codes.length * 3 + 1;
  for (const code of codes) {
    const ds = trades.filter(t => t.thscode === code).map(t => t.date).sort();
    const start = addDays(ds[0], -120);
    const endCand = addDays(ds[ds.length - 1], 130);
    const end = endCand > today ? today : endCand;
    onProgress(++step, total, `${code} 前复权K线`);
    const adj = await fetchBars(code, start, end, 'forward');
    onProgress(++step, total, `${code} 不复权K线`);
    const raw = await fetchBars(code, start, end, 'none');
    onProgress(++step, total, `${code} 异动解读`);
    const evEnd = addDays(ds[ds.length - 1], 90) > today ? today : addDays(ds[ds.length - 1], 90);
    const ev = await fetchEvents(code, addDays(ds[0], -60), evEnd);
    result.byCode[code] = { thscode: code, adj: adj.bars, adjMeta: adj.meta, raw: raw.bars, rawMeta: raw.meta, events: ev.events, eventsMeta: ev.meta };
  }
  onProgress(++step, total, `基准 ${BENCHMARK.name}`);
  const bStart = addDays(dates[0], -120);
  const bEndCand = addDays(dates[dates.length - 1], 130);
  const b = await fetchIndexBars(BENCHMARK.thscode, bStart, bEndCand > today ? today : bEndCand);
  result.bench = { ...BENCHMARK, bars: b.bars, meta: b.meta };
  return result;
}

/** 标的检索（用于“下次决策前检查”输入股票名称） */
export async function searchTicker(q) {
  const path = 'meta/tickers/search';
  const r = await getData({ path, params: { q, asset_type: 'a-share', limit: 8 }, kind: 'search', label: `检索“${q}”`, snapshotKey: snapKey(path, q) });
  return r.ok ? (r.data?.item || []) : [];
}

export async function health() {
  try { const r = await fetch('api/health'); return r.ok ? await r.json() : null; } catch { return null; }
}

/** AI 复盘调用；失败返回 { ok:false, ... }，由调用方切到规则兜底 */
export async function callReview(stage, pack, exAnte) {
  if (simulated('ai')) return { ok: false, code: 'SIMULATED', message: '故障演练：模拟 AI 服务不可用' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch('api/review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stage, pack, exAnte }), signal: ctrl.signal });
    if (!r.ok) return { ok: false, code: `HTTP_${r.status}`, message: `AI 接口返回 HTTP ${r.status}` };
    return await r.json();
  } catch (e) {
    return { ok: false, code: 'NETWORK', message: e.name === 'AbortError' ? 'AI 调用超时' : `网络错误：${e.message}` };
  } finally { clearTimeout(timer); }
}
