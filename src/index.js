import { handleApi } from './api/index.js';
import { handleEmail } from './email.js';
import { purgeExpired } from './lib.js';
import { gateCheck } from './gate.js';

/**
 * 站点外壳的安全头：
 * - CSP 只允许自身脚本，邮件正文在独立沙箱 iframe 里，不占用这里的策略
 * - frame-ancestors 'none' 防点击劫持
 */
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join('; ');

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin-allow-popups',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'content-security-policy': APP_CSP,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 站点门禁：所有请求先过密码验证，通过后 30 天免输入
    const gated = await gateCheck(request, env, url);
    if (gated) return gated;

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(request, env, ctx, url);
    }

    // 管理后台：/admin 与 /admin/ 都指向静态页
    const wantAdmin = url.pathname === '/admin' || url.pathname === '/admin/';
    // 静态资源层关掉了 html_handling，目录路径要显式映射到具体文件
    let assetPath = url.pathname === '/' ? '/index.html' : url.pathname;
    if (wantAdmin) assetPath = '/admin.html';

    const assetUrl = new URL(assetPath + url.search, url);
    let res = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));

    // 非静态资源路径回落到单页入口
    if (!wantAdmin && res.status === 404 && !/\.[a-z0-9]{1,8}$/i.test(url.pathname)) {
      const indexRes = await env.ASSETS.fetch(
        new Request(new URL('/index.html' + url.search, url).toString(), request),
      );
      res = new Response(indexRes.body, { status: 200, headers: indexRes.headers });
    }

    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);

    const isHtml = /text\/html/i.test(headers.get('content-type') || '');
    if (wantAdmin) {
      headers.set('cache-control', 'no-store');
      headers.set('x-robots-tag', 'noindex, nofollow');
    } else if (isHtml) {
      // HTML 绝不缓存：否则手机浏览器可能长期拿着旧 DOM，配上新脚本直接白屏
      headers.set('cache-control', 'no-store');
    } else {
      // 其余静态资源回源校验，发布后立刻生效
      headers.set('cache-control', 'public, max-age=0, must-revalidate');
    }

    return new Response(res.body, { status: res.status, headers });
  },

  async email(message, env, ctx) {
    return handleEmail(message, env, ctx);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      purgeExpired(env)
        .then((r) => console.log('[cron] purged', JSON.stringify(r)))
        .catch((e) => console.error('[cron] failed', e && e.message)),
    );
  },
};
