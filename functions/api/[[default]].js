/**
 * EdgeOne Pages Functions —— 软件下载中心 API
 *
 * 路由：functions/api/[[default]].js  →  /api/**（任意层级）
 * 运行时：EdgeOne 边缘函数（Web 标准 Request/Response，非 Node.js）
 *
 * 存储：EdgeOne Pages Blob（对象存储，按 key 读写）
 *   - 使用 @edgeone/pages-blob SDK，首次 getStore 自动创建命名空间
 *   - 无需在控制台手动绑定变量名，部署即可用
 *
 * 环境变量（项目设置 → 环境变量，可选）：
 *   - ADMIN_PASSWORD：管理员初始密码，未设置时默认为 admin
 */

import { getStore } from '@edgeone/pages-blob';

/* =========================================================
 * 常量
 * =======================================================*/
const DATA_KEY = 'site-data.json';
const PASSWORD_KEY = 'admin-password';
const MAX_PAYLOAD_BYTES = 900 * 1024;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

const LIMITS = {
  title: 120,
  subtitle: 240,
  name: 80,
  version: 60,
  url: 2048,
  note: 2000,
  softwares: 200,
  versions: 200,
  links: 100,
};

/* =========================================================
 * 初始默认数据（Blob 中还没有数据时展示）
 * 结构：软件 → 版本 → 自定义命名的下载链接
 * =======================================================*/
const DEFAULT_DATA = {
  title: '📦 软件下载中心',
  subtitle: '选择软件与版本，复制链接或直接下载',
  softwares: [
    {
      name: '微信 PC 版',
      note: '1. 安装前请先退出正在运行的旧版微信；\n2. 本页为官方直链，下载后请核对数字签名；\n3. 若下载速度较慢，可稍后重试或更换网络。',
      versions: [
        {
          version: '3.9.12',
          links: [
            { name: '直链下载', url: 'https://dldir1.qq.com/weixin/Windows/WeChatSetup.exe', backupUrl: 'https://dldir1v6.qq.com/weixin/Windows/WeChatSetup.exe' },
            { name: '备用链接', url: 'https://dldir1.qq.com/weixin/Windows/WeChatSetup_3.9.10.exe', backupUrl: '' },
          ],
        },
        {
          version: '3.9.10',
          links: [
            { name: '直链下载', url: 'https://dldir1.qq.com/weixin/Windows/WeChatSetup_3.9.10.exe', backupUrl: '' },
          ],
        },
      ],
    },
    {
      name: 'QQ NT',
      note: '1. 仅支持 Windows 10 及以上系统；\n2. 安装包较大，请保持网络稳定；\n3. 安装时建议选择「自定义安装」，避免捆绑组件。',
      versions: [
        {
          version: '9.9.15',
          links: [
            { name: '直链下载', url: 'https://dldir1.qq.com/qqfile/qq/QQNT/Windows/QQ_9.9.15_240701_x64_01.exe', backupUrl: 'https://dldir1v6.qq.com/qqfile/qq/QQNT/Windows/QQ_9.9.15_240701_x64_01.exe' },
          ],
        },
        {
          version: '9.9.12',
          links: [
            { name: '直链下载', url: 'https://dldir1.qq.com/qqfile/qq/QQNT/Windows/QQ_9.9.12_240612_x64_01.exe', backupUrl: '' },
          ],
        },
      ],
    },
    {
      name: 'WPS Office',
      note: '1. 安装前请关闭已打开的 WPS 文档；\n2. 个人免费版含广告，可在「设置 → 其他」中关闭；\n3. 请勿与其他版本 WPS 同时安装。',
      versions: [
        {
          version: '2024 夏季版',
          links: [
            { name: '直链下载', url: 'https://package.wps.cn/setup/wps_setup.exe', backupUrl: 'https://dl.wpscdn.cn/setup/wps_setup.exe' },
            { name: '备用镜像', url: 'https://dl.wpscdn.cn/setup/wps_setup.exe', backupUrl: '' },
          ],
        },
      ],
    },
  ],
};

/* =========================================================
 * 小工具
 * =======================================================*/
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function fail(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

/** 纯文本清洗：去掉换行 / 折叠空白 / 截断 */
function text(value, max) {
  let s = String(value ?? '');
  s = s.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return max ? s.slice(0, max) : s;
}

/** 多行文本清洗：保留换行，但统一换行符、去掉首尾空白与过多空行 */
function multiText(value, max) {
  let s = String(value ?? '').replace(/\r\n?/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return max ? s.slice(0, max) : s;
}

/** 链接清洗：拦截危险协议，其余原样保留 */
function cleanUrl(value) {
  const s = String(value ?? '').trim().slice(0, LIMITS.url);
  if (!s) return '';
  if (/^(javascript|data|vbscript|file|blob|about):/i.test(s)) return '';
  return s;
}

/** 常量时间比较，避免口令计时侧信道 */
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a ?? ''));
  const y = enc.encode(String(b ?? ''));
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** 规整路径：合并重复斜杠、去掉末尾斜杠，/ 除外 */
function normalizePath(pathname) {
  let p = String(pathname || '/').replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '/';
}

/* =========================================================
 * Blob 存储
 * getStore({ name, consistency: "strong" }) 首次调用自动创建命名空间
 * =======================================================*/
const store = getStore({ name: 'software-download', consistency: 'strong' });

function storageState() {
  return 'blob';
}

/** 生效密码：Blob 中改过的优先，其次环境变量，最后 admin */
async function resolvePassword(env) {
  try {
    const saved = await store.get(PASSWORD_KEY);
    if (saved) return String(saved);
  } catch (err) {
    console.error('[auth] 读取密码失败：', err?.message || err);
  }
  return String(env?.ADMIN_PASSWORD || 'admin');
}

/* =========================================================
 * 数据规整 / 读写
 * 兼容三种历史结构：
 *   1) 软件 → 版本 → links[]      （当前结构）
 *   2) 软件 → versions[{version,url,backupUrl}]（最早的版本直链结构）
 *   3) 软件 → links[]             （上一版的纯链接结构）
 * =======================================================*/
function sanitizeLink(link) {
  return {
    name: text(link?.name, LIMITS.name),
    url: cleanUrl(link?.url),
    backupUrl: cleanUrl(link?.backupUrl || ''),
  };
}

function sanitizeVersion(v) {
  let links = [];
  if (Array.isArray(v?.links)) {
    links = v.links.map(sanitizeLink).filter((l) => l.name).slice(0, LIMITS.links);
  } else if (v?.url) {
    const link = sanitizeLink({ name: '直链下载', url: v.url, backupUrl: v.backupUrl });
    if (link.name) links = [link];
  }
  return {
    version: text(v?.version, LIMITS.version),
    links,
  };
}

function sanitize(input) {
  const softwares = (Array.isArray(input?.softwares) ? input.softwares : [])
    .map((s) => {
      let versions = [];
      if (Array.isArray(s?.versions)) {
        versions = s.versions.map(sanitizeVersion).filter((v) => v.version).slice(0, LIMITS.versions);
      } else if (Array.isArray(s?.links)) {
        const links = s.links.map(sanitizeLink).filter((l) => l.name).slice(0, LIMITS.links);
        versions = [{ version: '最新版本', links }];
      }
      return {
        name: text(s?.name, LIMITS.name),
        note: multiText(s?.note, LIMITS.note),
        versions,
      };
    })
    .filter((s) => s.name)
    .slice(0, LIMITS.softwares);

  return {
    title: text(input?.title, LIMITS.title) || DEFAULT_DATA.title,
    subtitle: text(input?.subtitle, LIMITS.subtitle),
    softwares,
  };
}

async function readData() {
  try {
    const raw = await store.get(DATA_KEY, { type: 'json' });
    if (!raw) return sanitize(DEFAULT_DATA);
    return sanitize(raw);
  } catch (err) {
    console.error('[data] 读取 Blob 失败，回退默认数据：', err?.message || err);
    return sanitize(DEFAULT_DATA);
  }
}

async function saveData(data) {
  const payload = JSON.stringify({ ...data, updatedAt: new Date().toISOString() });
  if (payload.length > MAX_PAYLOAD_BYTES) {
    const err = new Error('数据过大，请精简软件/版本数量后再保存');
    err.status = 413;
    throw err;
  }
  await store.set(DATA_KEY, payload);
}

/* =========================================================
 * 入口
 * =======================================================*/
export async function onRequest(context) {
  const request = context?.request;
  if (!request) return fail('请求对象缺失', 500);

  const env = context.env || {};
  const method = String(request.method || 'GET').toUpperCase();
  const path = normalizePath(new URL(request.url).pathname);

  try {
    /* ---------- 健康检查 ---------- */
    if (path === '/api/health') {
      return json({ ok: true, storage: storageState(), time: new Date().toISOString() });
    }

    /* ---------- 读取数据 ---------- */
    if (path === '/api/data') {
      if (method === 'GET' || method === 'HEAD') {
        return json({ ok: true, storage: storageState(), data: await readData() });
      }

      /* ---------- 保存数据（整份替换） ---------- */
      if (method === 'PUT' || method === 'POST') {
        const supplied = request.headers.get('x-admin-password') || '';
        const expected = await resolvePassword(env);
        if (!safeEqual(supplied, expected)) return fail('未授权，请重新登录', 401);

        const body = await request.json().catch(() => null);
        if (!body || !Array.isArray(body.softwares)) return fail('数据格式不正确', 400);

        const data = sanitize(body);
        await saveData(data);
        return json({ ok: true, storage: storageState(), data });
      }

      return fail('Method Not Allowed', 405);
    }

    /* ---------- 登录校验 ---------- */
    if (path === '/api/login') {
      if (method !== 'POST') return fail('Method Not Allowed', 405);
      const body = await request.json().catch(() => ({}));
      const expected = await resolvePassword(env);
      if (!safeEqual(body?.password ?? '', expected)) return fail('密码不正确', 401);
      return json({ ok: true, storage: storageState() });
    }

    /* ---------- 修改管理密码 ---------- */
    if (path === '/api/password') {
      if (method !== 'PUT' && method !== 'POST') return fail('Method Not Allowed', 405);

      const supplied = request.headers.get('x-admin-password') || '';
      const expected = await resolvePassword(env);
      if (!safeEqual(supplied, expected)) return fail('当前密码不正确', 401);

      const body = await request.json().catch(() => null);
      const next = String(body?.newPassword ?? '').trim();
      if (next.length < 4) return fail('新密码至少 4 位', 400);
      if (next.length > 128) return fail('新密码最长 128 位', 400);

      await store.set(PASSWORD_KEY, next);
      return json({ ok: true });
    }

    return fail('Not Found', 404);
  } catch (err) {
    console.error('[api] 未处理异常：', err?.stack || err?.message || err);
    return fail(err?.message || String(err), err?.status || 500);
  }
}
