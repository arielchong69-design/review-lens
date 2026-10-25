// 交易记录：解析、校验、FIFO 配对成"回合"（round trip）。
import { normalizeDate } from './dates.js';

export const THSCODE_RE = /^\d{6}\.(SH|SZ|BJ)$/;

const SIDE_MAP = { '买': 'buy', '买入': 'buy', 'buy': 'buy', 'b': 'buy', '卖': 'sell', '卖出': 'sell', 'sell': 'sell', 's': 'sell' };

export const CSV_HEADERS = ['日期', '时间', '代码', '名称', '方向', '价格', '数量', '当时理由', '关键假设', '退出计划', '信心'];

/** 极简 CSV 解析（支持双引号转义、字段内逗号与换行） */
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(v => v.trim() !== '')) rows.push(row);
  return rows;
}

export function toCSV(trades) {
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [CSV_HEADERS.join(',')];
  for (const t of trades) {
    lines.push([t.date, t.time || '', t.thscode, t.name || '', t.side === 'buy' ? '买入' : '卖出',
      t.price ?? '', t.qty, t.reason || '', t.hypotheses || '', t.exit_plan || '', t.confidence ?? ''].map(esc).join(','));
  }
  return lines.join('\n');
}

/**
 * 把原始对象（来自 CSV 行或表单）规范化并校验。
 * 返回 { trade, errors: string[], warnings: string[] }
 */
export function normalizeTrade(raw, idx = 0) {
  const errors = [], warnings = [];
  const date = normalizeDate(raw.date);
  if (!date) errors.push(`第${idx + 1}条：日期“${raw.date ?? ''}”无法识别（示例 2025-03-18）`);
  let time = (raw.time || '').trim();
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) { warnings.push(`第${idx + 1}条：时间“${time}”格式不对，已忽略`); time = ''; }
  const thscode = String(raw.thscode || '').trim().toUpperCase();
  if (!THSCODE_RE.test(thscode)) errors.push(`第${idx + 1}条：代码“${raw.thscode ?? ''}”需为完整 thscode，如 600519.SH`);
  const side = SIDE_MAP[String(raw.side || '').trim().toLowerCase()] || SIDE_MAP[String(raw.side || '').trim()];
  if (!side) errors.push(`第${idx + 1}条：方向需为“买入”或“卖出”`);
  const qty = Number(raw.qty);
  if (!(qty > 0)) errors.push(`第${idx + 1}条：数量需为正数`);
  let price = raw.price === '' || raw.price == null ? null : Number(raw.price);
  if (price !== null && !(price > 0)) { errors.push(`第${idx + 1}条：价格需为正数或留空`); price = null; }
  if (price === null) warnings.push(`第${idx + 1}条：未填成交价，将以当日收盘价（不复权）代替，并在复盘中标注为“假设”`);
  let confidence = raw.confidence === '' || raw.confidence == null ? null : Number(raw.confidence);
  if (confidence !== null && !(confidence >= 1 && confidence <= 5)) { warnings.push(`第${idx + 1}条：信心应为1–5，已忽略`); confidence = null; }
  const reason = String(raw.reason || '').trim();
  if (!reason) warnings.push(`第${idx + 1}条：没有填写当时理由，过程质量将无法评估`);
  return {
    trade: {
      id: raw.id || `t${idx + 1}`,
      date, time: time || null, thscode, name: String(raw.name || '').trim(), side, qty, price,
      price_assumed: price === null,
      reason, hypotheses: String(raw.hypotheses || '').trim(), exit_plan: String(raw.exit_plan || '').trim(),
      confidence,
    },
    errors, warnings,
  };
}

/** CSV 文本 -> { trades, errors, warnings } */
export function parseTradesCSV(text) {
  const rows = parseCSV(text);
  if (!rows.length) return { trades: [], errors: ['文件为空'], warnings: [] };
  const header = rows[0].map(h => h.trim());
  const col = name => header.indexOf(name);
  const required = ['日期', '代码', '方向', '数量'];
  const missing = required.filter(h => col(h) < 0);
  if (missing.length) return { trades: [], errors: [`缺少表头：${missing.join('、')}。请使用模板：${CSV_HEADERS.join(',')}`], warnings: [] };
  const get = (r, name) => (col(name) >= 0 ? r[col(name)] : '');
  const trades = [], errors = [], warnings = [];
  rows.slice(1).forEach((r, i) => {
    const { trade, errors: e, warnings: w } = normalizeTrade({
      date: get(r, '日期'), time: get(r, '时间'), thscode: get(r, '代码'), name: get(r, '名称'),
      side: get(r, '方向'), price: get(r, '价格'), qty: get(r, '数量'), reason: get(r, '当时理由'),
      hypotheses: get(r, '关键假设'), exit_plan: get(r, '退出计划'), confidence: get(r, '信心'),
    }, i);
    errors.push(...e); warnings.push(...w);
    if (!e.length) trades.push(trade);
  });
  return { trades: sortTrades(trades), errors, warnings };
}

export function sortTrades(trades) {
  return [...trades].sort((a, b) => (a.date + (a.time || '12:00')).localeCompare(b.date + (b.time || '12:00')) || (a.side === 'buy' ? -1 : 1));
}

/**
 * FIFO 配对。trades 需已填好 price（effective_price）。
 * 返回 { roundTrips, openLots, issues }
 *  roundTrip: { thscode, name, buy_id, sell_id, buy_date, sell_date, qty, buy_price, sell_price, pnl, pnl_pct }
 */
export function matchFIFO(trades) {
  const lotsByCode = new Map();
  const roundTrips = [], issues = [];
  for (const t of sortTrades(trades)) {
    const price = t.effective_price ?? t.price;
    if (!(price > 0)) { issues.push({ trade_id: t.id, type: 'missing_price', msg: `${t.date} ${t.thscode} 缺少成交价且无法用行情补全，未参与盈亏计算` }); continue; }
    if (!lotsByCode.has(t.thscode)) lotsByCode.set(t.thscode, []);
    const lots = lotsByCode.get(t.thscode);
    if (t.side === 'buy') { lots.push({ trade: t, qty: t.qty, price }); continue; }
    let remain = t.qty;
    while (remain > 0 && lots.length) {
      const lot = lots[0];
      const q = Math.min(lot.qty, remain);
      roundTrips.push({
        thscode: t.thscode, name: t.name || lot.trade.name, buy_id: lot.trade.id, sell_id: t.id,
        buy_date: lot.trade.date, sell_date: t.date, qty: q, buy_price: lot.price, sell_price: price,
        pnl: round2((price - lot.price) * q), pnl_pct: round4(price / lot.price - 1),
      });
      lot.qty -= q; remain -= q;
      if (lot.qty <= 1e-9) lots.shift();
    }
    if (remain > 1e-9) issues.push({ trade_id: t.id, type: 'oversell', msg: `${t.date} 卖出 ${t.thscode} ${t.qty} 股，超过记录中的持仓 ${round2(t.qty - remain)} 股；超出部分（${round2(remain)} 股）可能来自未录入的历史买入，未计入盈亏` });
  }
  const openLots = [];
  for (const [code, lots] of lotsByCode) for (const l of lots) openLots.push({ thscode: code, name: l.trade.name, buy_id: l.trade.id, buy_date: l.trade.date, qty: l.qty, buy_price: l.price });
  return { roundTrips, openLots, issues };
}

export const round2 = x => Math.round(x * 100) / 100;
export const round4 = x => Math.round(x * 10000) / 10000;

/** 从理由/退出计划中提取止损比例，例如“止损-8%”“跌破8%止损”“止损 10%” */
export function extractStopLossPct(text) {
  if (!text) return null;
  const s = String(text);
  const m = s.match(/止损[^\d%]{0,6}(\d{1,2}(?:\.\d+)?)\s*%/) || s.match(/(?:跌|回撤|亏)[^\d%]{0,4}(\d{1,2}(?:\.\d+)?)\s*%[^。；;,，]{0,4}止损/);
  return m ? Number(m[1]) / 100 : null;
}

/** 从文本中提取止损价，例如“跌破 52 元止损”“止损价 52.5” */
export function extractStopLossPrice(text) {
  if (!text) return null;
  const m = String(text).match(/(?:止损价|跌破)\s*(\d+(?:\.\d+)?)\s*元?/);
  return m ? Number(m[1]) : null;
}

/** 识别持有周期意图 */
export function detectHorizon(text) {
  const s = String(text || '');
  if (/长期|长线|价值投资|持有[一二三两\d]+年|拿[一二三两\d]+年/.test(s)) return 'long';
  if (/短线|波段|博反弹|快进快出|超短|做T|打板/.test(s)) return 'short';
  return null;
}
