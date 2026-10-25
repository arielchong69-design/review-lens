// 行为偏差：确定性规则，每条都给出阈值、触发证据与“数据不足”状态。
// 规则推断 ≠ 事实；UI 中统一标注为“规则推断”。
import { extractStopLossPct, extractStopLossPrice, detectHorizon } from './trades.js';
import { pct } from './context.js';

export const THRESHOLDS = {
  chase_ret20: 0.15,       // 买前20日涨幅 ≥ 15%
  chase_near_high: -0.03,  // 或距60日高点 ≤ 3% 且放量
  chase_vol_ratio: 1.5,
  panic_bench_day: -0.02,  // 卖出当日基准跌幅 ≥ 2%
  panic_stock_day: -0.05,  // 或个股当日跌幅 ≥ 5%
  stop_tolerance: 0.02,    // 止损线被击穿超过 2 个百分点仍未离场
  chase_day_ret: 0.07,     // 或买入当日涨幅 ≥ 7%（盘中可见，属于“当日部分可知”）
  short_hold_days: 60,     // “长期”却持有不足 60 个交易日（约 3 个月）
  long_hold_days: 30,      // “短线”却持有超过 30 个交易日
  disposition_ratio: 0.6,  // 盈利回合平均持有天数 < 亏损回合 × 0.6
};

const EMOTION_RE = /恐慌|害怕|怕|慌|扛不住|受不了|顶不住|避险|先跑|割了|心态|睡不着|冲动|上头|眼红|踏空|FOMO|追/i;

function evRef(ctx, key) { return `E-${ctx.trade.id}-${key}`; }

/** 单笔交易层面的规则 */
export function tradeBiases(ctx) {
  const out = [];
  const t = ctx.trade, m = ctx.metrics || {};
  if (!ctx.ok) return [{ id: 'data', name: '数据不足', trade_id: t.id, status: 'insufficient', note: '缺少行情，偏差规则未运行' }];

  if (t.side === 'buy') {
    // 追涨
    const hasData = m.pre_ret_20 != null || (m.pre_dist_high_60 != null && m.pre_vol_ratio != null) || m.day_ret != null;
    const c1 = m.pre_ret_20 != null && m.pre_ret_20 >= THRESHOLDS.chase_ret20;
    const c2 = m.pre_dist_high_60 != null && m.pre_vol_ratio != null && m.pre_dist_high_60 >= THRESHOLDS.chase_near_high && m.pre_vol_ratio >= THRESHOLDS.chase_vol_ratio;
    const c3 = m.day_ret != null && m.day_ret >= THRESHOLDS.chase_day_ret;
    const hits = [c1 && `买前20日已涨 ${pct(m.pre_ret_20)}`, c2 && '贴近60日高点且放量', c3 && `买入当天大涨（收盘 ${pct(m.day_ret)}）`].filter(Boolean);
    out.push({
      id: 'chase', name: '追涨买入', trade_id: t.id, phase: 'ex_ante',
      status: !hasData ? 'insufficient' : hits.length ? 'triggered' : 'clear',
      rule: `满足任一：买前20日涨幅 ≥ ${pct(THRESHOLDS.chase_ret20)}；距60日高点 ≤ 3% 且近5日量能 ≥ 60日均量 ${THRESHOLDS.chase_vol_ratio} 倍；买入当日涨幅 ≥ ${pct(THRESHOLDS.chase_day_ret)}`,
      evidence: [evRef(ctx, 'pre_ret_20'), evRef(ctx, 'pre_dist_high_60'), evRef(ctx, 'pre_vol_ratio'), evRef(ctx, 'day_ret')],
      detail: hasData ? (hits.length ? `触发：${hits.join('；')}` : `买前20日 ${pct(m.pre_ret_20)}，距60日高点 ${pct(m.pre_dist_high_60)}，量比 ${m.pre_vol_ratio ?? '—'}，当日 ${pct(m.day_ret)}`) : '买入前历史行情不足',
      note: c3 && !c1 && !c2 ? '当日涨幅用的是收盘数据，决策时盘中只能看到一部分，因此按“当日部分可知”处理；追涨本身不等于错误，关键看理由里是否考虑了它' : '这些信息在买入时都能看到，属于事前可识别的风险信号；追涨本身不等于错误，关键看理由里是否考虑了它',
    });
    // 退出计划缺失
    const hasPlan = !!(t.exit_plan || extractStopLossPct(t.reason) || extractStopLossPrice(t.reason) || /止盈|止损|目标|离场|退出/.test(t.reason));
    out.push({
      id: 'no_exit_plan', name: '缺少退出计划', trade_id: t.id, phase: 'ex_ante', status: hasPlan ? 'clear' : 'triggered',
      rule: '买入记录中没有止损、止盈或离场条件', evidence: [], detail: hasPlan ? '已写明退出计划' : '理由和退出计划栏都没有离场条件',
      note: '没有事先定义的离场条件，事后很容易用结果倒推“当时应该怎样”',
    });
    // 理由缺失
    out.push({
      id: 'no_reason', name: '理由缺失', trade_id: t.id, phase: 'ex_ante', status: t.reason ? 'clear' : 'triggered',
      rule: '交易记录没有当时理由', evidence: [], detail: t.reason ? '' : '无法区分“判断对了”还是“运气好”',
    });
  }

  if (t.side === 'sell') {
    const hasData = m.bench_day_ret != null || m.day_ret != null;
    const marketStress = (m.bench_day_ret != null && m.bench_day_ret <= THRESHOLDS.panic_bench_day) || (m.day_ret != null && m.day_ret <= THRESHOLDS.panic_stock_day);
    const emotional = EMOTION_RE.test(t.reason);
    out.push({
      id: 'panic_sell', name: '情绪化卖出', trade_id: t.id, phase: 'same_day',
      status: !hasData && !emotional ? 'insufficient' : marketStress && emotional ? 'triggered' : marketStress || emotional ? 'watch' : 'clear',
      rule: `卖出当日基准跌幅 ≥ ${pct(-THRESHOLDS.panic_bench_day)} 或个股跌幅 ≥ ${pct(-THRESHOLDS.panic_stock_day)}，同时理由含情绪词（恐慌、避险、扛不住等）`,
      evidence: [evRef(ctx, 'bench_day_ret'), evRef(ctx, 'day_ret')],
      detail: `当日个股 ${pct(m.day_ret)}，基准 ${pct(m.bench_day_ret)}；理由${emotional ? '含' : '不含'}情绪词`,
      note: '只满足一项时标为“值得留意”，两项都满足才算触发',
    });
  }
  return out;
}

/** 回合层面的规则：止损执行、计划漂移 */
export function roundTripBiases(rt, buyTrade) {
  const out = [];
  const text = `${buyTrade?.reason || ''} ${buyTrade?.exit_plan || ''}`;
  const stopPct = extractStopLossPct(text);
  const stopPrice = extractStopLossPrice(text);
  const ref = `E-rt-${rt.buy_id}-${rt.sell_id}`;
  if (stopPct != null || stopPrice != null) {
    const line = stopPct != null ? -stopPct : stopPrice / rt.buy_price - 1;
    const breached = rt.hold_mae != null && rt.hold_mae < line - THRESHOLDS.stop_tolerance;
    out.push({
      id: 'stop_breach', name: '止损未执行', trade_id: rt.sell_id, round_trip: `${rt.buy_id}-${rt.sell_id}`, phase: 'ex_post',
      status: rt.hold_mae == null ? 'insufficient' : breached ? 'triggered' : 'clear',
      rule: `计划止损线 ${pct(line)}；持有期最大浮亏比止损线再低 ${pct(THRESHOLDS.stop_tolerance)} 以上仍未离场`,
      evidence: [`${ref}-mae`], detail: `持有期最大浮亏 ${pct(rt.hold_mae)}（${rt.hold_mae_date || '—'}），最终 ${pct(rt.pnl_pct)}`,
      note: '对照的是你自己写下的计划，不是事后最优解',
    });
  }
  const horizon = detectHorizon(text);
  if (horizon && rt.holding_days != null) {
    const drift = (horizon === 'long' && rt.holding_days < THRESHOLDS.short_hold_days) || (horizon === 'short' && rt.holding_days > THRESHOLDS.long_hold_days);
    out.push({
      id: 'plan_drift', name: '持有周期偏离计划', trade_id: rt.sell_id, round_trip: `${rt.buy_id}-${rt.sell_id}`, phase: 'ex_post',
      status: drift ? 'triggered' : 'clear',
      rule: `理由写的是${horizon === 'long' ? '长期' : '短线'}，实际持有 ${horizon === 'long' ? `< ${THRESHOLDS.short_hold_days}` : `> ${THRESHOLDS.long_hold_days}`} 个交易日`,
      evidence: [`${ref}-hold`], detail: `计划${horizon === 'long' ? '长期' : '短线'}，实际持有 ${rt.holding_days} 个交易日`,
    });
  }
  return out;
}

/** 组合层面：处置效应（赚了拿不住、亏了不愿卖） */
export function portfolioBiases(roundTrips) {
  const win = roundTrips.filter(r => r.pnl_pct > 0 && r.holding_days != null);
  const loss = roundTrips.filter(r => r.pnl_pct <= 0 && r.holding_days != null);
  if (win.length < 1 || loss.length < 2) {
    return [{ id: 'disposition', name: '处置效应', phase: 'ex_post', status: 'insufficient', rule: '至少需要 1 个盈利回合和 2 个亏损回合', detail: `当前盈利回合 ${win.length} 个，亏损回合 ${loss.length} 个`, evidence: [] }];
  }
  const avg = a => a.reduce((s, r) => s + r.holding_days, 0) / a.length;
  const aw = avg(win), al = avg(loss);
  const avgWinPct = win.reduce((s, r) => s + r.pnl_pct, 0) / win.length;
  return [{
    id: 'disposition', name: '处置效应', phase: 'ex_post',
    status: aw < al * THRESHOLDS.disposition_ratio ? 'triggered' : 'clear',
    rule: `盈利回合平均持有天数 < 亏损回合的 ${THRESHOLDS.disposition_ratio} 倍`,
    detail: `盈利回合平均持有 ${aw.toFixed(1)} 天（平均 ${pct(avgWinPct)}），亏损回合平均持有 ${al.toFixed(1)} 天`,
    evidence: roundTrips.map(r => `E-rt-${r.buy_id}-${r.sell_id}-hold`),
    note: `样本只有 ${roundTrips.length} 个回合，结论不稳定`,
  }];
}

/**
 * 过程 × 结果 四象限（规则化粗分）。
 * 过程分（0–5）：有理由、有可检验的假设、有退出计划、遵守计划（未触发止损未执行/计划漂移）、事前无追涨信号或理由中已考虑。
 */
export function processOutcome(rt, buyTrade, biasesForRt, buyBiases) {
  const reasons = [];
  let score = 0;
  if (buyTrade?.reason) { score++; reasons.push('+1 有当时理由'); } else reasons.push('0 没有理由');
  if (buyTrade?.hypotheses) { score++; reasons.push('+1 写了可检验的假设'); } else reasons.push('0 没写关键假设');
  const plan = buyBiases.find(b => b.id === 'no_exit_plan');
  if (plan?.status === 'clear') { score++; reasons.push('+1 有退出计划'); } else reasons.push('0 没有退出计划');
  const broke = biasesForRt.some(b => (b.id === 'stop_breach' || b.id === 'plan_drift') && b.status === 'triggered');
  if (plan?.status !== 'clear') reasons.push('0 没有计划，无从谈起遵守');
  else if (!broke) { score++; reasons.push('+1 按自己写下的计划执行'); } else reasons.push('0 违背了自己写下的计划');
  const chase = buyBiases.find(b => b.id === 'chase');
  const acknowledged = /追高|高位|涨幅较大|已经涨|风险|仓位/.test(buyTrade?.reason || '');
  if (chase?.status !== 'triggered' || acknowledged) { score++; reasons.push(chase?.status === 'triggered' ? '+1 有追涨信号，但理由中考虑了风险' : '+1 事前无明显追涨信号'); } else reasons.push('0 有追涨信号且理由未提及');
  // 违背自己写下的计划是一票否决项：分数再高也不算“过程好”
  const goodProcess = score >= 4 && !broke;
  if (broke && score >= 4) reasons.push('（违背计划，一票否决）');
  const outcomeVal = rt.excess ?? rt.pnl_pct;
  const goodOutcome = outcomeVal > 0;
  const quadrant = goodProcess && goodOutcome ? '过程好 · 结果好' : goodProcess ? '过程好 · 结果差' : goodOutcome ? '过程差 · 结果好' : '过程差 · 结果差';
  const reading = {
    '过程好 · 结果好': '方法与结果一致，可以总结成可重复的做法',
    '过程好 · 结果差': '可能是正常的不确定性，不要因为一次结果否定方法',
    '过程差 · 结果好': '结果好可能有运气成分，最容易强化坏习惯',
    '过程差 · 结果差': '优先改进的地方',
  }[quadrant];
  return { score, max: 5, reasons, quadrant, reading, outcome_basis: rt.excess != null ? '超额收益' : '绝对收益（基准缺失）', outcome_value: outcomeVal };
}

export const STATUS_LABEL = { triggered: '触发', watch: '值得留意', clear: '未触发', insufficient: '数据不足' };
