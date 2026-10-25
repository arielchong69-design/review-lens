// GET /api/health：只报告是否配置了 Key，不泄露 Key 本身。
export async function onRequestGet({ env }) {
  return new Response(JSON.stringify({
    ok: true,
    fuyao_key: !!env.FUYAO_API_KEY,
    deepseek_key: !!env.DEEPSEEK_API_KEY,
    model: env.DEEPSEEK_MODEL || 'deepseek-chat',
    time: new Date().toISOString(),
  }), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
