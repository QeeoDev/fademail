/**
 * FadeMail · 管理端 API（/api/admin/*）
 *
 * 会话 Cookie + CSRF 标记（浏览器）或 x-admin-token（脚本）鉴权，
 * 覆盖：账号、站点设置、总览统计、邮箱/邮件、域名、API Key、事件日志。
 */
import { add } from './router.js';
import {
  TTL_PRESETS, readSettings, writeSetting, ensureAdminAccount, verifyAdminPassword,
  allowedDomains, pubMailbox,
} from './common.js';
import {
  json, fail, nowSec, clamp, cleanText, safeEqual, rateLimit, clientIp,
  randomId, randomStr, sha256Hex, hashPassword, logEvent,
  signAdminSession, verifyAdminSession, ADMIN_COOKIE, siteUrl, purgeExpired,
} from '../lib.js';

/* ------------------------------- 会话与鉴权 ------------------------------- */

function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return '';
}

function adminCookie(env, token, url) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure}`;
}

/** 会话签名密钥：首次使用时随机生成并写进 settings，重启/换实例都不会失效 */
async function adminSessionSecret(env) {
  const row = await env.DB.prepare("SELECT v FROM settings WHERE k = 'admin_session_secret'").first();
  if (row?.v) return row.v;
  const secret = randomId(48);
  try {
    await writeSetting(env, 'admin_session_secret', secret);
  } catch { /* 并发写入忽略 */ }
  return secret;
}

/**
 * 管理端鉴权：浏览器走 HttpOnly 会话 Cookie（变更操作要求 x-admin-csrf 头），
 * 脚本 / 命令行可以直接带 x-admin-token。
 */
async function adminGuard(request, env, handler, { mutating = false } = {}) {
  const token = request.headers.get('x-admin-token') || '';
  let authed = false;
  let viaToken = false;
  if (token && env.ADMIN_TOKEN) {
    authed = safeEqual(token, env.ADMIN_TOKEN);
    viaToken = authed;
  }
  if (!authed) {
    const secret = await adminSessionSecret(env);
    authed = await verifyAdminSession(secret, readCookie(request, ADMIN_COOKIE));
  }
  if (!authed) return fail('管理员未登录或会话已过期', 401, { 'x-fm-code': 'admin-unauthorized' });
  if (mutating && !viaToken && request.headers.get('x-admin-csrf') !== '1') {
    return fail('缺少 CSRF 校验标记', 403);
  }
  const rl = await rateLimit(env, `admin:${clientIp(request)}`, 900, 60);
  if (!rl.allowed) return fail('操作过于频繁，请稍后再试', 429);
  return handler();
}

/* ------------------------------- 登录与账号 ------------------------------- */

add('POST', '/api/admin/login', async ({ request, env, url }) => {
  const ip = clientIp(request);
  const rl = await rateLimit(env, `adminlogin:${ip}`, 12, 600);
  if (!rl.allowed) return fail('尝试过于频繁，请 10 分钟后再试', 429);

  const body = await request.json().catch(() => ({}));
  const account = await ensureAdminAccount(env);
  if (!account) return fail('管理账号未初始化', 500);

  const username = cleanText(body.username, 32);
  const password = String(body.password || '').slice(0, 128);
  const legacyToken = String(body.token || '').trim();

  let ok = false;
  if (legacyToken && env.ADMIN_TOKEN) ok = safeEqual(legacyToken, env.ADMIN_TOKEN);
  if (!ok) {
    ok =
      !!username &&
      username.toLowerCase() === String(account.username).toLowerCase() &&
      (await verifyAdminPassword(account, password));
  }
  if (!ok) {
    await logEvent(env, 'admin.login.fail', username, '', ip);
    return fail('账号或密码不正确', 401);
  }

  const secret = await adminSessionSecret(env);
  const session = await signAdminSession(secret);
  await logEvent(env, 'admin.login', username || 'token', '', ip);
  return json(
    { ok: true, username: account.username, mustChange: !!account.must_change },
    200,
    {
      'set-cookie': adminCookie(env, session, url),
      'cache-control': 'no-store',
    },
  );
});

add('POST', '/api/admin/logout', async ({ request, env, url }) => {
  const headers = {
    'set-cookie': `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${url.protocol === 'https:' ? '; Secure' : ''}`,
  };
  if (readCookie(request, ADMIN_COOKIE)) await logEvent(env, 'admin.logout', '', '', clientIp(request));
  return json({ ok: true }, 200, headers);
});

add('GET', '/api/admin/me', async ({ request, env }) =>
  adminGuard(request, env, async () => {
    const account = await ensureAdminAccount(env);
    return json({
      ok: true,
      admin: true,
      username: account?.username || 'admin',
      mustChange: !!account?.must_change,
    });
  }));

add('GET', '/api/admin/account', async ({ request, env }) =>
  adminGuard(request, env, async () => {
    const account = await ensureAdminAccount(env);
    return json({
      ok: true,
      username: account?.username || 'admin',
      mustChange: !!account?.must_change,
      updatedAt: account?.updated_at || 0,
    });
  }));

/** 改账号 / 改密码：必须先验证当前密码 */
add('PATCH', '/api/admin/account', async ({ request, env }) =>
  adminGuard(
    request,
    env,
    async () => {
      const body = await request.json().catch(() => ({}));
      const account = await ensureAdminAccount(env);
      if (!account) return fail('管理账号未初始化', 500);

      const current = String(body.currentPassword || '');
      if (!(await verifyAdminPassword(account, current))) return fail('当前密码不正确', 403);

      const username = body.username ? cleanText(body.username, 32) : account.username;
      if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
        return fail('账号需为 3-32 位字母、数字或 . _ -', 400);
      }

      const newPassword = body.newPassword ? String(body.newPassword) : '';
      if (newPassword && newPassword.length < 6) return fail('新密码至少 6 位', 400);
      if (newPassword.length > 128) return fail('新密码过长', 400);

      const salt = newPassword ? randomId(16) : account.pw_salt;
      const hash = newPassword ? await hashPassword(newPassword, salt) : account.pw_hash;
      const mustChange = newPassword ? 0 : account.must_change;

      await env.DB.prepare(
        'UPDATE admin_accounts SET username = ?, pw_salt = ?, pw_hash = ?, must_change = ?, updated_at = ? WHERE id = 1',
      )
        .bind(username, salt, hash, mustChange, nowSec())
        .run();
      await logEvent(env, 'admin.account.update', username, newPassword ? 'password=changed' : '', clientIp(request));
      return json({ ok: true, username, mustChange: !!mustChange });
    },
    { mutating: true },
  ));

/* -------------------------------- 站点设置 -------------------------------- */

add('GET', '/api/admin/settings', async ({ request, env }) =>
  adminGuard(request, env, async () => {
    const conf = await readSettings(env);
    return json({
      ok: true,
      settings: {
        brand: conf.brand || env.BRAND || 'FadeMail',
        siteUrl: conf.siteUrl || siteUrl(env, ''),
        notice: conf.notice || '',
        ttls: Array.isArray(conf.ttls) && conf.ttls.length ? conf.ttls : TTL_PRESETS,
        defaultTtl: conf.defaultTtl ?? parseInt(env.DEFAULT_TTL_HOURS || '24', 10),
        maxTtl: conf.maxTtl ?? parseInt(env.MAX_TTL_HOURS || '720', 10),
      },
      domains: await allowedDomains(env),
    });
  }));

add('PATCH', '/api/admin/settings', async ({ request, env }) =>
  adminGuard(
    request,
    env,
    async () => {
      const body = await request.json().catch(() => ({}));
      const current = await readSettings(env);

      const brand = cleanText(body.brand ?? current.brand ?? env.BRAND ?? 'FadeMail', 32);
      if (!brand) return fail('站点名称不能为空', 400);

      const rawUrl = String(body.siteUrl ?? current.siteUrl ?? siteUrl(env, '')).trim();
      if (!/^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(rawUrl)) return fail('站点地址需以 http(s):// 开头', 400);
      const cleanUrl = rawUrl.replace(/\/+$/, '');

      const maxTtl = clamp(parseInt(body.maxTtl ?? current.maxTtl ?? env.MAX_TTL_HOURS ?? 720, 10), 1, 8760);

      let ttls = body.ttls ?? current.ttls ?? TTL_PRESETS;
      if (!Array.isArray(ttls)) return fail('有效期选项格式不正确', 400);
      ttls = [...new Set(ttls.map((n) => parseInt(n, 10)))].filter((n) => Number.isFinite(n) && n >= 1 && n <= maxTtl);
      if (!ttls.length) return fail('至少保留一个有效期选项', 400);
      if (ttls.length > 8) return fail('有效期选项最多 8 个', 400);
      ttls.sort((a, b) => a - b);

      const defaultTtl = clamp(parseInt(body.defaultTtl ?? current.defaultTtl ?? 24, 10), 1, maxTtl);
      const notice = cleanText(body.notice ?? current.notice ?? '', 200);

      await Promise.all([
        writeSetting(env, 'brand', brand),
        writeSetting(env, 'siteUrl', cleanUrl),
        writeSetting(env, 'maxTtl', maxTtl),
        writeSetting(env, 'ttls', JSON.stringify(ttls)),
        writeSetting(env, 'defaultTtl', defaultTtl),
        writeSetting(env, 'notice', notice),
      ]);
      await logEvent(env, 'admin.settings.update', brand, `ttls=${ttls.join('/')}`, clientIp(request));
      return json({
        ok: true,
        settings: { brand, siteUrl: cleanUrl, notice, ttls, defaultTtl, maxTtl },
      });
    },
    { mutating: true },
  ));

/* --------------------------------- 总览 ---------------------------------- */

add('GET', '/api/admin/overview', async ({ request, env }) =>
  adminGuard(request, env, async () => {
    const now = nowSec();
    const dayAgo = now - 86400;
    const [active, total, msgs, unread, att, keys, todayMb, todayMsg] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) AS n FROM mailboxes WHERE expires_at > ?').bind(now).first(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM mailboxes').first(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE is_read = 0').first(),
      env.DB.prepare('SELECT COUNT(*) AS n, SUM(size) AS s FROM attachments').first(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE revoked = 0').first(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM mailboxes WHERE created_at > ?').bind(dayAgo).first(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE received_at > ?').bind(dayAgo).first(),
    ]);

    const [domainRows, eventRows, topRows] = await Promise.all([
      env.DB.prepare(
        `SELECT d.domain, d.enabled, d.is_default,
           (SELECT COUNT(*) FROM mailboxes mb WHERE mb.domain = d.domain) AS mailboxes,
           (SELECT COUNT(*) FROM mailboxes mb WHERE mb.domain = d.domain AND mb.expires_at > ?) AS active
         FROM domains d ORDER BY d.is_default DESC, d.domain ASC`,
      )
        .bind(now)
        .all(),
      env.DB.prepare('SELECT id, kind, ref, detail, ip, created_at FROM events ORDER BY id DESC LIMIT 12').all(),
      env.DB.prepare(
        'SELECT id, address, msg_count, expires_at FROM mailboxes ORDER BY msg_count DESC, created_at DESC LIMIT 6',
      ).all(),
    ]);

    return json({
      ok: true,
      serverTime: now,
      stats: {
        activeMailboxes: active?.n || 0,
        totalMailboxes: total?.n || 0,
        messages: msgs?.n || 0,
        unread: unread?.n || 0,
        attachments: att?.n || 0,
        attachmentBytes: att?.s || 0,
        apiKeys: keys?.n || 0,
        newMailboxes24h: todayMb?.n || 0,
        newMessages24h: todayMsg?.n || 0,
      },
      domains: domainRows.results.map((d) => ({
        domain: d.domain,
        enabled: !!d.enabled,
        isDefault: !!d.is_default,
        mailboxes: d.mailboxes || 0,
        active: d.active || 0,
      })),
      events: eventRows.results.map((e) => ({
        id: e.id, kind: e.kind, ref: e.ref, detail: e.detail, ip: e.ip, at: e.created_at,
      })),
      top: topRows.results.map((m) => ({
        id: m.id, address: m.address, messages: m.msg_count || 0, expiresAt: m.expires_at,
      })),
    });
  }));

/* -------------------------------- 邮箱管理 -------------------------------- */

add('GET', '/api/admin/mailboxes', async ({ request, env, url }) =>
  adminGuard(request, env, async () => {
    const q = cleanText(url.searchParams.get('q') || '', 80).toLowerCase();
    const page = clamp(parseInt(url.searchParams.get('page') || '1', 10), 1, 1000);
    const size = clamp(parseInt(url.searchParams.get('size') || '20', 10), 5, 100);
    const like = `%${q}%`;
    const where = q ? 'WHERE mb.address LIKE ? OR mb.note LIKE ?' : '';
    const args = q ? [like, like] : [];

    const [rows, count] = await Promise.all([
      env.DB.prepare(
        `SELECT mb.id, mb.address, mb.note, mb.created_at, mb.expires_at, mb.msg_count,
           mb.pw_hash IS NOT NULL AS has_pw, mb.access_key IS NOT NULL AS protected,
           (SELECT COUNT(*) FROM messages m WHERE m.mailbox_id = mb.id) AS total,
           (SELECT COUNT(*) FROM messages m WHERE m.mailbox_id = mb.id AND m.is_read = 0) AS unread
         FROM mailboxes mb ${where}
         ORDER BY mb.created_at DESC LIMIT ? OFFSET ?`,
      )
        .bind(...args, size, (page - 1) * size)
        .all(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM mailboxes mb ${where}`).bind(...args).first(),
    ]);

    return json({
      ok: true,
      page,
      size,
      total: count?.n || 0,
      mailboxCount: count?.n || 0,
      mailboxes: rows.results.map((m) => ({
        id: m.id,
        address: m.address,
        note: m.note || '',
        createdAt: m.created_at,
        expiresAt: m.expires_at,
        messages: m.total || 0,
        unread: m.unread || 0,
        hasPassword: !!m.has_pw,
        protected: !!m.protected,
      })),
    });
  }));

add('GET', '/api/admin/mailboxes/:id', async ({ request, env, params }) =>
  adminGuard(request, env, async () => {
    const mb = await env.DB.prepare('SELECT * FROM mailboxes WHERE id = ?').bind(params.id).first();
    if (!mb) return fail('邮箱不存在', 404);
    const msgs = await env.DB.prepare(
      `SELECT id, from_addr, from_name, subject, snippet, is_read, attach_count, raw_size, received_at, code
       FROM messages WHERE mailbox_id = ? ORDER BY received_at DESC LIMIT 50`,
    )
      .bind(mb.id)
      .all();
    return json({
      ok: true,
      mailbox: { ...pubMailbox(mb), protected: !!mb.access_key },
      messages: msgs.results.map((m) => ({
        id: m.id,
        fromAddr: m.from_addr,
        fromName: m.from_name,
        subject: m.subject,
        snippet: m.snippet,
        isRead: !!m.is_read,
        attachCount: m.attach_count,
        size: m.raw_size,
        code: m.code,
        receivedAt: m.received_at,
      })),
    });
  }));

add('PATCH', '/api/admin/mailboxes/:id', async ({ request, env, params }) =>
  adminGuard(request, env, async () => {
    const body = await request.json().catch(() => ({}));
    const mb = await env.DB.prepare('SELECT * FROM mailboxes WHERE id = ?').bind(params.id).first();
    if (!mb) return fail('邮箱不存在', 404);
    const sets = [];
    const args = [];
    if (typeof body.note === 'string') {
      sets.push('note = ?');
      args.push(cleanText(body.note, 80));
    }
    if (body.ttlHours) {
      const maxTtl = clamp(parseInt(env.MAX_TTL_HOURS || '720', 10), 1, 8760);
      const addHours = clamp(parseInt(body.ttlHours, 10) || 0, 1, maxTtl);
      const base = Math.max(nowSec(), mb.expires_at);
      sets.push('expires_at = ?');
      args.push(Math.min(base + addHours * 3600, nowSec() + maxTtl * 3600));
    }
    if (!sets.length) return fail('没有需要更新的字段', 400);
    args.push(mb.id);
    await env.DB.prepare(`UPDATE mailboxes SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
    await logEvent(env, 'admin.mailbox.update', mb.address, JSON.stringify(body).slice(0, 120), clientIp(request));
    return json({ ok: true });
  }, { mutating: true }));

add('DELETE', '/api/admin/mailboxes/:id', async ({ request, env, params }) =>
  adminGuard(request, env, async () => {
    const mb = await env.DB.prepare('SELECT id, address FROM mailboxes WHERE id = ?').bind(params.id).first();
    if (!mb) return fail('邮箱不存在', 404);
    const ids = (await env.DB.prepare('SELECT id FROM messages WHERE mailbox_id = ?').bind(mb.id).all())
      .results.map((r) => r.id);
    const stmts = [];
    if (ids.length) {
      const p = ids.map(() => '?').join(',');
      stmts.push(env.DB.prepare(`DELETE FROM attachments WHERE message_id IN (${p})`).bind(...ids));
      stmts.push(env.DB.prepare(`DELETE FROM messages WHERE id IN (${p})`).bind(...ids));
    }
    stmts.push(env.DB.prepare('DELETE FROM mailboxes WHERE id = ?').bind(mb.id));
    await env.DB.batch(stmts);
    await logEvent(env, 'admin.mailbox.delete', mb.address, `messages=${ids.length}`, clientIp(request));
    return json({ ok: true, removed: ids.length });
  }, { mutating: true }));

add('GET', '/api/admin/messages/:id', async ({ request, env, params }) =>
  adminGuard(request, env, async () => {
    const m = await env.DB.prepare(
      `SELECT m.*, mb.address AS mb_address FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id WHERE m.id = ?`,
    )
      .bind(params.id)
      .first();
    if (!m) return fail('邮件不存在', 404);
    const atts = await env.DB.prepare('SELECT id, filename, mime, size, truncated FROM attachments WHERE message_id = ?')
      .bind(m.id)
      .all();
    return json({
      ok: true,
      message: {
        id: m.id,
        mailbox: m.mb_address,
        fromAddr: m.from_addr,
        fromName: m.from_name,
        toAddr: m.to_addr,
        subject: m.subject,
        text: String(m.body_text || '').slice(0, 20000),
        hasHtml: !!m.body_html,
        headers: JSON.parse(m.headers || '[]'),
        size: m.raw_size,
        receivedAt: m.received_at,
        attachments: atts.results,
      },
    });
  }));

/* ----------------------------- 域名 / 密钥 / 事件 ----------------------------- */

add('GET', '/api/admin/events', async ({ request, env, url }) =>
  adminGuard(request, env, async () => {
    const limit = clamp(parseInt(url.searchParams.get('limit') || '60', 10), 1, 200);
    const rows = await env.DB.prepare(
      'SELECT id, kind, ref, detail, ip, created_at FROM events ORDER BY id DESC LIMIT ?',
    )
      .bind(limit)
      .all();
    return json({ ok: true, events: rows.results });
  }));

add('GET', '/api/admin/keys', async ({ request, env }) =>
  adminGuard(request, env, async () => {
    const rows = await env.DB.prepare(
      'SELECT id, name, prefix, created_at, last_used, calls, revoked FROM api_keys ORDER BY created_at DESC',
    ).all();
    return json({ ok: true, keys: rows.results });
  }));

add('POST', '/api/admin/keys', async ({ request, env }) =>
  adminGuard(request, env, async () => {
    const body = await request.json().catch(() => ({}));
    const name = cleanText(body.name, 40) || 'default';
    const raw = 'fm_' + randomStr(32);
    const id = randomId(14);
    await env.DB.prepare(
      'INSERT INTO api_keys (id, name, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(id, name, await sha256Hex(raw), raw.slice(0, 10), nowSec())
      .run();
    await logEvent(env, 'admin.key.create', name, '', clientIp(request));
    return json({ ok: true, id, name, key: raw, note: '请立即保存，此密钥仅显示一次' }, 201);
  }, { mutating: true }));

add('DELETE', '/api/admin/keys/:id', async ({ request, env, params }) =>
  adminGuard(request, env, async () => {
    await env.DB.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?').bind(params.id).run();
    await logEvent(env, 'admin.key.revoke', params.id, '', clientIp(request));
    return json({ ok: true });
  }, { mutating: true }));

add('GET', '/api/admin/domains', async ({ request, env }) =>
  adminGuard(request, env, async () => {
    const rows = await env.DB.prepare(
      `SELECT d.*, (SELECT COUNT(*) FROM mailboxes mb WHERE mb.domain = d.domain) AS mailboxes
       FROM domains d ORDER BY d.is_default DESC, d.created_at ASC`,
    ).all();
    return json({ ok: true, domains: rows.results });
  }));

add('POST', '/api/admin/domains', async ({ request, env }) =>
  adminGuard(request, env, async () => {
    const body = await request.json().catch(() => ({}));
    const domain = cleanText(body.domain, 120).toLowerCase().replace(/^@/, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return fail('域名格式不正确', 400);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM domains').first();
    await env.DB.prepare(
      'INSERT INTO domains (domain, enabled, is_default, created_at) VALUES (?, 1, ?, ?) ON CONFLICT(domain) DO UPDATE SET enabled = 1',
    )
      .bind(domain, count?.n ? 0 : 1, nowSec())
      .run();
    await logEvent(env, 'admin.domain.add', domain, '', clientIp(request));
    return json({ ok: true, domain }, 201);
  }, { mutating: true }));

/** 启用 / 停用 / 设为默认域名 */
add('PATCH', '/api/admin/domains/:domain', async ({ request, env, params }) =>
  adminGuard(request, env, async () => {
    const body = await request.json().catch(() => ({}));
    const rows = await env.DB.prepare('SELECT * FROM domains WHERE domain = ?').bind(params.domain).all();
    if (!rows.results.length) return fail('域名不存在', 404);

    if (body.isDefault) {
      await env.DB.batch([
        env.DB.prepare('UPDATE domains SET is_default = 0').run(),
        env.DB.prepare('UPDATE domains SET is_default = 1, enabled = 1 WHERE domain = ?').bind(params.domain),
      ]);
    }
    if (typeof body.enabled === 'boolean') {
      if (!body.enabled) {
        const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM domains WHERE enabled = 1 AND domain != ?')
          .bind(params.domain)
          .first();
        if (!left?.n) return fail('至少要保留一个可用域名', 400);
      }
      await env.DB.prepare('UPDATE domains SET enabled = ? WHERE domain = ?')
        .bind(body.enabled ? 1 : 0, params.domain)
        .run();
    }
    await logEvent(env, 'admin.domain.update', params.domain, JSON.stringify(body).slice(0, 120), clientIp(request));
    return json({ ok: true });
  }, { mutating: true }));

add('DELETE', '/api/admin/domains/:domain', async ({ request, env, params }) =>
  adminGuard(request, env, async () => {
    await env.DB.prepare('UPDATE domains SET enabled = 0, is_default = 0 WHERE domain = ?').bind(params.domain).run();
    await logEvent(env, 'admin.domain.disable', params.domain, '', clientIp(request));
    return json({ ok: true });
  }, { mutating: true }));

add('POST', '/api/admin/purge', async ({ request, env }) =>
  adminGuard(request, env, async () => {
    const r = await purgeExpired(env);
    await logEvent(env, 'admin.purge', '', `mailboxes=${r.purged || 0}`, clientIp(request));
    return json({ ok: true, ...r });
  }, { mutating: true }));
