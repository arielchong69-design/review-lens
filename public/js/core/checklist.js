// 复盘结论沉淀：清单条目 + 可机器检查的触发条件 + 下次决策前检查。
import { THRESHOLDS } from './biases.js';
import { LESSON_TEMPLATES } from './review.js';
import { pct } from './context.js';

/** 每类规则偏差对应的“可自动检查”条件 */
export const BIAS_CHECKS = {
  chase: { type: 'any', conds: [{ metric: 'pre_ret_20', op: '>=', value: THRESHOLDS.chase_ret20, label: `近20日涨幅 ≥ ${pct(THRESHOLDS.chase_ret20)}` }, { all: [{ metric: 'pre_dist_high_60', op: '>=', value: THRESHOLDS.chase_near_high }, { metric: 'pre_vol_ratio', op: '>=', value: THRESHOLDS.chase_vol_ratio }], label: '贴近60日高点且放量' }] },
  no_exit_plan: { type: 'text_missing', pattern: '止损|止盈|离场|退出|目标', field: 'plan', label: '计划中没有离场条件' },
  no_reason: { type: 'text_missing', pattern: '.{6,}', field: 'reason', label: '理由少于6个字' },
  panic_sell: { type: 'manual', label: '卖出时对照最初假设' },
  stop_breach: { type: 'text_missing', pattern: '止损', field: 'plan', label: '没有写止损线' },
  plan_drift: { type: 'manual', label: '持有周期与计划是否一致' },
  disposition: { type: 'manual', label: '卖出理由是否只是“已经赚了/还没回本”' },
};

let seq = 0;
export function newId() { seq++; return `c${Date.now().toString(36)}${seq}`; }

/** 从一份复盘生成候选清单条目（去重由 mergeChecklist 负责） */
export function lessonsToChecklist(review, biases, tradeRef) {
  const items = [];
  for (const b of biases || []) {
    if (b.status !== 'triggered') continue;
    items.push({ id: newId(), key: `bias:${b.id}`, text: LESSON_TEMPLATES[b.id] || `留意“${b.name}”`, source: 'rule', bias_id: b.id, check: BIAS_CHECKS[b.id] || { type: 'manual' }, refs: b.evidence || [], trade_refs: [tradeRef], created_at: new Date().toISOString(), hits: 1 });
  }
  for (const l of review?.ex_post?.lessons || []) {
    if (!l.text || l.text.includes('已过滤')) continue; // 被合规过滤的经验不进清单
    items.push({ id: newId(), key: `ai:${l.text.slice(0, 24)}`, text: l.text, trigger: l.trigger || '', source: review.generator === 'rules' ? 'rule' : 'ai', check: { type: 'manual', label: l.trigger || '人工对照' }, refs: l.refs || [], trade_refs: [tradeRef], created_at: new Date().toISOString(), hits: 1 });
  }
  return items;
}

/** 合并：相同 key 的条目累加命中次数并合并来源交易 */
export function mergeChecklist(existing, incoming) {
  const map = new Map(existing.map(i => [i.key, { ...i }]));
  for (const it of incoming) {
    if (map.has(it.key)) {
      const cur = map.get(it.key);
      const refs = new Set([...(cur.trade_refs || []), ...(it.trade_refs || [])]);
      cur.hits = refs.size; cur.trade_refs = [...refs];
    } else map.set(it.key, it);
  }
  return [...map.values()].sort((a, b) => b.hits - a.hits);
}

function cmp(v, op, x) {
  if (v == null) return null;
  return op === '>=' ? v >= x : op === '<=' ? v <= x : op === '>' ? v > x : v < x;
}
function evalCond(c, metrics) {
  if (c.all) { const r = c.all.map(x => evalCond(x, metrics)); return r.includes(null) ? null : r.every(Boolean); }
  return cmp(metrics[c.metric], c.op, c.value);
}

/**
 * 下次决策前检查：对新计划逐条评估清单。
 * @param plan { thscode, side, reason, exit_plan }
 * @param metrics 用最新行情算出的事前指标（与复盘同口径）
 * @returns [{ item, status: 'hit'|'pass'|'manual'|'unknown', why }]
 */
export function evaluateChecklist(checklist, plan, metrics) {
  const planText = `${plan.reason || ''} ${plan.exit_plan || ''}`;
  return checklist.map(item => {
    const c = item.check || { type: 'manual' };
    if (c.type === 'any') {
      const r = c.conds.map(x => evalCond(x, metrics || {}));
      if (r.every(x => x === null)) return { item, status: 'unknown', why: '行情不足，无法自动判断' };
      const hitIdx = r.findIndex(x => x === true);
      return hitIdx >= 0 ? { item, status: 'hit', why: `满足：${c.conds[hitIdx].label}` } : { item, status: 'pass', why: '当前不满足触发条件' };
    }
    if (c.type === 'text_missing') {
      const text = c.field === 'reason' ? (plan.reason || '') : planText;
      return new RegExp(c.pattern).test(text) ? { item, status: 'pass', why: '计划中已包含' } : { item, status: 'hit', why: c.label };
    }
    return { item, status: 'manual', why: c.label || '需要你自己对照' };
  });
}

/**
 * 历史相似情形统计：过去在相同信号下的交易，事后表现如何（纯历史描述，非预测）。
 */
export function similarHistory(contexts, biasesByTrade, biasId) {
  const rows = contexts.filter(c => c.trade.side === 'buy' && (biasesByTrade[c.trade.id] || []).some(b => b.id === biasId && b.status === 'triggered'));
  const vals = rows.map(c => c.metrics.post_excess_20).filter(v => v != null);
  return { n: rows.length, n_with_outcome: vals.length, avg_excess_20: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, trades: rows.map(c => ({ id: c.trade.id, date: c.trade.aligned_date, name: c.trade.name || c.trade.thscode, excess20: c.metrics.post_excess_20 })) };
}
