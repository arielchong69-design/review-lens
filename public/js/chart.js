// 轻量 SVG 走势图：前复权收盘价、基准归一线、买卖点、事件点、信息截止线。
const NS = 'http://www.w3.org/2000/svg';
function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * @param container DOM
 * @param opts { bars, bench, trades:[{id,date,side,label}], events:[{date,label}], cutoff: 'YYYY-MM-DD'|null, onPick(tradeId) }
 */
export function renderChart(container, { bars, bench, trades, events, cutoff, onPick }) {
  container.innerHTML = '';
  if (!bars?.length) { container.innerHTML = '<div class="msg error">没有可用的行情数据，无法绘制走势图。</div>'; return; }
  const W = Math.max(640, container.clientWidth || 900), H = 320;
  const pad = { l: 56, r: 16, t: 16, b: 28 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '股价走势与交易点' }, container);
  const tip = document.createElement('div'); tip.className = 'tip'; tip.hidden = true; container.appendChild(tip);

  const n = bars.length;
  const x = i => pad.l + (i / Math.max(1, n - 1)) * (W - pad.l - pad.r);
  const dateIdx = new Map(bars.map((b, i) => [b.date, i]));
  const idxFor = d => { if (dateIdx.has(d)) return dateIdx.get(d); for (let i = 0; i < n; i++) if (bars[i].date >= d) return i; return null; };

  // 基准按首个共同日期归一到个股价格
  let benchPts = [];
  if (bench?.length) {
    const bmap = new Map(bench.map(b => [b.date, b.close]));
    const first = bars.find(b => bmap.has(b.date));
    if (first) {
      const k = first.close / bmap.get(first.date);
      benchPts = bars.map((b, i) => (bmap.has(b.date) ? [i, bmap.get(b.date) * k] : null)).filter(Boolean);
    }
  }
  const vals = bars.map(b => b.close).concat(benchPts.map(p => p[1]));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1; lo -= span * 0.06; hi += span * 0.06;
  const y = v => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);

  const grid = css('--border'), muted = css('--muted');
  for (let g = 0; g <= 4; g++) {
    const v = lo + ((hi - lo) * g) / 4;
    el('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), stroke: grid, 'stroke-width': 1 }, svg);
    const t = el('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: muted }, svg); t.textContent = v.toFixed(2);
  }
  const step = Math.ceil(n / 6);
  for (let i = 0; i < n; i += step) {
    const t = el('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', 'font-size': 11, fill: muted }, svg); t.textContent = bars[i].date.slice(2);
  }

  // 事后区间阴影
  if (cutoff) {
    const ci = idxFor(cutoff);
    if (ci != null) {
      el('rect', { x: x(ci), y: pad.t, width: W - pad.r - x(ci), height: H - pad.t - pad.b, fill: css('--post-soft'), opacity: 0.9 }, svg);
      el('line', { x1: x(ci), x2: x(ci), y1: pad.t, y2: H - pad.b, stroke: css('--post'), 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }, svg);
      const t = el('text', { x: x(ci) + 6, y: pad.t + 14, 'font-size': 12, fill: css('--post') }, svg); t.textContent = '信息截止线 → 右侧为事后信息';
    }
  }

  if (benchPts.length) el('polyline', { points: benchPts.map(([i, v]) => `${x(i)},${y(v)}`).join(' '), fill: 'none', stroke: muted, 'stroke-width': 1.2, 'stroke-dasharray': '5 4', opacity: 0.8 }, svg);
  el('polyline', { points: bars.map((b, i) => `${x(i)},${y(b.close)}`).join(' '), fill: 'none', stroke: css('--brand'), 'stroke-width': 1.8 }, svg);

  const show = (evt, html) => {
    const r = container.getBoundingClientRect();
    tip.innerHTML = html; tip.hidden = false;
    const left = Math.min(evt.clientX - r.left + 12, r.width - 290);
    tip.style.left = `${Math.max(0, left)}px`; tip.style.top = `${evt.clientY - r.top + 12}px`;
  };
  const hide = () => { tip.hidden = true; };

  // 事件点（底部）
  for (const e of events || []) {
    const i = idxFor(e.date); if (i == null) continue;
    const c = el('circle', { cx: x(i), cy: H - pad.b - 6, r: 4, fill: css('--same'), opacity: 0.85, style: 'cursor:help' }, svg);
    c.addEventListener('mousemove', ev => show(ev, `<b>${e.date}</b> ${escapeHtml(e.label)}`));
    c.addEventListener('mouseleave', hide);
  }
  // 买卖点
  for (const t of trades || []) {
    const i = idxFor(t.date); if (i == null) continue;
    const cy = y(bars[i].close);
    const isBuy = t.side === 'buy';
    const g = el('g', { style: 'cursor:pointer' }, svg);
    el('circle', { cx: x(i), cy, r: t.selected ? 9 : 7, fill: isBuy ? css('--up') : css('--down'), stroke: css('--surface'), 'stroke-width': 2 }, g);
    const tx = el('text', { x: x(i), y: cy + 4, 'text-anchor': 'middle', 'font-size': 10, fill: '#fff', 'font-weight': 700 }, g); tx.textContent = isBuy ? 'B' : 'S';
    g.addEventListener('mousemove', ev => show(ev, `<b>${t.date} ${isBuy ? '买入' : '卖出'}</b><br>${escapeHtml(t.label || '')}`));
    g.addEventListener('mouseleave', hide);
    g.addEventListener('click', () => onPick?.(t.id));
  }
  // 悬停读数
  const overlay = el('rect', { x: pad.l, y: pad.t, width: W - pad.l - pad.r, height: H - pad.t - pad.b, fill: 'transparent' }, svg);
  overlay.style.pointerEvents = 'none';
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
