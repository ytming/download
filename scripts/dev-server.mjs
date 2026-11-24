#!/usr/bin/env node
/**
 * 本地预览服务器（零依赖，只需 Node 18+）
 *
 * 作用：在本地模拟 EdgeOne Pages 的「静态资源 + /functions 边缘函数」运行时，
 * 让你在部署到 EdgeOne 之前就能完整预览页面和管理后台。
 *
 *   node scripts/dev-server.mjs          # 默认 http://127.0.0.1:3000
 *   PORT=8080 node scripts/dev-server.mjs
 *
 * 与线上行为一致的部分：
 *   - functions/ 目录按文件名路由（支持 [id] 与 [[default]] 通配）
 *   - context.request / context.env / context.params
 *   - @edgeone/pages-blob（本地用 node_modules 里的 shim，数据落盘到 .dev/blob.json）
 *
 * 注意：`.dev/` 只用于本地，已被 .gitignore 排除，不会上传到 GitHub。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FUNCTIONS_DIR = path.join(ROOT, 'functions');
const DEV_DIR = path.join(ROOT, '.dev');
const KV_FILE = path.join(DEV_DIR, 'kv.json');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

/** 不对外提供的目录（线上这些内容不会作为静态资源发布） */
const PRIVATE_SEGMENTS = new Set(['functions', '.dev', '.git', 'node_modules', 'scripts', '.github']);

/* =========================================================
 * 迷你 KV：接口与 EdgeOne KV 对齐（get / put / delete / list）
 * =======================================================*/
class LocalKV {
  constructor(file) {
    this.file = file;
    this.store = this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  flush() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.store, null, 2), 'utf8');
  }

  async get(key) {
    const entry = this.store[String(key)];
    return entry ? entry.value : null;
  }

  async put(key, value) {
    this.store[String(key)] = { value: String(value) };
    this.flush();
    return 'OK';
  }

  async delete(key) {
    delete this.store[String(key)];
    this.flush();
    return 'OK';
  }

  async list(options = {}) {
    const prefix = String(options.prefix || '');
    const keys = Object.keys(this.store)
      .filter((k) => k.startsWith(prefix))
      .map((k) => ({ key: k }));
    return { keys, complete: true };
  }
}

/* =========================================================
 * 环境变量：读取 .dev.vars / .env，再合并进程环境变量
 * =======================================================*/
function parseEnvFile(file) {
  const out = {};
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

const fileEnv = {
  ...parseEnvFile(path.join(ROOT, '.env')),
  ...parseEnvFile(path.join(ROOT, '.dev.vars')),
};

const env = {
  ADMIN_PASSWORD: 'admin',
  ...fileEnv,
  ...Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => typeof v === 'string')
  ),
};

/* =========================================================
 * 函数路由：扫描 functions/ 目录，编译成路由表
 * =======================================================*/
function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(mjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function compileRoute(file) {
  const rel = path.relative(FUNCTIONS_DIR, file).split(path.sep).join('/');
  const noExt = rel.replace(/\.(mjs|js)$/, '');
  const segments = noExt.split('/');
  if (segments[segments.length - 1] === 'index') segments.pop();

  return segments.map((segment) => {
    if (/^\[\[.+\]\]$/.test(segment)) {
      return { type: 'catchall', name: segment.replace(/^\[+|\]+$/g, '') };
    }
    if (/^\[.+\]$/.test(segment)) {
      return { type: 'param', name: segment.replace(/^\[+|\]+$/g, '') };
    }
    return { type: 'static', raw: segment };
  });
}

const routes = walk(FUNCTIONS_DIR).map((file) => ({
  file,
  segments: compileRoute(file),
}));

const moduleCache = new Map();

async function loadHandler(file) {
  if (!moduleCache.has(file)) {
    moduleCache.set(file, await import(pathToFileURL(file).href + `?t=${Date.now()}`));
  }
  const mod = await moduleCache.get(file);
  return mod.onRequest || mod.default?.fetch || mod.default;
}

function matchRoute(segments, pathSegments) {
  const params = {};
  let index = 0;

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];

    if (segment.type === 'catchall') {
      return { params }; // 剩余路径全部吞掉
    }

    if (index >= pathSegments.length) return null;

    if (segment.type === 'static') {
      if (pathSegments[index] !== segment.raw) return null;
    } else {
      params[segment.name] = decodeURIComponent(pathSegments[index]);
    }
    index += 1;
  }

  return index === pathSegments.length ? { params } : null;
}

/* =========================================================
 * 静态资源
 * =======================================================*/
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function isPrivatePath(relPath) {
  return relPath
    .split('/')
    .filter(Boolean)
    .some((segment) => PRIVATE_SEGMENTS.has(segment));
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';

  const resolved = path.resolve(ROOT, '.' + rel);
  const relative = path.relative(ROOT, resolved).split(path.sep).join('/');

  if (relative.startsWith('..') || isPrivatePath(relative)) {
    return sendText(res, 404, 'Not Found');
  }

  let stat = null;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return sendText(res, 404, 'Not Found');
  }

  const file = stat.isDirectory() ? path.join(resolved, 'index.html') : resolved;
  let body;
  try {
    body = fs.readFileSync(file);
  } catch {
    return sendText(res, 404, 'Not Found');
  }

  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendText(res, status, text) {
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': buf.length,
  });
  res.end(buf);
}

/* =========================================================
 * 请求桥接：Node IncomingMessage → Web Request
 * =======================================================*/
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function toWebRequest(req) {
  const host = req.headers.host || `${HOST}:${PORT}`;
  const url = new URL(req.url || '/', `http://${host}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(', '));
    else if (typeof value === 'string') headers.set(key, value);
  }

  const method = (req.method || 'GET').toUpperCase();
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    const buffer = await readBody(req);
    if (buffer.length) body = buffer;
  }

  return new Request(url, { method, headers, body });
}

async function sendWebResponse(res, response) {
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  let buffer = Buffer.alloc(0);
  if (response.body) {
    buffer = Buffer.from(await response.arrayBuffer());
  }
  headers['content-length'] = buffer.length;

  res.writeHead(response.status, headers);
  res.end(buffer);
}

/* =========================================================
 * 服务器
 * =======================================================*/
const BLOB_FILE = path.join(DEV_DIR, 'blob.json');

/* =========================================================
 * 兼容：旧 KV 全局（已迁移到 @edgeone/pages-blob，仅保留以防老代码引用）
 * =======================================================*/
if (!fs.existsSync(KV_FILE)) {
  fs.mkdirSync(DEV_DIR, { recursive: true });
  fs.writeFileSync(KV_FILE, '{}', 'utf8');
}

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  let status = 200;

  try {
    const pathSegments = pathname.split('/').filter(Boolean);

    let matched = null;
    for (const route of routes) {
      const result = matchRoute(route.segments, pathSegments);
      if (!result) continue;
      // 精确度优先：静态段多的路由排前面
      if (!matched || route.segments.length > matched.route.segments.length) {
        matched = { route, params: result.params };
      }
    }

    if (matched) {
      const handler = await loadHandler(matched.route.file);
      if (typeof handler !== 'function') {
        status = 500;
        return sendText(res, 500, 'Function 未导出 onRequest');
      }
      const request = await toWebRequest(req);
      const response = await handler({
        request,
        env,
        params: matched.params,
        waitUntil: () => {},
      });
      status = response.status;
      await sendWebResponse(res, response);
      return;
    }

    const before = res.statusCode;
    serveStatic(req, res, pathname);
    status = res.statusCode || before;
  } catch (err) {
    status = 500;
    console.error('[dev] 请求处理失败：', err);
    if (!res.headersSent) sendText(res, 500, 'Internal Error');
    else res.end();
  } finally {
    const ms = Date.now() - startedAt;
    console.log(`${req.method} ${pathname} → ${status} (${ms}ms)`);
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  软件下载中心 · 本地预览（模拟 EdgeOne Pages 运行时）');
  console.log(`  地址: http://${HOST}:${PORT}`);
  console.log(`  函数: ${routes.length} 个，KV: ${path.relative(ROOT, KV_FILE)}`);
  console.log('  管理后台: 右上角「管理后台」或 Ctrl/⌘ + Shift + A');
  console.log('');
});
