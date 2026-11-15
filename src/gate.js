/**
 * FadeMail · 站点门禁（gate）
 *
 * 所有请求（页面 / 静态资源 / API）都先过这一关：浏览器首次访问输入站点密码，
 * 验证通过后发一枚 30 天的 HttpOnly 签名 Cookie，期间不再重复填写；
 * Cookie 过期或密码更换后自动回到输入页。
 *
 * 密码放在 Worker Secret（SITE_PASSWORD）里，不进代码库；
 * 未配置密码时全站锁死（fail closed），绝不裸奔。
 */
import {
  fail, json, nowSec, hmacHex, safeEqual, sha256Hex, rateLimit, clientIp, logEvent,
} from './lib.js';

const GATE_COOKIE = 'fm_gate';
const GATE_TTL = 30 * 86400; // 30 天内免输入
const PW_DOMAIN = 'fademail-gate-pw:'; // 域分隔，避免与其他 sha256 用途串用

function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return '';
}

/** 签名密钥：由站点密码派生，密码换掉则所有旧 Cookie 立即失效 */
async function gateSecret(env) {
  return sha256Hex(`fademail-gate-secret:${env.SITE_PASSWORD}`);
}

/** token = <过期时间>.<HMAC 前 32 位>，无状态、防篡改、到点重新输入 */
async function issueToken(env) {
  const exp = nowSec() + GATE_TTL;
  const sig = await hmacHex(await gateSecret(env), `gate:${exp}`);
  return `${exp}.${sig.slice(0, 32)}`;
}

async function verifyToken(env, token) {
  if (!token) return false;
  const [payload, sig] = String(token).split('.');
  const exp = parseInt(payload, 10);
  if (!Number.isFinite(exp) || exp <= nowSec()) return false;
  const want = (await hmacHex(await gateSecret(env), `gate:${exp}`)).slice(0, 32);
  return safeEqual(sig, want);
}

/** 门禁入口：返回 Response 表示拦截，返回 null 表示放行 */
export async function gateCheck(request, env, url) {
  if (request.method === 'OPTIONS') return null; // CORS 预检不带凭据，放行

  if (!env.SITE_PASSWORD) {
    return new Response('Service temporarily unavailable', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '300', 'cache-control': 'no-store' },
    });
  }

  if (await verifyToken(env, readCookie(request, GATE_COOKIE))) return null;

  // 门禁自己的验证端点（未验证时唯一可用的 API）
  if (request.method === 'POST' && url.pathname === '/api/gate') {
    return gateLogin(request, env, url);
  }

  const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
  if (isApi) {
    return fail('需要先通过站点门禁', 401, {
      'x-fm-code': 'gate-required',
      'cache-control': 'no-store',
    });
  }
  return gatePage();
}

async function gateLogin(request, env, url) {
  const ip = clientIp(request);
  const rl = await rateLimit(env, `gate:${ip}`, 10, 600);
  if (!rl.allowed) return fail('尝试过于频繁，请 10 分钟后再试', 429);

  const body = await request.json().catch(() => ({}));
  const password = String(body.password ?? '');
  // 双方先哈希再常数比较，不直接对比明文，避免时序侧信道
  const got = await sha256Hex(PW_DOMAIN + password);
  const want = await sha256Hex(PW_DOMAIN + env.SITE_PASSWORD);
  if (!safeEqual(got, want)) {
    await logEvent(env, 'gate.fail', '', '', ip);
    return fail('密码不正确', 401);
  }

  await logEvent(env, 'gate.pass', '', '', ip);
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return json({ ok: true }, 200, {
    'set-cookie': `${GATE_COOKIE}=${await issueToken(env)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${GATE_TTL}${secure}`,
    'cache-control': 'no-store',
  });
}

/**
 * 输入密码页：完全内联、零外部依赖（页面本身受门禁保护，
 * 未验证时连 style.css / app.js 都拿不到，因此必须自足）。
 * 风格沿用站点：白底居中、品牌蓝 #4d6bfe、克制圆角。
 */
function gatePage() {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>访问验证 · FadeMail</title>
<style>
  :root { color-scheme: light; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    background: #fff;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #1f2328;
  }
  .card { width: 100%; max-width: 360px; padding: 0 24px; }
  .brand {
    display: flex; align-items: center; gap: 10px;
    justify-content: center; margin-bottom: 6px;
  }
  .brand .logo {
    width: 34px; height: 34px; border-radius: 9px;
    background: #4d6bfe; color: #fff;
    display: flex; align-items: center; justify-content: center;
    font-size: 17px; font-weight: 600;
  }
  .brand .name { font-size: 19px; font-weight: 600; letter-spacing: .2px; }
  .sub { text-align: center; color: #6b7280; font-size: 13.5px; margin-bottom: 30px; }
  label { display: block; font-size: 13.5px; color: #374151; margin-bottom: 7px; }
  .box {
    display: flex; align-items: center;
    border: 1px solid #dcdfe3; border-radius: 8px;
    transition: border-color .15s, box-shadow .15s;
  }
  .box:focus-within { border-color: #4d6bfe; box-shadow: 0 0 0 3px rgba(77,107,254,.12); }
  .box input {
    flex: 1; height: 44px; padding: 0 14px;
    border: 0; outline: 0; background: transparent;
    font: inherit; font-size: 15px; color: #1f2328;
  }
  .toggle {
    border: 0; background: none; cursor: pointer;
    padding: 0 14px; height: 44px; color: #9ca3af; font-size: 13px;
  }
  .toggle:hover { color: #4d6bfe; }
  button.go {
    width: 100%; height: 44px; margin-top: 18px;
    border: 0; border-radius: 8px; cursor: pointer;
    background: #4d6bfe; color: #fff; font: inherit; font-size: 15px; font-weight: 500;
    transition: background .15s;
  }
  button.go:hover { background: #3f5be6; }
  button.go:disabled { opacity: .55; cursor: default; }
  .err {
    min-height: 20px; margin-top: 12px; text-align: center;
    color: #d93025; font-size: 13px;
  }
  .foot { margin-top: 34px; text-align: center; color: #9ca3af; font-size: 12px; }
</style>
</head>
<body>
  <main class="card">
    <div class="brand"><span class="logo">F</span><span class="name">FadeMail</span></div>
    <p class="sub">本站为私有服务，请输入访问密码继续</p>
    <form id="f" autocomplete="off">
      <label for="pw">访问密码</label>
      <div class="box">
        <input id="pw" type="password" placeholder="请输入密码" autofocus autocomplete="current-password">
        <button type="button" class="toggle" id="t" aria-label="显示或隐藏密码">显示</button>
      </div>
      <button class="go" id="go" type="submit">进入</button>
      <p class="err" id="err"></p>
    </form>
    <p class="foot">验证通过后 30 天内无需再次输入</p>
  </main>
<script>
(function () {
  var f = document.getElementById('f');
  var pw = document.getElementById('pw');
  var go = document.getElementById('go');
  var err = document.getElementById('err');
  document.getElementById('t').addEventListener('click', function () {
    var show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    this.textContent = show ? '隐藏' : '显示';
  });
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = pw.value;
    if (!v) { err.textContent = '请输入密码'; pw.focus(); return; }
    go.disabled = true;
    err.textContent = '';
    fetch('/api/gate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: v }),
    }).then(function (r) {
      if (r.ok) { location.replace(location.pathname + location.search); return; }
      return r.json().catch(function () { return {}; }).then(function (d) {
        err.textContent = d.error || '密码不正确';
        go.disabled = false;
        pw.focus(); pw.select();
      });
    }).catch(function () {
      err.textContent = '网络异常，请重试';
      go.disabled = false;
    });
  });
})();
</script>
</body>
</html>`;

  const csp = [
    "default-src 'none'",
    "script-src 'unsafe-inline'", // 页面为 Worker 生成的静态内容，不含任何插值
    "style-src 'unsafe-inline'",
    "img-src data:",
    "connect-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': csp,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow',
      'x-fm-code': 'gate-page',
    },
  });
}
