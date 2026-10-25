// 示例交易：为演示构造的匿名投资者记录（不对应任何真实用户）。
// 标的、日期和行情真实（扶摇接口）；理由、假设和成交价为构造内容，成交价均落在当日真实价格区间内。
// 比亚迪一笔故意不填成交价，用来演示“以收盘价代替并标注为假设”。
// 比较指数（第二比较基准）均已在扶摇同花顺指数目录与当前成分股中核实（2026-10-25）：
//   茅台→881273.TI 白酒（行业）、同花顺→886108.TI AI应用（概念）、中国平安→881156.TI 保险（行业）、比亚迪→884099.TI 乘用车（行业）。
export const SAMPLE_TRADES = [
  { id: 's1', date: '2025-12-01', time: '', thscode: '600519.SH', name: '贵州茅台', sector_code: '881273.TI', side: '买入', price: 1450, qty: 100,
    reason: '估值处于近几年低位，股息率有吸引力，打算长期持有一年以上。', hypotheses: '白酒需求企稳；公司维持高分红', exit_plan: '跌破止损-10%离场', confidence: 3 },
  { id: 's2', date: '2026-01-12', time: '10:15', thscode: '300033.SZ', name: '同花顺', sector_code: '886108.TI', side: '买入', price: 386.5, qty: 200,
    reason: 'AI 应用是今年主线，同花顺是金融 AI 龙头，早盘看到异动提醒说在大涨，怕踏空，先上车。', hypotheses: 'AI 应用板块热度继续；一季度经纪与广告业务改善', exit_plan: '', confidence: 4 },
  { id: 's3', date: '2026-01-20', time: '', thscode: '600519.SH', name: '贵州茅台', sector_code: '881273.TI', side: '卖出', price: 1376, qty: 100,
    reason: '拿了一个多月没什么起色，先卖掉换别的。', hypotheses: '', exit_plan: '', confidence: 2 },
  { id: 's4', date: '2026-01-28', time: '14:20', thscode: '600519.SH', name: '贵州茅台', sector_code: '881273.TI', side: '买入', price: 1330, qty: 100,
    reason: '跌了这么多，感觉要反弹了，抄个底。', hypotheses: '', exit_plan: '', confidence: 3 },
  { id: 's5', date: '2026-02-05', time: '', thscode: '600519.SH', name: '贵州茅台', sector_code: '881273.TI', side: '卖出', price: 1550, qty: 100,
    reason: '一周涨了这么多，赶紧落袋为安。', hypotheses: '', exit_plan: '', confidence: 4 },
  { id: 's6', date: '2026-02-10', time: '', thscode: '601318.SH', name: '中国平安', sector_code: '881156.TI', side: '买入', price: 68.4, qty: 300,
    reason: '保险股估值低、负债端改善，短线博反弹。', hypotheses: '新单保费回暖；长端利率企稳', exit_plan: '止盈+10%，止损-6%', confidence: 3 },
  { id: 's7', date: '2026-03-04', time: '', thscode: '600519.SH', name: '贵州茅台', sector_code: '881273.TI', side: '买入', price: 1405, qty: 100,
    reason: '回调到 1400 附近，作为底仓长期配置，考虑到近期波动大，仓位只用一成。', hypotheses: '春节后动销恢复；批价企稳', exit_plan: '止损-10%；持有一年以上', confidence: 3 },
  { id: 's8', date: '2026-03-09', time: '', thscode: '300033.SZ', name: '同花顺', sector_code: '886108.TI', side: '卖出', price: 312.5, qty: 200,
    reason: '跌得受不了了，先卖了避险。', hypotheses: '', exit_plan: '', confidence: 1 },
  { id: 's9', date: '2026-04-20', time: '', thscode: '601318.SH', name: '中国平安', sector_code: '881156.TI', side: '卖出', price: 58.1, qty: 300,
    reason: '一直没回本，拖了很久，最后还是卖了。', hypotheses: '', exit_plan: '', confidence: 2 },
  { id: 's10', date: '2026-05-18', time: '', thscode: '002594.SZ', name: '比亚迪', sector_code: '884099.TI', side: '买入', price: '', qty: 100,
    reason: '新车型发布，销量预期强。', hypotheses: '新车型订单超预期', exit_plan: '', confidence: 3 },
  { id: 's11', date: '2026-06-15', time: '', thscode: '600519.SH', name: '贵州茅台', sector_code: '881273.TI', side: '卖出', price: 1275, qty: 100,
    reason: '跌到止损线附近，买入时的假设没有兑现，按计划离场。', hypotheses: '', exit_plan: '', confidence: 3 },
];
