import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { runCheck } from './pipeline.ts';
import { createRateLimiter } from './limit.ts';

const PORT = Number(process.env.PORT) || 8000;
const MAX_BODY = 8 * 1024 * 1024; // 이미지 포함 8MB
const MAX_TEXT = 5000;
// 공개 배포 보호: IP당 10분에 10회, 서버 전체 동시 판독 6건까지
const allowIp = createRateLimiter(10, 10 * 60_000);
const MAX_RUNNING = 6;
let running = 0;
// Cloudflare → Coolify 프록시를 거치므로 실제 IP는 헤더에 있음
const clientIp = (req: import('node:http').IncomingMessage) =>
  String(req.headers['cf-connecting-ip'] ?? '').trim() || String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
const sendError = (res: import('node:http').ServerResponse, status: number, error: string) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error }));
};
const PUBLIC = new URL('../public/', import.meta.url);
// public/ 안의 이 파일들만 내보냄 (경로 조작 방지를 위해 이름 목록으로 고정)
const STATIC: Record<string, string> = {
  '/': 'index.html', '/index.html': 'index.html',
  '/manifest.webmanifest': 'manifest.webmanifest', '/sw.js': 'sw.js', '/icon.svg': 'icon.svg',
  '/icon-192.png': 'icon-192.png', '/icon-512.png': 'icon-512.png', '/icon-maskable-512.png': 'icon-maskable-512.png',
  '/apple-touch-icon.png': 'apple-touch-icon.png',
};
const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', webmanifest: 'application/manifest+json', js: 'text/javascript; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png',
};

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname; // 공유하기로 들어온 /?text=... 도 화면으로
  if (req.method === 'GET' && STATIC[path]) {
    const file = STATIC[path];
    res.writeHead(200, {
      'Content-Type': TYPES[file.split('.').pop()!],
      // sw.js와 화면은 항상 새로 확인해야 업데이트가 바로 반영됨
      'Cache-Control': /\.(png|svg)$/.test(file) ? 'public, max-age=86400' : 'no-cache',
    });
    res.end(await readFile(new URL(file, PUBLIC)));
    return;
  }
  if (req.method === 'GET' && path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, liner: Boolean(process.env.LINER_API_KEY), foodsafetyKey: Boolean(process.env.FOODSAFETY_API_KEY) }));
    return;
  }
  if (req.method === 'POST' && path === '/api/check') {
    if (!allowIp(clientIp(req))) return sendError(res, 429, '판독 요청이 너무 많아요. 10분 뒤에 다시 시도해 주세요.');
    if (running >= MAX_RUNNING) return sendError(res, 503, '지금 판독하는 사람이 많아요. 잠시 뒤 다시 시도해 주세요.');
    let input: { text?: unknown; productName?: unknown; imageDataUrl?: unknown };
    try {
      input = JSON.parse(await readBody(req));
    } catch (e) {
      res.writeHead((e as Error).message === 'too_large' ? 413 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (e as Error).message === 'too_large' ? '파일이 너무 커요. 8MB 이하로 올려 주세요.' : '요청 형식이 잘못됐어요.' }));
      return;
    }
    const text = typeof input.text === 'string' ? input.text.trim().slice(0, MAX_TEXT) : '';
    const productName = typeof input.productName === 'string' ? input.productName.trim().slice(0, 100) : '';
    const image = typeof input.imageDataUrl === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(input.imageDataUrl) ? input.imageDataUrl : undefined;
    if (!text && !image) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '광고 문구를 붙여넣거나 광고 이미지를 올려 주세요.' }));
      return;
    }

    running++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const emit = (event: string, data: unknown) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    try {
      await runCheck({ text, productName, imageDataUrl: image }, emit);
    } catch (e) {
      console.error(e);
      emit('error', { message: '판독 중 오류가 났어요. 잠시 뒤 다시 시도해 주세요.', detail: String((e as Error).message).slice(0, 200) });
    } finally {
      running--;
    }
    res.end();
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, () => console.log(`판독 서버: http://localhost:${PORT}`));
