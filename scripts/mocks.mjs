// 离线开发用的模拟上游（合成数据，绝不用于线上）。
import { makeBars, makeEvents } from '../tests/fixtures.mjs';
import { msToDate } from '../public/js/core/dates.js';

const seedOf = s => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

export async function mockFuyaoFetch(url) {
  const u = new URL(url);
  const p = u.pathname.replace('/api/', '');
  const q = Object.fromEntries(u.searchParams);
  const ok = data => new Response(JSON.stringify({ code: 0, message: 'success', request_id: `mock-${Math.random().toString(16).slice(2, 10)}`, data }));
  if (p.endsWith('prices/historical')) {
    const start = msToDate(Number(q.start)), end = msToDate(Number(q.end));
    const isIdx = p.startsWith('a-share-index');
    const base = isIdx ? 3800 : 20 + (seedOf(q.thscode) % 200);
    const bars = makeBars({ start: '2024-01-01', end: '2026-10-23', startPrice: base, seed: seedOf(q.thscode), vol: isIdx ? 0.009 : 0.02, drift: d => (d >= '2025-12-15' && d < '2026-01-12' && q.thscode === '300033.SZ' ? 0.012 : 0) })
      .filter(b => { const d = msToDate(b.date_ms); return d >= start && d <= end; });
    return ok({ timestamp: Date.now(), item: bars });
  }
  if (p === 'news/anomaly/analysis') {
    const evs = makeEvents([
      { date: '2026-01-08', text: `${q.thscode} 合成事件：板块热度上升（模拟数据）`, tag: '大涨' },
      { date: '2026-01-12', time: '14:00', text: `${q.thscode} 合成事件：午后快速拉升（模拟数据）`, tag: '快速拉升' },
      { date: '2026-02-20', text: `${q.thscode} 合成事件：大跌（模拟数据）`, tag: '大跌' },
    ]).filter(e => { const d = msToDate(e.first_publish_time); return d >= q.begin_date && d <= q.end_date; });
    return ok({ items: evs, was_truncated: false });
  }
  if (p === 'meta/tickers/search') return ok({ timestamp: Date.now(), item: [{ thscode: '600519.SH', ticker: '600519', name: '贵州茅台', asset_type: 'a-share' }] });
  return new Response(JSON.stringify({ code: 3001, message: 'mock: not found', data: null }));
}

export async function mockDeepSeekFetch(url, init) {
  const body = JSON.parse(init.body);
  const user = JSON.parse(body.messages[1].content);
  const ids = user.evidence.map(e => e.id);
  const pick = re => ids.find(i => re.test(i));
  const ante = !('hypothesis_check' in user.output_schema);
  const content = ante ? {
    reason_assessment: [
      { text: `理由提到热度高，决策前20日涨跌幅为 ${user.evidence.find(e => /pre_ret_20$/.test(e.id))?.value ?? '—'}，与“热度”描述一致。`, type: 'fact', topic: '走势', refs: [pick(/pre_ret_20$/)].filter(Boolean) },
      { text: '理由没有提及估值或业绩数据，属于主题驱动。', type: 'inference', topic: '理由完整性', refs: [] },
      { text: '退出计划栏未填写。', type: 'fact', topic: '计划与纪律', refs: [pick(/trade_price$/)].filter(Boolean) },
      { text: '后来股价大跌，说明理由不成立。', type: 'fact', refs: [pick(/post_ret_20$/)].filter(Boolean) },
    ],
    hypotheses: (user.trade.hypotheses || '').split(/[；;]/).filter(h => h && h !== '（未填写）').map(h => ({ hypothesis: h, how_to_check: '对照之后的价格与事件' })),
    visible_risks: [{ text: '近期涨幅较大，波动率高。', type: 'fact', topic: '波动', refs: [pick(/pre_vol_20$/)].filter(Boolean) }],
  } : {
    hypothesis_check: (user.ex_ante_review?.hypotheses || []).map(h => ({ hypothesis: h.hypothesis, verdict: '无法判断', text: '现有数据不足以检验', refs: [] })),
    attribution: [
      { factor: '市场环境', text: '交易后基准走势对结果有影响。', confidence: '中', refs: [pick(/post_excess_20$/)].filter(Boolean) },
      { factor: '执行纪律', text: '没有事先写退出计划，下跌后被动卖出，亏损扩大 33.3%。', confidence: '中', refs: [] },
    ],
    uncertainties: [{ text: '事件对股价的影响程度无法量化。' }],
    lessons: [{ text: '买入前写下离场条件。', trigger: '每次买入前', refs: [] }, { text: '建议下次直接买入龙头股。', trigger: '', refs: [] }],
  };
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 1234 } }));
}
