// 证据相关性校验的回归测试：真实但不相关的证据、主题误标、事后证据误用、同日时序不确定、
// 部分支撑、证据缺失、引用删除后失去支撑、结构化断言。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBars, normalizeEvents } from '../public/js/core/context.js';
import { analyze, buildPack } from '../public/js/core/engine.js';
import { validateAIOutput, ruleBasedReview, buildExAntePrompt } from '../public/js/core/review.js';
import { evidenceKinds, evidenceTiming, SUPPORT } from '../public/js/core/relevance.js';
import { makeBars, makeEvents } from './fixtures.mjs';

const BENCH = { thscode: '000300.SH', name: '沪深300', bars: normalizeBars(makeBars({ start: '2024-06-01', end: '2025-06-30', startPrice: 3500, seed: 9, vol: 0.008 })), meta: { ok: true, mode: 'live' } };
function setup({ trades, events = [] }) {
  const bars = normalizeBars(makeBars({ start: '2024-06-01', end: '2025-06-30', seed: 7, drift: d => (d >= '2025-02-01' && d < '2025-03-03' ? 0.012 : 0) }));
  const md = { thscode: '600000.SH', adj: bars, raw: bars, adjMeta: { ok: true, mode: 'live' }, rawMeta: { ok: true, mode: 'live' }, events: normalizeEvents(makeEvents(events), { mode: 'live' }), eventsMeta: { ok: true, mode: 'live' } };
  return analyze(trades, { byCode: { '600000.SH': md }, bench: BENCH });
}
const BUY = { id: 'b', date: '2025-03-03', thscode: '600000.SH', side: 'buy', qty: 100, price: null, reason: 'AI 行情起来了，怕踏空', hypotheses: '板块热度延续', exit_plan: '' };
const SELL = { id: 's', date: '2025-04-15', thscode: '600000.SH', side: 'sell', qty: 100, price: null, reason: '', hypotheses: '', exit_plan: '' };
const r = setup({ trades: [BUY, SELL] });
const pack = buildPack(r, 'b');
const EV = pack.evidence;
const disp = id => EV.find(e => e.id === id).display;
const one = (section, key, item) => validateAIOutput(section, { [key]: [item] }, EV);

// ---------- 证据类型与时序 ----------
test('证据类型与时序按证据 ID 结构确定，并新增计划/规则证据', () => {
  assert.deepEqual(evidenceKinds({ id: 'E-b-pre_ret_20' }), ['momentum']);
  assert.deepEqual(evidenceKinds({ id: 'E-b-post_excess_20' }), ['outcome', 'benchmark']);
  const plan = EV.find(e => e.id === 'E-b-rec_exit_plan');
  assert.equal(plan.state, 'missing');
  assert.equal(evidenceTiming(plan), 'at_decision');
  const rule = EV.find(e => e.id === 'E-b-rule-chase');
  assert.equal(rule.status, 'triggered');
  assert.equal(evidenceTiming(EV.find(e => e.id === 'E-b-day_ret')), 'partial');
  assert.equal(evidenceTiming(EV.find(e => e.id === 'E-b-trade_price')), 'at_decision');
});

// ---------- 真实但不相关的证据 ----------
test('真实但不相关的证据：“退出计划未填写”引用成交价 → 不相关引用被移除，结论降级为“证据有限”', () => {
  const { data, report } = one('ex_ante', 'reason_assessment', { text: '退出计划栏未填写，缺少离场条件。', type: 'fact', topic: '计划与纪律', refs: ['E-b-trade_price'] });
  const x = data.reason_assessment[0];
  assert.deepEqual(x.irrelevant_refs, ['E-b-trade_price']);
  assert.deepEqual(x.refs, []);
  assert.equal(x.support, SUPPORT.LIMITED);
  assert.equal(x.type, 'inference');
  assert.match(x.text, /^（证据有限）/);
  assert.equal(report.irrelevant_refs.length, 1);
  assert.equal(report.downgraded.length, 1);
});
test('同一结论附带可核对的结构化断言 → 由交易记录确定性验证通过，并自动关联真实的记录证据', () => {
  const { data } = one('ex_ante', 'reason_assessment', { text: '退出计划栏未填写，缺少离场条件。', type: 'fact', topic: '计划与纪律', refs: ['E-b-trade_price'], assert: { field: 'exit_plan', state: 'missing' } });
  const x = data.reason_assessment[0];
  assert.equal(x.support, SUPPORT.PASS);
  assert.ok(x.refs.includes('E-b-rec_exit_plan'));
  assert.ok(!x.refs.includes('E-b-trade_price'));
  assert.equal(x.type, 'fact');
});

// ---------- 主题误标 ----------
test('主题误标：讲退出计划却标成“走势”并引用涨跌幅（类型匹配）→ 数值锚定失败，降级', () => {
  const { data } = one('ex_ante', 'visible_risks', { text: '没有写任何离场条件。', type: 'fact', topic: '走势', refs: ['E-b-pre_ret_20'] });
  const x = data.visible_risks[0];
  assert.equal(x.support, SUPPORT.LIMITED);
  assert.ok(x.support_notes.some(n => /主题标注有误/.test(n)));
});
test('主题误标的对照组：主题与数值都正确 → 结构化校验通过', () => {
  const { data } = one('ex_ante', 'visible_risks', { text: `买入前20日已涨 ${disp('E-b-pre_ret_20')}，追涨属性明显。`, type: 'fact', topic: '走势', refs: ['E-b-pre_ret_20'] });
  assert.equal(data.visible_risks[0].support, SUPPORT.PASS);
});
test('结构化断言优先于主题：主题随便标，只要断言与记录不符就隐藏', () => {
  const a = one('ex_ante', 'reason_assessment', { text: '交易时已经写好了退出计划。', type: 'fact', topic: '走势', refs: [], assert: { field: 'exit_plan', state: 'filled' } });
  assert.equal(a.data.reason_assessment.length, 0);
  assert.match(a.report.hidden[0].reason, /与交易记录不符/);
  const b = one('ex_ante', 'visible_risks', { text: '没有追涨。', type: 'fact', topic: '计划与纪律', refs: [], assert: { rule: 'chase', status: 'clear' } });
  assert.equal(b.data.visible_risks.length, 0);
  assert.match(b.report.hidden[0].reason, /与规则检查结果不符/);
});

// ---------- 事后证据误用 ----------
test('事后证据误用①：事前结论引用决策后证据 → 整条移除', () => {
  const { data, report } = one('ex_ante', 'reason_assessment', { text: `买入后20日 ${disp('E-b-post_ret_20')}，说明理由错误。`, type: 'fact', topic: '走势', refs: ['E-b-post_ret_20'] });
  assert.equal(data.reason_assessment.length, 0);
  assert.equal(report.removed.length, 1);
});
test('事后证据误用②：只用事前证据就判定假设“成立” → 改为“无法判断”', () => {
  const { data } = one('ex_post', 'hypothesis_check', { hypothesis: '股价继续上涨', hypothesis_type: '价格或相对表现', verdict: '成立', text: `买前已涨 ${disp('E-b-pre_ret_20')}`, refs: ['E-b-pre_ret_20'] });
  const x = data.hypothesis_check[0];
  assert.equal(x.verdict, '无法判断');
  assert.ok(x.support_notes.some(n => /决策后的证据/.test(n)));
});
test('事后证据误用③：用个股事后涨跌做“市场环境”归因但没有基准证据 → 证据有限、置信度降为低', () => {
  const { data } = one('ex_post', 'attribution', { factor: '市场环境', text: `交易后20日下跌 ${disp('E-b-post_ret_20')}，主要是大盘拖累。`, confidence: '高', refs: ['E-b-post_ret_20'] });
  const x = data.attribution[0];
  assert.equal(x.support, SUPPORT.LIMITED);
  assert.equal(x.confidence, '低');
});

// ---------- 同日时序 ----------
test('同日时序：交易未填时间，同日事件为“时序不确定”，不能支撑通过的事前结论', () => {
  const r2 = setup({ trades: [BUY], events: [{ date: '2025-03-03', time: '10:00', text: '同日异动' }] });
  const p2 = buildPack(r2, 'b');
  const ev = p2.evidence.find(e => /-ev-/.test(e.id));
  assert.equal(evidenceTiming(ev), 'uncertain');
  const { data } = validateAIOutput('ex_ante', { reason_assessment: [{ text: '当天有异动提醒，理由与消息一致。', type: 'fact', topic: '事件信息', refs: [ev.id] }] }, p2.evidence);
  assert.equal(data.reason_assessment[0].support, SUPPORT.LIMITED);
  assert.ok(data.reason_assessment[0].support_notes.some(n => /同日时序不确定/.test(n)));
});
test('同日时序：交易 10:30，09:40 的事件属于决策前已知 → 可以通过；14:00 的事件属于决策后 → 不能进入事前结论', () => {
  const r3 = setup({ trades: [{ ...BUY, time: '10:30' }], events: [{ date: '2025-03-03', time: '09:40', text: '早盘异动' }, { date: '2025-03-03', time: '14:00', text: '午后异动' }] });
  const p3 = buildPack(r3, 'b');
  const evs = p3.evidence.filter(e => /-ev-/.test(e.id));
  const before = evs.find(e => e.display.includes('早盘')), after = evs.find(e => e.display.includes('午后'));
  assert.equal(evidenceTiming(before), 'pre');
  assert.equal(evidenceTiming(after), 'post');
  const ok = validateAIOutput('ex_ante', { reason_assessment: [{ text: '早盘已有异动提醒。', type: 'fact', topic: '事件信息', refs: [before.id] }] }, p3.evidence);
  assert.equal(ok.data.reason_assessment[0].support, SUPPORT.PASS);
  const bad = validateAIOutput('ex_ante', { reason_assessment: [{ text: '有异动提醒支持理由。', type: 'fact', topic: '事件信息', refs: [after.id] }] }, p3.evidence);
  assert.equal(bad.data.reason_assessment.length, 0);
  assert.equal(bad.report.removed.length, 1);
});
test('同日时序：只引用当日收盘涨跌（当日部分可知）→ 不能单独支撑事前结论', () => {
  const { data } = one('ex_ante', 'visible_risks', { text: `当天大涨 ${disp('E-b-day_ret')}。`, type: 'fact', topic: '走势', refs: ['E-b-day_ret'] });
  assert.equal(data.visible_risks[0].support, SUPPORT.LIMITED);
  assert.ok(data.visible_risks[0].support_notes.some(n => /当日部分可知/.test(n)));
});

// ---------- 部分支撑 ----------
test('部分支撑：“相对基准”只引用个股涨跌、没有基准 → 证据有限', () => {
  const { data } = one('ex_ante', 'reason_assessment', { text: `买前20日上涨 ${disp('E-b-pre_ret_20')}，明显强于大盘。`, type: 'fact', topic: '相对基准', refs: ['E-b-pre_ret_20'] });
  assert.equal(data.reason_assessment[0].support, SUPPORT.LIMITED);
});
test('部分支撑：AI 自评 partial 只能降级；自评 full 也不能把证据不足的结论升级', () => {
  const a = one('ex_ante', 'visible_risks', { text: `买前20日已涨 ${disp('E-b-pre_ret_20')}。`, type: 'fact', topic: '走势', refs: ['E-b-pre_ret_20'], support: 'partial' });
  assert.equal(a.data.visible_risks[0].support, SUPPORT.LIMITED);
  const b = one('ex_ante', 'reason_assessment', { text: `买前20日上涨 ${disp('E-b-pre_ret_20')}，强于大盘。`, type: 'fact', topic: '相对基准', refs: ['E-b-pre_ret_20'], support: 'full' });
  assert.equal(b.data.reason_assessment[0].support, SUPPORT.LIMITED);
});
test('部分支撑：行业归因受数据覆盖限制，最高只能“证据有限”', () => {
  const r2 = setup({ trades: [BUY, SELL], events: [{ date: '2025-03-10', text: '板块异动' }] });
  const p2 = buildPack(r2, 'b');
  const ev = p2.evidence.find(e => /-ev-/.test(e.id));
  const { data } = validateAIOutput('ex_post', { attribution: [{ factor: '行业或主题', text: '板块热度回落拖累个股。', confidence: '中', refs: [ev.id] }] }, p2.evidence);
  assert.equal(data.attribution[0].support, SUPPORT.LIMITED);
});

// ---------- 证据缺失 ----------
test('证据缺失：基本面类假设即使引用了事后证据，也判“无法判断”', () => {
  const { data } = one('ex_post', 'hypothesis_check', { hypothesis: '一季度业绩改善', hypothesis_type: '基本面或经营', verdict: '成立', text: `买入后20日 ${disp('E-b-post_ret_20')}`, refs: ['E-b-post_ret_20'] });
  assert.equal(data.hypothesis_check[0].verdict, '无法判断');
  assert.equal(data.hypothesis_check[0].support, SUPPORT.UNDETERMINED);
});
test('证据缺失：引用了没有数值的证据（窗口未走完）→ 视为缺失，结论不能通过', () => {
  const late = setup({ trades: [{ ...BUY, date: '2025-06-20' }] });
  const p = buildPack(late, 'b');
  const { data, report } = validateAIOutput('ex_post', { attribution: [{ factor: '买卖时点', text: '买入后60日表现很差。', confidence: '高', refs: ['E-b-post_ret_60'] }] }, p.evidence);
  assert.equal(data.attribution[0].support, SUPPORT.LIMITED);
  assert.ok(report.irrelevant_refs.some(x => /没有取到数值/.test(x.reason)));
});

// ---------- 引用删除后结论失去支撑 ----------
test('引用删除后失去支撑：引用全部不相关且数字无法溯源 → 隐藏，不保留确定性断言', () => {
  const { data, report } = one('ex_ante', 'visible_risks', { text: '年化波动率高达 88.88%，风险极大。', type: 'fact', topic: '波动', refs: ['E-b-rec_reason'] });
  assert.equal(data.visible_risks.length, 0);
  assert.equal(report.hidden.length, 1);
});
test('引用删除后失去支撑：没有数字的事实断言 → 改写为不确定表达并降级为推断', () => {
  const { data } = one('ex_ante', 'visible_risks', { text: '波动明显偏高。', type: 'fact', topic: '波动', refs: ['E-b-rec_reason'] });
  const x = data.visible_risks[0];
  assert.equal(x.type, 'inference');
  assert.match(x.text, /^（证据有限）/);
  assert.deepEqual(x.refs, []);
});

// ---------- 规则兜底与提示词 ----------
test('规则兜底的输出也经过同一套校验，核心结论都有标签，不出现隐藏或不相关引用', () => {
  const rb = ruleBasedReview(pack);
  const a = validateAIOutput('ex_ante', rb.ex_ante, EV), b = validateAIOutput('ex_post', rb.ex_post, EV);
  for (const rep of [a.report, b.report]) { assert.equal(rep.hidden.length, 0); assert.equal(rep.irrelevant_refs.length, 0); }
  for (const x of [...a.data.reason_assessment, ...a.data.visible_risks]) assert.ok(x.support, x.text);
  assert.ok(a.data.visible_risks.some(x => x.support === SUPPORT.PASS));
});
test('提示词：证据带类型与时序，事前阶段不含任何决策后证据', () => {
  const { user } = buildExAntePrompt(pack);
  const u = JSON.parse(user);
  assert.ok(u.evidence.every(e => e.kind && e.timing));
  assert.ok(u.evidence.every(e => e.timing !== 'post'));
  assert.ok(u.evidence.some(e => e.kind === 'plan'));
});
test('时序传递：只由“当日大涨”触发的追涨规则，其规则证据时序为“当日部分可知”，不能单独支撑事前结论', () => {
  const bars = normalizeBars(makeBars({ start: '2024-06-01', end: '2025-06-30', seed: 11, drift: d => (d === '2025-03-03' ? 0.1 : 0) }));
  const md = { thscode: '600000.SH', adj: bars, raw: bars, adjMeta: { ok: true }, rawMeta: { ok: true }, events: [], eventsMeta: { ok: true } };
  const rr = analyze([BUY], { byCode: { '600000.SH': md }, bench: BENCH });
  const p = buildPack(rr, 'b');
  const ruleEv = p.evidence.find(e => e.id === 'E-b-rule-chase');
  assert.equal(ruleEv.status, 'triggered');
  assert.equal(evidenceTiming(ruleEv), 'partial');
  const rb = ruleBasedReview(p);
  const { data } = validateAIOutput('ex_ante', rb.ex_ante, p.evidence);
  const chase = data.visible_risks.find(x => /追涨/.test(x.text));
  assert.notEqual(chase.support, SUPPORT.PASS);
});
test('复合结论（线上实测发现）：主题为“位置”却同时用到波动率数值，波动率引用被移除后不能整体“通过”', () => {
  const text = `距前60日最高价 ${disp('E-b-pre_dist_high_60')}，同时年化波动 ${disp('E-b-pre_vol_20')}，风险偏大。`;
  const { data } = one('ex_ante', 'visible_risks', { text, type: 'fact', topic: '位置', refs: ['E-b-pre_dist_high_60', 'E-b-pre_vol_20'] });
  const x = data.visible_risks[0];
  assert.deepEqual(x.irrelevant_refs, ['E-b-pre_vol_20']);
  assert.equal(x.support, SUPPORT.LIMITED);
  assert.ok(x.support_notes.some(n => /主题之外的证据/.test(n)));
});
test('复合结论的对照组：被移除的主题外引用，数值并未出现在结论里 → 不影响通过', () => {
  const { data } = one('ex_ante', 'visible_risks', { text: `距前60日最高价 ${disp('E-b-pre_dist_high_60')}。`, type: 'fact', topic: '位置', refs: ['E-b-pre_dist_high_60', 'E-b-pre_vol_20'] });
  assert.equal(data.visible_risks[0].support, SUPPORT.PASS);
});
test('断言只证明结构化事实（线上实测发现）：通过的结论必须注明“其余解读未经验证”', () => {
  const { data } = one('ex_ante', 'reason_assessment', { text: '理由属于情绪驱动，没有判断依据。', type: 'fact', topic: '理由完整性', refs: [], assert: { field: 'reason', state: 'filled' } });
  const x = data.reason_assessment[0];
  assert.equal(x.support, SUPPORT.PASS);
  assert.ok(x.support_notes.some(n => /当时理由已填写/.test(n) && /其余解读未经验证/.test(n)));
});
