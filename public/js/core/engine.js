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
