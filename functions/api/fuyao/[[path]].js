// 扶摇 API 代理：Key 只存在服务端环境变量 FUYAO_API_KEY，前端永远拿不到。
// 只放行复盘需要的只读接口（白名单），并统一包装来源元信息。
import { proxyFuyao } from '../../_lib/fuyao.js';

export async function onRequestGet({ request, env, params }) {
  const path = Array.isArray(params.path) ? params.path.join('/') : String(params.path || '');
  const url = new URL(request.url);
  const body = await proxyFuyao(path, url.searchParams, env);
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
