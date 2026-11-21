/**
 * 冒烟测试：验证配置、邮箱访问保护、邮件渲染安全与后台接口。
 * 用法：
 *   node scripts/smoke.mjs                        # 默认打本地 8787
 *   node scripts/smoke.mjs https://your-site.example.com
 * 后台用例默认用账号密码 admin / 123456，可用 ADMIN_USER / ADMIN_PASS 覆盖；
 * 显式设置 ADMIN_TOKEN 时改为令牌方式。
 */
const base = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/+$/, '');

// 后台默认用账号密码登录；显式设置 ADMIN_TOKEN 时才走令牌（CLI 场景）
const adminToken = process.env.ADMIN_TOKEN || '';
const adminUser = process.env.ADMIN_USER || 'admin';
const adminPass = process.env.ADMIN_PASS || '123456';
// 站点门禁密码（与 Worker Secret SITE_PASSWORD / 本地 .dev.vars 一致，默认 123456）
const gatePass = process.env.FM_SITE_PASSWORD || '123456';

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}${extra ? ' · ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? ' · ' + extra : ''}`);
  }
};

let gateCookie = ''; // 过门禁后所有请求都带上

const req = async (path, { method = 'GET', body, headers = {}, withGate = true } = {}) => {
  const init = { method, headers: { ...headers } };
  if (withGate && gateCookie) {
    // 与调用方显式传入的 cookie（如后台会话）合并，不互相覆盖
    init.headers.cookie = init.headers.cookie ? `${init.headers.cookie}; ${gateCookie}` : gateCookie;
  }
  if (body) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + path, init);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, headers: res.headers, data, text };
};

/** 站点门禁：先验证拦截行为，再用密码换 Cookie */
const passGate = async () => {
  const blocked = await req('/api/config', { withGate: false });
  if (blocked.headers.get('x-fm-code') === 'gate-page') {
    // 极老版本没有门禁，直接跳过
    console.log('  skip 站点门禁（未启用）');
    return true;
  }
  check('未验证访问 API 被拦 (401)', blocked.status === 401 && blocked.headers.get('x-fm-code') === 'gate-required');
  const page = await req('/', { withGate: false });
  check('未验证访问页面返回密码页', page.status === 200 && /访问密码/.test(page.text));
  check('密码页 noindex', /noindex/.test(page.headers.get('x-robots-tag') || ''));

  const bad = await req('/api/gate', { method: 'POST', body: { password: 'wrong' }, withGate: false });
  check('错误密码被拒 (401)', bad.status === 401);

  const ok = await req('/api/gate', { method: 'POST', body: { password: gatePass }, withGate: false });
  const raw = ok.headers.get('set-cookie') || '';
  check('正确密码通过门禁', ok.status === 200 && /fm_gate=/.test(raw), raw.slice(0, 10) + '…');
  gateCookie = raw.split(';')[0];

  const after = await req('/api/config');
  check('通过后 API 正常', after.status === 200);
  return true;
};

const run = async () => {
  console.log(`FadeMail smoke @ ${base}\n`);

  // 0. 站点门禁：验证拦截行为并取得免验证 Cookie
  await passGate();

  // 1. 站点外壳
  const home = await req('/');
  check('首页 200', home.status === 200);
  check('首页为真实内容而非密码页', !/访问密码/.test(home.text));
  check('首页带 CSP', !!home.headers.get('content-security-policy'), home.headers.get('content-security-policy')?.slice(0, 40));
  check('首页禁止被嵌入', /frame-ancestors 'none'/.test(home.headers.get('content-security-policy') || ''));

  const adminPage = await req('/admin');
  check('管理后台页面可达', adminPage.status === 200 && /管理后台/.test(adminPage.text));
  check('后台页 noindex', /noindex/.test(adminPage.headers.get('x-robots-tag') || ''));

  // 1.1 CORS：只给白名单来源发头，来源伪造 / 本地页面都不行
  const evilOrigin = await req('/api/config', { headers: { origin: 'https://evil.example' } });
  check('非白名单来源无 CORS 头', !evilOrigin.headers.get('access-control-allow-origin'));
  const localOrigin = await req('/api/config', { headers: { origin: 'http://localhost:5173' } });
  check('localhost 来源无 CORS 头', !localOrigin.headers.get('access-control-allow-origin'));

  // 2. 配置与域名
  const cfg = await req('/api/config');
  check('config 200', cfg.status === 200);
  check('返回站点地址', !!cfg.data?.siteUrl, cfg.data?.siteUrl);
  const domains = cfg.data?.domains || [];
  check('至少配置了一个收信域名', domains.length > 0, domains.join(','));

  // 3. 创建邮箱 + 访问保护
  const local = 'smoke' + Math.random().toString(36).slice(2, 8);
  const pw = 'smoke-' + Math.random().toString(36).slice(2, 10);
  const created = await req('/api/mailboxes', {
    method: 'POST',
    body: { local, domain: domains[0], ttlHours: 1, password: pw },
  });
  check('创建邮箱 201', created.status === 201, created.data?.error);
  const mb = created.data?.mailbox;
  check('创建时下发访问密钥', !!mb?.accessKey, mb?.accessKey ? `len=${mb.accessKey.length}` : 'missing');
  check('邮箱标记为受保护', mb?.protected === true);

  const noKey = await req(`/api/mailboxes/${mb.id}/messages`);
  check('无密钥读信被拒 (403)', noKey.status === 403, noKey.data?.error);
  const badKey = await req(`/api/mailboxes/${mb.id}/messages`, { headers: { 'x-mailbox-key': 'wrong' } });
  check('错误密钥被拒 (403)', badKey.status === 403);
  const withKey = await req(`/api/mailboxes/${mb.id}/messages`, { headers: { 'x-mailbox-key': mb.accessKey } });
  check('带密钥可读信', withKey.status === 200, `total=${withKey.data?.total}`);

  const noKeyPatch = await req(`/api/mailboxes/${mb.id}`, { method: 'PATCH', body: { note: 'x' } });
  check('无密钥改邮箱被拒 (403)', noKeyPatch.status === 403);

  // 4. 密码找回会带上密钥
  const rec = await req('/api/auth/recover', { method: 'POST', body: { password: pw } });
  const recovered = (rec.data?.mailboxes || []).find((m) => m.id === mb.id);
  check('密码找回可用', rec.status === 200 && !!recovered);
  check('找回结果包含密钥', !!recovered?.accessKey);

  // 4.1 找回密码要求唯一，避免一群人共用一个密码
  const dup = await req('/api/mailboxes', {
    method: 'POST',
    body: { domain: domains[0], ttlHours: 1, password: pw },
  });
  check('找回密码不可重复 (409)', dup.status === 409, dup.data?.error);

  // 5. 邮件注入与净化（本地可用 cdn-cgi 投递）
  const rawMail = [
    'From: "Smoke" <smoke@example.com>',
    `To: ${mb.address}`,
    'Subject: smoke test',
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <smoke-${Date.now()}@example.com>`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<html><body>',
    '<h1>hello</h1>',
    '<script>parent.document.title="pwned"</script>',
    '<iframe src="https://evil.example"></iframe>',
    '<img src=x onerror="alert(1)">',
    '<a href="javascript:alert(2)">click</a>',
    '<form action="https://evil"><input name="p"></form>',
    '<svg onload="alert(3)"><circle r="4"/></svg>',
    '</body></html>',
  ].join('\r\n');

  const deliver = await fetch(`${base}/cdn-cgi/handler/email?from=smoke@example.com&to=${encodeURIComponent(mb.address)}`, {
    method: 'POST',
    headers: { 'content-type': 'message/rfc822' },
    body: rawMail,
  }).catch(() => null);
  // 这个投递入口只在 wrangler dev 里存在，线上跑时跳过
  const canDeliver = !!deliver && deliver.status < 400;
  if (deliver && (deliver.status === 404 || deliver.status === 405)) {
    console.log('  skip 邮件净化用例（线上环境无法本地投递）');
  } else {
    check('本地投递测试邮件', canDeliver, deliver ? `HTTP ${deliver.status}` : 'failed');
  }

  if (canDeliver) {
    const list = await req(`/api/mailboxes/${mb.id}/messages`, { headers: { 'x-mailbox-key': mb.accessKey } });
    const msg = list.data?.messages?.[0];
    check('收到邮件', !!msg);
    if (msg) {
      const html = await req(`/api/messages/${msg.id}/html?k=${encodeURIComponent(mb.accessKey)}`);
      const body = html.text || '';
      check('正文返回 200', html.status === 200);
      check('脚本已被剔除', !/<script/i.test(body));
      check('iframe 已被剔除', !/<iframe/i.test(body));
      check('事件属性已被剔除', !/\sonerror\s*=/i.test(body));
      check('伪协议已被剔除', !/javascript:/i.test(body));
      check('表单已被剔除', !/<form/i.test(body));
      check('svg 已被剔除', !/<svg[\s>]/i.test(body));
      check('CSP 沙箱生效', /sandbox/.test(html.headers.get('content-security-policy') || ''));
      check('正文不缓存', /no-store/.test(html.headers.get('cache-control') || ''));
      check('无 referrer 泄露', html.headers.get('referrer-policy') === 'no-referrer');

      const noKeyHtml = await req(`/api/messages/${msg.id}/html`);
      check('正文无密钥被拒 (403)', noKeyHtml.status === 403);
    }
  }

  // 6. 管理后台
  const badLogin = await req('/api/admin/login', { method: 'POST', body: { token: 'nope' } });
  check('错误令牌登录被拒', badLogin.status === 401);

  const unauth = await req('/api/admin/overview');
  check('未登录访问后台接口被拒', unauth.status === 401);

  {
    const login = await req('/api/admin/login', {
      method: 'POST',
      body: adminToken ? { token: adminToken } : { username: adminUser, password: adminPass },
    });
    check('管理员登录成功', login.status === 200, login.data?.error || '');
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    check('下发 HttpOnly 会话', /fm_admin=/.test(cookie), cookie.slice(0, 12) + '…');

    const overview = await req('/api/admin/overview', { headers: { cookie } });
    check('后台总览可用', overview.status === 200 && !!overview.data?.stats);
    check('总览含域名维度', Array.isArray(overview.data?.domains));

    const list = await req('/api/admin/mailboxes?page=1&size=5', { headers: { cookie } });
    check('后台邮箱列表可用', list.status === 200 && Array.isArray(list.data?.mailboxes));

    const csrfMissing = await req(`/api/admin/mailboxes/${mb.id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    check('Cookie 变更操作需要 CSRF 标记', csrfMissing.status === 403);

    const key = await req('/api/admin/keys', { method: 'POST', headers: { cookie, 'x-admin-csrf': '1' }, body: { name: 'smoke' } });
    check('后台可创建 API Key', key.status === 201 && /^fm_/.test(key.data?.key || ''));
    const rawKey = key.data?.key || '';

    // 开放 API：带密钥不需要站点门禁 Cookie
    const v1NoGate = await req('/api/v1/domains', { headers: { authorization: `Bearer ${rawKey}` }, withGate: false });
    check('v1 带密钥绕过站点门禁', v1NoGate.status === 200 && Array.isArray(v1NoGate.data?.domains));
    const v1BadKey = await req('/api/v1/domains', { headers: { authorization: 'Bearer fm_not_real' }, withGate: false });
    check('v1 无效密钥仍被拒 (401)', v1BadKey.status === 401);

    const events = await req('/api/admin/events?limit=20', { headers: { cookie } });
    check('活动日志可用', events.status === 200 && Array.isArray(events.data?.events));

    // 活动记录删除：只删本次冒烟自己产生的那条
    const smokeEvent = (events.data?.events || []).find((ev) => ev.kind === 'admin.key.create' && ev.ref === 'smoke');
    const evDel = smokeEvent
      ? await req(`/api/admin/events/${smokeEvent.id}`, { method: 'DELETE', headers: { cookie, 'x-admin-csrf': '1' } })
      : null;
    check('活动记录可真删', !!evDel && evDel.status === 200, smokeEvent ? '' : '未找到刚创建的事件');

    // API Key 删除是真删，删完旧密钥立刻失效
    const keyDel = await req(`/api/admin/keys/${encodeURIComponent(key.data?.id)}`, {
      method: 'DELETE',
      headers: { cookie, 'x-admin-csrf': '1' },
    });
    check('API Key 删除成功', keyDel.status === 200);
    const keysAfter = await req('/api/admin/keys', { headers: { cookie } });
    check('删除后列表不再有该密钥', !(keysAfter.data?.keys || []).some((k) => k.id === key.data?.id));
    const v1After = await req('/api/v1/domains', { headers: { authorization: `Bearer ${rawKey}` }, withGate: false });
    check('删除后旧密钥立即失效 (401)', v1After.status === 401);

    const siteConf = await req('/api/admin/settings', { headers: { cookie } });
    check('可读取站点配置', siteConf.status === 200 && !!siteConf.data?.settings?.brand);
    check('站点配置含标题与图标', typeof siteConf.data?.settings?.title === 'string' && typeof siteConf.data?.settings?.logo === 'string');

    // 标题 / 图标可保存，随后原样还原，避免污染站点
    const before = siteConf.data?.settings || {};
    const patched = await req('/api/admin/settings', {
      method: 'PATCH',
      headers: { cookie, 'x-admin-csrf': '1' },
      body: { ...before, title: 'Smoke 标题', logo: '🧪' },
    });
    check('站点标题可保存', patched.data?.settings?.title === 'Smoke 标题');
    check('站点图标可保存', patched.data?.settings?.logo === '🧪');
    await req('/api/admin/settings', {
      method: 'PATCH',
      headers: { cookie, 'x-admin-csrf': '1' },
      body: before,
    });

    const account = await req('/api/admin/account', { headers: { cookie } });
    check('可读取管理员账号', account.status === 200 && !!account.data?.username);

    const cleaned = await req(`/api/admin/mailboxes/${mb.id}`, {
      method: 'DELETE',
      headers: { cookie, 'x-admin-csrf': '1' },
    });
    check('后台可删除邮箱', cleaned.status === 200);
  }

  console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
};

run().catch((e) => {
  console.error('smoke 执行失败：', e);
  process.exit(1);
});
