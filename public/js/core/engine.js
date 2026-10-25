// 复盘主链路编排：交易 + 市场数据 → 时间线上下文 → 回合 → 偏差 → 证据包。
import { buildTradeContext, buildRoundTripContext } from './context.js';
import { matchFIFO, sortTrades } from './trades.js';
import { tradeBiases, roundTripBiases, portfolioBiases, processOutcome } from './biases.js';

export function analyze(trades, market) {
  const sorted = sortTrades(trades);
  const contexts = sorted.map(t => buildTradeContext(t, market.byCode[t.thscode], market.bench));
  const withPrice = contexts.map(c => ({ ...c.trade, effective_price: c.effective_price }));
  const { roundTrips: rts, openLots, issues } = matchFIFO(withPrice);
  const roundTrips = rts.map(rt => buildRoundTripContext(rt, market.byCode[rt.thscode], market.bench));

  const biasesByTrade = {};
  for (const c of contexts) biasesByTrade[c.trade.id] = tradeBiases(c);
  const tradeById = Object.fromEntries(sorted.map(t => [t.id, t]));
  for (const rt of roundTrips) {
    rt.biases = roundTripBiases(rt, tradeById[rt.buy_id]);
    rt.process = processOutcome(rt, tradeById[rt.buy_id], rt.biases, biasesByTrade[rt.buy_id] || []);
  }
  const portfolio = portfolioBiases(roundTrips);

  // 计划类证据（用户当时的记录）与规则类证据（偏差规则结果）：都来自真实记录，带可核对的结构化字段
  for (const c of contexts) {
    c.evidence.push(...recordEvidence(c.trade));
    c.evidence.push(...ruleEvidence(biasesByTrade[c.trade.id] || [], `E-${c.trade.id}`, c.trade.aligned_date || c.trade.date));
  }
  for (const rt of roundTrips) rt.evidence.push(...ruleEvidence(rt.biases, `E-rt-${rt.buy_id}-${rt.sell_id}`, rt.sell_date));

  const totalPnl = roundTrips.reduce((s, r) => s + r.pnl, 0);
  const wins = roundTrips.filter(r => r.pnl > 0).length;
  const summary = {
    trades: sorted.length, stocks: new Set(sorted.map(t => t.thscode)).size, round_trips: roundTrips.length,
    realized_pnl: Math.round(totalPnl * 100) / 100, win_rate: roundTrips.length ? wins / roundTrips.length : null,
    avg_excess: avg(roundTrips.map(r => r.excess).filter(v => v != null)),
    open_positions: openLots.length,
    triggered: Object.values(biasesByTrade).flat().concat(roundTrips.flatMap(r => r.biases), portfolio).filter(b => b.status === 'triggered').length,
    data_errors: contexts.flatMap(c => c.checks).filter(x => x.level === 'error').length,
  };
  return { trades: sorted, contexts, roundTrips, openLots, issues, biasesByTrade, portfolio, summary };
}

const REC_FIELDS = [['reason', '当时理由'], ['hypotheses', '关键假设'], ['exit_plan', '退出计划']];
const BIAS_STATUS_TEXT = { triggered: '触发', watch: '值得留意', clear: '未触发', insufficient: '数据不足' };

/** 用户交易记录中的文字字段 → 证据。未填写也如实记录为“未填写”。 */
export function recordEvidence(t) {
  return REC_FIELDS.map(([f, label]) => {
    const v = String(t[f] || '').trim();
    return {
      id: `E-${t.id}-rec_${f}`, trade_id: t.id, phase: 'ex_ante', kinds: ['plan'], timing: 'at_decision', state: v ? 'filled' : 'missing',
      label: `用户记录：${label}`, value: v || '（未填写）', unit: 'text', display: v ? v.slice(0, 80) : '（未填写）', as_of: t.aligned_date || t.date,
      source: { api: '用户交易记录', thscode: t.thscode }, calc: '交易时由用户填写；若事后补记，时序以用户声明为准',
    };
  });
}

/** 偏差规则结果 → 证据。status 为规则的确定性结果。 */
export function ruleEvidence(biases, prefix, asOf) {
  return (biases || []).filter(b => b.id && b.id !== 'data').map(b => ({
    id: `${prefix}-rule-${b.id}`, phase: b.phase === 'same_day' ? 'same_day' : b.phase === 'ex_post' ? 'ex_post' : 'ex_ante', kinds: ['rule'],
    timing: b.phase === 'same_day' ? 'partial' : b.phase === 'ex_post' ? 'post' : 'pre', status: b.status,
    label: `规则检查：${b.name}`, value: `${BIAS_STATUS_TEXT[b.status] || b.status}${b.detail ? '（' + b.detail + '）' : ''}`, unit: 'text',
    display: `${BIAS_STATUS_TEXT[b.status] || b.status}${b.detail ? '：' + b.detail : ''}`.slice(0, 120), as_of: asOf,
    source: { api: '复盘镜规则引擎', rule: b.rule || '' }, calc: b.rule || '',
  }));
}

function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }

/**
 * 为某笔交易组装证据包（送给 AI 或规则兜底）。
 * 卖出交易会附带其所在回合的指标与偏差；买入交易若已平仓，也附带回合信息。
 */
export function buildPack(result, tradeId) {
  const ctx = result.contexts.find(c => c.trade.id === tradeId);
  if (!ctx) return null;
  const rt = result.roundTrips.find(r => r.sell_id === tradeId) || result.roundTrips.find(r => r.buy_id === tradeId) || null;
  const biases = [...(result.biasesByTrade[tradeId] || []), ...(rt?.biases || [])];
  const evidence = [...ctx.evidence, ...(rt?.evidence || [])];
  return {
    trade: { ...ctx.trade, effective_price: ctx.effective_price },
    metrics: ctx.metrics, evidence, biases, checks: ctx.checks,
    round_trip: rt ? { buy_id: rt.buy_id, sell_id: rt.sell_id, buy_date: rt.buy_date, sell_date: rt.sell_date, pnl_pct: rt.pnl_pct, excess: rt.excess, holding_days: rt.holding_days } : null,
    process_outcome: rt?.process || null,
  };
}
