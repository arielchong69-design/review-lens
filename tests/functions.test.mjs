import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxyFuyao } from '../functions/_lib/fuyao.js';
import { runReviewStage } from '../functions/_lib/ai.js';

const params = new URLSearchParams({ thscode: '600519.SH', interval: '1d', start: '1', end: '2', adjust: 'forward', evil: 'x' });
const okFetch = body => async () => new Response(JSON.stringify(body), { status: 200 });

test('代理：未配置 Key → NO_KEY，且不发起请求', async () => {
  let called = false;
  const r = await proxyFuyao('a-share/prices/historical', params, {}, async () => { called = true; });
  assert.equal(r.code, 'NO_KEY');
  assert.equal(called, false);
});
test('代理：白名单外路径被拒绝', async () => {
  const r = await proxyFuyao('fund/backtest', params, { FUYAO_API_KEY: 'k' }, okFetch({}));
  assert.equal(r.code, 'PATH_NOT_ALLOWED');
});
test('代理：Key 放在请求头，非白名单参数被丢弃，响应中不回显 Key', async () => {
  let seen;
  const r = await proxyFuyao('a-share/prices/historical', params, { FUYAO_API_KEY: 'secret-key' }, async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ code: 0, message: 'success', request_id: 'rid', data: { item: [] } }));
  });
  assert.equal(seen.init.headers['X-api-key'], 'secret-key');
  assert.ok(!seen.url.includes('evil'));
  assert.ok(r.ok);
  assert.equal(r.request_id, 'rid');
  assert.ok(!JSON.stringify(r).includes('secret-key'));
});
test('代理：业务错误码翻译成中文说明', async () => {
  const r = await proxyFuyao('a-share-index/prices/historical', params, { FUYAO_API_KEY: 'k' }, okFetch({ code: 1003, message: 'out of range', data: null }));
  assert.equal(r.ok, false);
  assert.match(r.message, /近5年/);
});
test('代理：HTTP 429 → 限流', async () => {
  const r = await proxyFuyao('a-share/prices/historical', params, { FUYAO_API_KEY: 'k' }, async () => new Response('', { status: 429 }));
  assert.equal(r.code, 4001);
});
test('代理：上游返回非 JSON → BAD_JSON', async () => {
  const r = await proxyFuyao('a-share/prices/historical', params, { FUYAO_API_KEY: 'k' }, async () => new Response('<html>502</html>', { status: 502 }));
  assert.equal(r.code, 'BAD_JSON');
});
test('代理：超时 → TIMEOUT', async () => {
  const r = await proxyFuyao('a-share/prices/historical', params, { FUYAO_API_KEY: 'k', FUYAO_TIMEOUT_MS: 30 }, (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
  assert.equal(r.code, 'TIMEOUT');
});

const PACK = { trade: { id: 't1', date: '2025-03-03', thscode: '600000.SH', side: 'buy', qty: 1, reason: 'r' }, evidence: [{ id: 'E-t1-pre_ret_20', phase: 'ex_ante', label: 'x', display: '+18.20%', value: 0.182 }, { id: 'E-t1-post_ret_20', phase: 'ex_post', label: 'y', display: '-9.10%', value: -0.091 }], biases: [] };
const aiFetch = content => async () => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 10 } }));

test('AI：未配置 Key → NO_KEY（前端会切换到规则兜底）', async () => {
  const r = await runReviewStage({ stage: 'ex_ante', pack: PACK }, {});
  assert.equal(r.code, 'NO_KEY');
});
test('AI：输出不是 JSON → BAD_JSON', async () => {
  const r = await runReviewStage({ stage: 'ex_ante', pack: PACK }, { DEEPSEEK_API_KEY: 'k' }, aiFetch('我觉得这笔交易不错'));
  assert.equal(r.code, 'BAD_JSON');
});
test('AI：正常输出经过校验，后见之明条目被移除', async () => {
  const content = JSON.stringify({ reason_assessment: [{ text: '买前涨了 18.20%', type: 'fact', refs: ['E-t1-pre_ret_20'] }, { text: '后来跌了', type: 'fact', refs: ['E-t1-post_ret_20'] }], hypotheses: [], visible_risks: [] });
  const r = await runReviewStage({ stage: 'ex_ante', pack: PACK }, { DEEPSEEK_API_KEY: 'k' }, aiFetch(content));
  assert.ok(r.ok);
  assert.equal(r.data.reason_assessment.length, 1);
  assert.equal(r.report.removed.length, 1);
});
test('AI：事前提示词中不包含任何事后证据', async () => {
  let sent;
  await runReviewStage({ stage: 'ex_ante', pack: PACK }, { DEEPSEEK_API_KEY: 'k' }, async (u, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] })); });
  const userMsg = sent.messages[1].content;
  assert.ok(userMsg.includes('E-t1-pre_ret_20'));
  assert.ok(!userMsg.includes('E-t1-post_ret_20'));
});
test('AI：HTTP 错误 → 返回失败而不是空结论', async () => {
  const r = await runReviewStage({ stage: 'ex_post', pack: PACK }, { DEEPSEEK_API_KEY: 'k' }, async () => new Response('', { status: 503 }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'HTTP_503');
});
