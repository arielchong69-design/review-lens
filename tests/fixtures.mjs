// 测试用合成行情（仅用于自动化测试，明确不是真实数据）。
import { dateToMs, addDays } from '../public/js/core/dates.js';

export function rng(seed = 42) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function weekdays(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const wd = new Date(d + 'T00:00:00Z').getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d);
  }
  return out;
}

/**
 * 生成扶摇格式 K 线。drift(date) 返回当日期望涨跌，可用来制造“买前大涨”等场景。
 */
export function makeBars({ start, end, startPrice = 10, seed = 1, drift = () => 0, vol = 0.015, volume = () => 1e6, skip = [] }) {
  const r = rng(seed);
  let p = startPrice;
  return weekdays(start, end).filter(d => !skip.includes(d)).map(d => {
    const ret = drift(d) + (r() - 0.5) * 2 * vol;
    const open = p;
    p = Math.max(0.5, p * (1 + ret));
    const hi = Math.max(open, p) * (1 + r() * 0.01), lo = Math.min(open, p) * (1 - r() * 0.01);
    return { date_ms: dateToMs(d), open_price: r2(open), high_price: r2(hi), low_price: r2(lo), close_price: r2(p), volume: volume(d), turnover: volume(d) * p };
  });
}
const r2 = x => Math.round(x * 100) / 100;

export function makeEvents(list) {
  // list: [{ date:'YYYY-MM-DD', time:'HH:mm', tag, text }]
  return list.map((e, i) => ({
    analysis_id: `syn${i}`, analysis_content: `<p>${e.text}</p>`, key_word_list: ['测试'], tag_name: e.tag || '大涨',
    first_publish_time: Date.parse(`${e.date}T${e.time || '10:00'}:00Z`) - 8 * 3600 * 1000, create_time: null, link_url: 'https://example.org',
  }));
}
