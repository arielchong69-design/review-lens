// DeepSeek 调用 + 输出校验（与运行平台无关，便于单元测试）。
import { buildExAntePrompt, buildExPostPrompt, safeParseJSON, validateAIOutput } from '../../public/js/core/review.js';

export const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

export async function runReviewStage({ stage, pack, exAnte }, env, fetchImpl = fetch) {
  const started = Date.now();
  if (!pack || !Array.isArray(pack.evidence) || !pack.trade) return { ok: false, code: 'BAD_INPUT', message: '缺少交易或证据' };
  if (pack.evidence.length > 200) return { ok: false, code: 'BAD_INPUT', message: '证据条目过多' };
  const key = env?.DEEPSEEK_API_KEY;
  if (!key) return { ok: false, code: 'NO_KEY', message: '服务端未配置 DeepSeek API Key（DEEPSEEK_API_KEY）' };
  const prompt = stage === 'ex_ante' ? buildExAntePrompt(pack) : buildExPostPrompt(pack, exAnte);
  const model = env?.DEEPSEEK_MODEL || 'deepseek-chat';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(env?.AI_TIMEOUT_MS || 45000));
  try {
    const res = await fetchImpl(DEEPSEEK_URL, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, temperature: 0.2, max_tokens: 1600,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
      }),
    });
    if (!res.ok) {
      const why = { 400: '请求格式错误', 401: 'API Key 无效', 402: '账户余额不足', 422: '参数错误', 429: '请求过于频繁', 500: '服务内部错误', 503: '服务繁忙' }[res.status] || '未知错误';
      return { ok: false, code: `HTTP_${res.status}`, message: `DeepSeek 返回 HTTP ${res.status}（${why}）`, latency_ms: Date.now() - started };
    }
    const body = await res.json();
    const content = body?.choices?.[0]?.message?.content;
    const parsed = safeParseJSON(content);
    if (!parsed) return { ok: false, code: 'BAD_JSON', message: 'AI 输出不是合法 JSON', raw: String(content || '').slice(0, 500), latency_ms: Date.now() - started };
    const { data, report } = validateAIOutput(stage, parsed, pack.evidence);
    return { ok: true, stage, model, data, report, usage: body?.usage || null, latency_ms: Date.now() - started, prompt: { system: prompt.system, user_chars: prompt.user.length } };
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    return { ok: false, code: aborted ? 'TIMEOUT' : 'NETWORK', message: aborted ? 'AI 调用超时' : `AI 调用失败：${e?.message || e}`, latency_ms: Date.now() - started };
  } finally { clearTimeout(timer); }
}
