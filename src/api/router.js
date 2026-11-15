/**
 * FadeMail · API 路由表
 *
 * 各资源模块（frontend / messages / auth / v1 / admin）在加载时向这里注册路由，
 * 入口 index.js 用 match() 按方法 + 路径找到处理函数。
 */
const routes = [];

export const add = (method, pattern, handler) =>
  routes.push({ method, segs: pattern.split('/').filter(Boolean), handler });

export function match(method, pathname) {
  const segs = pathname.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== method || r.segs.length !== segs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < r.segs.length; i++) {
      const s = r.segs[i];
      if (s.startsWith(':')) params[s.slice(1)] = decodeURIComponent(segs[i]);
      else if (s !== segs[i]) { ok = false; break; }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}
