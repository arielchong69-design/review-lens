// 扶摇代理核心逻辑（与运行平台无关，便于单元测试）。
export const FUYAO_BASE = 'https://fuyao.aicubes.cn';

export const ALLOWED_PATHS = new Set([
  'a-share/prices/historical',
  'a-share-index/prices/historical',
  'meta/tickers/search',
  'news/anomaly/analysis',
  'a-share/calendar/trading-days',
]);

const ALLOWED_PARAMS = new Set(['thscode', 'interval', 'start', 'end', 'adjust', 'q', 'asset_type', 'limit', 'begin_date', 'end_date']);

/**
 * @returns 统一结构 { ok, code, message, request_id, data, fetched_at, latency_ms, upstream }
 */
export async function proxyFuyao(path, searchParams, env, fetchImpl = fetch) {
  const fetched_at = new Date().toISOString();
  if (!ALLOWED_PATHS.has(path)) return { ok: false, code: 'PATH_NOT_ALLOWED', message: `接口 ${path} 不在白名单中`, data: null, fetched_at };
  const key = env?.FUYAO_API_KEY;
  if (!key) return { ok: false, code: 'NO_KEY', message: '服务端未配置扶摇 API Key（FUYAO_API_KEY）', data: null, fetched_at };
  const qs = new URLSearchParams();
  for (const [k, v] of searchParams) if (ALLOWED_PARAMS.has(k)) qs.set(k, v);
  const upstream = `${FUYAO_BASE}/api/${path}?${qs}`;
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(env?.FUYAO_TIMEOUT_MS || 15000));
  try {
    const res = await fetchImpl(upstream, { headers: { 'X-api-key': key, accept: 'application/json' }, signal: ctrl.signal });
    const latency_ms = Date.now() - t0;
    if (res.status === 429) return { ok: false, code: 4001, message: '扶摇接口限流（HTTP 429），请稍后再试', data: null, fetched_at, latency_ms, upstream: redact(upstream) };
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { return { ok: false, code: 'BAD_JSON', message: `上游返回无法解析（HTTP ${res.status}）`, data: null, fetched_at, latency_ms, upstream: redact(upstream) }; }
    const ok = body?.code === 0;
    return { ok, code: body?.code ?? res.status, message: ok ? 'success' : describeCode(body?.code, body?.message), request_id: body?.request_id || null, data: body?.data ?? null, fetched_at, latency_ms, upstream: redact(upstream) };
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    return { ok: false, code: aborted ? 'TIMEOUT' : 'NETWORK', message: aborted ? '扶摇接口超时' : `无法连接扶摇接口：${e?.message || e}`, data: null, fetched_at, latency_ms: Date.now() - t0, upstream: redact(upstream) };
  } finally { clearTimeout(timer); }
}

function redact(u) { return u.replace(FUYAO_BASE, ''); }

export const CODE_TEXT = {
  1001: '缺少必填参数', 1002: '参数格式错误', 1003: '参数越界（例如指数只支持近5年、单次窗口超限）', 1004: '参数冲突',
  2001: 'API Key 无效或缺失', 2003: 'API Key 无权访问该接口', 3001: '标的不存在', 3002: '数据未就绪', 3004: '该标的类型不支持此能力',
  4001: '频率超限', 5001: '服务内部错误', 5002: '上游超时', 5003: '数据源不可用',
};
export function describeCode(code, msg) {
  return `${CODE_TEXT[code] || '未知错误'}（code=${code}${msg ? '，' + msg : ''}）`;
}
