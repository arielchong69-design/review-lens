// 示例交易：为演示构造的匿名投资者记录（不对应任何真实用户）。
// 标的与日期真实存在，行情与事件来自扶摇接口；理由、假设、成交价为构造内容。
// 成交价留空的记录，系统会用当日不复权收盘价代替并标注为“假设”。
export const SAMPLE_TRADES = [
  { id: 's1', date: '2025-12-01', time: '', thscode: '600519.SH', name: '贵州茅台', side: '买入', price: '', qty: 100,
    reason: '估值处于近几年低位，股息率有吸引力，打算长期持有。', hypotheses: '白酒需求企稳；公司维持高分红', exit_plan: '跌破止损-10%离场；否则持有一年以上', confidence: 3 },
  { id: 's2', date: '2026-01-12', time: '10:15', thscode: '300033.SZ', name: '同花顺', side: '买入', price: '', qty: 200,
    reason: 'AI 应用是今年主线，同花顺是金融 AI 龙头，最近讨论度很高，怕踏空，先上车。', hypotheses: 'AI 应用板块热度继续；一季度经纪与广告业务改善', exit_plan: '', confidence: 4 },
  { id: 's3', date: '2026-01-20', time: '', thscode: '600519.SH', name: '贵州茅台', side: '卖出', price: '', qty: 50,
    reason: '赚了一点，先落袋一半。', hypotheses: '', exit_plan: '', confidence: 2 },
  { id: 's4', date: '2026-02-10', time: '', thscode: '601318.SH', name: '中国平安', side: '买入', price: '', qty: 300,
    reason: '保险股估值低、负债端改善，短线博反弹。', hypotheses: '新单保费回暖；长端利率企稳', exit_plan: '止盈+10%，止损-6%', confidence: 3 },
  { id: 's5', date: '2026-03-09', time: '', thscode: '300033.SZ', name: '同花顺', side: '卖出', price: '', qty: 200,
    reason: '跌得受不了了，先卖了避险。', hypotheses: '', exit_plan: '', confidence: 1 },
  { id: 's6', date: '2026-04-20', time: '', thscode: '601318.SH', name: '中国平安', side: '卖出', price: '', qty: 300,
    reason: '一直没回本，拖了很久，最后还是卖了。', hypotheses: '', exit_plan: '', confidence: 2 },
  { id: 's7', date: '2026-05-18', time: '', thscode: '002594.SZ', name: '比亚迪', side: '买入', price: '', qty: 100,
    reason: '新车型发布，销量预期强。', hypotheses: '新车型订单超预期', exit_plan: '', confidence: 3 },
  { id: 's8', date: '2026-06-15', time: '', thscode: '600519.SH', name: '贵州茅台', side: '卖出', price: '', qty: 50,
    reason: '白酒动销数据不及预期，买入时的假设被证伪，按计划离场。', hypotheses: '', exit_plan: '', confidence: 3 },
];
