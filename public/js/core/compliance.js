// 合规过滤：产品不得输出确定性涨跌预测、收益承诺或直接买卖建议。
// 规则按句子匹配，命中则整句替换，并保留命中记录供 UI 展示与测试。

export const COMPLIANCE_RULES = [
  // 允许中间夹几个字（“建议下次直接买入”），但排除“买入前/买入时/买入理由”这类过程性表述
  { id: 'trade_advice', label: '直接买卖建议', re: /(建议|推荐|应该|应当|可以考虑|值得|不妨|赶紧|立即|马上)[^。；;，,！!？?]{0,8}?(买入|卖出|加仓|减仓|清仓|满仓|抄底|上车|建仓|止盈出局|持有该股|继续持有)(?!前|时|之前|的?理由|的?计划|的?条件|决策)/ },
  { id: 'trade_advice2', label: '直接买卖建议', re: /(买入|卖出|加仓|减仓)\s*(信号|时机已到|机会来了|良机)/ },
  { id: 'target_price', label: '目标价', re: /目标价|目标位\s*\d|看到\s*\d+(\.\d+)?\s*元/ },
  { id: 'certain_forecast', label: '确定性涨跌预测', re: /(必然|必将|必定|一定会|肯定会|注定|势必|铁定)\s*(上涨|下跌|大涨|大跌|涨|跌|反弹|突破|新高)|必涨|必跌|稳涨/ },
  { id: 'future_forecast', label: '涨跌预测', re: /(将|会|即将|有望)\s*(大幅)?\s*(上涨|下跌|涨到|跌到|涨至|跌至)\s*\d*|(明天|下周|下个月|未来[一二三两\d]+[天周月])\s*(会|将)?\s*(涨|跌)/ },
  { id: 'return_promise', label: '收益承诺', re: /稳赚|保本|保证收益|保证盈利|收益承诺|无风险套利|零风险|包赚|翻倍没问题|躺赚/ },
];

export function splitSentences(text) {
  return String(text || '').split(/(?<=[。！？!?；;\n])/).filter(s => s.length);
}

/**
 * @returns {{ text: string, hits: Array<{rule:string,label:string,sentence:string}> }}
 */
export function filterCompliance(text) {
  const hits = [];
  const out = splitSentences(text).map(sentence => {
    for (const r of COMPLIANCE_RULES) {
      if (r.re.test(sentence)) {
        hits.push({ rule: r.id, label: r.label, sentence: sentence.trim() });
        return `【已过滤：此句涉及${r.label}，本产品不提供】`;
      }
    }
    return sentence;
  }).join('');
  return { text: out, hits };
}

export function isCompliant(text) {
  return filterCompliance(text).hits.length === 0;
}

export const DISCLAIMER = '本工具只复盘历史决策过程，不预测涨跌，不构成任何投资建议。事实、规则推断与 AI 推断已分别标注。';
