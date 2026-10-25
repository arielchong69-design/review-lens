import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDate, msToDate, dateToMs, parseUpstreamTime } from '../public/js/core/dates.js';
import { parseTradesCSV, matchFIFO, extractStopLossPct, detectHorizon, toCSV } from '../public/js/core/trades.js';
import { buildTradeContext, normalizeBars, normalizeEvents } from '../public/js/core/context.js';
import { analyze, buildPack } from '../public/js/core/engine.js';
import { filterCompliance } from '../public/js/core/compliance.js';
import { validateAIOutput, ruleBasedReview, safeParseJSON } from '../public/js/core/review.js';
import { evaluateChecklist, lessonsToChecklist, mergeChecklist } from '../public/js/core/checklist.js';
import { makeBars, makeEvents } from './fixtures.mjs';

const BENCH = (opts = {}) => ({ thscode: '000300.SH', name: '沪深300', bars: normalizeBars(makeBars({ start: '2024-06-01', end: '2025-06-30', startPrice: 3500, seed: 9, vol: 0.008, ...opts })), meta: { ok: true, mode: 'live', request_id: 'bench-req' } });

function market(code, barOpts, events = []) {
  const items = makeBars({ start: '2024-06-01', end: '2025-06-30', ...barOpts });
  const bars = normalizeBars(items);
  return { thscode: code, adj: bars, raw: bars, adjMeta: { ok: true, mode: 'live', request_id: 'adj-req' }, rawMeta: { ok: true, mode: 'live', request_id: 'raw-req' }, events: normalizeEvents(makeEvents(events), { request_id: 'ev-req', mode: 'live' }), eventsMeta: { ok: true, mode: 'live' } };
}

// ---------- 日期 ----------
test('日期：多种格式规范化，非法日期返回 null', () => {
  assert.equal(normalizeDate('2025/3/8'), '2025-03-08');
  assert.equal(normalizeDate('20250308'), '2025-03-08');
  assert.equal(normalizeDate('2025-02-30'), null);
  assert.equal(normalizeDate('abc'), null);
});
test('日期：上海时区 00:00 毫秒戳往返一致', () => {
  assert.equal(msToDate(dateToMs('2025-01-06')), '2025-01-06');
  assert.equal(msToDate(1716134400000), '2024-05-20'); // 文档示例
});
test('日期：上游时间单位推断（毫秒 / 秒 / 字符串）', () => {
  assert.equal(parseUpstreamTime(1716134400000).unit, 'ms');
  assert.equal(parseUpstreamTime(1716134400).ms, 1716134400000);
  assert.equal(parseUpstreamTime('2025-01-06 10:30:00').unit, 'datetime');
  assert.equal(parseUpstreamTime(null).ms, null);
});

// ---------- 交易解析 ----------
test('CSV：引号内逗号、缺价警告、非法代码报错', () => {
  const csv = '日期,时间,代码,名称,方向,价格,数量,当时理由,关键假设,退出计划,信心\n2025-01-06,,600519.SH,贵州茅台,买入,,100,"估值低，高股息",,止损-8%,4\n2025-01-07,,600519,茅台,买入,1500,100,,,,';
  const r = parseTradesCSV(csv);
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].reason, '估值低，高股息');
  assert.ok(r.warnings.some(w => w.includes('未填成交价')));
  assert.ok(r.errors.some(e => e.includes('thscode')));
});
test('CSV：缺少必需表头时给出模板提示', () => {
  const r = parseTradesCSV('a,b\n1,2');
  assert.equal(r.trades.length, 0);
  assert.match(r.errors[0], /缺少表头/);
});
test('CSV：导出再导入保持一致', () => {
  const r = parseTradesCSV('日期,代码,方向,数量,价格,当时理由\n2025-01-06,600519.SH,买入,100,1500,"含""引号"",和逗号"');
  const again = parseTradesCSV(toCSV(r.trades));
  assert.deepEqual(again.trades[0].reason, r.trades[0].reason);
});
test('FIFO：部分卖出、超卖识别', () => {
  const trades = [
    { id: 'a', date: '2025-01-02', thscode: '600000.SH', side: 'buy', qty: 100, price: 10 },
    { id: 'b', date: '2025-01-03', thscode: '600000.SH', side: 'buy', qty: 100, price: 12 },
    { id: 'c', date: '2025-01-10', thscode: '600000.SH', side: 'sell', qty: 150, price: 11 },
    { id: 'd', date: '2025-01-11', thscode: '600000.SH', side: 'sell', qty: 100, price: 13 },
  ];
  const { roundTrips, openLots, issues } = matchFIFO(trades);
  assert.equal(roundTrips.length, 3);
  assert.equal(roundTrips[0].pnl, 100); // (11-10)*100
  assert.equal(roundTrips[1].pnl, -50); // (11-12)*50
  assert.equal(openLots.length, 0);
  assert.equal(issues[0].type, 'oversell');
});
test('文本抽取：止损比例与持有周期意图', () => {
  assert.equal(extractStopLossPct('跌破止损-8%离场'), 0.08);
  assert.equal(extractStopLossPct('回撤10%就止损'), 0.1);
  assert.equal(extractStopLossPct('没有计划'), null);
  assert.equal(detectHorizon('打算长期持有'), 'long');
  assert.equal(detectHorizon('短线博反弹'), 'short');
});

// ---------- 时间线与后见之明隔离 ----------
test('事前指标只依赖 T-1 及之前的数据：篡改未来行情不改变事前证据', () => {
  const t = { id: 't1', date: '2025-03-03', thscode: '600000.SH', side: 'buy', qty: 100, price: null, reason: '测试' };
  const m1 = market('600000.SH', { seed: 3 });
  const m2 = structuredClone(m1);
  for (const b of m2.adj) if (b.date > '2025-03-03') { b.close *= 3; b.high *= 3; b.low *= 3; }
  const c1 = buildTradeContext(t, m1, BENCH()), c2 = buildTradeContext(t, m2, BENCH());
  const pre = c => c.evidence.filter(e => e.phase === 'ex_ante').map(e => [e.id, e.value]);
  assert.deepEqual(pre(c1), pre(c2));
  assert.notDeepEqual(c1.metrics.post_ret_20, c2.metrics.post_ret_20);
  // 每条事前证据的时点都早于交易日
  for (const e of c1.evidence.filter(e => e.phase === 'ex_ante' && !e.id.includes('-ev-'))) assert.ok(e.as_of < '2025-03-03', e.id);
});
test('事件按首次可见时间分到事前 / 同日不确定 / 事后', () => {
  const m = market('600000.SH', { seed: 4 }, [
    { date: '2025-02-20', text: '事前事件' },
    { date: '2025-03-03', time: '09:40', text: '同日早盘事件' },
    { date: '2025-03-03', time: '14:30', text: '同日午后事件' },
    { date: '2025-03-10', text: '事后事件' },
  ]);
  const noTime = buildTradeContext({ id: 'x', date: '2025-03-03', thscode: '600000.SH', side: 'buy', qty: 1, price: null }, m, BENCH());
  assert.equal(noTime.events.pre.length, 1);
  assert.equal(noTime.events.same.length, 2);
  assert.equal(noTime.events.post.length, 1);
  const withTime = buildTradeContext({ id: 'y', date: '2025-03-03', time: '10:00', thscode: '600000.SH', side: 'buy', qty: 1, price: null }, m, BENCH());
  assert.equal(withTime.events.pre.length, 2);
  assert.equal(withTime.events.post.length, 2);
  assert.equal(withTime.events.same.length, 0);
});

// ---------- 数据冲突与缺失 ----------
test('成交价超出当日价格区间 → PRICE_CONFLICT', () => {
  const m = market('600000.SH', { seed: 5, startPrice: 10 });
  const c = buildTradeContext({ id: 'p', date: '2025-03-03', thscode: '600000.SH', side: 'buy', qty: 1, price: 999 }, m, BENCH());
  assert.ok(c.checks.some(x => x.code === 'PRICE_CONFLICT'));
});
test('非交易日 → 对齐到下一交易日并提示', () => {
  const m = market('600000.SH', { seed: 5 });
  const c = buildTradeContext({ id: 'w', date: '2025-03-01', thscode: '600000.SH', side: 'buy', qty: 1, price: null }, m, BENCH());
  assert.equal(c.trade.aligned_date, '2025-03-03');
  assert.ok(c.checks.some(x => x.code === 'NON_TRADING_DAY'));
  assert.ok(c.checks.some(x => x.code === 'PRICE_ASSUMED'));
});
test('行情完全缺失 → 不生成任何价格结论', () => {
  const md = { thscode: '600000.SH', adj: [], raw: [], adjMeta: { ok: false, message: '数据源不可用（code=5003）' }, rawMeta: { ok: false }, events: [], eventsMeta: { ok: false } };
  const c = buildTradeContext({ id: 'n', date: '2025-03-03', thscode: '600000.SH', side: 'buy', qty: 1, price: 10 }, md, BENCH());
  assert.equal(c.ok, false);
  assert.ok(c.checks.some(x => x.code === 'NO_PRICE_DATA' && x.msg.includes('5003')));
  assert.equal(c.evidence.length, 0);
});
test('基准缺失 → 超额收益为空并提示，不静默给出', () => {
  const m = market('600000.SH', { seed: 6 });
  const c = buildTradeContext({ id: 'b', date: '2025-03-03', thscode: '600000.SH', side: 'buy', qty: 1, price: null }, m, { thscode: '000300.SH', bars: [], meta: { ok: false, message: 'code=5003' } });
  assert.equal(c.metrics.post_excess_20, null);
  assert.ok(c.checks.some(x => x.code === 'BENCH_MISSING'));
});
test('事件接口返回空 → 提示“空列表不代表没有事件”', () => {
  const m = market('600000.SH', { seed: 6 });
  const c = buildTradeContext({ id: 'e', date: '2025-03-03', thscode: '600000.SH', side: 'buy', qty: 1, price: null }, m, BENCH());
  assert.ok(c.checks.some(x => x.code === 'EVENTS_EMPTY'));
});
test('窗口未走完 → 事后指标为空并注明行情截止日', () => {
  const m = market('600000.SH', { seed: 6 });
  const c = buildTradeContext({ id: 'late', date: '2025-06-20', thscode: '600000.SH', side: 'buy', qty: 1, price: null }, m, BENCH());
  assert.equal(c.metrics.post_ret_60, null);
  assert.match(c.evidence.find(e => e.id === 'E-late-post_ret_60').calc, /尚未走完/);
});

// ---------- 偏差规则 ----------
test('买前大涨 → 追涨触发；卖出当日大跌且理由含情绪词 → 情绪化卖出触发', () => {
  const m = market('600000.SH', { seed: 7, drift: d => (d >= '2025-02-01' && d < '2025-03-03' ? 0.012 : d === '2025-04-07' ? -0.08 : 0) });
  const trades = [
    { id: 'b1', date: '2025-03-03', thscode: '600000.SH', side: 'buy', qty: 100, price: null, reason: 'AI 行情起来了，赶紧上车', hypotheses: '', exit_plan: '' },
    { id: 's1', date: '2025-04-07', thscode: '600000.SH', side: 'sell', qty: 100, price: null, reason: '大跌太恐慌了，先跑', hypotheses: '', exit_plan: '' },
  ];
  const r = analyze(trades, { byCode: { '600000.SH': m }, bench: BENCH() });
  const chase = r.biasesByTrade.b1.find(b => b.id === 'chase');
  assert.equal(chase.status, 'triggered');
  assert.equal(r.biasesByTrade.b1.find(b => b.id === 'no_exit_plan').status, 'triggered');
  assert.equal(r.biasesByTrade.s1.find(b => b.id === 'panic_sell').status, 'triggered');
  assert.equal(r.roundTrips.length, 1);
  assert.ok(['过程差 · 结果好', '过程差 · 结果差'].includes(r.roundTrips[0].process.quadrant));
});
test('止损线被击穿仍持有 → 止损未执行；“长期”却很快卖出 → 计划漂移', () => {
  const m = market('600000.SH', { seed: 8, drift: d => (d >= '2025-03-04' && d < '2025-03-14' ? -0.02 : 0) });
  const trades = [
    { id: 'b', date: '2025-03-03', thscode: '600000.SH', side: 'buy', qty: 100, price: null, reason: '长期持有，止损-5%', hypotheses: '', exit_plan: '' },
    { id: 's', date: '2025-03-20', thscode: '600000.SH', side: 'sell', qty: 100, price: null, reason: '', hypotheses: '', exit_plan: '' },
  ];
  const r = analyze(trades, { byCode: { '600000.SH': m }, bench: BENCH() });
  const rt = r.roundTrips[0];
  assert.equal(rt.biases.find(b => b.id === 'stop_breach').status, 'triggered');
  assert.equal(rt.biases.find(b => b.id === 'plan_drift').status, 'triggered');
});
test('样本不足时处置效应标为“数据不足”而不是“未触发”', () => {
  const r = analyze([{ id: 'b', date: '2025-03-03', thscode: '600000.SH', side: 'buy', qty: 1, price: null }], { byCode: { '600000.SH': market('600000.SH', { seed: 1 }) }, bench: BENCH() });
  assert.equal(r.portfolio[0].status, 'insufficient');
});

// ---------- 合规 ----------
test('合规过滤：买卖建议、目标价、确定性预测、收益承诺', () => {
  for (const s of ['建议买入该股。', '目标价 50 元。', '该股必将上涨。', '下周会涨。', '稳赚不赔。', '应该加仓。']) {
    const r = filterCompliance(s);
    assert.equal(r.hits.length, 1, s);
    assert.match(r.text, /已过滤/);
  }
  assert.equal(filterCompliance('买入前20日涨幅为 +18.20%，属于追涨。').hits.length, 0);
  assert.equal(filterCompliance('下次买入前先写下止损条件。').hits.length, 0);
});

// ---------- AI 输出校验 ----------
const EVID = [
  { id: 'E-t1-pre_ret_20', phase: 'ex_ante', display: '+18.20%' },
  { id: 'E-t1-post_ret_20', phase: 'ex_post', display: '-9.10%' },
];
test('AI 校验：事前段落引用事后证据 → 移除（后见之明）', () => {
  const { data, report } = validateAIOutput('ex_ante', { reason_assessment: [{ text: '买前涨了 18.20%', type: 'fact', refs: ['E-t1-pre_ret_20'] }, { text: '买入后跌了 9.10%', type: 'fact', refs: ['E-t1-post_ret_20'] }] }, EVID);
  assert.equal(data.reason_assessment.length, 1);
  assert.equal(report.removed.length, 1);
});
test('AI 校验：事前段落出现“后来/最终”等措辞 → 移除', () => {
  const { report } = validateAIOutput('ex_ante', { visible_risks: [{ text: '最终证明估值陷阱', type: 'inference', refs: [] }] }, EVID);
  assert.equal(report.removed.length, 1);
});
test('AI 校验：标为事实却没有有效引用 → 降级为推断；编造引用被剔除', () => {
  const { data, report } = validateAIOutput('ex_ante', { reason_assessment: [{ text: '成交量放大', type: 'fact', refs: ['E-fake'] }] }, EVID);
  assert.equal(data.reason_assessment[0].type, 'inference');
  assert.deepEqual(data.reason_assessment[0].invalid_refs, ['E-fake']);
  assert.equal(report.downgraded.length, 1);
});
test('AI 校验：无法溯源的数字被标记', () => {
  const { report } = validateAIOutput('ex_post', { attribution: [{ factor: '市场环境', text: '大盘下跌 33.3%', confidence: '高', refs: ['E-t1-post_ret_20'] }] }, EVID);
  assert.equal(report.untraced_numbers.length, 1);
});
test('AI 校验：经验中的买卖建议被合规过滤', () => {
  const { data, report } = validateAIOutput('ex_post', { lessons: [{ text: '建议买入银行股。', trigger: '', refs: [] }] }, EVID);
  assert.match(data.lessons[0].text, /已过滤/);
  assert.equal(report.compliance.length, 1);
});
test('AI 校验：枚举值非法时规范化', () => {
  const { data } = validateAIOutput('ex_post', { hypothesis_check: [{ hypothesis: 'h', verdict: '大概成立', text: 'x', refs: ['E-t1-post_ret_20'] }], attribution: [{ factor: 'x', text: 'y', confidence: '很高', refs: ['E-t1-post_ret_20'] }] }, EVID);
  assert.equal(data.hypothesis_check[0].verdict, '无法判断');
  assert.equal(data.attribution[0].confidence, '低');
});
test('JSON 容错解析：代码块包裹、前后多余文字', () => {
  assert.deepEqual(safeParseJSON('好的：```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(safeParseJSON('not json'), null);
});

// ---------- 规则兜底与清单 ----------
test('规则兜底复盘：结构完整、引用均存在、无合规问题', () => {
  const m = market('600000.SH', { seed: 7, drift: d => (d >= '2025-02-01' && d < '2025-03-03' ? 0.012 : 0) });
  const r = analyze([{ id: 'b1', date: '2025-03-03', thscode: '600000.SH', side: 'buy', qty: 100, price: null, reason: '追', hypotheses: 'AI催化持续；业绩改善', exit_plan: '' }], { byCode: { '600000.SH': m }, bench: BENCH() });
  const pack = buildPack(r, 'b1');
  const rv = ruleBasedReview(pack);
  const ids = new Set(pack.evidence.map(e => e.id));
  for (const sec of [rv.ex_ante, rv.ex_post]) for (const arr of Object.values(sec)) for (const it of arr) for (const ref of it.refs || []) assert.ok(ids.has(ref), ref);
  assert.equal(rv.ex_ante.hypotheses.length, 2);
  assert.ok(rv.ex_post.lessons.length >= 1);
  assert.equal(JSON.stringify(rv).includes('已过滤'), false);
});
test('清单：合并去重计数，下次决策前自动检查', () => {
  const biases = [{ id: 'chase', name: '追涨买入', status: 'triggered', evidence: [] }, { id: 'no_exit_plan', name: '缺少退出计划', status: 'triggered', evidence: [] }];
  let list = mergeChecklist([], lessonsToChecklist(null, biases, 't1'));
  list = mergeChecklist(list, lessonsToChecklist(null, [biases[0]], 't2'));
  assert.equal(list.find(i => i.key === 'bias:chase').hits, 2);
  const res = evaluateChecklist(list, { reason: '突破买入', exit_plan: '' }, { pre_ret_20: 0.2 });
  assert.equal(res.find(r => r.item.key === 'bias:chase').status, 'hit');
  assert.equal(res.find(r => r.item.key === 'bias:no_exit_plan').status, 'hit');
  const res2 = evaluateChecklist(list, { reason: '突破买入', exit_plan: '止损-8%' }, { pre_ret_20: 0.02, pre_dist_high_60: -0.2, pre_vol_ratio: 1 });
  assert.equal(res2.find(r => r.item.key === 'bias:chase').status, 'pass');
  assert.equal(res2.find(r => r.item.key === 'bias:no_exit_plan').status, 'pass');
  const res3 = evaluateChecklist(list, { reason: 'x' }, {});
  assert.equal(res3.find(r => r.item.key === 'bias:chase').status, 'unknown');
});

// ---------- 回归测试（开发中发现的问题） ----------
test('回归：建议与动作之间夹字也要过滤；“买入前写下…”这类过程表述不误伤', () => {
  assert.equal(filterCompliance('建议下次直接买入龙头股。').hits.length, 1);
  assert.equal(filterCompliance('应该尽快加仓。').hits.length, 1);
  assert.equal(filterCompliance('建议在买入前写下止损条件。').hits.length, 0);
  assert.equal(filterCompliance('应该先写清买入理由。').hits.length, 0);
});
test('回归：事前“假设”的检验方法可以描述未来，不应被当作后见之明移除', () => {
  const { data, report } = validateAIOutput('ex_ante', { hypotheses: [{ hypothesis: '一季度业绩改善', how_to_check: '对照之后公布的一季报' }] }, EVID);
  assert.equal(data.hypotheses.length, 1);
  assert.equal(report.removed.length, 0);
});
test('非法输入：数量≤0、方向不明、价格为负都被拒绝', () => {
  const r = parseTradesCSV('日期,代码,方向,数量,价格\n2025-01-06,600519.SH,买入,0,10\n2025-01-06,600519.SH,持有,100,10\n2025-01-06,600519.SH,卖出,100,-1');
  assert.equal(r.trades.length, 0);
  assert.equal(r.errors.length, 3);
});
test('被合规过滤的 AI 经验不会进入清单', () => {
  const items = lessonsToChecklist({ ex_post: { lessons: [{ text: '【已过滤：此句涉及直接买卖建议，本产品不提供】' }, { text: '买入前写下离场条件。' }] } }, [], 't1');
  assert.equal(items.length, 1);
});
test('追涨：买入当天大涨（当日部分可知）也会触发', () => {
  const m = market('600000.SH', { seed: 11, drift: d => (d === '2025-03-03' ? 0.1 : 0) });
  const r = analyze([{ id: 'b', date: '2025-03-03', thscode: '600000.SH', side: 'buy', qty: 1, price: null, reason: '看到大涨赶紧上车' }], { byCode: { '600000.SH': m }, bench: BENCH() });
  const chase = r.biasesByTrade.b.find(x => x.id === 'chase');
  assert.equal(chase.status, 'triggered');
  assert.match(chase.detail, /买入当天大涨/);
});
test('过程分：没有退出计划时，“遵守计划”不得分', () => {
  const m = market('600000.SH', { seed: 12 });
  const r = analyze([
    { id: 'b', date: '2025-03-03', thscode: '600000.SH', side: 'buy', qty: 1, price: null, reason: '有理由', hypotheses: '有假设', exit_plan: '' },
    { id: 's', date: '2025-03-20', thscode: '600000.SH', side: 'sell', qty: 1, price: null, reason: '' },
  ], { byCode: { '600000.SH': m }, bench: BENCH() });
  const p = r.roundTrips[0].process;
  assert.ok(p.reasons.some(x => x.includes('没有计划，无从谈起遵守')));
  assert.ok(p.score <= 3);
});
test('过程分：违背自己写下的计划时，分数再高也不算“过程好”', () => {
  const m = market('600000.SH', { seed: 8, drift: d => (d >= '2025-03-04' && d < '2025-03-14' ? -0.02 : 0) });
  const r = analyze([
    { id: 'b', date: '2025-03-03', thscode: '600000.SH', side: 'buy', qty: 1, price: null, reason: '估值低，长期持有', hypotheses: '业绩改善', exit_plan: '止损-5%' },
    { id: 's', date: '2025-03-20', thscode: '600000.SH', side: 'sell', qty: 1, price: null, reason: '' },
  ], { byCode: { '600000.SH': m }, bench: BENCH() });
  assert.match(r.roundTrips[0].process.quadrant, /^过程差/);
});
