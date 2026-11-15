/**
 * FadeMail · 通用工具：响应、随机、哈希、限流、清理
 */

const JSON_CT = 'application/json; charset=utf-8';

export const nowSec = () => Math.floor(Date.now() / 1000);

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': JSON_CT,
      'cache-control': 'no-store',
      ...extra,
    },
  });
}

export function fail(message, status = 400, extra = {}) {
  return json({ ok: false, error: message }, status, extra);
}

/* ------------------------------- 跨域白名单 ------------------------------- */

/** 站点允许的来源：SITE_URL + ALLOWED_ORIGINS，额外放行本机调试端口 */
export function allowedOrigins(env) {
  const raw = [env.SITE_URL || '', env.ALLOWED_ORIGINS || ''].join(',');
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

export function isAllowedOrigin(origin, env) {
  if (!origin) return false;
  // 只认显式白名单：同源请求本来就不需要 CORS，额外放行 localhost 等于给任意本地页面开口子
  return allowedOrigins(env).includes(origin.replace(/\/+$/, ''));
}

/** 只对白名单来源回 CORS 头，避免任意站点带着 id 读取接口 */
export function corsHeaders(request, env, method = 'GET') {
  const origin = request.headers.get('origin') || '';
  if (!isAllowedOrigin(origin, env)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,x-api-key,x-admin-token,x-mailbox-key,x-admin-csrf',
    'access-control-max-age': '600',
    'vary': 'origin',
  };
}

export function withCors(res, request, env) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(request, env))) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

/** 站点主地址，用于生成邮件内的绝对链接 */
export function siteUrl(env, fallback) {
  return (env.SITE_URL || fallback || '').replace(/\/+$/, '');
}

/* ------------------------------- 随机 / 哈希 ------------------------------- */

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function randomStr(len = 10) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function randomId(len = 18) {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil((len * 3) / 4) + 1));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, 'A')
    .replace(/\//g, 'B')
    .replace(/=/g, '')
    .slice(0, len)
    .toLowerCase();
}

export const bytesToHex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export const hexToBytes = (hex) =>
  new Uint8Array((hex.match(/.{1,2}/g) || []).map((h) => parseInt(h, 16)));

export async function sha256Hex(text) {
  return bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return bytesToHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

/** PBKDF2-SHA256，迭代数控制在免费版 CPU 限制内 */
export async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: 15000, hash: 'SHA-256' },
    key,
    256,
  );
  return bytesToHex(bits);
}

export function safeEqual(a = '', b = '') {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 找回密码索引的 HMAC 密钥。优先用环境变量；两者都没配时，
 * 首次使用会生成一个随机密钥写进 settings，不再使用任何硬编码默认值。
 */
async function recoverySecret(env) {
  try {
    const row = await env.DB.prepare("SELECT v FROM settings WHERE k = 'recovery_secret'").first();
    if (row?.v) return row.v;
    const fresh = randomId(40);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO settings (k, v, updated_at) VALUES ('recovery_secret', ?, ?)",
    )
      .bind(fresh, nowSec())
      .run();
    const again = await env.DB.prepare("SELECT v FROM settings WHERE k = 'recovery_secret'").first();
    return again?.v || fresh;
  } catch {
    // 极端兜底：至少做到「每次部署/实例不同」，绝不用固定常量
    return `ephemeral-${nowSec()}`;
  }
}

/** 密码找回索引：HMAC(secret, 规范化密码)，相同密码可跨设备找回 */
export async function recoveryKey(env, password) {
  const secret = env.RECOVERY_SECRET || env.ADMIN_TOKEN || (await recoverySecret(env));
  return hmacHex(secret, 'recover:' + password.trim().toLowerCase());
}

/* --------------------------------- 限流 --------------------------------- */

export function clientIp(request) {
  // 只信任 Cloudflare 注入的 cf-connecting-ip。x-real-ip 客户端可以随意伪造，
  // 采信它等于把限流键交给攻击者，换个头就能绕过创建 / 登录 / 找回的频次限制。
  return request.headers.get('cf-connecting-ip') || '0.0.0.0';
}

/**
 * 固定窗口计数器。返回 { allowed, remaining, resetAt }
 */
export async function rateLimit(env, key, limit, windowSec) {
  const now = nowSec();
  const bucket = now - (now % windowSec);
  try {
    const row = await env.DB.prepare(
      `INSERT INTO rate_limits (k, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(k) DO UPDATE SET
         count = CASE WHEN window_start = ? THEN count + 1 ELSE 1 END,
         window_start = ?
       RETURNING count`,
    )
      .bind(key, bucket, bucket, bucket)
      .first();
    const count = row?.count ?? 1;
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt: bucket + windowSec };
  } catch {
    return { allowed: true, remaining: limit, resetAt: now };
  }
}

/* -------------------------------- 过期清理 -------------------------------- */

export async function purgeExpired(env) {
  const now = nowSec();
  const expired = await env.DB.prepare('SELECT id FROM mailboxes WHERE expires_at <= ? LIMIT 500')
    .bind(now)
    .all();
  const ids = expired.results.map((r) => r.id);
  if (!ids.length) return { purged: 0 };

  const placeholders = ids.map(() => '?').join(',');
  const msgRows = await env.DB.prepare(
    `SELECT id FROM messages WHERE mailbox_id IN (${placeholders})`,
  )
    .bind(...ids)
    .all();
  const msgIds = msgRows.results.map((r) => r.id);

  const stmts = [];
  if (msgIds.length) {
    const mp = msgIds.map(() => '?').join(',');
    stmts.push(env.DB.prepare(`DELETE FROM attachments WHERE message_id IN (${mp})`).bind(...msgIds));
    stmts.push(env.DB.prepare(`DELETE FROM messages WHERE id IN (${mp})`).bind(...msgIds));
  }
  stmts.push(env.DB.prepare(`DELETE FROM mailboxes WHERE id IN (${placeholders})`).bind(...ids));
  await env.DB.batch(stmts);

  // 顺带清理过期的限流记录与孤儿附件
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - 86400),
    env.DB.prepare(
      'DELETE FROM attachments WHERE message_id NOT IN (SELECT id FROM messages)',
    ),
  ]);

  return { purged: ids.length, messages: msgIds.length };
}

/* ------------------------------- 输入校验 -------------------------------- */

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export function cleanText(v, max = 200) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

export const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
export const LOCAL_RE = /^[a-z0-9]([a-z0-9._-]{1,28})[a-z0-9]$/;

export const RESERVED = new Set([
  'admin', 'administrator', 'postmaster', 'hostmaster', 'webmaster', 'abuse', 'root',
  'mailer-daemon', 'noreply', 'no-reply', 'support', 'security', 'billing', 'api', 'www',
]);

/* ------------------------------ 管理端会话 ------------------------------- */

export const ADMIN_COOKIE = 'fm_admin';
const ADMIN_TTL = 12 * 3600;

/**
 * 无状态会话：payload 里放过期时间，签名防篡改。
 * secret 由调用方（api.js）从 settings 表读取，首次自动生成并持久化。
 */
export async function signAdminSession(secret, ttlSec = ADMIN_TTL) {
  if (!secret) throw new Error('missing admin session secret');
  const exp = nowSec() + ttlSec;
  const payload = `${exp}`;
  const sig = await hmacHex(secret, `admin:${payload}`);
  return `${payload}.${sig.slice(0, 32)}`;
}

export async function verifyAdminSession(secret, token) {
  if (!token || !secret) return false;
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig) return false;
  const exp = parseInt(payload, 10);
  if (!Number.isFinite(exp) || exp <= nowSec()) return false;
  const want = (await hmacHex(secret, `admin:${payload}`)).slice(0, 32);
  return safeEqual(sig, want);
}

/* ------------------------------- 活动记录 -------------------------------- */

/** 写一条后台可见的事件，失败不影响主流程 */
export async function logEvent(env, kind, ref = '', detail = '', ip = '') {
  try {
    await env.DB.prepare('INSERT INTO events (kind, ref, detail, ip, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(String(kind).slice(0, 32), String(ref).slice(0, 120), String(detail).slice(0, 200), String(ip).slice(0, 46), nowSec())
      .run();
  } catch { /* 事件表缺失时静默忽略 */ }
}

/* ----------------------------- 邮件 HTML 净化 ----------------------------- */

const DANGEROUS_TAGS = [
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input',
  'button', 'select', 'option', 'textarea', 'base', 'link', 'meta', 'svg', 'math',
  'template', 'noscript', 'portal',
];

/**
 * 邮件正文净化：CSP 已经是主要防线，这里做「去掉危险标签 / 事件属性 / 伪协议」的兜底，
 * 保证即使有人拿到原始 HTML 也不会在浏览器里执行任何脚本。
 */
export function sanitizeEmailHtml(input) {
  let html = String(input || '').slice(0, 600000);

  // 1. 成对出现的危险标签连同内容一起删除
  for (const tag of DANGEROUS_TAGS) {
    const pair = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
    html = html.replace(pair, ' ');
  }
  // 2. 残留的单个危险标签（未闭合 / 自闭合）
  html = html.replace(new RegExp(`<\\/?(${DANGEROUS_TAGS.join('|')})\\b[^>]*>`, 'gi'), ' ');
  // 3. 注释里常藏条件注释脚本
  html = html.replace(/<!--[\s\S]*?-->/g, ' ');
  // 4. 事件属性与可注入属性
  html = html.replace(/\s+on[a-z]{3,}\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  html = html.replace(/\s+(srcdoc|formaction|xlink:href|dynsrc|lowsrc)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // 5. javascript: / vbscript: / data:text/html 伪协议
  html = html.replace(
    /((?:href|src|action|poster)\s*=\s*)(["']?)\s*(?:javascript|vbscript|livescript)\s*:[^"'\s>]*\2/gi,
    '$1$2#$2',
  );
  html = html.replace(
    /((?:href|src)\s*=\s*)(["']?)\s*data\s*:\s*text\/html[^"'\s>]*\2/gi,
    '$1$2#$2',
  );
  // 6. 给外链补上安全属性
  html = html.replace(/<a\b([^>]*)>/gi, (full, attrs) => {
    let a = attrs
      .replace(/\s+target\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s+rel\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    return `<a${a} target="_blank" rel="noopener noreferrer nofollow">`;
  });

  // 关闭标签是否成对不重要，浏览器会自行修补
  return html;
}

/** 允许内联展示的图片类型：只放行位图，SVG / HTML 一律走下载 */
const INLINE_SAFE = /^image\/(png|jpeg|jpg|pjpeg|gif|webp|bmp|x-ms-bmp|avif|apng)$/i;

export function isInlineSafeImage(mime) {
  return INLINE_SAFE.test(String(mime || '').trim());
}
