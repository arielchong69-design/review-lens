// 复盘镜：前端主程序
import { SAMPLE_TRADES } from './data/sample-trades.js';
import { normalizeTrade, parseTradesCSV, toCSV, CSV_HEADERS, sortTrades, THSCODE_RE } from './core/trades.js';
import { analyze, buildPack } from './core/engine.js';
import { pct, currentMetrics } from './core/context.js';
import { STATUS_LABEL } from './core/biases.js';
import { ruleBasedReview, validateAIOutput, DISCLAIMER } from './core/review.js';
import { SUPPORT_LABEL, SUPPORT_NOTE, evidenceKinds, TIMING_LABEL, evidenceTiming } from './core/relevance.js';
import { lessonsToChecklist, mergeChecklist, evaluateChecklist, similarHistory } from './core/checklist.js';
import { addDays, todayShanghai } from './core/dates.js';
import { state as ds, resetLog, loadMarketForTrades, callReview, health, searchTicker, fetchBars, fetchIndexBars, fetchEvents, BENCHMARK, exportSnapshot } from './datasource.js';
import { renderChart, escapeHtml as h } from './chart.js';
import { HISTORY_CAVEAT } from './core/sector.js';

const $ = sel => document.querySelector(sel);
const app = { trades: [], result: null, market: null, selected: null, stock: null, reviews: {}, checklist: [], evidenceIndex: new Map(), health: null };

// ---------- 本地存储（失败时静默降级为内存） ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 隐私模式等 */ } },
};

// ---------- 通用 UI ----------
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'timeline' && app.result) renderTimeline();
  if (name === 'status') renderStatus();
  if (name === 'checklist') renderChecklist();
  window.scrollTo({ top: 0 });
}
const fmtMoney = v => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toLocaleString('zh-CN', { maximumFractionDigits: 2 }));
const cls = v => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');
const sideText = s => (s === 'buy' ? '买入' : '卖出');
const msgBox = (level, title, items = []) => `<div class="msg ${level}">${title}${items.length ? `<ul>${items.map(i => `<li>${h(i)}</li>`).join('')}</ul>` : ''}</div>`;
const quadCls = q => ({ '过程好 · 结果好': 'gg', '过程好 · 结果差': 'gb', '过程差 · 结果好': 'bg', '过程差 · 结果差': 'bb' }[q] || '');

// ---------- ① 交易记录 ----------
function setTrades(list, msgs = { errors: [], warnings: [] }) {
  app.trades = sortTrades(list);
  store.set('rl.trades', app.trades);
  const box = $('#importMsgs');
  box.innerHTML = (msgs.errors.length ? msgBox('error', `有 ${msgs.errors.length} 条记录无法导入：`, msgs.errors) : '') + (msgs.warnings.length ? msgBox('warn', '提示：', msgs.warnings) : '');
  renderTradeTable();
}

function renderTradeTable() {
  const t = $('#tradeTable');
  if (!app.trades.length) { t.innerHTML = '<tr><td class="muted">还没有交易记录。可以载入示例、上传 CSV，或手动添加。</td></tr>'; return; }
  t.innerHTML = `<thead><tr><th>日期</th><th>代码</th><th>名称</th><th>方向</th><th class="num">成交价</th><th class="num">数量</th><th>当时理由</th><th>关键假设</th><th>退出计划</th><th>信心</th><th>比较指数</th><th></th></tr></thead><tbody>${
    app.trades.map(x => `<tr>
      <td>${x.date}${x.time ? `<div class="small muted">${x.time}</div>` : ''}</td><td>${x.thscode}</td><td>${h(x.name)}</td>
      <td class="${x.side === 'buy' ? 'up' : 'down'}">${sideText(x.side)}</td>
      <td class="num">${x.price ?? '<span class="muted small">收盘价代替</span>'}</td><td class="num">${x.qty}</td>
      <td class="reason-cell">${h(x.reason) || '<span class="muted">（未填）</span>'}</td><td class="reason-cell small">${h(x.hypotheses)}</td><td class="small">${h(x.exit_plan)}</td>
      <td>${x.confidence ?? ''}</td><td class="small">${h(x.sector_code || '')}</td><td><button class="btn ghost danger small" data-del="${x.id}">删除</button></td></tr>`).join('')
  }</tbody>`;
  t.querySelectorAll('[data-del]').forEach(b => b.onclick = () => setTrades(app.trades.filter(x => x.id !== b.dataset.del)));
}

function loadSample() {
  const errors = [], warnings = [];
  const list = SAMPLE_TRADES.map((r, i) => { const n = normalizeTrade(r, i); errors.push(...n.errors); return { ...n.trade, id: r.id }; });
  setTrades(list, { errors, warnings });
  app.reviews = {}; store.set('rl.reviews', {});
}

function download(name, text, type = 'text/plain') {
  const blob = new Blob(['﻿' + text], { type: `${type};charset=utf-8` });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function runAnalysis() {
  if (!app.trades.length) { $('#importMsgs').innerHTML = msgBox('error', '请先添加至少一笔交易'); return; }
  const btn = $('#btnRun'); btn.disabled = true;
  const prog = $('#runProgress');
  resetLog();
  try {
    app.market = await loadMarketForTrades(app.trades, (i, n, label) => { prog.innerHTML = `<span class="spinner"></span> 正在获取数据 ${i}/${n}：${h(label)}`; });
    app.result = analyze(app.trades, app.market);
    if (app.market.sectorWarnings?.length) $('#importMsgs').innerHTML = msgBox('warn', '比较指数提示：', app.market.sectorWarnings);
    indexEvidence();
    const failed = ds.callLog.filter(c => !c.ok).length, snap = ds.callLog.filter(c => c.mode === 'snapshot').length;
    prog.innerHTML = `完成：${ds.callLog.length} 次数据调用，${snap ? `${snap} 次使用离线快照，` : ''}${failed ? `<span class="down">${failed} 次失败</span>（详见“数据状态”）` : '全部成功'}`;
    app.selected = app.result.trades[0]?.id;
    app.stock = app.result.trades[0]?.thscode;
    renderReport();
    switchTab('timeline');
  } catch (e) {
    prog.innerHTML = `<span class="down">复盘失败：${h(e.message)}</span>`;
    console.error(e);
  } finally { btn.disabled = false; }
}

function indexEvidence() {
  app.evidenceIndex = new Map();
  for (const c of app.result.contexts) for (const e of c.evidence) app.evidenceIndex.set(e.id, e);
  for (const r of app.result.roundTrips) for (const e of r.evidence) app.evidenceIndex.set(e.id, e);
}

// ---------- ② 时间线 ----------
function renderTimeline() {
  const r = app.result;
  $('#timelineEmpty').hidden = !!r; $('#timelineBody').hidden = !r;
  if (!r) return;
  const codes = [...new Set(r.trades.map(t => t.thscode))];
  const sel = $('#stockSelect');
  sel.innerHTML = codes.map(c => { const t = r.trades.find(x => x.thscode === c); return `<option value="${c}" ${c === app.stock ? 'selected' : ''}>${h(t.name || c)} ${c}</option>`; }).join('');
  sel.onchange = () => { app.stock = sel.value; app.selected = r.trades.find(t => t.thscode === app.stock)?.id; renderTimeline(); };
  const md = app.market.byCode[app.stock];
  const ctx = r.contexts.find(c => c.trade.id === app.selected);
  const stockTrades = r.contexts.filter(c => c.trade.thscode === app.stock);
  renderChart($('#chart'), {
    bars: md?.adj?.length ? md.adj : md?.raw, bench: app.market.bench?.bars, sector: md?.sector?.bars,
    trades: stockTrades.map(c => ({ id: c.trade.id, date: c.trade.aligned_date || c.trade.date, side: c.trade.side, label: c.trade.reason, selected: c.trade.id === app.selected })),
    events: (md?.events || []).filter(e => e.date).map(e => ({ date: e.date, label: `${e.tag}：${e.content.slice(0, 80)}` })),
    cutoff: ctx?.trade.aligned_date || null,
    onPick: id => { app.selected = id; renderTimeline(); },
  });
  renderCutoff(ctx);
  // 完整时间线
  const items = [];
  for (const c of stockTrades) items.push({ date: c.trade.aligned_date || c.trade.date, time: c.trade.time, kind: 'trade', c });
  for (const e of md?.events || []) if (e.date) items.push({ date: e.date, time: e.datetime?.slice(11), kind: 'ev', e });
  items.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  const cut = ctx?.trade.aligned_date;
  $('#timelineList').innerHTML = items.map(it => {
    const after = cut && it.date > cut ? ' after' : '';
    if (it.kind === 'trade') {
      const t = it.c.trade;
      return `<li class="trade ${t.side}${t.id === app.selected ? ' selected' : ''}${after}" data-id="${t.id}"><span class="date">${it.date}${t.time ? ' ' + t.time : ''}</span>${sideText(t.side)} ${t.qty} 股 @ ${it.c.effective_price ?? '—'}${t.price_assumed ? '（收盘价代替）' : ''} — ${h(t.reason || '未填理由')}</li>`;
    }
    return `<li class="ev${after}"><span class="date">${it.date}${it.time ? ' ' + it.time : ''}</span><span class="tag unc">${h(it.e.tag || '异动')}</span>${h(it.e.content.slice(0, 120))}</li>`;
  }).join('') || '<li class="muted">没有数据</li>';
  $('#timelineList').querySelectorAll('li.trade').forEach(li => li.onclick = () => { app.selected = li.dataset.id; renderTimeline(); });
}

function renderCutoff(ctx) {
  if (!ctx) { $('#phaseCols').innerHTML = ''; $('#checks').innerHTML = ''; return; }
  const t = ctx.trade;
  $('#cutoffTitle').textContent = `信息截止线：${t.aligned_date || t.date}${t.time ? ' ' + t.time : ''} ${sideText(t.side)} ${t.name || t.thscode}`;
  const md = app.market.byCode[t.thscode];
  const sec = md?.sector;
  const b = app.market.bench;
  $('#benchCard').innerHTML = `<div><div class="t">基准一 · 宽基</div><div class="n">${h(b?.name || '沪深300')}（${h(b?.thscode || '000300.SH')}）</div><div class="small muted">${b?.bars?.length ? '用于超额收益与“市场环境”比较' : '行情获取失败，相关比较无法给出'}</div></div>`
    + (sec?.valid
      ? `<div><div class="t">基准二 · ${h(sec.typeLabel)}</div><div class="n">${h(sec.name)}（${h(sec.thscode)}）</div><div class="small">${h(sec.roleLabel)}</div><div class="small muted">${h(sec.notes.join('；'))}${sec.bars?.length ? '' : '；行情获取失败，相关比较无法给出'}</div></div>`
      : `<div><div class="t">基准二 · 行业或概念指数</div><div class="n">${md?.sectorError ? '已填写但未使用' : '未设置'}</div><div class="small muted">${h(md?.sectorError || '可在交易记录中为该股票填写“比较指数代码”（同花顺行业或概念指数）')}</div></div>`);
  const lv = { error: 'error', warn: 'warn', info: 'info' };
  $('#checks').innerHTML = ctx.checks.map(c => `<div class="msg ${lv[c.level]}">${c.level === 'error' ? '数据冲突/缺失：' : c.level === 'warn' ? '注意：' : ''}${h(c.msg)}</div>`).join('');
  const col = (phase, title, sub) => {
    const evs = ctx.evidence.filter(e => e.phase === phase);
    const nums = evs.filter(e => e.unit !== 'text'), texts = evs.filter(e => e.unit === 'text' && evidenceKinds(e).includes('event')), recs = evs.filter(e => evidenceKinds(e).includes('plan'));
    return `<div class="phase ${phase === 'ex_ante' ? 'ante' : phase === 'same_day' ? 'same' : 'post'}"><h3>${title}</h3><div class="small muted" style="margin-bottom:6px">${sub}</div>
      ${nums.map(e => `<div class="ev-row" data-ev="${e.id}"><span>${h(e.label)}</span><span class="v ${e.unit === '%' && !e.unsigned ? cls(e.value) : ''}">${h(e.display)}${e.unit !== '%' && e.unit !== 'text' && e.value != null ? ' ' + e.unit : ''}</span></div>`).join('')}
      ${texts.length ? `<div class="small" style="margin-top:6px;font-weight:600">事件</div>${texts.map(e => `<div class="ev-text" data-ev="${e.id}">${h(e.label)}：${h(e.display.slice(0, 70))}…</div>`).join('')}` : ''}
      ${recs.length ? `<div class="small" style="margin-top:6px;font-weight:600">当时的记录</div>${recs.map(e => `<div class="ev-text" data-ev="${e.id}">${h(e.label.replace('用户记录：', ''))}：${h(e.display)}</div>`).join('')}` : ''}
      ${!evs.length ? '<div class="muted small">无</div>' : ''}</div>`;
  };
  $('#phaseCols').innerHTML = col('ex_ante', '事前可知', '决策前一交易日收盘及更早的信息') + col('same_day', '当日（部分可知）', '决策当天，盘中只能看到一部分') + col('ex_post', '事后才知道', '只能用来检验假设，不能用来苛责当时');
  $('#phaseCols').querySelectorAll('[data-ev]').forEach(n => n.onclick = () => showEvidence(n.dataset.ev));
}

// ---------- 证据抽屉 ----------
function showEvidence(id) {
  const e = app.evidenceIndex.get(id);
  const body = $('#drawerBody');
  if (!e) { body.innerHTML = `<h2>证据 ${h(id)}</h2><p class="msg error">找不到这条证据（可能是 AI 编造的引用，已被校验拦截）。</p>`; }
  else {
    const phase = { ex_ante: '事前可知', same_day: '当日（部分可知）', ex_post: '事后信息' }[e.phase];
    const s = e.source || {};
    body.innerHTML = `<h2>${h(e.label)}</h2>
      <div style="font-size:22px;font-weight:700;margin-top:6px" class="${e.unit === '%' && !e.unsigned ? cls(e.value) : ''}">${h(e.unit === 'text' ? '' : e.display)}${e.unit && !['%', 'text'].includes(e.unit) && e.value != null ? ' ' + e.unit : ''}</div>
      ${e.unit === 'text' ? `<p>${h(e.value)}</p>` : ''}
      <dl class="kv">
        <dt>证据 ID</dt><dd>${h(e.id)}</dd>
        <dt>信息阶段</dt><dd>${phase}</dd>
        <dt>证据类型</dt><dd>${h(evidenceKinds(e).join(' / '))}</dd>
        <dt>时序</dt><dd>${h(TIMING_LABEL[evidenceTiming(e)] || '—')}</dd>${e.state ? `<dt>记录状态</dt><dd>${e.state === 'filled' ? '已填写' : '未填写'}</dd>` : ''}${e.status ? `<dt>规则结果</dt><dd>${h(e.status)}</dd>` : ''}
        <dt>数据时点</dt><dd>${h(e.as_of || '—')}</dd>
        <dt>单位</dt><dd>${h(e.unit === 'text' ? '文本' : e.unit || '—')}</dd>
        <dt>计算口径</dt><dd>${h(e.calc || '—')}</dd>
        <dt>来源接口</dt><dd>${h(s.api || '—')}</dd>
        <dt>标的</dt><dd>${h(s.thscode || '—')}</dd>
        <dt>request_id</dt><dd>${h(s.request_id || '—')}</dd>
        <dt>获取时间</dt><dd>${h(s.fetched_at || '—')}</dd>
        <dt>获取方式</dt><dd>${s.mode === 'snapshot' ? '离线快照（实时接口当时不可用）' : s.mode === 'live' ? '实时调用' : h(s.mode || '—')}</dd>
        ${s.field ? `<dt>时间字段</dt><dd>${h(s.field)}</dd>` : ''}
        ${s.url ? `<dt>原文</dt><dd><a href="${h(s.url)}" target="_blank" rel="noopener noreferrer">打开链接</a></dd>` : ''}
      </dl>`;
  }
  $('#drawer').hidden = false;
}

// ---------- ③ 复盘报告 ----------
function renderReport() {
  const r = app.result;
  $('#reportEmpty').hidden = !!r; $('#reportBody').hidden = !r;
  if (!r) return;
  const s = r.summary;
  $('#stats').innerHTML = [
    ['交易笔数', s.trades, `${s.stocks} 只股票`],
    ['已完成回合', s.round_trips, `${s.open_positions} 笔仍持有`],
    ['已实现盈亏', `<span class="${cls(s.realized_pnl)}">${fmtMoney(s.realized_pnl)}</span>`, '元，不含费用'],
    ['胜率', s.win_rate == null ? '—' : (s.win_rate * 100).toFixed(0) + '%', '按回合计'],
    ['平均超额', `<span class="${cls(s.avg_excess)}">${pct(s.avg_excess)}</span>`, '相对沪深300同期'],
    ['触发的偏差', s.triggered, s.data_errors ? `<span class="down">${s.data_errors} 处数据冲突</span>` : '规则推断'],
  ].map(([k, v, sub]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`).join('');

  $('#rtTable').innerHTML = r.roundTrips.length ? `<thead><tr><th>股票</th><th>买入</th><th>卖出</th><th class="num">持有天数</th><th class="num">收益</th><th class="num">基准同期</th><th class="num">超额</th><th class="num">相对比较指数</th><th class="num">卖出后20日</th><th>过程 × 结果</th></tr></thead><tbody>${
    r.roundTrips.map(rt => `<tr class="clickable" data-id="${rt.sell_id}">
      <td>${h(rt.name || rt.thscode)}</td><td>${rt.buy_date}<div class="small muted">@ ${rt.buy_price}</div></td><td>${rt.sell_date}<div class="small muted">@ ${rt.sell_price} × ${rt.qty}</div></td>
      <td class="num">${rt.holding_days ?? '—'}</td><td class="num ${cls(rt.pnl_pct)}">${pct(rt.pnl_pct)}<div class="small">${fmtMoney(rt.pnl)}</div></td>
      <td class="num ${cls(rt.bench_ret)}">${pct(rt.bench_ret)}</td><td class="num ${cls(rt.excess)}">${pct(rt.excess)}</td><td class="num ${cls(rt.excess_sector)}" title="${h(app.market.byCode[rt.thscode]?.sector?.valid ? app.market.byCode[rt.thscode].sector.name + '（' + app.market.byCode[rt.thscode].sector.typeLabel + '）；只说明表现差异，不说明原因' : '未设置第二比较基准')}">${pct(rt.excess_sector)}${app.market.byCode[rt.thscode]?.sector?.valid ? `<div class="small muted">${h(app.market.byCode[rt.thscode].sector.name)}</div>` : ''}</td>
      <td class="num ${cls(rt.post_sell_ret_20)}" title="事后信息，仅供参考">${pct(rt.post_sell_ret_20)}</td>
      <td><span class="quad ${quadCls(rt.process.quadrant)}" title="${h(rt.process.reasons.join('\n'))}">${rt.process.quadrant}</span><div class="small muted">过程分 ${rt.process.score}/5</div></td></tr>`).join('')
  }</tbody>` : '<tr><td class="muted">还没有完整的买入→卖出回合。</td></tr>';
  $('#rtTable').querySelectorAll('tr.clickable').forEach(tr => tr.onclick = () => { $('#tradeSelect').value = tr.dataset.id; renderReviewFor(tr.dataset.id); });
  const pb = r.portfolio[0];
  const issues = r.issues.map(i => i.msg);
  $('#portfolioBias').innerHTML = `<div class="bias ${pb.status}" style="margin-top:10px"><span class="st">${STATUS_LABEL[pb.status]}</span><b>组合层面 · ${pb.name}</b> <span class="tag rule">规则推断</span><div>${h(pb.detail)}</div><div class="rule">${h(pb.rule)}${pb.note ? '；' + h(pb.note) : ''}</div></div>
    <p class="small muted">“过程 × 结果”是规则粗分：过程分看是否有理由、可检验假设、退出计划、是否遵守计划、是否在追涨时考虑了风险；结果看超额收益。鼠标悬停可看打分明细。</p>
    ${issues.length ? msgBox('warn', '配对提示：', issues) : ''}`;

  const sel = $('#tradeSelect');
  sel.innerHTML = r.trades.map(t => `<option value="${t.id}">${t.date} ${sideText(t.side)} ${h(t.name || t.thscode)}${app.reviews[t.id] ? ' ✓' : ''}</option>`).join('');
  if (app.selected) sel.value = app.selected;
  sel.onchange = () => renderReviewFor(sel.value);
  renderReviewFor(sel.value);
}

function renderReviewFor(id) {
  app.selected = id;
  const out = $('#reviewOut');
  const rv = app.reviews[id];
  const pack = buildPack(app.result, id);
  if (!pack) { out.innerHTML = '<p class="muted">找不到这笔交易</p>'; return; }
  if (!rv) {
    out.innerHTML = `${tradeHeader(pack)}${biasBlock(pack)}<p class="muted">点击“生成复盘”：AI 先只看决策当时的 ${pack.evidence.filter(e => e.phase !== 'ex_post').length} 条证据做事前评估，再看全部 ${pack.evidence.length} 条证据做事后检验。</p>`;
    bindRefs(out); return;
  }
  out.innerHTML = `${tradeHeader(pack)}<div class="review">${renderExAnte(rv)}${biasBlock(pack)}${renderExPost(rv, pack)}${renderValidation(rv)}</div>`;
  bindRefs(out);
  out.querySelectorAll('[data-add-lesson]').forEach(b => b.onclick = () => addLessons(id, b.dataset.addLesson === 'all' ? null : Number(b.dataset.addLesson)));
}

function tradeHeader(p) {
  const t = p.trade;
  const errs = p.checks.filter(c => c.level === 'error');
  return `<div class="card" style="box-shadow:none;background:var(--surface-2)">
    <b>${t.aligned_date || t.date}${t.time ? ' ' + t.time : ''} ${sideText(t.side)} ${h(t.name || t.thscode)}</b> ${t.qty} 股 @ ${p.trade.effective_price ?? '—'}${t.price_assumed ? '（收盘价代替）' : ''}
    <div><span class="muted">当时理由：</span>${h(t.reason || '（未填写）')}</div>
    ${t.hypotheses ? `<div><span class="muted">关键假设：</span>${h(t.hypotheses)}</div>` : ''}
    ${t.exit_plan ? `<div><span class="muted">退出计划：</span>${h(t.exit_plan)}</div>` : ''}
    ${p.process_outcome ? `<div style="margin-top:6px"><span class="quad ${quadCls(p.process_outcome.quadrant)}">${p.process_outcome.quadrant}</span> <span class="small muted">过程分 ${p.process_outcome.score}/5（${h(p.process_outcome.reasons.join('；'))}）· 结果按${p.process_outcome.outcome_basis} ${pct(p.process_outcome.outcome_value)}。${h(p.process_outcome.reading)}</span></div>` : ''}
    ${errs.length ? msgBox('error', '本笔交易存在数据冲突/缺失，相关结论置信度降低：', errs.map(e => e.msg)) : ''}
  </div>`;
}

function refChips(refs = []) {
  return refs.map(r => { const e = app.evidenceIndex.get(r); const ph = e?.phase === 'ex_ante' ? 'ante' : e?.phase === 'ex_post' ? 'post' : 'same'; return `<span class="ref ${ph}" data-ref="${h(r)}" title="${h(e?.label || '未知证据')}">${h(shortRef(r, e))}</span>`; }).join('');
}
function shortRef(r, e) { return e ? (e.label.length > 12 ? e.label.slice(0, 12) + '…' : e.label) : r; }
function bindRefs(root) { root.querySelectorAll('[data-ref]').forEach(n => n.onclick = () => showEvidence(n.dataset.ref)); }
const typeTag = t => (t === 'fact' ? '<span class="tag fact">事实</span>' : '<span class="tag inference">推断</span>');
const supportTag = x => {
  if (!x || !x.support) return '';
  // 已改写为“（证据有限）/（无法判断）……”或假设已判“无法判断”的，不重复显示标签
  if (typeof x.text === 'string' && /^（(证据有限|无法判断)）/.test(x.text)) return '';
  if (x.verdict === '无法判断') return '';
  const cls = x.support === 'pass' ? 'fact' : x.support === 'limited' ? 'inference' : 'unc';
  const tip = [SUPPORT_NOTE, ...(x.support_notes || [])].join('\n');
  return `<span class="tag ${cls}" title="${h(tip)}">${SUPPORT_LABEL[x.support]}</span>`;
};
const removedRefs = x => (x.irrelevant_refs?.length ? `<span class="small muted" title="${h(x.support_notes?.join('\n') || '')}">（已移除不相关引用 ${x.irrelevant_refs.length} 条）</span>` : '');
const assertNote = x => { const n = (x.support_notes || []).find(t => t.startsWith('结构化断言已核对')); return n ? `<div class="small muted">${h(n)}</div>` : ''; };
const claimTail = x => `${refChips(x.refs)}${removedRefs(x)}${x.untraced ? '<span class="tag warn">数字未能溯源</span>' : ''}${assertNote(x)}`;
const genLabel = rv => (rv.generator === 'ai' ? `由 ${h(rv.model || 'AI')} 生成，已通过引用与合规校验` : `规则引擎生成（AI 不可用：${h(rv.ai_error || '未知')}）`);

function renderExAnte(rv) {
  const a = rv.ex_ante || {};
  const li = (arr, f) => (arr?.length ? `<ul>${arr.map(f).join('')}</ul>` : '<p class="muted small">无</p>');
  return `<section class="ante"><h3>A. 回到当时：只看事前信息 <span class="gen">${genLabel(rv.stage1 || rv)}</span></h3>
    <div class="small muted" style="margin-bottom:6px">这一步 AI 拿不到任何交易之后的数据，避免后见之明。</div>
    <b class="small">理由与当时证据是否一致</b>${li(a.reason_assessment, x => `<li>${supportTag(x)}${typeTag(x.type)}${h(x.text)} ${claimTail(x)}</li>`)}
    <b class="small">从理由中拆出的可检验假设</b>${li(a.hypotheses, x => `<li>${h(x.hypothesis)}${x.how_to_check ? `<div class="small muted">如何检验：${h(x.how_to_check)}</div>` : ''}</li>`)}
    <b class="small">当时就能看到的风险信号</b>${li(a.visible_risks, x => `<li>${supportTag(x)}${typeTag(x.type)}${h(x.text)} ${claimTail(x)}</li>`)}
  </section>`;
}

function biasBlock(p) {
  if (!p.biases.length) return '';
  return `<section class="rules" style="border:1px solid var(--border);border-left:4px solid var(--brand);border-radius:8px;padding:12px 14px;margin-bottom:12px"><h3 style="margin:0 0 8px">B. 行为偏差检查 <span class="tag rule">规则推断</span></h3><div class="bias-grid">${
    p.biases.map(b => `<div class="bias ${b.status}"><span class="st">${STATUS_LABEL[b.status] || b.status}</span><b>${h(b.name)}</b><div>${h(b.detail || '')} ${refChips((b.evidence || []).filter(r => app.evidenceIndex.has(r)))}</div><div class="rule">规则：${h(b.rule || '')}</div>${b.note ? `<div class="rule">${h(b.note)}</div>` : ''}</div>`).join('')
  }</div></section>`;
}

function renderExPost(rv, pack) {
  const p = rv.ex_post || {};
  const li = (arr, f) => (arr?.length ? `<ul>${arr.map(f).join('')}</ul>` : '<p class="muted small">无</p>');
  const verdictTag = v => `<span class="tag ${v === '成立' ? 'fact' : v === '不成立' ? 'warn' : 'unc'}">${h(v)}</span>`;
  return `<section class="post"><h3>C. 事后检验与归因 <span class="gen">${genLabel(rv.stage2 || rv)}</span></h3>
    <b class="small">假设检验</b>${li(p.hypothesis_check, x => `<li>${verdictTag(x.verdict)}${supportTag(x)}<b>${h(x.hypothesis)}</b>：${h(x.text || '')} ${claimTail(x)}${x.support_notes?.length && x.support !== 'pass' ? `<div class="small muted">${h(x.support_notes.join('；'))}</div>` : ''}</li>`)}
    <b class="small">归因</b>${li(p.attribution, x => `<li><span class="tag unc">${h(x.factor)}</span><span class="tag ${x.confidence === '高' ? 'fact' : x.confidence === '中' ? 'inference' : 'unc'}">置信度 ${h(x.confidence)}</span>${supportTag(x)}${h(x.text)} ${claimTail(x)}${x.unreferenced ? '<span class="tag warn">无相关证据</span>' : ''}</li>`)}
    <b class="small">不确定因素</b>${li(p.uncertainties, x => `<li><span class="tag unc">不确定</span>${h(x.text)}</li>`)}
    <b class="small">可复用的经验</b>${li(p.lessons, (x, i) => `<li>${h(x.text)}${x.trigger ? `<div class="small muted">何时提醒：${h(x.trigger)}</div>` : ''} <button class="btn ghost small" data-add-lesson="${i}">加入清单</button></li>`)}
    <div style="margin-top:8px"><button class="btn primary" data-add-lesson="all">把本次经验和触发的偏差全部加入清单</button></div>
  </section>`;
}

function renderValidation(rv) {
  const reps = [rv.stage1?.report, rv.stage2?.report].filter(Boolean);
  if (!reps.length) return `<div class="validation">本次为规则引擎生成，数字直接来自证据；结论同样经过证据相关性校验并标注支撑程度。<div class="small muted">${h(SUPPORT_NOTE)}</div></div>`;
  const sum = k => reps.reduce((s, r) => s + (Array.isArray(r[k]) ? r[k].length : r[k] || 0), 0);
  const list = (k, f) => reps.flatMap(r => r[k] || []).map(f).map(x => `<li>${h(x)}</li>`).join('');
  const sup = k => reps.reduce((s, r) => s + (r.support?.[k] || 0), 0);
  return `<div class="validation"><b>AI 输出校验</b>：共 ${sum('total')} 条结论，${sum('passed')} 条保留；
    移除 ${sum('removed')} 条（后见之明），隐藏 ${sum('hidden')} 条（与记录矛盾或失去全部证据），降级 ${sum('downgraded')} 条，移除不相关引用 ${sum('irrelevant_refs')} 条，合规过滤 ${sum('compliance')} 句，数字未能溯源 ${sum('untraced_numbers')} 处。
    <div>核心结论：结构化校验通过 ${sup('pass')} 条 · 证据有限 ${sup('limited')} 条 · 无法判断 ${sup('undetermined')} 条</div>
    <div class="small muted">${h(SUPPORT_NOTE)}</div>
    ${sum('removed') + sum('downgraded') + sum('compliance') + sum('untraced_numbers') + sum('hidden') + sum('irrelevant_refs') ? `<details><summary>查看明细</summary><ul>
      ${list('removed', x => `移除：${x.text}（${x.reason}）`)}${list('hidden', x => `隐藏：${x.text}（${x.reason}）`)}${list('downgraded', x => `降级：${x.text}（${x.reason}）`)}${list('irrelevant_refs', x => `不相关引用 ${x.ref}：${x.reason}`)}
      ${list('compliance', x => `合规过滤（${x.label}）：${x.sentence}`)}${list('untraced_numbers', x => `数字未溯源：${x.number} — ${x.text}`)}</ul></details>` : ''}
    <div class="small muted" style="margin-top:4px">耗时 ${[rv.stage1?.latency_ms, rv.stage2?.latency_ms].filter(Boolean).map(v => (v / 1000).toFixed(1) + 's').join(' + ')}${rv.stage2?.usage ? ` · tokens ${(rv.stage1?.usage?.total_tokens || 0) + (rv.stage2?.usage?.total_tokens || 0)}` : ''}</div></div>`;
}

async function generateReview(id, quiet = false) {
  const pack = buildPack(app.result, id);
  if (!pack) return;
  const out = $('#reviewOut');
  if (!quiet) out.innerHTML = `${tradeHeader(pack)}<p><span class="spinner"></span> 第 1 步：AI 只看决策当时的信息…</p>`;
  const rv = { trade_id: id, created_at: new Date().toISOString() };
  const s1 = await callReview('ex_ante', pack, null);
  let exAnte;
  if (s1.ok) { exAnte = s1.data; rv.stage1 = { generator: 'ai', model: s1.model, report: s1.report, latency_ms: s1.latency_ms, usage: s1.usage }; }
  else { const v = validateAIOutput('ex_ante', ruleBasedReview(pack).ex_ante, pack.evidence); exAnte = v.data; rv.stage1 = { generator: 'rules', ai_error: s1.message, rules_report: v.report }; }
  if (!quiet) out.innerHTML = `${tradeHeader(pack)}<p><span class="spinner"></span> 第 2 步：对照事后信息检验假设、做归因…</p>`;
  const s2 = await callReview('ex_post', pack, exAnte);
  let exPost;
  if (s2.ok) { exPost = s2.data; rv.stage2 = { generator: 'ai', model: s2.model, report: s2.report, latency_ms: s2.latency_ms, usage: s2.usage }; }
  else { const v = validateAIOutput('ex_post', ruleBasedReview(pack).ex_post, pack.evidence); exPost = v.data; rv.stage2 = { generator: 'rules', ai_error: s2.message, rules_report: v.report }; }
  rv.ex_ante = exAnte; rv.ex_post = exPost;
  rv.generator = rv.stage1.generator === 'ai' && rv.stage2.generator === 'ai' ? 'ai' : 'rules';
  rv.model = s2.model || s1.model; rv.ai_error = s2.message || s1.message;
  rv.biases = pack.biases;
  app.reviews[id] = rv;
  store.set('rl.reviews', app.reviews);
  const opt = $(`#tradeSelect option[value="${id}"]`); if (opt && !opt.textContent.endsWith('✓')) opt.textContent += ' ✓';
  if (!quiet || app.selected === id) renderReviewFor(id);
}

async function reviewAll() {
  const btn = $('#btnReviewAll'); btn.disabled = true;
  const ids = app.result.trades.map(t => t.id);
  for (let k = 0; k < ids.length; k++) {
    btn.textContent = `复盘中 ${k + 1}/${ids.length}…`;
    if (!app.reviews[ids[k]]) await generateReview(ids[k], true);
  }
  btn.textContent = '复盘全部'; btn.disabled = false;
  renderReviewFor($('#tradeSelect').value);
}

function addLessons(id, idx) {
  const rv = app.reviews[id];
  if (!rv) return;
  const t = app.result.trades.find(x => x.id === id);
  const ref = `${t.date} ${sideText(t.side)} ${t.name || t.thscode}`;
  let items;
  if (idx == null) items = lessonsToChecklist({ ...rv, generator: rv.stage2?.generator }, rv.biases, ref);
  else items = lessonsToChecklist({ ex_post: { lessons: [rv.ex_post.lessons[idx]] }, generator: rv.stage2?.generator }, [], ref);
  app.checklist = mergeChecklist(app.checklist, items);
  store.set('rl.checklist', app.checklist);
  toast(`已加入清单（共 ${app.checklist.length} 条）`);
}

function toast(text) {
  const d = document.createElement('div');
  d.textContent = text;
  Object.assign(d.style, { position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)', background: 'var(--text)', color: 'var(--bg)', padding: '8px 16px', borderRadius: '8px', zIndex: 60, fontSize: '13px' });
  document.body.appendChild(d); setTimeout(() => d.remove(), 2200);
}

// ---------- ④ 清单 ----------
function renderChecklist() {
  const ul = $('#checklistList');
  if (!app.checklist.length) { ul.innerHTML = '<li class="muted">清单是空的。在“复盘报告”里生成复盘后，点击“加入清单”。</li>'; return; }
  ul.innerHTML = app.checklist.map(i => `<li><div><div>${h(i.text)}</div>
    <div class="meta">${i.source === 'ai' ? '<span class="tag inference">AI 提炼</span>' : '<span class="tag rule">规则</span>'}${i.check?.type && i.check.type !== 'manual' ? '<span class="tag fact">自动检查</span>' : '<span class="tag unc">人工对照</span>'}
    来自 ${i.hits} 笔交易：${h((i.trade_refs || []).join('、'))}${i.trigger ? ` · 何时提醒：${h(i.trigger)}` : ''}</div></div>
    <button class="btn ghost danger small" data-rm="${i.id}">删除</button></li>`).join('');
  ul.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { app.checklist = app.checklist.filter(x => x.id !== b.dataset.rm); store.set('rl.checklist', app.checklist); renderChecklist(); });
}

function exportMarkdown() {
  const lines = ['# 我的投资决策清单', '', `导出时间：${new Date().toLocaleString('zh-CN')}`, '', DISCLAIMER, ''];
  app.checklist.forEach((i, k) => lines.push(`${k + 1}. ${i.text}`, `   - 来源：${i.source === 'ai' ? 'AI 提炼' : '规则'}；出现 ${i.hits} 次（${(i.trade_refs || []).join('、')}）${i.trigger ? `\n   - 何时提醒：${i.trigger}` : ''}`));
  download('决策清单.md', lines.join('\n'), 'text/markdown');
}

// ---------- ⑤ 决策前检查 ----------
async function precheck(form) {
  const out = $('#precheckOut');
  const q = form.q.value.trim();
  out.innerHTML = '<p><span class="spinner"></span> 获取最新行情…</p>';
  let code = q.toUpperCase(), name = '';
  if (!THSCODE_RE.test(code)) {
    const found = await searchTicker(q);
    if (!found.length) { out.innerHTML = msgBox('error', `没有找到“${q}”。请输入完整代码（如 600519.SH），或检查“数据状态”里检索接口是否可用。`); return; }
    code = found[0].thscode; name = found[0].name;
  } else name = app.trades.find(t => t.thscode === code)?.name || '';
  const end = todayShanghai(), start = addDays(end, -150);
  const [bars, bench, evs] = await Promise.all([fetchBars(code, start, end, 'forward'), fetchIndexBars(BENCHMARK.thscode, start, end), fetchEvents(code, addDays(end, -30), end)]);
  const plan = { thscode: code, side: form.side.value === '买入' ? 'buy' : 'sell', reason: form.reason.value, exit_plan: form.exit_plan.value };
  const { metrics, as_of } = currentMetrics(bars.bars, bench.bars);
  const res = evaluateChecklist(app.checklist, plan, metrics);
  const stale = as_of && as_of < addDays(end, -5);
  const hist = app.result ? similarHistory(app.result.contexts, app.result.biasesByTrade, 'chase') : null;
  const past = app.result ? app.result.contexts.filter(c => c.trade.thscode === code) : [];
  const statusTxt = { hit: '需要注意', pass: '已满足', manual: '请自己对照', unknown: '无法自动判断' };
  out.innerHTML = `
    <h3>${h(name || code)} ${code} · 当前状态（截至 ${as_of || '—'} 收盘）</h3>
    ${!bars.bars.length ? msgBox('error', `行情获取失败：${bars.meta.message}。以下依赖行情的检查项无法判断。`) : ''}
    ${stale ? msgBox('warn', `最新行情日期为 ${as_of}，距今超过 5 天，可能停牌或数据过期。`) : ''}
    ${bars.meta.mode === 'snapshot' ? msgBox('warn', '行情来自离线快照，不是最新数据。') : ''}
    <div class="stats">${[['近20日涨跌', metrics.pre_ret_20], ['近60日涨跌', metrics.pre_ret_60], ['距60日高点', metrics.pre_dist_high_60], ['20日年化波动', metrics.pre_vol_20, 'plain'], ['量比(5/60)', metrics.pre_vol_ratio, 'x'], ['沪深300近20日', metrics.bench_pre_ret_20]]
      .map(([k, v, u]) => `<div class="stat"><div class="k">${k}</div><div class="v ${u ? '' : cls(v)}">${u === 'x' ? (v ?? '—') : u === 'plain' ? (v == null ? '—' : (v * 100).toFixed(2) + '%') : pct(v)}</div></div>`).join('')}</div>
    <h3>逐条对照我的清单</h3>
    ${app.checklist.length ? `<ul class="check-res">${res.map(r => `<li class="${r.status}"><b>${statusTxt[r.status]}</b> · ${h(r.item.text)}<div class="why">${h(r.why)}</div></li>`).join('')}</ul>` : '<p class="muted">清单是空的，先去复盘几笔交易。</p>'}
    ${hist && hist.n ? `<h3>历史上的相似情形（纯历史统计，不代表未来）</h3><p>你过去有 ${hist.n} 笔买入触发了“追涨”信号${hist.n_with_outcome ? `，其中 ${hist.n_with_outcome} 笔事后 20 个交易日相对沪深300的平均超额为 <b class="${cls(hist.avg_excess_20)}">${pct(hist.avg_excess_20)}</b>` : ''}。样本很少，只用来提醒自己，不能作为判断依据。</p>` : ''}
    ${past.length ? `<h3>你在这只股票上的历史决策</h3><ul>${past.map(c => `<li>${c.trade.aligned_date} ${sideText(c.trade.side)}：${h(c.trade.reason || '未填理由')}${app.reviews[c.trade.id] ? ' <span class="tag fact">已复盘</span>' : ''}</li>`).join('')}</ul>` : ''}
    <h3>近 30 天异动事件</h3>
    ${evs.meta.ok ? (evs.events.length ? `<ul>${evs.events.slice(-6).reverse().map(e => `<li><span class="muted">${e.date}</span> ${h(e.tag)}：${h(e.content.slice(0, 100))}</li>`).join('')}</ul>` : '<p class="muted small">接口返回为空（空列表也可能是服务降级，不代表没有事件）。</p>') : msgBox('warn', `事件获取失败：${evs.meta.message}`)}
    <div class="msg info">${DISCLAIMER} 是否交易由你自己决定。</div>
    <button class="btn" id="btnSavePlan">把这次决策记到交易记录里（成交后补价格）</button>`;
  $('#btnSavePlan').onclick = () => {
    const n = normalizeTrade({ date: end, thscode: code, name, side: form.side.value, price: '', qty: 100, reason: form.reason.value, exit_plan: form.exit_plan.value }, app.trades.length);
    if (n.errors.length) { toast(n.errors[0]); return; }
    setTrades([...app.trades, { ...n.trade, id: `p${Date.now().toString(36)}` }]);
    toast('已记入交易记录，数量默认 100 股，请到“交易记录”修改');
  };
}

// ---------- 数据状态 ----------
async function refreshHealth() {
  app.health = await health();
  const hb = app.health;
  const db = $('#dataBadge'), ab = $('#aiBadge');
  if (!hb) { db.className = 'badge warn'; db.textContent = '数据：后端不可用，仅离线快照'; ab.className = 'badge warn'; ab.textContent = 'AI：不可用，规则兜底'; ds.mode = 'snapshot'; $('#modeSelect').value = 'snapshot'; return; }
  db.className = `badge ${hb.fuyao_key ? 'ok' : 'warn'}`; db.textContent = hb.fuyao_key ? '数据：扶摇实时' : '数据：未配置 Key，用离线快照';
  ab.className = `badge ${hb.deepseek_key ? 'ok' : 'warn'}`; ab.textContent = hb.deepseek_key ? `AI：${hb.model}` : 'AI：未配置，规则兜底';
}

function renderStatus() {
  const hb = app.health;
  const snap = ds.snapshot;
  $('#healthBox').innerHTML = `<div class="msg info">后端：${hb ? '在线' : '不可用'} · 扶摇 Key：${hb?.fuyao_key ? '已配置' : '未配置'} · DeepSeek Key：${hb?.deepseek_key ? '已配置' : '未配置'} · 离线快照：${snap?.generated_at ? `生成于 ${h(snap.generated_at)}，${Object.keys(snap.entries || {}).length} 组数据` : '尚未加载或不存在'}</div>`;
  const rows = ds.callLog;
  $('#logTable').innerHTML = rows.length ? `<thead><tr><th>数据</th><th>接口</th><th>状态</th><th>说明</th><th>request_id</th><th>获取时间</th><th class="num">条数</th><th>最新日期</th><th class="num">耗时</th></tr></thead><tbody>${
    rows.map(c => `<tr><td>${h(c.label)}</td><td class="small">${h(c.api)}</td>
      <td>${c.mode === 'live' ? '<span class="tag fact">实时</span>' : c.mode === 'snapshot' ? '<span class="tag inference">离线快照</span>' : '<span class="tag warn">失败</span>'}</td>
      <td class="small">${h(c.mode === 'snapshot' ? `实时失败：${c.fallback_reason || ''}` : c.ok ? '成功' : c.message)}</td><td class="small">${h(c.request_id || '—')}</td>
      <td class="small">${h(c.fetched_at || '—')}</td><td class="num">${c.count ?? '—'}</td><td>${h(c.as_of || '—')}</td><td class="num">${c.latency_ms ?? '—'}ms</td></tr>`).join('')
  }</tbody>` : '<tr><td class="muted">还没有数据调用。</td></tr>';
}

// ---------- 初始化 ----------
function init() {
  $('#disclaimer').textContent = DISCLAIMER;
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => switchTab(t.dataset.tab));
  $('#btnSample').onclick = loadSample;
  $('#fileCsv').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    const r = parseTradesCSV(await f.text());
    setTrades(r.trades, r);
    e.target.value = '';
  };
  $('#btnTemplate').onclick = () => download('交易记录模板.csv', CSV_HEADERS.join(',') + '\n2026-01-12,10:15,300033.SZ,同花顺,买入,,200,AI应用是主线，怕踏空,AI板块热度继续；一季度业绩改善,止损-8%,4\n', 'text/csv');
  $('#btnExport').onclick = () => download('我的交易记录.csv', toCSV(app.trades), 'text/csv');
  $('#btnClear').onclick = () => { if (confirm('确定清空所有交易记录？')) { setTrades([]); app.result = null; app.reviews = {}; store.set('rl.reviews', {}); } };
  $('#addForm').onsubmit = e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const n = normalizeTrade(f, app.trades.length);
    if (n.errors.length) { $('#importMsgs').innerHTML = msgBox('error', '无法添加：', n.errors); return; }
    setTrades([...app.trades, { ...n.trade, id: `m${Date.now().toString(36)}` }], { errors: [], warnings: n.warnings });
    e.target.reset();
  };
  $('#btnRun').onclick = runAnalysis;
  $('#btnGoReview').onclick = () => { switchTab('report'); $('#tradeSelect').value = app.selected; renderReviewFor(app.selected); };
  $('#btnReview').onclick = () => generateReview($('#tradeSelect').value);
  $('#btnReviewAll').onclick = reviewAll;
  $('#btnExportMd').onclick = exportMarkdown;
  $('#btnClearList').onclick = () => { if (confirm('确定清空清单？')) { app.checklist = []; store.set('rl.checklist', []); renderChecklist(); } };
  $('#precheckForm').onsubmit = e => { e.preventDefault(); precheck(e.target); };
  $('#modeSelect').onchange = e => { ds.mode = e.target.value; };
  $('#btnSnapshot').onclick = () => {
    const snap = exportSnapshot();
    const n = Object.keys(snap.entries).length;
    if (!n) { toast('本次没有实时获取的数据可导出（请先在实时模式下完成一次复盘）'); return; }
    download('snapshot.json', JSON.stringify(snap), 'application/json');
    toast(`已导出 ${n} 组原始响应`);
  };
  document.querySelectorAll('.drill input').forEach(cb => cb.onchange = () => { cb.checked ? ds.simulate.add(cb.value) : ds.simulate.delete(cb.value); });
  $('#drawerClose').onclick = () => { $('#drawer').hidden = true; };
  $('#drawer').onclick = e => { if (e.target.id === 'drawer') $('#drawer').hidden = true; };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#drawer').hidden = true; });

  app.checklist = store.get('rl.checklist', []);
  app.reviews = store.get('rl.reviews', {});
  const saved = store.get('rl.trades', null);
  if (saved?.length) setTrades(saved); else loadSample();
  refreshHealth();
  // 便于端到端测试
  window.__app = app;
}
init();
