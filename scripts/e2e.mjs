// 端到端冒烟测试（Playwright）：载入示例 → 复盘 → 时间线 → AI 复盘 → 加入清单 → 决策前检查 → 故障演练。
// 用法：BASE=http://localhost:8788 node scripts/e2e.mjs [截图目录]
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.BASE || 'http://localhost:8788';
const OUT = process.argv[2] || 'shots';
import { mkdirSync } from 'node:fs';
mkdirSync(OUT, { recursive: true });

const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
const step = async (name, fn) => { try { await fn(); console.log('✓', name); } catch (e) { console.log('✗', name, e.message); errors.push(`${name}: ${e.message}`); } };

await page.goto(BASE + '/');
await page.evaluate(() => localStorage.clear());
await page.reload();
await step('载入示例', async () => { await page.click('#btnSample'); await page.waitForSelector('#tradeTable tbody tr'); });
await page.screenshot({ path: `${OUT}/1-trades.png`, fullPage: true });
await step('开始复盘', async () => { await page.click('#btnRun'); await page.waitForSelector('#tab-timeline.active', { timeout: 60000 }); await page.waitForSelector('#chart svg'); });
await page.screenshot({ path: `${OUT}/2-timeline.png`, fullPage: true });
await step('切换股票与交易', async () => {
  await page.selectOption('#stockSelect', '300033.SZ');
  await page.click('#timelineList li.trade');
  await page.waitForSelector('#phaseCols .phase.ante');
});
await page.screenshot({ path: `${OUT}/3-cutoff.png`, fullPage: true });
await step('证据抽屉', async () => { await page.click('#phaseCols .ev-row'); await page.waitForSelector('#drawer:not([hidden])'); await page.screenshot({ path: `${OUT}/4-evidence.png` }); await page.click('#drawerClose'); });
await step('生成复盘', async () => {
  await page.click('#btnGoReview');
  await page.click('#btnReview');
  await page.waitForSelector('#reviewOut .review', { timeout: 120000 });
});
await page.screenshot({ path: `${OUT}/5-review.png`, fullPage: true });
await step('加入清单', async () => { await page.click('[data-add-lesson="all"]'); await page.click('.tab[data-tab="checklist"]'); await page.waitForSelector('#checklistList li'); });
await page.screenshot({ path: `${OUT}/6-checklist.png`, fullPage: true });
await step('决策前检查', async () => {
  await page.click('.tab[data-tab="precheck"]');
  await page.fill('#precheckForm [name=q]', '300033.SZ');
  await page.fill('#precheckForm [name=reason]', '突破新高，追一下');
  await page.click('#precheckForm button[type=submit]');
  await page.waitForSelector('.check-res, #precheckOut .msg', { timeout: 60000 });
});
await page.screenshot({ path: `${OUT}/7-precheck.png`, fullPage: true });
await step('数据状态', async () => { await page.click('.tab[data-tab="status"]'); await page.waitForSelector('#logTable tbody tr'); });
await page.screenshot({ path: `${OUT}/8-status.png`, fullPage: true });
await step('故障演练：事件+基准+AI 失败', async () => {
  for (const v of ['events', 'bench', 'snapshot', 'ai']) await page.check(`.drill input[value=${v}]`);
  await page.click('.tab[data-tab="trades"]');
  await page.click('#btnRun');
  await page.waitForSelector('#tab-timeline.active', { timeout: 60000 });
  const txt = await page.textContent('#checks');
  if (!/基准指数行情获取失败/.test(txt) || !/事件数据获取失败/.test(txt)) throw new Error('未显示降级提示: ' + txt);
  await page.screenshot({ path: `${OUT}/9-degraded.png`, fullPage: true });
  await page.click('.tab[data-tab="report"]');
  await page.selectOption('#tradeSelect', 's5');
  await page.click('#btnReview');
  await page.waitForSelector('#reviewOut .review', { timeout: 60000 });
  const r = await page.textContent('#reviewOut');
  if (!/规则引擎生成/.test(r)) throw new Error('AI 失败时未切到规则兜底');
  await page.screenshot({ path: `${OUT}/10-fallback.png`, fullPage: true });
});
await page.setViewportSize({ width: 390, height: 844 });
await page.click('.tab[data-tab="timeline"]');
await page.screenshot({ path: `${OUT}/11-mobile.png`, fullPage: false });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
if (overflow) errors.push('手机宽度下出现横向滚动');
await browser.close();
console.log(errors.length ? `\n${errors.length} 个问题：\n` + errors.join('\n') : '\n全部通过');
process.exit(errors.length ? 1 : 0);
