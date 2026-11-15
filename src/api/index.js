/**
 * FadeMail · API 入口
 *
 * 各资源模块加载时向 router 注册路由；本文件只负责 CORS / 错误兜底 / 响应加工。
 */
import { match } from './router.js';
import { fail, withCors, corsHeaders } from '../lib.js';

import './frontend.js';
import './messages.js';
import './auth.js';
import './v1.js';
import './admin.js';

export async function handleApi(request, env, ctx, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }
  const hit = match(request.method, url.pathname);
  if (!hit) return withCors(fail('接口不存在', 404), request, env);

  let res;
  try {
    res = await hit.handler({ request, env, ctx, params: hit.params, url });
  } catch (e) {
    console.error('[api]', url.pathname, e && e.stack ? e.stack : e);
    res = fail('服务器内部错误：' + (e.message || e), 500);
  }

  const out = new Headers(res.headers);
  out.set('x-content-type-options', 'nosniff');
  if (!out.has('referrer-policy')) out.set('referrer-policy', 'no-referrer');
  return withCors(new Response(res.body, { status: res.status, headers: out }), request, env);
}
