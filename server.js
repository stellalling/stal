import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, publicDir, isSmtpConfigured } from './src/config.js';
import { SESSION_COOKIE, userFromToken } from './src/auth.js';
import { parseCookies } from './src/http.js';
import { handleApi, bootstrapHousekeeping } from './src/api.js';
import { startScheduler, runCrawlJob, statusSnapshot } from './src/scheduler.js';
import { flushAll, contestStore } from './src/store.js';

const cfg = getConfig();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const PROTECTED_PAGES = new Set(['/home.html', '/admin.html']);

function currentUser(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return userFromToken(token);
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

function serveFile(res, filePath, extraHeaders = {}) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-cache',
      ...extraHeaders,
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400).end('Bad Request');
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    await handleApi(req, res, url);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end('Method Not Allowed');
    return;
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  if (pathname === '/home' || pathname === '/admin') pathname = `${pathname}.html`;

  const user = currentUser(req);

  if (pathname === '/index.html' && user) {
    redirect(res, '/home.html');
    return;
  }
  if (PROTECTED_PAGES.has(pathname)) {
    if (!user) {
      redirect(res, '/?next=' + encodeURIComponent(pathname));
      return;
    }
    if (pathname === '/admin.html' && user.role !== 'admin') {
      redirect(res, '/home.html');
      return;
    }
  }

  const relative = pathname.replace(/^\/+/, '');
  const filePath = path.join(publicDir, relative);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>404</title><body style="font-family:system-ui;padding:48px"><h1>404</h1><p>页面不存在。<a href="/">返回首页</a></p>');
    return;
  }
  serveFile(res, filePath);
});

server.listen(cfg.server.port, cfg.server.host, () => {
  console.log('');
  console.log(`  ${cfg.site.name}`);
  console.log(`  → http://${cfg.server.host}:${cfg.server.port}`);
  console.log(`  SMTP: ${isSmtpConfigured() ? `已配置（${cfg.smtp.user}）` : '未配置 —— 请在 config.json 填写 smtp.user（QQ 邮箱地址）'}`);
  console.log(`  推送时间: 每天 ${cfg.mail.sendHour}:${String(cfg.mail.sendMinute).padStart(2, '0')}（仅次日比赛，限速 ${cfg.mail.perMinute} 封/分钟）`);
  console.log('');
  if (process.env.STAL_NO_SCHEDULER === '1') {
    console.log('[scheduler] 已禁用：STAL_NO_SCHEDULER=1（仅本地调试时用，避免和服务器重复发信）');
  } else {
    startScheduler();
  }
  bootstrapHousekeeping();
});

function shutdown(signal) {
  console.log(`\n[server] 收到 ${signal}，正在保存数据并退出…`);
  flushAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { server, runCrawlJob, statusSnapshot, contestStore };
