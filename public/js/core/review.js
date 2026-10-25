// AI 复盘：两阶段提示词（事前视角 / 事后视角）、输出校验、规则兜底。
// 浏览器与 Cloudflare Functions 共用本文件。
import { filterCompliance, DISCLAIMER } from './compliance.js';
import { pct } from './context.js';
import { STATUS_LABEL } from './biases.js';

export const HINDSIGHT_RE = /后来|之后|事后|最终|结果证明|事实证明|随后|此后|接下来|后续(走势|表现)|卖出后|买入后.*(涨|跌)/;

/** 压缩证据，减少 token：只保留模型需要的字段 */
export function compactEvidence(list) {
  return list.filter(e => e.value != null && e.value !== '').map(e => ({ id: e.id, phase: e.phase, label: e.label, value: e.display ?? e.value, as_of: e.as_of || null }));
}

export function buildExAntePrompt(pack) {
  const ev = compactEvidence(pack.evidence.filter(e => e.phase === 'ex_ante' || e.phase === 'same_day'));
  const system = [
    '你是投资复盘教练，只做“过程复盘”，帮助用户还原决策当时的信息与假设。',
    '硬性规则：',
    '1. 你现在只能看到决策当时已知或部分可知的证据（phase=ex_ante 或 same_day）。不得猜测或提及交易之后发生的任何事情，不得使用“后来、最终、结果证明”等事后措辞。',
    '2. 每条 type=fact 的结论必须在 refs 中引用证据 id；没有证据支撑的判断标为 type=inference，并说明依据。',
    '3. 不预测涨跌，不给买卖、仓位或目标价建议，不承诺收益。',
    '4. 数字只能来自证据，原样引用，不要自行计算新数字。',
    '5. 只输出 JSON，中文，简洁。',
  ].join('\n');
  const user = {
    task: '从决策当时的视角评估这笔交易的理由',
    trade: pickTrade(pack.trade),
    rule_checks: (pack.biases || []).filter(b => b.phase !== 'ex_post').map(b => ({ name: b.name, status: STATUS_LABEL[b.status], detail: b.detail })),
    evidence: ev,
    output_schema: {
      reason_assessment: [{ text: '理由与当时证据是否一致、哪些部分有证据、哪些没有', type: 'fact|inference', refs: ['证据id'] }],
      hypotheses: [{ hypothesis: '从理由中拆出的可检验假设', how_to_check: '用什么数据、在什么时间点可以检验' }],
      visible_risks: [{ text: '当时就能看到的风险信号', type: 'fact|inference', refs: ['证据id'] }],
    },
  };
  return { system, user: JSON.stringify(user) };
}

export function buildExPostPrompt(pack, exAnte) {
  const ev = compactEvidence(pack.evidence);
  const system = [
    '你是投资复盘教练。现在可以看到交易前后的全部证据，任务是：检验当时的假设、做归因、提炼可复用的经验。',
    '硬性规则：',
    '1. 区分“当时可知”和“事后才知道”：评价当时的决策只能依据 phase=ex_ante/same_day 的证据；phase=ex_post 的证据只能用来检验假设和描述后续变化，不能用来指责当时“应该知道”。',
    '2. 每条 type=fact 的结论必须引用证据 id；归因要给出 confidence（高/中/低），证据不足时写“无法判断”，不要硬凑。',
    '3. 结果好不等于决策好，结果差不等于决策差，要说明运气与不确定性的成分。',
    '4. 不预测涨跌，不给买卖、仓位或目标价建议，不承诺收益。经验应是“决策过程”层面的规则，例如“买入前写下离场条件”，而不是“下次买/卖某股票”。',
    '5. 数字只能来自证据，原样引用。只输出 JSON，中文，简洁。',
  ].join('\n');
  const user = {
    task: '检验假设、归因、提炼经验',
    trade: pickTrade(pack.trade),
    round_trip: pack.round_trip ? { buy_date: pack.round_trip.buy_date, sell_date: pack.round_trip.sell_date, pnl: pct(pack.round_trip.pnl_pct), excess: pct(pack.round_trip.excess), holding_days: pack.round_trip.holding_days } : null,
    process_outcome: pack.process_outcome ? { quadrant: pack.process_outcome.quadrant, score: `${pack.process_outcome.score}/5` } : null,
    rule_checks: (pack.biases || []).map(b => ({ name: b.name, status: STATUS_LABEL[b.status], detail: b.detail })),
    ex_ante_review: exAnte ? { hypotheses: exAnte.hypotheses } : null,
    evidence: ev,
    output_schema: {
      hypothesis_check: [{ hypothesis: '假设', verdict: '成立|不成立|无法判断', text: '依据', refs: ['证据id'] }],
      attribution: [{ factor: '市场环境|行业或主题|个股事件|买卖时点|执行纪律|不确定性', text: '说明', confidence: '高|中|低', refs: ['证据id'] }],
      uncertainties: [{ text: '哪些因素无法从现有数据判断' }],
      lessons: [{ text: '可复用的过程经验（一句话）', trigger: '下次在什么情况下提醒自己', refs: ['证据id'] }],
    },
  };
  return { system, user: JSON.stringify(user) };
}

function pickTrade(t) {
  return { id: t.id, date: t.aligned_date || t.date, time: t.time, code: t.thscode, name: t.name, side: t.side === 'buy' ? '买入' : '卖出', price: t.effective_price ?? t.price, qty: t.qty, reason: t.reason || '（未填写）', hypotheses: t.hypotheses || '（未填写）', exit_plan: t.exit_plan || '（未填写）', confidence: t.confidence };
}

export function safeParseJSON(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1];
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

/** 抽取文本中的百分数，用于数字溯源检查 */
function percentsIn(text) {
  return [...String(text).matchAll(/([+-]?\d+(?:\.\d+)?)\s*%/g)].map(m => Number(m[1]));
}

/**
 * 校验并清洗 AI 输出。
 * @param section 'ex_ante' | 'ex_post'
 * @param obj 模型 JSON
 * @param evidence 证据全集（含 phase）
 * @returns { data, report }
 */
export function validateAIOutput(section, obj, evidence) {
  const byId = new Map(evidence.map(e => [e.id, e]));
  const report = { total: 0, passed: 0, removed: [], downgraded: [], compliance: [], untraced_numbers: [] };
  const lists = section === 'ex_ante' ? ['reason_assessment', 'hypotheses', 'visible_risks'] : ['hypothesis_check', 'attribution', 'uncertainties', 'lessons'];
  const data = {};
  for (const key of lists) {
    const arr = Array.isArray(obj?.[key]) ? obj[key] : [];
    data[key] = [];
    for (const raw of arr.slice(0, 8)) {
      if (!raw || typeof raw !== 'object') continue;
      report.total++;
      const item = { ...raw };
      const textFields = ['text', 'hypothesis', 'how_to_check', 'trigger'].filter(f => typeof item[f] === 'string');
      const joined = textFields.map(f => item[f]).join(' ');
      // 1) 引用存在性
      const refs = Array.isArray(item.refs) ? item.refs.filter(r => typeof r === 'string') : [];
      const valid = refs.filter(r => byId.has(r));
      const invalid = refs.filter(r => !byId.has(r));
      item.refs = valid;
      if (invalid.length) item.invalid_refs = invalid;
      // 2) 后见之明：事前段落不得引用事后证据或使用事后措辞
      if (section === 'ex_ante') {
        const postRefs = valid.filter(r => byId.get(r).phase === 'ex_post');
        // “假设”条目天然要描述未来如何检验，只检查引用，不检查措辞
        const wordingHit = key !== 'hypotheses' && HINDSIGHT_RE.test(joined);
        if (postRefs.length || wordingHit) {
          report.removed.push({ key, text: joined, reason: postRefs.length ? `事前评估引用了事后证据 ${postRefs.join(', ')}` : '事前评估使用了事后措辞（后见之明）' });
          continue;
        }
      }
      // 3) 事实必须有有效引用，否则降级为推断
      if ((item.type === 'fact' || key === 'hypothesis_check' || key === 'attribution') && !valid.length && !(key === 'hypothesis_check' && item.verdict === '无法判断')) {
        if (item.type === 'fact') { item.type = 'inference'; report.downgraded.push({ key, text: joined, reason: invalid.length ? `引用的证据不存在：${invalid.join(', ')}` : '标为事实但没有引用证据' }); }
        else if (key === 'attribution') { item.confidence = '低'; item.unreferenced = true; report.downgraded.push({ key, text: joined, reason: '归因没有引用证据，置信度降为“低”' }); }
        else if (key === 'hypothesis_check') { item.verdict = '无法判断'; report.downgraded.push({ key, text: joined, reason: '假设检验没有引用证据，结论改为“无法判断”' }); }
      }
      if (!item.type && key !== 'uncertainties' && key !== 'lessons' && key !== 'hypotheses') item.type = valid.length ? 'fact' : 'inference';
      // 4) 数字溯源：文本中的百分数应能在引用证据（或全部证据）中找到
      const nums = percentsIn(joined);
      if (nums.length) {
        const pool = (valid.length ? valid.map(r => byId.get(r)) : evidence).flatMap(e => percentsIn(e.display ?? ''));
        const allPool = evidence.flatMap(e => percentsIn(e.display ?? ''));
        for (const n of nums) {
          const hit = pool.some(p => Math.abs(Math.abs(p) - Math.abs(n)) <= 0.051) || allPool.some(p => Math.abs(Math.abs(p) - Math.abs(n)) <= 0.051);
          if (!hit) { report.untraced_numbers.push({ key, number: `${n}%`, text: joined }); item.untraced = true; }
        }
      }
      // 5) 合规过滤
      for (const f of textFields) {
        const { text, hits } = filterCompliance(item[f]);
        if (hits.length) { item[f] = text; report.compliance.push(...hits); }
      }
      // 规范化枚举
      if (key === 'hypothesis_check' && !['成立', '不成立', '无法判断'].includes(item.verdict)) item.verdict = '无法判断';
      if (key === 'attribution' && !['高', '中', '低'].includes(item.confidence)) item.confidence = '低';
      data[key].push(item);
      report.passed++;
    }
  }
  return { data, report };
}

/**
 * 规则兜底：AI 不可用时，用确定性规则生成同结构的复盘，明确标注来源。
 */
export function ruleBasedReview(pack) {
  const t = pack.trade, m = pack.metrics || {};
  const id = k => `E-${t.id}-${k}`;
  const has = k => pack.evidence.some(e => e.id === id(k) && e.value != null);
  const exAnte = { reason_assessment: [], hypotheses: [], visible_risks: [] };
  if (t.reason) exAnte.reason_assessment.push({ text: `当时理由：“${t.reason}”。规则引擎无法理解理由语义，请对照下方事前证据自行判断是否一致。`, type: 'inference', refs: [] });
  else exAnte.reason_assessment.push({ text: '没有填写当时理由，无法评估决策依据。', type: 'fact', refs: [] });
  if (has('pre_ret_20')) exAnte.reason_assessment.push({ text: `决策前20个交易日该股涨跌幅为 ${pct(m.pre_ret_20)}，同期基准 ${pct(m.bench_pre_ret_20)}。`, type: 'fact', refs: [id('pre_ret_20'), id('bench_pre_ret_20')].filter(r => pack.evidence.some(e => e.id === r)) });
  if (t.hypotheses) t.hypotheses.split(/[；;\n]/).filter(Boolean).forEach(h => exAnte.hypotheses.push({ hypothesis: h.trim(), how_to_check: '对照交易后的价格与事件证据' }));
  for (const b of pack.biases || []) if (b.status === 'triggered' && b.phase !== 'ex_post') exAnte.visible_risks.push({ text: `${b.name}：${b.detail}`, type: 'fact', refs: (b.evidence || []).filter(r => pack.evidence.some(e => e.id === r)) });

  const exPost = { hypothesis_check: [], attribution: [], uncertainties: [], lessons: [] };
  exAnte.hypotheses.forEach(h => exPost.hypothesis_check.push({ hypothesis: h.hypothesis, verdict: '无法判断', text: '规则引擎无法自动判断文字假设，请结合事后证据人工确认', refs: [] }));
  if (has('post_excess_20')) {
    const ex = m.post_excess_20, br = m.bench_post_ret_20;
    exPost.attribution.push({ factor: '市场环境', text: `交易后20个交易日基准涨跌 ${pct(br)}，个股相对基准超额 ${pct(ex)}。`, confidence: '中', refs: [id('post_excess_20'), id('post_ret_20')] });
  }
  if (pack.round_trip) exPost.attribution.push({ factor: '执行纪律', text: `该回合持有 ${pack.round_trip.holding_days ?? '—'} 个交易日，收益 ${pct(pack.round_trip.pnl_pct)}，超额 ${pct(pack.round_trip.excess)}。`, confidence: '中', refs: [`E-rt-${pack.round_trip.buy_id}-${pack.round_trip.sell_id}-pnl`, `E-rt-${pack.round_trip.buy_id}-${pack.round_trip.sell_id}-excess`] });
  exPost.uncertainties.push({ text: '规则引擎不读取新闻语义，个股事件对价格的影响无法量化。' });
  for (const b of pack.biases || []) if (b.status === 'triggered') exPost.lessons.push({ text: LESSON_TEMPLATES[b.id] || `留意“${b.name}”`, trigger: b.rule, refs: b.evidence || [] });
  return { ex_ante: exAnte, ex_post: exPost };
}

export const LESSON_TEMPLATES = {
  chase: '买入前20日已大涨或贴近阶段高点时，先写下“为什么这次不是追高”，并设好离场条件再下单。',
  no_exit_plan: '每次买入前写下止损和止盈条件。',
  no_reason: '每笔交易至少写一句理由和一个可检验的假设。',
  panic_sell: '大盘急跌当天想卖出时，先对照买入时的假设是否被证伪，而不是看当日涨跌。',
  stop_breach: '止损线一旦写下就按计划执行；如果要改，先写下改的理由。',
  plan_drift: '持有周期和买入时的计划不一致时，先判断理由是否变了。',
  disposition: '盈利单不要只因为“已经赚了”就卖，亏损单不要只因为“还没回本”就拿着，回到最初假设判断。',
};

export { DISCLAIMER };
