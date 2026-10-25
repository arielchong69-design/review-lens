// 证据相关性校验（确定性规则，不调用 AI，不做关键词匹配）。
//
// 思路：
//  1. 每条证据按其 ID 结构确定“类型”（走势、基准、事件、计划……）和“时序”（决策前/当日部分可知/时序不确定/决策后）。
//  2. AI 为每条结论声明一个“主题”（固定枚举），主题对应一组允许的证据类型和必需的证据类型（固定对照表）。
//  3. 能用结构化字段直接验证的结论（是否填写退出计划、某条规则是否触发），要求 AI 附带 assert 字段，
//     校验器直接对照交易记录与规则结果判定真假，不依赖 AI 标注的主题。
//  4. 数值类主题要求“数值锚定”：结论中至少有一个数值能在其引用的相关证据中找到，
//     以此发现“主题标错但引用了同类型证据”的情况。
//  5. 最终标签由校验器决定：结构化校验通过 / 证据有限 / 无法判断。
//
// 限制：这是“类别 + 数值 + 结构化字段”层面的检查，不是语义蕴含或因果验证。
// 主题标注正确、数值也引用正确，但推理方向或因果解释错误的结论，仍可能通过校验。

export const SUPPORT = { PASS: 'pass', LIMITED: 'limited', UNDETERMINED: 'undetermined' };
export const SUPPORT_LABEL = { pass: '结构化校验通过', limited: '证据有限', undetermined: '无法判断' };
export const SUPPORT_NOTE = '“结构化校验通过”只表示引用的证据存在、时序适用、类型与结论主题匹配且数值可溯源，不代表语义或因果关系已被验证。';

/** 证据类型（可多个）。按 ID 结构判定，与文字内容无关。 */
export function evidenceKinds(e) {
  if (Array.isArray(e?.kinds) && e.kinds.length) return e.kinds;
  const id = String(e?.id || '');
  if (/-ev-/.test(id)) return ['event'];
  if (/-sector_info$/.test(id)) return ['sector_meta'];
  if (/-(post_)?excess_sector(_\d+)?$/.test(id)) return ['outcome', 'sector'];
  if (/-sector(_pre_ret_\d+|_day_ret|_post_ret_\d+)?$/.test(id)) return ['sector'];
  if (/-rec_(reason|hypotheses|exit_plan)$/.test(id)) return ['plan'];
  if (/-rule-[a-z_]+$/.test(id)) return ['rule'];
  if (/^E-rt-/.test(id)) {
    if (/-hold$/.test(id)) return ['holding'];
    if (/-mae$/.test(id)) return ['holding', 'outcome'];
    if (/-bench$/.test(id)) return ['benchmark'];
    if (/-excess$/.test(id)) return ['outcome', 'benchmark'];
    return ['outcome']; // pnl / after
  }
  if (/-bench_/.test(id)) return ['benchmark'];
  if (/-post_excess_\d+$/.test(id)) return ['outcome', 'benchmark'];
  if (/-post_(ret_\d+|mae_20|mfe_20)$/.test(id)) return ['outcome'];
  if (/-(pre_ret_\d+|day_ret)$/.test(id)) return ['momentum'];
  if (/-pre_vol_20$/.test(id)) return ['volatility'];
  if (/-pre_dist_high_60$/.test(id)) return ['position'];
  if (/-pre_vol_ratio$/.test(id)) return ['volume'];
  if (/-(trade_price|day_range)$/.test(id)) return ['execution'];
  return ['other'];
}

/**
 * 时序：pre 决策前已知 / at_decision 决策时点已知（成交价、用户当时记录）/ partial 当日部分可知（收盘口径）/
 *       uncertain 同日但先后不确定 / post 决策后产生
 */
export function evidenceTiming(e) {
  if (e?.timing) return e.timing;
  const id = String(e?.id || '');
  if (e?.phase === 'ex_ante') return /-rec_/.test(id) ? 'at_decision' : 'pre';
  if (e?.phase === 'ex_post') return 'post';
  if (/-trade_price$/.test(id)) return 'at_decision';
  if (/-ev-/.test(id)) return 'uncertain';
  return 'partial';
}

export const TIMING_LABEL = { pre: '决策前已知', at_decision: '决策时点已知', partial: '当日部分可知', uncertain: '同日时序不确定', post: '决策后产生' };

// ---------------- 主题 → 证据类型对照表 ----------------
// allow：可引用的类型；requireAll：必须同时出现的类型；requireAny：至少出现其一；
// anchor：是否要求数值锚定；assert：是否要求结构化断言；cap：该主题能达到的最高标签（受数据覆盖限制）
export const TOPIC_RULES = {
  走势: { allow: ['momentum', 'position', 'volume', 'benchmark', 'sector'], requireAny: ['momentum', 'position'], anchor: true },
  波动: { allow: ['volatility', 'momentum'], requireAny: ['volatility'], anchor: true },
  量能: { allow: ['volume', 'momentum'], requireAny: ['volume'], anchor: true },
  位置: { allow: ['position', 'momentum'], requireAny: ['position'], anchor: true },
  // 比较对象可以是沪深300，也可以是第二比较基准（行业 / 概念指数）
  相对基准: { allow: ['benchmark', 'sector', 'momentum', 'outcome', 'sector_meta'], requireGroups: [['benchmark', 'sector'], ['momentum', 'outcome']], anchor: true },
  成交价位: { allow: ['execution'], requireAny: ['execution'], anchor: true },
  事件信息: { allow: ['event'], requireAny: ['event'], anchor: false },
  计划与纪律: { allow: ['plan', 'rule', 'holding', 'outcome'], assert: true, anchor: false },
  理由完整性: { allow: ['plan', 'rule'], assert: true, anchor: false },
};

export const FACTOR_RULES = {
  市场环境: { allow: ['benchmark', 'outcome', 'momentum'], requireAll: ['benchmark'], anchor: true },
  // 归因是因果判断：相对行业/概念指数的表现差异只能说明“表现不同”，不能证明原因，因此最高“证据有限”
  行业或主题: { allow: ['event', 'benchmark', 'sector', 'outcome', 'sector_meta'], requireAny: ['event', 'sector'], anchor: false, cap: 'limited', capReason: '相对行业/概念指数的表现差异只能说明表现不同，不能证明行业或主题是原因；行业归因最高为“证据有限”', capReasonNoSector: '没有行业或概念比较指数，行业归因最多为“证据有限”' },
  个股事件: { allow: ['event', 'outcome'], requireAny: ['event'], anchor: false },
  买卖时点: { allow: ['momentum', 'position', 'volume', 'volatility', 'execution', 'outcome', 'benchmark', 'sector'], requireAny: ['momentum', 'position', 'volume', 'execution', 'outcome'], anchor: true },
  执行纪律: { allow: ['plan', 'rule', 'holding', 'outcome'], assertOrAnchor: true },
  不确定性: { allow: null, exempt: true },
};

export const HYPOTHESIS_RULES = {
  价格或相对表现: { allow: ['outcome', 'benchmark'], requireAny: ['outcome'], needPost: true, anchor: true },
  事件或消息: { allow: ['event'], requireAny: ['event'], needPost: true, anchor: false },
  基本面或经营: { unsupported: '现有证据库不含财务或经营数据，无法检验该类假设' },
  // 有第二比较基准时可以检验；用户指定且未确认成分关系的基准最高“证据有限”
  行业或板块: { allow: ['sector', 'outcome', 'sector_meta'], requireAny: ['sector'], needPost: true, anchor: true, needSector: true, unsupportedNoSector: '未设置行业或概念比较指数（或获取失败），无法检验该类假设' },
  其他: { unsupported: '假设类型不明确，无法用现有证据检验' },
};

// ---------------- 数值锚定 ----------------
const WINDOW_INTS = new Set([5, 20, 60, 244]);
/** 抽取文本中的数值（去掉日期、常见窗口长度） */
export function numbersIn(text) {
  const s = String(text || '').replace(/\d{4}-\d{2}-\d{2}/g, ' ').replace(/\d{1,2}:\d{2}(:\d{2})?/g, ' ');
  return [...s.matchAll(/[+-]?\d+(?:\.\d+)?/g)].map(m => Math.abs(Number(m[0]))).filter(n => !(Number.isInteger(n) && WINDOW_INTS.has(n)) && n !== 0);
}
function close(a, b) {
  return Math.abs(a - b) <= 0.051 || (b > 100 && Math.abs(a - b) / b <= 0.001);
}
/** 文本是否至少引用了一条证据中的数值 */
export function anchored(text, evs) {
  const tn = numbersIn(text);
  if (!tn.length) return false;
  const en = evs.flatMap(e => numbersIn(e.display ?? e.value));
  return tn.some(a => en.some(b => close(a, b)));
}

// ---------------- 结构化断言 ----------------
/**
 * assert 形如 { field: 'exit_plan', state: 'missing' } 或 { rule: 'chase', status: 'triggered' }。
 * 返回 { ok: true|false|null, refs: [对应证据ID], reason }；null 表示断言格式无效或找不到对应记录。
 */
const FIELD_TEXT = { reason: '当时理由', hypotheses: '关键假设', exit_plan: '退出计划' };
const STATUS_TEXT = { triggered: '触发', clear: '未触发', watch: '值得留意', insufficient: '数据不足' };
export function describeAssert(a) {
  if (a?.field) return `${FIELD_TEXT[a.field] || a.field}${a.state === 'filled' ? '已填写' : '未填写'}`;
  if (a?.rule) return `规则 ${a.rule} ${STATUS_TEXT[a.status] || a.status}`;
  return '';
}

export function checkAssert(assert, evidence) {
  if (!assert || typeof assert !== 'object') return { ok: null, refs: [], reason: '没有结构化断言' };
  if (assert.field) {
    const e = evidence.find(x => new RegExp(`-rec_${assert.field}$`).test(x.id));
    if (!e || !['filled', 'missing'].includes(assert.state)) return { ok: null, refs: [], reason: `断言字段 ${assert.field} 无法核对` };
    return { ok: e.state === assert.state, refs: [e.id], reason: e.state === assert.state ? '与交易记录一致' : `与交易记录不符：记录显示“${e.state === 'filled' ? '已填写' : '未填写'}”` };
  }
  if (assert.rule) {
    const e = evidence.find(x => new RegExp(`-rule-${assert.rule}$`).test(x.id));
    if (!e || !assert.status) return { ok: null, refs: [], reason: `断言规则 ${assert.rule} 无法核对` };
    return { ok: e.status === assert.status, refs: [e.id], reason: e.status === assert.status ? '与规则检查结果一致' : `与规则检查结果不符：实际为“${e.status}”` };
  }
  return { ok: null, refs: [], reason: '断言格式无效' };
}

/**
 * 评估一条结论。
 * @param section 'ex_ante' | 'ex_post'
 * @param key 所在列表
 * @param item 已经过存在性检查的结论（refs 只含存在的 ID）
 * @param byId 证据索引；evidence 证据全集
 * @returns { support, kept: [id], irrelevant: [{id,reason}], notes: [string], contradicted: string|null, rule: 主题规则或 null }
 */
export function evaluateClaim(section, key, item, byId, evidence, text) {
  const notes = [];
  const irrelevant = [];
  let rule = null, topicName = null;
  if (key === 'attribution') { topicName = item.factor; rule = FACTOR_RULES[item.factor] || null; }
  else if (key === 'hypothesis_check') { topicName = item.hypothesis_type; rule = HYPOTHESIS_RULES[item.hypothesis_type] || HYPOTHESIS_RULES.其他; }
  else { topicName = item.topic; rule = TOPIC_RULES[item.topic] || null; }

  // 结构化断言优先：不依赖主题，直接对照记录
  const a = checkAssert(item.assert, evidence);
  if (a.ok === false) return { support: SUPPORT.UNDETERMINED, kept: [], irrelevant, notes: [a.reason], contradicted: a.reason, rule };
  let refs = [...new Set([...(item.refs || []), ...(a.ok ? a.refs : [])])];
  // 断言只核对了一个结构化事实（如“退出计划未填写”），结论中对它的解读并未被验证，必须写明
  if (a.ok) notes.push(`结构化断言已核对：${describeAssert(item.assert)}（${a.reason}）；结论中的其余解读未经验证`);

  if (rule?.exempt) return { support: null, kept: refs, irrelevant, notes, contradicted: null, rule };
  const sectorMeta = evidence.find(e => evidenceKinds(e).includes('sector_meta'));
  const hasSectorSeries = evidence.some(e => evidenceKinds(e).includes('sector') && e.value != null);
  if (rule?.needSector && !hasSectorSeries) {
    return { support: SUPPORT.UNDETERMINED, kept: refs, irrelevant, notes: [rule.unsupportedNoSector], contradicted: null, rule };
  }
  if (rule?.unsupported) {
    return { support: SUPPORT.UNDETERMINED, kept: refs, irrelevant, notes: [rule.unsupported], contradicted: null, rule };
  }
  if (!rule) {
    notes.push(topicName ? `主题“${topicName}”不在对照表中，无法做相关性校验` : '没有声明主题，无法做相关性校验');
    return { support: SUPPORT.LIMITED, kept: refs, irrelevant, notes, contradicted: null, rule };
  }

  // 相关性：类型不在允许范围内的引用移除；值缺失的证据（如窗口未走完）视为缺失
  const kept = [];
  for (const id of refs) {
    const e = byId.get(id);
    if (e && (e.value == null || e.value === '' || e.display === '—')) { irrelevant.push({ id, reason: '该证据没有取到数值（数据缺失或窗口未走完）' }); continue; }
    const kinds = evidenceKinds(e);
    // 经结构化断言核对过的证据是确定性依据，不受主题对照表限制
    if (a.ok && a.refs.includes(id)) { kept.push(id); continue; }
    if (rule.allow && !kinds.some(k => rule.allow.includes(k))) irrelevant.push({ id, reason: `证据类型（${kinds.join('/')}）与主题“${topicName}”不匹配` });
    else kept.push(id);
  }

  // 时序：事前结论中，“当日部分可知”“时序不确定”的证据不能作为充分支撑
  let supporting = kept;
  if (section === 'ex_ante') {
    const weak = kept.filter(id => ['partial', 'uncertain'].includes(evidenceTiming(byId.get(id))));
    if (weak.length) {
      supporting = kept.filter(id => !weak.includes(id));
      notes.push(`${weak.map(id => `${byId.get(id).label || id}（${TIMING_LABEL[evidenceTiming(byId.get(id))]}）`).join('、')}不能作为事前结论的充分支撑`);
    }
  }
  if (rule.needPost) {
    const post = supporting.filter(id => evidenceTiming(byId.get(id)) === 'post');
    if (!post.length) { notes.push('检验假设需要决策后的证据，当前引用中没有'); return { support: SUPPORT.UNDETERMINED, kept, irrelevant, notes, contradicted: null, rule }; }
  }

  const kindsOf = ids => new Set(ids.flatMap(id => evidenceKinds(byId.get(id))));
  const have = kindsOf(supporting);
  let support = SUPPORT.PASS;
  if (!supporting.length && !(rule.assert || rule.assertOrAnchor) ) { support = SUPPORT.LIMITED; notes.push('没有与主题相关且时序适用的证据'); }
  if (rule.requireAll && !rule.requireAll.every(k => have.has(k))) { support = SUPPORT.LIMITED; notes.push(`主题“${topicName}”需要 ${rule.requireAll.join('、')} 类证据`); }
  if (rule.requireAny && !rule.requireAny.some(k => have.has(k))) { support = SUPPORT.LIMITED; notes.push(`主题“${topicName}”需要 ${rule.requireAny.join(' 或 ')} 类证据`); }
  for (const g of rule.requireGroups || []) if (!g.some(k => have.has(k))) { support = SUPPORT.LIMITED; notes.push(`主题“${topicName}”需要 ${g.join(' 或 ')} 类证据`); }
  if (rule.assert && a.ok !== true) { support = SUPPORT.LIMITED; notes.push('计划与纪律类结论需要可核对的结构化断言（如退出计划是否填写、规则是否触发）'); }
  if (rule.assertOrAnchor && a.ok !== true && !anchored(text, supporting.map(id => byId.get(id)))) { support = SUPPORT.LIMITED; notes.push('既没有可核对的结构化断言，也没有引用到证据中的数值'); }
  if (rule.anchor && support === SUPPORT.PASS && !anchored(text, supporting.map(id => byId.get(id)))) {
    support = SUPPORT.LIMITED;
    notes.push(anchored(text, kept.map(id => byId.get(id)))
      ? '结论依据的数值来自当日部分可知或时序不确定的证据'
      : '结论中没有出现所引用证据的数值，无法确认结论来自这些证据（可能是主题标注有误）');
  }
  if (rule.cap === 'limited' && support === SUPPORT.PASS) { support = SUPPORT.LIMITED; notes.push(hasSectorSeries || !rule.capReasonNoSector ? rule.capReason : rule.capReasonNoSector); }
  // 引用了用户指定、未确认成分关系的比较指数：不能作为“该股所属板块”的检验依据
  if (key === 'hypothesis_check' && support === SUPPORT.PASS && sectorMeta?.sector_role === 'user_specified' && have.has('sector')) {
    support = SUPPORT.LIMITED; notes.push('比较指数为用户指定，未确认该股票属于此指数，不能代表该股所属板块');
  }
  // 复合结论：被移除的主题外引用，其数值确实出现在结论里 → 结论有一部分内容没有通过主题校验，不能整体通过
  const usedOffTopic = irrelevant.filter(x => !/没有取到数值/.test(x.reason) && byId.get(x.id) && anchored(text, [byId.get(x.id)]));
  if (usedOffTopic.length && support === SUPPORT.PASS) {
    support = SUPPORT.LIMITED;
    notes.push(`结论还用到了主题之外的证据（${usedOffTopic.map(x => byId.get(x.id).label).join('、')}），这部分没有通过主题校验`);
  }
  // AI 自评只能降级，不能升级
  if (item.support === 'partial' && support === SUPPORT.PASS) { support = SUPPORT.LIMITED; notes.push('AI 自评为“部分支撑”'); }
  // 称谓核对：只有“行业指数 + 当前成分股”才能称为所属行业
  if (sectorMeta && /所属行业/.test(text) && sectorMeta.sector_role !== 'industry_member' && support === SUPPORT.PASS) {
    support = SUPPORT.LIMITED;
    notes.push(`结论把比较指数称为“所属行业”，但核实结果为：${sectorMeta.display}`);
  }
  return { support, kept, irrelevant, notes, contradicted: null, rule };
}
