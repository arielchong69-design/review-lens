// POST /api/review  { stage: 'ex_ante'|'ex_post', pack, exAnte? }
import { runReviewStage } from '../_lib/ai.js';

export async function onRequestPost({ request, env }) {
  let input;
  try { input = await request.json(); } catch { return json({ ok: false, code: 'BAD_INPUT', message: '请求体不是 JSON' }); }
  if (!['ex_ante', 'ex_post'].includes(input?.stage)) return json({ ok: false, code: 'BAD_INPUT', message: 'stage 必须是 ex_ante 或 ex_post' });
  const out = await runReviewStage(input, env);
  return json(out);
}

function json(obj) {
  return new Response(JSON.stringify(obj), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
