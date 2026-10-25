// 把一笔交易与行情、基准、事件对齐，产出“事前 / 当日 / 事后”三段证据。
// 所有数字都生成 evidence 条目，带来源接口、request_id、时点、单位与计算口径，便于回溯。
import { msToDate, msToDateTime, parseUpstreamTime } from './dates.js';
import { round4 } from './trades.js';

export const TRADING_DAYS_PER_YEAR = 244;

/** 扶摇 PriceBarItem[] -> 统一 bar（升序、去重） */
export function normalizeBars(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  return items
    .filter(b => b && b.date_ms != null && Number(b.close_price) > 0)
    .map(b => ({
      date: msToDate(b.date_ms), date_ms: Number(b.date_ms),
      open: Number(b.open_price), high: Number(b.high_price), low: Number(b.low_price), close: Number(b.close_price),
      volume: Number(b.volume), turnover: Number(b.turnover),
    }))
    .sort((a, b) => a.date_ms - b.date_ms)
    .filter(b => (seen.has(b.date) ? false : (seen.add(b.date), true)));
}

/** 扶摇日期范围异动解读 items -> 统一事件 */
export function normalizeEvents(items, sourceMeta = {}) {
  if (!Array.isArray(items)) return [];
  return items.map((it, k) => {
    // 优先“第一次进行解读的时间”，代表信息首次可被看到的时点；没有则退回发生时间
    const pub = parseUpstreamTime(it.first_publish_time);
    const occ = parseUpstreamTime(it.create_time ?? it.last_anomaly_time);
    const chosen = pub.ms != null ? { ...pub, field: 'first_publish_time' } : { ...occ, field: it.create_time != null ? 'create_time' : 'last_anomaly_time' };
    return {
      id: it.analysis_id || `ev${k}`,
      time_ms: chosen.ms, time_field: chosen.field, time_unit: chosen.unit, time_raw: chosen.raw,
      date: chosen.ms != null ? msToDate(chosen.ms) : null,
      datetime: chosen.ms != null && chosen.unit !== 'date-only' ? msToDateTime(chosen.ms) : null,
      tag: it.tag_name || it.anomaly_type || '',
      keywords: it.key_word_list || [],
      content: stripHtml(it.analysis_content || ''),
      url: it.link_url || null,
      source: sourceMeta,
    };
  }).filter(e => e.time_ms != null || e.content);
}

export function stripHtml(s) {
  return String(s).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

function idxOnOrAfter(bars, date) {
  for (let i = 0; i < bars.length; i++) if (bars[i].date >= date) return i;
  return -1;
}
function idxOf(bars, date) {
  for (let i = 0; i < bars.length; i++) if (bars[i].date === date) return i;
  return -1;
}
function std(arr) {
  if (arr.length < 2) return null;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}
const pct = x => (x == null || Number.isNaN(x) ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%');
export { pct };

/** 窗口收益：bars[i-n] -> bars[i]（收盘到收盘） */
function windowRet(bars, end, n) {
  const start = end - n;
  if (start < 0 || end >= bars.length || end < 0) return null;
  return bars[end].close / bars[start].close - 1;
}

/**
 * 事前指标（只用 bars[0..pre]）。复盘与“下次决策前检查”共用同一口径。
 */
export function exAnteMetrics(adj, pre) {
  const m = {};
  m.pre_ret_5 = windowRet(adj, pre, 5);
  m.pre_ret_20 = windowRet(adj, pre, 20);
  m.pre_ret_60 = windowRet(adj, pre, 60);
  if (pre >= 20) {
    const rets = [];
    for (let k = pre - 19; k <= pre; k++) rets.push(adj[k].close / adj[k - 1].close - 1);
    const s = std(rets);
    m.pre_vol_20 = s == null ? null : s * Math.sqrt(TRADING_DAYS_PER_YEAR);
  } else m.pre_vol_20 = null;
  if (pre >= 59) {
    let hi = -Infinity;
    for (let k = pre - 59; k <= pre; k++) hi = Math.max(hi, adj[k].high);
    m.pre_dist_high_60 = adj[pre].close / hi - 1;
    const avg = (a, b) => { let s = 0, n = 0; for (let k = a; k <= b; k++) { s += adj[k].volume; n++; } return s / n; };
    const v60 = avg(pre - 59, pre);
    m.pre_vol_ratio = v60 > 0 ? avg(pre - 4, pre) / v60 : null;
  } else { m.pre_dist_high_60 = null; m.pre_vol_ratio = null; }
  return m;
}

/** 以最新一根K线为“当下”计算事前指标（用于下次决策前检查） */
export function currentMetrics(adj, benchBars = []) {
  if (!adj.length) return { metrics: {}, as_of: null };
  const m = exAnteMetrics(adj, adj.length - 1);
  m.bench_pre_ret_20 = benchBars.length ? windowRet(benchBars, benchBars.length - 1, 20) : null;
  return { metrics: roundMetrics(m), as_of: adj[adj.length - 1].date };
}

/**
 * 构建单笔交易的复盘上下文。
 * @param trade 规范化后的交易
 * @param md { thscode, raw: bar[], adj: bar[], rawMeta, adjMeta, events: event[], eventsMeta }
 * @param bench { thscode, name, bars: bar[], meta }
 */
export function buildTradeContext(trade, md, bench) {
  const ev = [];
  const checks = []; // 数据冲突、缺失、假设
  const tid = trade.id;
  const raw = md?.raw || [];
  const adj = md?.adj?.length ? md.adj : raw; // 复权缺失时退回不复权，并提示
  const priceSrc = md?.adjMeta?.ok ? md.adjMeta : md?.rawMeta;
  if (!md?.adj?.length && raw.length) checks.push({ level: 'warn', code: 'ADJ_MISSING', msg: '前复权行情缺失，收益改用不复权价格计算，若期间有分红送转会有偏差' });

  const add = (key, phase, label, value, unit, extra = {}) => {
    // 波动率等“水平类”百分比不带正负号，避免被误读为涨跌
    const display = unit === '%' ? (extra.unsigned ? (value == null ? '—' : (value * 100).toFixed(2) + '%') : pct(value)) : value == null ? '—' : String(value);
    const item = { id: `E-${tid}-${key}`, trade_id: tid, phase, label, value, unit, display, ...extra };
    ev.push(item);
    return item;
  };

  if (!adj.length) {
    checks.push({ level: 'error', code: 'NO_PRICE_DATA', msg: `没有取到 ${trade.thscode} 的行情数据（${md?.adjMeta?.message || md?.rawMeta?.message || '未知原因'}），本笔交易的价格相关结论均无法给出` });
    return { trade, ok: false, checks, evidence: ev, metrics: {}, events: { pre: [], same: [], post: [] }, tradeIdx: -1, effective_price: trade.price };
  }

  // 1) 对齐交易日
  let i = idxOf(adj, trade.date);
  let alignedDate = trade.date;
  if (i < 0) {
    const j = idxOnOrAfter(adj, trade.date);
    if (j < 0) {
      checks.push({ level: 'error', code: 'DATE_OUT_OF_RANGE', msg: `交易日期 ${trade.date} 晚于已获取行情的最后一天 ${adj[adj.length - 1].date}` });
      return { trade, ok: false, checks, evidence: ev, metrics: {}, events: { pre: [], same: [], post: [] }, tradeIdx: -1, effective_price: trade.price };
    }
    alignedDate = adj[j].date;
    i = j;
    checks.push({ level: 'warn', code: 'NON_TRADING_DAY', msg: `${trade.date} 不是交易日（或停牌），已对齐到下一个有行情的交易日 ${alignedDate}，请核对原始记录` });
  }
  const rawIdx = idxOf(raw, alignedDate);
  const rawBar = rawIdx >= 0 ? raw[rawIdx] : null;

  // 2) 成交价：缺失则以当日不复权收盘价代替；存在则与当日高低价核对
  let price = trade.price;
  if (price == null) {
    if (rawBar) {
      price = rawBar.close;
      checks.push({ level: 'info', code: 'PRICE_ASSUMED', msg: `未填成交价，以 ${alignedDate} 不复权收盘价 ${rawBar.close} 代替（假设）` });
    } else {
      checks.push({ level: 'error', code: 'PRICE_UNKNOWN', msg: '未填成交价，且缺少当日不复权行情，无法补全' });
    }
  } else if (rawBar) {
    const tol = 0.005;
    if (price > rawBar.high * (1 + tol) || price < rawBar.low * (1 - tol)) {
      checks.push({ level: 'error', code: 'PRICE_CONFLICT', msg: `成交价 ${price} 超出 ${alignedDate} 当日不复权价格区间 [${rawBar.low}, ${rawBar.high}]，记录可能有误（日期、代码或价格），相关收益结论置信度降低` });
    }
  } else {
    checks.push({ level: 'warn', code: 'RAW_MISSING', msg: '缺少不复权行情，无法核对成交价是否在当日价格区间内' });
  }

  const srcFor = (meta, api) => ({ api, thscode: trade.thscode, request_id: meta?.request_id || null, fetched_at: meta?.fetched_at || null, mode: meta?.mode || null });
  const pSrc = srcFor(priceSrc, `/api/a-share/prices/historical (adjust=${md?.adj?.length ? 'forward' : 'none'})`);
  const bSrc = { api: '/api/a-share-index/prices/historical', thscode: bench?.thscode, request_id: bench?.meta?.request_id || null, fetched_at: bench?.meta?.fetched_at || null, mode: bench?.meta?.mode || null };

  // 3) 事前指标：只用 T-1 及之前的收盘数据（T 日收盘在决策时尚未发生）
  const pre = i - 1;
  const asOfPre = pre >= 0 ? adj[pre].date : null;
  const m = exAnteMetrics(adj, pre);

  // 基准对齐
  const bb = bench?.bars || [];
  const bi = bb.length ? idxOf(bb, alignedDate) : -1;
  m.bench_pre_ret_20 = bi > 0 ? windowRet(bb, bi - 1, 20) : null;
  if (bb.length && bi < 0) checks.push({ level: 'warn', code: 'BENCH_MISSING_DAY', msg: `基准 ${bench.name || bench.thscode} 在 ${alignedDate} 没有数据，相对收益无法计算` });
  if (!bb.length) checks.push({ level: 'warn', code: 'BENCH_MISSING', msg: `基准指数行情获取失败（${bench?.meta?.message || '未知原因'}），超额收益与“市场环境”类归因无法给出` });

  const preCalc = `截至 ${asOfPre || '—'} 收盘（交易日前一交易日，决策时已知）`;
  if (pre < 0) checks.push({ level: 'warn', code: 'NO_PRE_HISTORY', msg: '交易日之前没有行情，事前指标无法计算（可能是新股或取数区间过短）' });
  add('pre_ret_5', 'ex_ante', '买卖前5个交易日涨跌幅', m.pre_ret_5, '%', { as_of: asOfPre, source: pSrc, calc: `前复权收盘价，${preCalc}` });
  add('pre_ret_20', 'ex_ante', '买卖前20个交易日涨跌幅', m.pre_ret_20, '%', { as_of: asOfPre, source: pSrc, calc: `前复权收盘价，${preCalc}` });
  add('pre_ret_60', 'ex_ante', '买卖前60个交易日涨跌幅', m.pre_ret_60, '%', { as_of: asOfPre, source: pSrc, calc: `前复权收盘价，${preCalc}` });
  add('pre_vol_20', 'ex_ante', '买卖前20日年化波动率', m.pre_vol_20, '%', { unsigned: true, as_of: asOfPre, source: pSrc, calc: `日收益标准差 × √${TRADING_DAYS_PER_YEAR}，${preCalc}` });
  add('pre_dist_high_60', 'ex_ante', '距前60日最高价', m.pre_dist_high_60, '%', { as_of: asOfPre, source: pSrc, calc: `收盘价 / 60日最高价 − 1，${preCalc}` });
  add('pre_vol_ratio', 'ex_ante', '近5日均量 / 近60日均量', m.pre_vol_ratio == null ? null : Math.round(m.pre_vol_ratio * 100) / 100, '倍', { as_of: asOfPre, source: pSrc, calc: `成交量（股），${preCalc}` });
  add('bench_pre_ret_20', 'ex_ante', `基准（${bench?.name || '—'}）前20日涨跌幅`, m.bench_pre_ret_20, '%', { as_of: asOfPre, source: bSrc, calc: `指数收盘价，${preCalc}` });

  // 4) 当日：决策当天的走势只有部分可知
  m.day_ret = i > 0 ? adj[i].close / adj[i - 1].close - 1 : null;
  m.bench_day_ret = bi > 0 ? bb[bi].close / bb[bi - 1].close - 1 : null;
  add('day_ret', 'same_day', '交易当日涨跌幅', m.day_ret, '%', { as_of: alignedDate, source: pSrc, calc: '当日收盘 / 前收 − 1；决策时只能看到盘中的一部分' });
  add('bench_day_ret', 'same_day', `基准交易当日涨跌幅`, m.bench_day_ret, '%', { as_of: alignedDate, source: bSrc, calc: '当日收盘 / 前收 − 1' });
  if (price != null) add('trade_price', 'same_day', '成交价（不复权）', price, '元', { as_of: alignedDate, source: { api: '用户交易记录', thscode: trade.thscode }, calc: trade.price == null ? '用户未填，取当日不复权收盘价（假设）' : '用户填写' });
  if (rawBar) add('day_range', 'same_day', '当日价格区间（不复权）', `${rawBar.low} – ${rawBar.high}`, '元', { as_of: alignedDate, source: srcFor(md.rawMeta, '/api/a-share/prices/historical (adjust=none)'), calc: '最低价 – 最高价' });

  // 5) 事后：从成交价出发。ret = (adjClose[i+k]/adjClose[i]) × (rawClose[i]/成交价) − 1
  const scale = rawBar && price ? rawBar.close / price : 1;
  const lastDate = adj[adj.length - 1].date;
  const postRet = k => (i + k < adj.length ? (adj[i + k].close / adj[i].close) * scale - 1 : null);
  const benchPost = k => (bi >= 0 && bi + k < bb.length ? bb[bi + k].close / bb[bi].close - 1 : null);
  for (const k of [5, 20, 60]) {
    m[`post_ret_${k}`] = postRet(k);
    m[`bench_post_ret_${k}`] = benchPost(k);
    m[`post_excess_${k}`] = m[`post_ret_${k}`] != null && m[`bench_post_ret_${k}`] != null ? m[`post_ret_${k}`] - m[`bench_post_ret_${k}`] : null;
    const asOf = i + k < adj.length ? adj[i + k].date : null;
    const why = asOf ? '' : `（行情只到 ${lastDate}，窗口尚未走完）`;
    add(`post_ret_${k}`, 'ex_post', `交易后${k}个交易日涨跌幅（相对成交价）`, m[`post_ret_${k}`], '%', { as_of: asOf, source: pSrc, calc: `前复权收盘，相对成交价${why}` });
    add(`post_excess_${k}`, 'ex_post', `交易后${k}个交易日超额收益（相对基准）`, m[`post_excess_${k}`], '%', { as_of: asOf, source: { ...pSrc, api: pSrc.api + ' + ' + bSrc.api }, calc: `个股收益 − ${bench?.name || '基准'}同期收益${why}` });
  }
  // 交易后 20 日内最大浮亏/浮盈（对买入有意义）
  if (i + 1 < adj.length && price) {
    let lo = Infinity, hi = -Infinity;
    const end = Math.min(adj.length - 1, i + 20);
    for (let k = i + 1; k <= end; k++) { lo = Math.min(lo, adj[k].low); hi = Math.max(hi, adj[k].high); }
    m.post_mae_20 = (lo / adj[i].close) * scale - 1;
    m.post_mfe_20 = (hi / adj[i].close) * scale - 1;
    add('post_mae_20', 'ex_post', '交易后20日内最大不利波动', m.post_mae_20, '%', { as_of: adj[end].date, source: pSrc, calc: '区间最低价相对成交价' });
    add('post_mfe_20', 'ex_post', '交易后20日内最大有利波动', m.post_mfe_20, '%', { as_of: adj[end].date, source: pSrc, calc: '区间最高价相对成交价' });
  }

  // 5b) 第二比较基准（行业 / 概念指数）：口径与沪深300完全相同；缺失时只提示，不影响主链路
  const sec = md?.sector;
  if (sec?.valid) {
    const sb = sec.bars || [];
    const sTag = `${sec.name}·${sec.typeLabel}`;
    const sSrc = { api: '/api/a-share-index/prices/historical', thscode: sec.thscode, request_id: sec.meta?.request_id || null, fetched_at: sec.meta?.fetched_at || null, mode: sec.meta?.mode || null };
    const si = sb.length ? idxOf(sb, alignedDate) : -1;
    // 关系说明本身也作为证据（事前已知：代码由用户在决策时指定；成分关系为当前快照）
    ev.push({ id: `E-${tid}-sector_info`, trade_id: tid, phase: 'ex_ante', kinds: ['sector_meta'], timing: 'at_decision', label: '第二比较基准', value: `${sec.name}（${sec.thscode}）：${sec.typeLabel}；${sec.roleLabel}`, unit: 'text', display: `${sec.name}（${sec.thscode}）：${sec.typeLabel}；${sec.roleLabel}`, as_of: alignedDate, source: { api: '/api/a-share-index/catalog/ths-index-list + /api/a-share-index/constituents/ths-stock-list', thscode: sec.thscode }, calc: sec.notes.join('；'), sector_type: sec.type, sector_role: sec.role });
    if (!sb.length) checks.push({ level: 'warn', code: 'SECTOR_MISSING', msg: `第二比较基准 ${sec.name} 行情获取失败（${sec.meta?.message || '未知原因'}），相对该指数的比较无法给出；沪深300 比较不受影响` });
    else {
      if (si < 0) checks.push({ level: 'warn', code: 'SECTOR_MISSING_DAY', msg: `第二比较基准 ${sec.name} 在 ${alignedDate} 没有数据，相对该指数的比较无法给出` });
      m.sector_pre_ret_20 = si > 0 ? windowRet(sb, si - 1, 20) : null;
      m.sector_day_ret = si > 0 ? sb[si].close / sb[si - 1].close - 1 : null;
      add('sector_pre_ret_20', 'ex_ante', `比较指数（${sTag}）前20日涨跌幅`, m.sector_pre_ret_20 == null ? null : round4(m.sector_pre_ret_20), '%', { as_of: asOfPre, source: sSrc, calc: `指数收盘价，${preCalc}` });
      add('sector_day_ret', 'same_day', `比较指数（${sTag}）交易当日涨跌幅`, m.sector_day_ret == null ? null : round4(m.sector_day_ret), '%', { as_of: alignedDate, source: sSrc, calc: '当日收盘 / 前收 − 1；决策时只能看到盘中的一部分' });
      for (const k of [5, 20, 60]) {
        const sp = si >= 0 && si + k < sb.length ? sb[si + k].close / sb[si].close - 1 : null;
        m[`sector_post_ret_${k}`] = sp;
        m[`post_excess_sector_${k}`] = m[`post_ret_${k}`] != null && sp != null ? m[`post_ret_${k}`] - sp : null;
        const asOf = si >= 0 && si + k < sb.length ? sb[si + k].date : null;
        const why = asOf ? '' : `（行情只到 ${sb[sb.length - 1].date}，窗口尚未走完）`;
        add(`sector_post_ret_${k}`, 'ex_post', `比较指数（${sTag}）交易后${k}个交易日涨跌幅`, sp == null ? null : round4(sp), '%', { as_of: asOf, source: sSrc, calc: `指数收盘价，交易日收盘起算${why}` });
        add(`post_excess_sector_${k}`, 'ex_post', `交易后${k}个交易日相对比较指数（${sec.name}）的差异`, m[`post_excess_sector_${k}`] == null ? null : round4(m[`post_excess_sector_${k}`]), '%', { as_of: asOf, source: { ...pSrc, api: pSrc.api + ' + ' + sSrc.api }, calc: `个股收益 − ${sec.name}同期收益；只说明表现差异，不说明原因${why}` });
      }
    }
  } else if (md?.sectorError) {
    checks.push({ level: 'warn', code: 'SECTOR_INVALID', msg: md.sectorError });
  }

  // 6) 事件：按“信息首次可见时间”与决策时点比较
  const events = { pre: [], same: [], post: [] };
  const decisionMs = trade.time ? Date.parse(`${alignedDate}T${trade.time}:00Z`) - 8 * 3600 * 1000 : null;
  for (const e of md?.events || []) {
    if (!e.date) { events.same.push({ ...e, timing: 'unknown', timing_note: '时间字段缺失，无法判断是否事前可知' }); continue; }
    if (e.date < alignedDate) events.pre.push({ ...e, timing: 'pre' });
    else if (e.date > alignedDate) events.post.push({ ...e, timing: 'post' });
    else if (decisionMs != null && e.datetime) {
      (e.time_ms <= decisionMs ? events.pre : events.post).push({ ...e, timing: e.time_ms <= decisionMs ? 'pre' : 'post', timing_note: `与交易时间 ${trade.time} 比较` });
    } else events.same.push({ ...e, timing: 'same_day_uncertain', timing_note: trade.time ? '事件只有日期没有具体时间' : '交易未填时间，无法判断同日事件的先后' });
  }
  const tagEv = (e, phase) => ({
    id: `E-${tid}-ev-${e.id}`, trade_id: tid, phase, label: `事件：${e.tag || '异动'}（${e.datetime || e.date || '时间未知'}）`, value: e.content.slice(0, 160), unit: 'text', display: e.content.slice(0, 160),
    as_of: e.date, source: { api: '/api/news/anomaly/analysis', thscode: trade.thscode, request_id: e.source?.request_id || null, fetched_at: e.source?.fetched_at || null, mode: e.source?.mode || null, field: e.time_field, url: e.url },
    calc: `时间取 ${e.time_field}（${e.time_unit}）`,
  });
  // 只纳入窗口内的事件，避免证据包过长：事前 60 天、事后 60 天
  const near = (e, from, to) => e.date >= from && e.date <= to;
  const from = pre >= 60 ? adj[pre - 59].date : adj[0].date;
  const to = adj[Math.min(adj.length - 1, i + 60)].date;
  events.pre = events.pre.filter(e => near(e, from, alignedDate));
  events.post = events.post.filter(e => near(e, alignedDate, to));
  events.pre.slice(-8).forEach(e => ev.push(tagEv(e, 'ex_ante')));
  events.same.forEach(e => ev.push(tagEv(e, 'same_day')));
  events.post.slice(0, 8).forEach(e => ev.push(tagEv(e, 'ex_post')));
  if (md?.eventsMeta && !md.eventsMeta.ok) checks.push({ level: 'warn', code: 'EVENTS_UNAVAILABLE', msg: `事件数据获取失败（${md.eventsMeta.message || '未知原因'}），“事件驱动”类归因无法判断，不代表期间没有事件` });
  else if (md?.eventsMeta?.ok && !(md.events || []).length) checks.push({ level: 'info', code: 'EVENTS_EMPTY', msg: '事件接口返回为空。接口文档说明空列表也可能是服务降级，不能据此断言期间没有异动' });
  if (md?.eventsMeta?.was_truncated) checks.push({ level: 'warn', code: 'EVENTS_TRUNCATED', msg: '事件数据被上游截断（超过365天范围），部分较早事件可能缺失' });

  // 7) 数据新鲜度
  const modes = [md?.adjMeta?.mode, md?.rawMeta?.mode, bench?.meta?.mode, md?.eventsMeta?.mode].filter(Boolean);
  if (modes.includes('snapshot')) checks.push({ level: 'warn', code: 'SNAPSHOT_DATA', msg: '部分数据来自离线快照（实时接口不可用），快照时间见“数据状态”，结论可能不是最新' });

  return { trade: { ...trade, aligned_date: alignedDate }, ok: true, checks, evidence: ev, metrics: roundMetrics(m), events, tradeIdx: i, effective_price: price, last_bar_date: lastDate };
}

function roundMetrics(m) {
  const o = {};
  for (const [k, v] of Object.entries(m)) o[k] = v == null || Number.isNaN(v) ? null : round4(v);
  return o;
}

/**
 * 回合（买→卖）层面的指标：持有收益、基准同期、超额、持有期最大回撤、卖出后表现。
 */
export function buildRoundTripContext(rt, md, bench) {
  const adj = md?.adj?.length ? md.adj : md?.raw || [];
  const raw = md?.raw || [];
  const bi0 = idxOnOrAfter(adj, rt.buy_date), si0 = idxOnOrAfter(adj, rt.sell_date);
  const out = { ...rt, holding_days: null, bench_ret: null, excess: null, hold_mae: null, post_sell_ret_20: null, evidence: [] };
  if (bi0 < 0 || si0 < 0) return out;
  out.holding_days = si0 - bi0;
  // 持有期内最大不利波动（相对买入价）
  const rawB = raw[idxOf(raw, adj[bi0].date)];
  const scale = rawB ? rawB.close / rt.buy_price : 1;
  let lo = Infinity, loDate = null;
  for (let k = bi0 + 1; k <= si0; k++) if (adj[k].low < lo) { lo = adj[k].low; loDate = adj[k].date; }
  if (lo < Infinity) { out.hold_mae = round4((lo / adj[bi0].close) * scale - 1); out.hold_mae_date = loDate; }
  // 基准同期
  const bb = bench?.bars || [];
  const b1 = idxOf(bb, adj[bi0].date), b2 = idxOf(bb, adj[si0].date);
  if (b1 >= 0 && b2 >= 0) { out.bench_ret = round4(bb[b2].close / bb[b1].close - 1); out.excess = round4(rt.pnl_pct - out.bench_ret); }
  // 卖出后 20 个交易日（事后信息，只用于“卖出后发生了什么”，不用于评判当时）
  const rawS = raw[idxOf(raw, adj[si0].date)];
  const sScale = rawS ? rawS.close / rt.sell_price : 1;
  if (si0 + 20 < adj.length) out.post_sell_ret_20 = round4((adj[si0 + 20].close / adj[si0].close) * sScale - 1);
  const id = `E-rt-${rt.buy_id}-${rt.sell_id}`;
  const src = { api: '/api/a-share/prices/historical', thscode: rt.thscode, request_id: md?.adjMeta?.request_id || md?.rawMeta?.request_id || null, fetched_at: md?.adjMeta?.fetched_at || null, mode: md?.adjMeta?.mode || md?.rawMeta?.mode || null };
  out.evidence.push(
    { id: `${id}-pnl`, phase: 'ex_post', label: `回合收益（${rt.buy_date} → ${rt.sell_date}）`, value: rt.pnl_pct, unit: '%', display: pct(rt.pnl_pct), as_of: rt.sell_date, source: { api: '用户交易记录（FIFO 配对）' }, calc: '卖出价 / 买入价 − 1，不含费用' },
    { id: `${id}-hold`, phase: 'ex_post', label: '持有交易日数', value: out.holding_days, unit: '天', display: String(out.holding_days), as_of: rt.sell_date, source: src, calc: '按行情交易日计数' },
    { id: `${id}-bench`, phase: 'ex_post', label: `基准同期涨跌幅`, value: out.bench_ret, unit: '%', display: pct(out.bench_ret), as_of: rt.sell_date, source: { api: '/api/a-share-index/prices/historical', thscode: bench?.thscode, request_id: bench?.meta?.request_id || null }, calc: '买入日收盘 → 卖出日收盘' },
    { id: `${id}-excess`, phase: 'ex_post', label: '回合超额收益', value: out.excess, unit: '%', display: pct(out.excess), as_of: rt.sell_date, source: src, calc: '回合收益 − 基准同期' },
    { id: `${id}-mae`, phase: 'ex_post', label: '持有期最大浮亏', value: out.hold_mae, unit: '%', display: pct(out.hold_mae), as_of: out.hold_mae_date, source: src, calc: '持有期最低价相对买入价（前复权换算）' },
    { id: `${id}-after`, phase: 'ex_post', label: '卖出后20个交易日涨跌幅', value: out.post_sell_ret_20, unit: '%', display: pct(out.post_sell_ret_20), as_of: si0 + 20 < adj.length ? adj[si0 + 20].date : null, source: src, calc: '相对卖出价；属于事后信息，仅供参考，不用于评判当时决策' },
  );
  // 第二比较基准同期（行业 / 概念指数）
  const sec = md?.sector;
  out.sector_ret = null; out.excess_sector = null;
  if (sec?.valid && sec.bars?.length) {
    const sb = sec.bars;
    const s1 = idxOf(sb, adj[bi0].date), s2 = idxOf(sb, adj[si0].date);
    if (s1 >= 0 && s2 >= 0) { out.sector_ret = round4(sb[s2].close / sb[s1].close - 1); out.excess_sector = round4(rt.pnl_pct - out.sector_ret); }
    const sSrc = { api: '/api/a-share-index/prices/historical', thscode: sec.thscode, request_id: sec.meta?.request_id || null };
    out.evidence.push(
      { id: `${id}-sector`, phase: 'ex_post', label: `比较指数（${sec.name}·${sec.typeLabel}）同期涨跌幅`, value: out.sector_ret, unit: '%', display: pct(out.sector_ret), as_of: rt.sell_date, source: sSrc, calc: '买入日收盘 → 卖出日收盘' },
      { id: `${id}-excess_sector`, phase: 'ex_post', label: `回合相对比较指数（${sec.name}）的差异`, value: out.excess_sector, unit: '%', display: pct(out.excess_sector), as_of: rt.sell_date, source: src, calc: '回合收益 − 比较指数同期；只说明表现差异，不说明原因' },
    );
  }
  return out;
}
