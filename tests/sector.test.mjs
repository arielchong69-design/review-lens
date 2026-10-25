// 第二比较基准（行业 / 概念指数）的回归测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBars } from '../public/js/core/context.js';
import { buildTradeContext } from '../public/js/core/context.js';
import { analyze, buildPack } from '../public/js/core/engine.js';
import { parseTradesCSV } from '../public/js/core/trades.js';
import { checkSectorCode, resolveSector, sectorDisplay, sectorCodesByStock, SECTOR_ROLE_LABEL } from '../public/js/core/sector.js';
import { validateAIOutput, ruleBasedReview, buildExAntePrompt, buildExPostPrompt } from '../public/js/core/review.js';
import { evidenceKinds, SUPPORT } from '../public/js/core/relevance.js';
import { makeBars } from './fixtures.mjs';

const CAT = {
  industry: { ok: true, items: [{ thscode: '881125.TI', name: '白酒' }] },
  cn_concept: { ok: true, items: [{ thscode: '885525.TI', name: '白酒概念' }, { thscode: '885728.TI', name: '人工智能' }] },
};
const CONS = (...codes) => ({ ok: true, items: codes.map(c => ({ thscode: c })) });
const BENCH = { thscode: '000300.SH', name: '沪深300', bars: normalizeBars(makeBars({ start: '2024-06-01', end: '2025-06-30', startPrice: 3500, seed: 9, vol: 0.008 })), meta: { ok: true, mode: 'live' } };
const stockBars = normalizeBars(makeBars({ start: '2024-06-01', end: '2025-06-30', seed: 7, drift: d => (d >= '2025-02-01' && d < '2025-03-03' ? 0.012 : 0) }));
const sectorBars = normalizeBars(makeBars({ start: '2024-06-01', end: '2025-06-30', startPrice: 1800, seed: 21, vol: 0.012 }));
function md(sector, extra = {}) {
  return { thscode: '600000.SH', adj: stockBars, raw: stockBars, adjMeta: { ok: true, mode: 'live' }, rawMeta: { ok: true, mode: 'live' }, events: [], eventsMeta: { ok: true, mode: 'live' }, sector, ...extra };
}
const sectorOf = (role = 'concept_member', bars = sectorBars) => {
  const base = role === 'industry_member' ? resolveSector('881125.TI', '600000.SH', CAT, CONS('600000.SH'))
    : role === 'concept_member' ? resolveSector('885525.TI', '600000.SH', CAT, CONS('600000.SH'))
      : resolveSector('885525.TI', '600000.SH', CAT, CONS('000001.SZ'));
  return { ...base, bars, meta: { ok: true, mode: 'live', request_id: 'sec-req' } };
};
const BUY = { id: 'b', date: '2025-03-03', thscode: '600000.SH', side: 'buy', qty: 100, price: null, reason: '板块热度高', hypotheses: '板块热度延续', exit_plan: '止损-8%' };
const SELL = { id: 's', date: '2025-04-15', thscode: '600000.SH', side: 'sell', qty: 100, price: null, reason: '' };
const run = (sector, extra) => analyze([BUY, SELL], { byCode: { '600000.SH': md(sector, extra) }, bench: BENCH });

// ---------- 代码校验与类型区分 ----------
test('比较指数代码格式：只接受同花顺 .TI 代码，空值允许', () => {
  assert.equal(checkSectorCode('').empty, true);
  assert.equal(checkSectorCode(' 885525.ti ').code, '885525.TI');
  assert.equal(checkSectorCode('000300.SH').ok, false);
  assert.equal(checkSectorCode('白酒').ok, false);
});
test('行业指数 + 当前成分股 → 所属行业指数，并注明历史成分无法核实', () => {
  const s = resolveSector('881125.TI', '600000.SH', CAT, CONS('600000.SH'));
  assert.equal(s.type, 'industry');
  assert.equal(s.role, 'industry_member');
  assert.equal(s.name, '白酒');
  assert.ok(s.notes.some(n => /历史/.test(n)));
});
test('概念指数即使包含该股，也不会被标为“所属行业”', () => {
  const s = resolveSector('885525.TI', '600000.SH', CAT, CONS('600000.SH'));
  assert.equal(s.type, 'concept');
  assert.equal(s.role, 'concept_member');
  assert.ok(!/所属行业/.test(s.roleLabel));
  assert.match(sectorDisplay(s), /白酒概念（885525\.TI，概念指数 · 相关概念指数/);
});
test('不在当前成分股中 → 用户指定的比较基准，明确不认定为所属行业', () => {
  const s = resolveSector('881125.TI', '600000.SH', CAT, CONS('000001.SZ'));
  assert.equal(s.role, 'user_specified');
  assert.equal(s.roleLabel, SECTOR_ROLE_LABEL.user_specified);
  assert.ok(s.notes.some(n => /不认定为所属行业/.test(n)));
});
test('成分股获取失败 → 关系未知，按用户指定处理', () => {
  const s = resolveSector('881125.TI', '600000.SH', CAT, { ok: false });
  assert.equal(s.relation, 'unknown');
  assert.equal(s.role, 'user_specified');
});
test('目录正常但找不到该代码 → 判为无效，不使用', () => {
  const s = resolveSector('999999.TI', '600000.SH', CAT, CONS());
  assert.equal(s.valid, false);
  assert.match(s.error, /找不到/);
});
test('目录获取失败 → 名称和类型标为“未核实”，只能作为用户指定基准', () => {
  const s = resolveSector('885525.TI', '600000.SH', { industry: { ok: false }, cn_concept: { ok: false } }, CONS('600000.SH'));
  assert.equal(s.verified, false);
  assert.equal(s.type, 'unknown');
  assert.equal(s.role, 'user_specified');
});
test('CSV：新增“比较指数”列可选；旧模板仍能导入；非法代码报错；同一股票多个代码给出提示', () => {
  const old = parseTradesCSV('日期,代码,方向,数量\n2025-01-06,600519.SH,买入,100');
  assert.equal(old.trades.length, 1);
  const r = parseTradesCSV('日期,代码,方向,数量,比较指数\n2025-01-06,600519.SH,买入,100,885525.TI\n2025-01-07,600519.SH,卖出,100,881125.TI\n2025-01-08,600000.SH,买入,1,000300.SH');
  assert.equal(r.trades[0].sector_code, '885525.TI');
  assert.ok(r.errors.some(e => /比较指数/.test(e)));
  assert.equal(sectorCodesByStock(r.trades).warnings.length, 1);
});

// ---------- 事前事后隔离 ----------
test('事前隔离：篡改交易日之后的比较指数行情，事前的比较指数证据不变', () => {
  const t = { ...BUY };
  const a = buildTradeContext(t, md(sectorOf()), BENCH);
  const tampered = sectorBars.map(b => (b.date > '2025-03-03' ? { ...b, close: b.close * 3 } : b));
  const b = buildTradeContext(t, md(sectorOf('concept_member', tampered)), BENCH);
  const pre = c => c.evidence.filter(e => e.phase === 'ex_ante' && /sector/.test(e.id)).map(e => [e.id, e.value]);
  assert.deepEqual(pre(a), pre(b));
  assert.notEqual(a.metrics.post_excess_sector_20, b.metrics.post_excess_sector_20);
  assert.ok(a.evidence.find(e => e.id === 'E-b-sector_pre_ret_20').as_of < '2025-03-03');
  assert.equal(a.evidence.find(e => e.id === 'E-b-sector_day_ret').phase, 'same_day');
});

// ---------- 失败不影响主链路 ----------
test('比较指数行情失败：只提示，沪深300 与其他证据完全不变', () => {
  const none = buildTradeContext(BUY, md(undefined), BENCH);
  const fail = buildTradeContext(BUY, md({ ...sectorOf(), bars: [], meta: { ok: false, message: 'code=5003' } }), BENCH);
  assert.ok(fail.checks.some(c => c.code === 'SECTOR_MISSING' && /沪深300 比较不受影响/.test(c.msg)));
  const core = c => c.evidence.filter(e => !/sector/.test(e.id)).map(e => [e.id, e.value]);
  assert.deepEqual(core(fail), core(none));
  assert.equal(fail.ok, true);
});
test('比较指数无效：只提示“已不使用”，复盘照常完成', () => {
  const r = run(undefined, { sectorError: '在同花顺行业和概念指数目录中都找不到 999999.TI，已不使用该比较基准' });
  const c = r.contexts.find(x => x.trade.id === 'b');
  assert.ok(c.checks.some(x => x.code === 'SECTOR_INVALID'));
  assert.equal(r.roundTrips.length, 1);
  assert.equal(r.roundTrips[0].excess_sector, null);
  assert.notEqual(r.roundTrips[0].excess, null);
});
test('回合层面：同期比较指数涨跌与相对差异写入证据，并注明“不说明原因”', () => {
  const r = run(sectorOf());
  const rt = r.roundTrips[0];
  assert.notEqual(rt.sector_ret, null);
  const e = rt.evidence.find(x => x.id.endsWith('-excess_sector'));
  assert.match(e.calc, /不说明原因/);
  assert.deepEqual(evidenceKinds(e), ['outcome', 'sector']);
});

// ---------- 不自动升级、不把相对收益当因果 ----------
const P = sector => buildPack(run(sector), 'b');
const disp = (p, id) => p.evidence.find(e => e.id === id).display;
test('相对基准：引用比较指数并写出数值 → 可以结构化校验通过（只陈述表现差异）', () => {
  const p = P(sectorOf());
  const text = `买前20日该股 ${disp(p, 'E-b-pre_ret_20')}，比较指数同期 ${disp(p, 'E-b-sector_pre_ret_20')}。`;
  const { data } = validateAIOutput('ex_ante', { reason_assessment: [{ text, type: 'fact', topic: '相对基准', refs: ['E-b-pre_ret_20', 'E-b-sector_pre_ret_20'] }] }, p.evidence);
  assert.equal(data.reason_assessment[0].support, SUPPORT.PASS);
});
test('行业归因：即使引用了比较指数的相对差异，也最高“证据有限”，并说明相对收益不能证明因果', () => {
  const p = P(sectorOf('industry_member'));
  const { data } = validateAIOutput('ex_post', { attribution: [{ factor: '行业或主题', text: `交易后20日相对比较指数 ${disp(p, 'E-b-post_excess_sector_20')}，行业拖累。`, confidence: '高', refs: ['E-b-post_excess_sector_20'] }] }, p.evidence);
  const x = data.attribution[0];
  assert.equal(x.support, SUPPORT.LIMITED);
  assert.equal(x.confidence, '低');
  assert.ok(x.support_notes.some(n => /不能证明/.test(n)));
});
test('板块类假设：有决策后的比较指数证据且为当前成分股 → 可以检验；用户指定的基准 → 最高“证据有限”；没有比较指数 → 无法判断', () => {
  const mk = p => ({ hypothesis_check: [{ hypothesis: '板块热度延续', hypothesis_type: '行业或板块', verdict: '不成立', text: `比较指数交易后20日 ${disp(p, 'E-b-sector_post_ret_20')}`, refs: ['E-b-sector_post_ret_20'] }] });
  const member = P(sectorOf('concept_member'));
  assert.equal(validateAIOutput('ex_post', mk(member), member.evidence).data.hypothesis_check[0].support, SUPPORT.PASS);
  const user = P(sectorOf('user_specified'));
  const u = validateAIOutput('ex_post', mk(user), user.evidence).data.hypothesis_check[0];
  assert.equal(u.support, SUPPORT.LIMITED);
  assert.equal(u.verdict, '无法判断');
  const none = buildPack(run(undefined), 'b');
  const n = validateAIOutput('ex_post', { hypothesis_check: [{ hypothesis: '板块热度延续', hypothesis_type: '行业或板块', verdict: '成立', text: 'x', refs: [] }] }, none.evidence).data.hypothesis_check[0];
  assert.equal(n.verdict, '无法判断');
  assert.ok(n.support_notes.some(x => /未设置行业或概念比较指数/.test(x)));
});
test('板块类假设只引用事前的比较指数证据 → 无法判断（检验需要决策后证据）', () => {
  const p = P(sectorOf('concept_member'));
  const { data } = validateAIOutput('ex_post', { hypothesis_check: [{ hypothesis: '板块热度延续', hypothesis_type: '行业或板块', verdict: '成立', text: `买前比较指数 ${disp(p, 'E-b-sector_pre_ret_20')}`, refs: ['E-b-sector_pre_ret_20'] }] }, p.evidence);
  assert.equal(data.hypothesis_check[0].verdict, '无法判断');
});
test('称谓核对：把概念指数或用户指定基准称为“所属行业” → 降为证据有限；行业指数且为当前成分股 → 不受影响', () => {
  const text = p => `买前20日该股 ${disp(p, 'E-b-pre_ret_20')}，所属行业同期 ${disp(p, 'E-b-sector_pre_ret_20')}。`;
  const item = p => ({ reason_assessment: [{ text: text(p), type: 'fact', topic: '相对基准', refs: ['E-b-pre_ret_20', 'E-b-sector_pre_ret_20'] }] });
  const c = P(sectorOf('concept_member'));
  const x = validateAIOutput('ex_ante', item(c), c.evidence).data.reason_assessment[0];
  assert.equal(x.support, SUPPORT.LIMITED);
  assert.ok(x.support_notes.some(n => /所属行业/.test(n)));
  const i = P(sectorOf('industry_member'));
  assert.equal(validateAIOutput('ex_ante', item(i), i.evidence).data.reason_assessment[0].support, SUPPORT.PASS);
});
test('规则兜底：有比较指数时补充相对比较与行业归因（证据有限），无隐藏、无不相关引用', () => {
  const p = P(sectorOf('concept_member'));
  const rb = ruleBasedReview(p);
  const a = validateAIOutput('ex_ante', rb.ex_ante, p.evidence), b = validateAIOutput('ex_post', rb.ex_post, p.evidence);
  assert.ok(a.data.reason_assessment.some(x => /第二比较基准/.test(x.text) && x.support === SUPPORT.PASS));
  const attr = b.data.attribution.find(x => x.factor === '行业或主题');
  assert.equal(attr.support, SUPPORT.LIMITED);
  for (const rep of [a.report, b.report]) { assert.equal(rep.hidden.length, 0); assert.equal(rep.irrelevant_refs.length, 0); }
});
test('提示词：带比较指数说明与称谓规则；事前阶段不含决策后的比较指数证据', () => {
  const p = P(sectorOf('concept_member'));
  const pre = buildExAntePrompt(p);
  assert.match(pre.system, /只有“行业指数且该股为当前成分股”才能称为所属行业/);
  const u = JSON.parse(pre.user);
  assert.ok(u.evidence.some(e => e.kind === 'sector_meta'));
  assert.ok(!u.evidence.some(e => /sector_post|excess_sector/.test(e.id)));
  assert.match(buildExPostPrompt(p, null).system, /不能写成因果结论/);
});
test('比较指数在交易日之后才有行情（线上实测：AI应用指数从 2026-01-13 开始）→ 不做任何相对比较，并说明原因', () => {
  const late = sectorBars.filter(b => b.date > '2025-03-03');
  const c = buildTradeContext(BUY, md(sectorOf('concept_member', late)), BENCH);
  assert.ok(c.checks.some(x => x.code === 'SECTOR_STARTS_AFTER' && /决策时该指数尚无数据/.test(x.msg)));
  assert.ok(c.evidence.filter(e => /sector/.test(e.id) && e.id !== 'E-b-sector_info').every(e => e.value == null));
  assert.match(c.evidence.find(e => e.id === 'E-b-sector_info').value, /交易日尚无数据/);
  const p = buildPack(analyze([BUY, SELL], { byCode: { '600000.SH': md(sectorOf('concept_member', late)) }, bench: BENCH }), 'b');
  const { data } = validateAIOutput('ex_post', { hypothesis_check: [{ hypothesis: '板块热度延续', hypothesis_type: '行业或板块', verdict: '成立', text: 'x', refs: [] }] }, p.evidence);
  assert.equal(data.hypothesis_check[0].verdict, '无法判断');
});
