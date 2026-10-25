// 本地开发服务器：静态文件 + 模拟 Cloudflare Pages Functions 路由。
// 用法：node scripts/dev-server.mjs [--mock]   （--mock：用合成数据模拟扶摇与 DeepSeek，仅供离线开发与 UI 测试）
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proxyFuyao } from '../functions/_lib/fuyao.js';
import { runReviewStage } from '../functions/_lib/ai.js';
import { mockFuyaoFetch, mockDeepSeekFetch } from './mocks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'public');
const MOCK = process.argv.includes('--mock');
const PORT = Number(process.env.PORT || 8788);

// 读取 .dev.vars（与 wrangler 约定一致）
const env = { ...process.env };
const varsFile = path.join(root, '.dev.vars');
if (existsSync(varsFile)) for (const line of readFileSync(varsFile, 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/); if (m) env[m[1]] = m[2]; }
if (MOCK) { env.FUYAO_API_KEY ||= 'mock'; env.DEEPSEEK_API_KEY ||= 'mock'; }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.csv': 'text/csv; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'content-type': type }); res.end(body); };
  try {
    if (url.pathname === '/api/health') return send(200, JSON.stringify({ ok: true, fuyao_key: !!env.FUYAO_API_KEY, deepseek_key: !!env.DEEPSEEK_API_KEY, model: env.DEEPSEEK_MODEL || 'deepseek-chat', mock: MOCK }));
    if (url.pathname.startsWith('/api/fuyao/')) {
      const p = url.pathname.slice('/api/fuyao/'.length);
      const out = await proxyFuyao(p, url.searchParams, env, MOCK ? mockFuyaoFetch : fetch);
      return send(200, JSON.stringify(out));
    }
    if (url.pathname === '/api/review' && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c;
      const input = JSON.parse(body || '{}');
      const out = await runReviewStage(input, env, MOCK ? mockDeepSeekFetch : fetch);
      return send(200, JSON.stringify(out));
    }
    let file = path.join(pub, decodeURIComponent(url.pathname));
    if (!file.startsWith(pub)) return send(403, 'forbidden', 'text/plain');
    if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
    if (!existsSync(file)) return send(404, 'not found', 'text/plain');
    send(200, await readFile(file), TYPES[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    send(500, JSON.stringify({ ok: false, message: String(e) }));
  }
});
server.listen(PORT, () => console.log(`复盘镜 dev server: http://localhost:${PORT} ${MOCK ? '(MOCK 模式：合成数据)' : ''}`));
