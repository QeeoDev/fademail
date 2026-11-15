/**
 * FadeMail · API 层
 */
import {
  json, fail, withCors, corsHeaders, nowSec, randomStr, randomId, sha256Hex, hashPassword,
  safeEqual, recoveryKey, rateLimit, clientIp, clamp, cleanText, LOCAL_RE,
  RESERVED, purgeExpired, sanitizeEmailHtml, isInlineSafeImage, logEvent,
  signAdminSession, verifyAdminSession, ADMIN_COOKIE, siteUrl, isAllowedOrigin,
} from './lib.js';

/* --------------------------------- 路由表 --------------------------------- */

const routes = [];
const add = (method, pattern, handler) => routes.push({ method, segs: pattern.split('/').filter(Boolean), handler });

function match(method, pathname) {
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

/* -------------------------------- 公共工具 -------------------------------- */

const TTL_PRESETS = [1, 6, 24, 168];

/* -------------------------------- 站点配置 -------------------------------- */

const SETTING_KEYS = ['brand', 'siteUrl', 'ttls', 'defaultTtl', 'maxTtl', 'notice'];

/** 读取后台可编辑的站点配置（没写过的项回落到环境变量） */
async function readSettings(env) {
  try {
    const rows = await env.DB.prepare('SELECT k, v FROM settings').all();
    const out = {};
    for (const r of rows.results || []) {
      if (!SETTING_KEYS.includes(r.k)) continue;
      if (r.k === 'ttls') {
        try {
          const arr = JSON.parse(r.v);
          if (Array.isArray(arr)) out.ttls = arr.map((n) => parseInt(n, 10)).filter((n) => n > 0);
        } catch { /* 忽略坏值 */ }
      } else if (r.k === 'defaultTtl' || r.k === 'maxTtl') {
        const n = parseInt(r.v, 10);
        if (Number.isFinite(n) && n > 0) out[r.k] = n;
      } else {
        out[r.k] = r.v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

async function writeSetting(env, k, v) {
  await env.DB.prepare(
    `INSERT INTO settings (k, v, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
  )
    .bind(k, String(v), nowSec())
    .run();
}

/* ------------------------------- 管理账号 --------------------------------- */

const DEFAULT_ADMIN = { username: 'admin', password: '123456' };

/** 首次访问时创建默认管理员，之后就一直用库里的账号 */
async function ensureAdminAccount(env) {
  const row = await env.DB.prepare('SELECT * FROM admin_accounts WHERE id = 1').first();
  if (row) return row;
  const salt = randomId(16);
  const hash = await hashPassword(DEFAULT_ADMIN.password, salt);
  try {
    await env.DB.prepare(
      'INSERT INTO admin_accounts (id, username, pw_salt, pw_hash, must_change, updated_at) VALUES (1, ?, ?, ?, 1, ?)',
    )
      .bind(DEFAULT_ADMIN.username, salt, hash, nowSec())
      .run();
  } catch { /* 并发插入忽略 */ }
  return env.DB.prepare('SELECT * FROM admin_accounts WHERE id = 1').first();
}

async function verifyAdminPassword(account, password) {
  if (!account || !password) return false;
  const hash = await hashPassword(password, account.pw_salt);
  return safeEqual(hash, account.pw_hash);
}

/**
 * 对外邮箱信息。accessKey 是访问邮件的凭据，
 * 只有在「刚创建 / 密码找回」这种能证明所有权的场景才返回。
 */
function pubMailbox(mb, { withKey = false } = {}) {
  const data = {
    id: mb.id,
    address: mb.address,
    localPart: mb.local_part,
    domain: mb.domain,
    note: mb.note || '',
    createdAt: mb.created_at,
    expiresAt: mb.expires_at,
    hasPassword: !!mb.pw_hash,
    protected: !!mb.access_key,
    messageCount: mb.msg_count || 0,
  };
  if (withKey && mb.access_key) data.accessKey = mb.access_key;
  return data;
}

/** 从请求头或查询串里取邮箱访问密钥 */
function readAccessKey(request, url) {
  return (
    request.headers.get('x-mailbox-key') ||
    (url && url.searchParams.get('k')) ||
    ''
  ).trim();
}

/**
 * 邮箱访问校验：新邮箱都带 access_key，凭密钥才能读信 / 改邮箱。
 * 老数据（部署前创建，没有 access_key）保持可用，等它们自然过期。
 */
function checkMailboxAccess(request, url, mb) {
  if (!mb.access_key) return null;
  const key = readAccessKey(request, url);
  if (!key) return fail('该邮箱已启用访问保护，请用创建它的浏览器打开，或通过密码找回', 403, { 'x-fm-code': 'key-required' });
  if (!safeEqual(key, mb.access_key)) return fail('访问密钥不正确', 403, { 'x-fm-code': 'key-invalid' });
  return null;
}

async function loadMailbox(env, id) {
  if (!id) return null;
  const mb = await env.DB.prepare('SELECT * FROM mailboxes WHERE id = ?').bind(id).first();
  if (!mb) return null;
  if (mb.expires_at <= nowSec()) return { ...mb, expired: true };
  return mb;
}

async function allowedDomains(env) {
  const rows = await env.DB.prepare(
    'SELECT domain FROM domains WHERE enabled = 1 ORDER BY is_default DESC, domain ASC',
  ).all();
  const list = rows.results.map((r) => r.domain);
  if (list.length) return list;
  return (env.MAIL_DOMAINS || '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

async function createMailbox(env, opts = {}) {
  const domains = await allowedDomains(env);
  if (!domains.length) return { error: '服务端未配置任何可用域名', status: 500 };

  const domain = (opts.domain || domains[0]).toString().trim().toLowerCase();
  if (!domains.includes(domain)) return { error: '不支持该域名后缀', status: 400 };

  const maxTtl = clamp(parseInt(env.MAX_TTL_HOURS || '720', 10), 1, 8760);
  const ttl = clamp(parseInt(opts.ttlHours, 10) || parseInt(env.DEFAULT_TTL_HOURS || '24', 10), 1, maxTtl);

  let local = (opts.local || '').toString().trim().toLowerCase();
  const wanted = !!local;
  if (local) {
    if (!LOCAL_RE.test(local)) return { error: '地址需为 3-30 位字母/数字/. _ -，且首尾为字母或数字', status: 400 };
    if (RESERVED.has(local)) return { error: '该地址为系统保留字，请换一个', status: 400 };
  }

  const password = (opts.password || '').toString();
  if (password && (password.length < 6 || password.length > 64)) {
    return { error: '密码长度需为 6-64 位', status: 400 };
  }
  if (password && (await passwordTaken(env, password))) {
    return { error: '该密码已被其他邮箱使用，请更换一个', status: 409 };
  }

  const now = nowSec();
  let salt = '', hash = '', rkey = null;
  if (password) {
    salt = randomId(16);
    hash = await hashPassword(password, salt);
    rkey = await recoveryKey(env, password);
  }

  const note = cleanText(opts.note, 80);
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = local || randomStr(10);
    const address = `${candidate}@${domain}`;
    const exists = await env.DB.prepare('SELECT id FROM mailboxes WHERE address = ?').bind(address).first();
    if (exists) {
      if (wanted) return { error: '该邮箱地址已被占用，试试别的', status: 409 };
      local = '';
      continue;
    }
    const id = randomId(18);
    const accessKey = randomId(40);
    try {
      await env.DB.prepare(
        `INSERT INTO mailboxes (id, address, local_part, domain, note, pw_salt, pw_hash, recovery_key, access_key, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(id, address, candidate, domain, note, salt || null, hash || null, rkey, accessKey, now, now + ttl * 3600, now)
        .run();
      await logEvent(env, 'mailbox.create', address, `ttl=${ttl}h`, opts.ip || '');
      const mb = await env.DB.prepare('SELECT * FROM mailboxes WHERE id = ?').bind(id).first();
      return { mailbox: pubMailbox(mb, { withKey: true }) };
    } catch (e) {
      if (String(e.message || e).includes('UNIQUE')) {
        if (wanted) return { error: '该邮箱地址已被占用，试试别的', status: 409 };
        local = '';
        continue;
      }
      return { error: '创建失败：' + (e.message || e), status: 500 };
    }
  }
  return { error: '生成地址失败，请重试', status: 500 };
}

/**
 * 找回密码要求全局唯一：一个密码只能对应一个邮箱，
 * 避免「撞密码」后一次找回把别人的邮箱也列出来。
 */
async function passwordTaken(env, password, exceptId = '') {
  const rkey = await recoveryKey(env, password);
  const row = await env.DB.prepare(
    'SELECT id FROM mailboxes WHERE recovery_key = ? AND id != ? LIMIT 1',
  )
    .bind(rkey, exceptId)
    .first();
  return !!row;
}

async function requireMailbox(env, id) {
  const mb = await loadMailbox(env, id);
  if (!mb) return { error: fail('邮箱不存在或已被销毁', 404) };
  if (mb.expired) return { error: fail('邮箱已过期', 410) };
  return { mailbox: mb };
}

async function bumpSeen(env, id) {
  await env.DB.prepare('UPDATE mailboxes SET last_seen_at = ? WHERE id = ?').bind(nowSec(), id).run();
}

/* ------------------------------- 前端 API -------------------------------- */

add('GET', '/api/config', async ({ env, url }) => {
  const [domains, conf] = await Promise.all([allowedDomains(env), readSettings(env)]);
  const maxTtl = clamp(parseInt(conf.maxTtl ?? env.MAX_TTL_HOURS ?? 720, 10), 1, 8760);
  const presets = Array.isArray(conf.ttls) && conf.ttls.length ? conf.ttls : TTL_PRESETS;
  const ttls = presets.filter((h) => h >= 1 && h <= maxTtl).sort((a, b) => a - b);
  return json({
    ok: true,
    brand: conf.brand || env.BRAND || 'FadeMail',
    siteUrl: conf.siteUrl || siteUrl(env, url.origin),
    notice: conf.notice || '',
    domains,
    ttls: ttls.length ? ttls : TTL_PRESETS.filter((h) => h <= maxTtl),
    defaultTtl: clamp(parseInt(conf.defaultTtl ?? env.DEFAULT_TTL_HOURS ?? 24, 10), 1, maxTtl),
    maxTtl,
    maxAttachmentMB: 1,
    adminEnabled: true,
  });
});

add('GET', '/api/health', async ({ env }) => {
  const t0 = Date.now();
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM mailboxes').first();
  return json({
    ok: true,
    db: row ? 'up' : 'down',
    mailboxes: row?.n || 0,
    latencyMs: Date.now() - t0,
    time: nowSec(),
  });
});

add('POST', '/api/mailboxes', async ({ request, env }) => {
  const ip = clientIp(request);
  const rl = await rateLimit(env, `create:${ip}`, 20, 3600);
  if (!rl.allowed) {
    return fail('创建过于频繁，请稍后再试', 429, { 'retry-after': String(rl.resetAt - nowSec()) });
  }
  const body = await request.json().catch(() => ({}));
  const result = await createMailbox(env, { ...body, ip });
  if (result.error) return fail(result.error, result.status || 400);
  return json({ ok: true, mailbox: result.mailbox }, 201);
});

add('GET', '/api/mailboxes/:id', async ({ request, env, params, url }) => {
  const { error, mailbox } = await requireMailbox(env, params.id);
  if (error) return error;
  const denied = checkMailboxAccess(request, url, mailbox);
  if (denied) return denied;
  const unread = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM messages WHERE mailbox_id = ? AND is_read = 0',
  )
    .bind(mailbox.id)
    .first();
  return json({ ok: true, mailbox: pubMailbox(mailbox), unread: unread?.n || 0 });
});

add('PATCH', '/api/mailboxes/:id', async ({ request, env, params, url }) => {
  const { error, mailbox } = await requireMailbox(env, params.id);
  if (error) return error;
  const denied = checkMailboxAccess(request, url, mailbox);
  if (denied) return denied;
  const body = await request.json().catch(() => ({}));
  const sets = [];
  const args = [];

  if (typeof body.note === 'string') {
    sets.push('note = ?');
    args.push(cleanText(body.note, 80));
  }
  if (body.ttlHours) {
    const maxTtl = clamp(parseInt(env.MAX_TTL_HOURS || '720', 10), 1, 8760);
    const addHours = clamp(parseInt(body.ttlHours, 10) || 0, 1, maxTtl);
    const base = Math.max(nowSec(), mailbox.expires_at);
    const cap = nowSec() + maxTtl * 3600;
    sets.push('expires_at = ?');
    args.push(Math.min(base + addHours * 3600, cap));
  }
  if (!sets.length) return fail('没有需要更新的字段', 400);
  args.push(mailbox.id);
  await env.DB.prepare(`UPDATE mailboxes SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
  const fresh = await env.DB.prepare('SELECT * FROM mailboxes WHERE id = ?').bind(mailbox.id).first();
  return json({ ok: true, mailbox: pubMailbox(fresh) });
});

add('DELETE', '/api/mailboxes/:id', async ({ request, env, params, url }) => {
  const mb = await env.DB.prepare('SELECT * FROM mailboxes WHERE id = ?').bind(params.id).first();
  if (!mb) return fail('邮箱不存在', 404);
  const denied = checkMailboxAccess(request, url, mb);
  if (denied) return denied;
  const msgs = await env.DB.prepare('SELECT id FROM messages WHERE mailbox_id = ?').bind(mb.id).all();
  const ids = msgs.results.map((r) => r.id);
  const stmts = [];
  if (ids.length) {
    const p = ids.map(() => '?').join(',');
    stmts.push(env.DB.prepare(`DELETE FROM attachments WHERE message_id IN (${p})`).bind(...ids));
    stmts.push(env.DB.prepare(`DELETE FROM messages WHERE id IN (${p})`).bind(...ids));
  }
  stmts.push(env.DB.prepare('DELETE FROM mailboxes WHERE id = ?').bind(mb.id));
  await env.DB.batch(stmts);
  await logEvent(env, 'mailbox.burn', mb.address, `messages=${ids.length}`, clientIp(request));
  return json({ ok: true });
});

add('GET', '/api/mailboxes/:id/messages', async ({ request, env, params, url }) => {
  const { error, mailbox } = await requireMailbox(env, params.id);
  if (error) return error;
  const denied = checkMailboxAccess(request, url, mailbox);
  if (denied) return denied;
  const rl = await rateLimit(env, `read:${clientIp(request)}`, 600, 60);
  if (!rl.allowed) return fail('刷新过于频繁，请稍后再试', 429);
  const since = parseInt(url.searchParams.get('since') || '0', 10);
  const limit = clamp(parseInt(url.searchParams.get('limit') || '60', 10), 1, 100);
  const [rows, stat] = await Promise.all([
    env.DB.prepare(
      `SELECT id, from_name, from_addr, to_addr, subject, snippet, is_read, attach_count, raw_size, received_at, code
       FROM messages WHERE mailbox_id = ? AND received_at > ?
       ORDER BY received_at DESC LIMIT ?`,
    )
      .bind(mailbox.id, since, limit)
      .all(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread
       FROM messages WHERE mailbox_id = ?`,
    )
      .bind(mailbox.id)
      .first(),
  ]);
  await bumpSeen(env, mailbox.id);
  const total = stat?.total || 0;
  return json({
    ok: true,
    serverTime: nowSec(),
    total,
    truncated: total > rows.results.length,
    unread: stat?.unread || 0,
    mailbox: pubMailbox(mailbox),
    messages: rows.results.map((m) => ({
      id: m.id,
      fromName: m.from_name,
      fromAddr: m.from_addr,
      toAddr: m.to_addr,
      subject: m.subject,
      snippet: m.snippet,
      isRead: !!m.is_read,
      attachCount: m.attach_count,
      size: m.raw_size,
      code: m.code,
      receivedAt: m.received_at,
    })),
  });
});

add('POST', '/api/mailboxes/:id/read-all', async ({ request, env, params, url }) => {
  const { error, mailbox } = await requireMailbox(env, params.id);
  if (error) return error;
  const denied = checkMailboxAccess(request, url, mailbox);
  if (denied) return denied;
  const r = await env.DB.prepare('UPDATE messages SET is_read = 1 WHERE mailbox_id = ? AND is_read = 0')
    .bind(mailbox.id)
    .run();
  return json({ ok: true, updated: r.meta?.changes || 0 });
});

add('DELETE', '/api/mailboxes/:id/messages', async ({ request, env, params, url }) => {
  const { error, mailbox } = await requireMailbox(env, params.id);
  if (error) return error;
  const denied = checkMailboxAccess(request, url, mailbox);
  if (denied) return denied;
  const ids = await env.DB.prepare('SELECT id FROM messages WHERE mailbox_id = ?').bind(mailbox.id).all();
  const list = ids.results.map((r) => r.id);
  const stmts = [];
  if (list.length) {
    const p = list.map(() => '?').join(',');
    stmts.push(env.DB.prepare(`DELETE FROM attachments WHERE message_id IN (${p})`).bind(...list));
    stmts.push(env.DB.prepare(`DELETE FROM messages WHERE id IN (${p})`).bind(...list));
  }
  stmts.push(env.DB.prepare('UPDATE mailboxes SET msg_count = 0 WHERE id = ?').bind(mailbox.id));
  await env.DB.batch(stmts);
  return json({ ok: true, removed: list.length });
});

add('POST', '/api/mailboxes/:id/password', async ({ request, env, params, url }) => {
  const { error, mailbox } = await requireMailbox(env, params.id);
  if (error) return error;
  const denied = checkMailboxAccess(request, url, mailbox);
  if (denied) return denied;
  const body = await request.json().catch(() => ({}));

  // 已设置过密码的邮箱，改密码需要先验证旧密码
  if (mailbox.pw_hash) {
    const current = (body.current || '').toString();
    if (!current) return fail('请先输入当前密码', 400);
    const hash = await hashPassword(current, mailbox.pw_salt);
    if (!safeEqual(hash, mailbox.pw_hash)) return fail('当前密码不正确', 403);
  }

  const password = (body.password ?? '').toString();
  if (password === '') {
    await env.DB.prepare(
      'UPDATE mailboxes SET pw_salt = NULL, pw_hash = NULL, recovery_key = NULL WHERE id = ?',
    )
      .bind(mailbox.id)
      .run();
    return json({ ok: true, cleared: true });
  }
  if (password.length < 6 || password.length > 64) return fail('密码长度需为 6-64 位', 400);
  if (await passwordTaken(env, password, mailbox.id)) {
    return fail('该密码已被其他邮箱使用，请更换一个', 409);
  }

  const salt = randomId(16);
  const hash = await hashPassword(password, salt);
  const rkey = await recoveryKey(env, password);
  await env.DB.prepare(
    'UPDATE mailboxes SET pw_salt = ?, pw_hash = ?, recovery_key = ? WHERE id = ?',
  )
    .bind(salt, hash, rkey, mailbox.id)
    .run();
  const fresh = await env.DB.prepare('SELECT * FROM mailboxes WHERE id = ?').bind(mailbox.id).first();
  return json({ ok: true, mailbox: pubMailbox(fresh) });
});

/** 侧边栏批量未读数：只认 id，不泄露密码等敏感字段 */
add('GET', '/api/summary', async ({ request, env, url }) => {
  const rl = await rateLimit(env, `summary:${clientIp(request)}`, 300, 60);
  if (!rl.allowed) return fail('请求过于频繁', 429);
  const ids = (url.searchParams.get('ids') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 40);
  if (!ids.length) return json({ ok: true, items: [] });
  const ph = ids.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT mb.id, mb.address, mb.note, mb.expires_at,
       (SELECT COUNT(*) FROM messages m WHERE m.mailbox_id = mb.id) AS total,
       (SELECT COUNT(*) FROM messages m WHERE m.mailbox_id = mb.id AND m.is_read = 0) AS unread
     FROM mailboxes mb WHERE mb.id IN (${ph})`,
  )
    .bind(...ids)
    .all();
  return json({
    ok: true,
    items: rows.results.map((r) => ({
      id: r.id,
      address: r.address,
      note: r.note || '',
      expiresAt: r.expires_at,
      total: r.total || 0,
      unread: r.unread || 0,
    })),
  });
});

/* ------------------------------- 邮件相关 -------------------------------- */

/** 邮件 + 所属邮箱的访问信息（一次 JOIN，避免多跑一次查询） */
async function loadMessage(env, id) {
  return env.DB.prepare(
    `SELECT m.*, mb.address AS mb_address, mb.expires_at AS mb_expires, mb.access_key AS mb_key
     FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
     WHERE m.id = ?`,
  )
    .bind(id)
    .first();
}

add('GET', '/api/messages/:id', async ({ request, env, params, url }) => {
  const m = await loadMessage(env, params.id);
  if (!m) return fail('邮件不存在', 404);
  if (m.mb_expires <= nowSec()) return fail('邮件已随邮箱销毁', 410);
  const denied = checkMailboxAccess(request, url, { access_key: m.mb_key });
  if (denied) return denied;
  const rl = await rateLimit(env, `msg:${clientIp(request)}`, 600, 60);
  if (!rl.allowed) return fail('读取过于频繁，请稍后再试', 429);
  await env.DB.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').bind(m.id).run();
  const atts = await env.DB.prepare(
    'SELECT id, filename, mime, size, truncated FROM attachments WHERE message_id = ?',
  )
    .bind(m.id)
    .all();
  return json({
    ok: true,
    message: {
      id: m.id,
      mailboxId: m.mailbox_id,
      mailboxAddress: m.mb_address,
      fromName: m.from_name,
      fromAddr: m.from_addr,
      toAddr: m.to_addr,
      subject: m.subject,
      text: m.body_text,
      hasHtml: !!m.body_html,
      headers: JSON.parse(m.headers || '[]'),
      code: m.code,
      size: m.raw_size,
      receivedAt: m.received_at,
      attachments: atts.results.map((a) => ({
        id: a.id, filename: a.filename, mime: a.mime, size: a.size, truncated: !!a.truncated,
      })),
    },
  });
});

add('PATCH', '/api/messages/:id', async ({ request, env, params, url }) => {
  const m = await loadMessage(env, params.id);
  if (!m) return fail('邮件不存在', 404);
  const denied = checkMailboxAccess(request, url, { access_key: m.mb_key });
  if (denied) return denied;
  const body = await request.json().catch(() => ({}));
  if (typeof body.isRead === 'boolean') {
    await env.DB.prepare('UPDATE messages SET is_read = ? WHERE id = ?')
      .bind(body.isRead ? 1 : 0, params.id)
      .run();
  }
  return json({ ok: true });
});

add('DELETE', '/api/messages/:id', async ({ request, env, params, url }) => {
  const m = await loadMessage(env, params.id);
  if (!m) return fail('邮件不存在', 404);
  const denied = checkMailboxAccess(request, url, { access_key: m.mb_key });
  if (denied) return denied;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM attachments WHERE message_id = ?').bind(params.id),
    env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(params.id),
  ]);
  return json({ ok: true });
});

/**
 * 邮件正文渲染：三重隔离
 * 1) 服务端净化：脚本 / iframe / 表单 / 事件属性 / 伪协议全部剔除
 * 2) CSP `sandbox` + `default-src 'none'`：即使有残留也无法执行或外联
 * 3) 图片默认拦截、外链强制新窗口并去掉 referrer（防追踪像素、防密钥经 Referer 外泄）
 */
add('GET', '/api/messages/:id/html', async ({ request, env, params, url }) => {
  const m = await loadMessage(env, params.id);
  if (!m) return new Response('Not found', { status: 404 });
  if (m.mb_expires <= nowSec()) return new Response('邮件已随邮箱销毁', { status: 410 });

  const key = readAccessKey(request, url);
  if (m.mb_key && !safeEqual(key, m.mb_key)) {
    return new Response('访问密钥无效', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const rl = await rateLimit(env, `html:${clientIp(request)}`, 300, 60);
  if (!rl.allowed) return new Response('读取过于频繁', { status: 429 });

  const allowImg = url.searchParams.get('img') === '1';
  const dark = url.searchParams.get('theme') === 'dark';
  const isHtml = !!m.body_html;
  // 富文本邮件一律用白底深字渲染：邮件自带的配色大多按白底设计，暗色下会「黑字黑底」
  const pageBg = isHtml ? '#ffffff' : dark ? '#0d1117' : '#ffffff';
  const pageFg = isHtml ? '#1f2328' : dark ? '#e6edf3' : '#1f2328';
  const linkFg = isHtml ? '#0969da' : dark ? '#7dd3fc' : '#0969da';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const base = `<style>
    html,body{margin:0;padding:0}
    body{padding:20px;font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue","PingFang SC","Microsoft YaHei",sans-serif;
      color:${pageFg};background:${pageBg};word-break:break-word;overflow-wrap:anywhere}
    img{max-width:100%;height:auto}
    table{max-width:100%}
    a{color:${linkFg}}
    pre{white-space:pre-wrap;word-break:break-word;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
    blockquote{margin:0;padding-left:12px;border-left:3px solid ${dark && !isHtml ? '#30363d' : '#d0d7de'};color:${dark && !isHtml ? '#8b949e' : '#57606a'}}
  </style>`;

  let body = m.body_html
    ? sanitizeEmailHtml(m.body_html)
    : `<pre>${esc(m.body_text || '(无正文)')}</pre>`;

  // 内嵌图片（cid:xxx）改写为可访问的绝对地址，沙箱内也能显示
  if (m.body_html) {
    const inline = await env.DB.prepare(
      'SELECT id, content_id FROM attachments WHERE message_id = ? AND content_id IS NOT NULL AND content IS NOT NULL',
    )
      .bind(params.id)
      .all();
    if (inline.results.length) {
      // 用请求本身的 origin，保证在 workers.dev / 任意自定义域名下都能取到内嵌图
      const origin = url.origin;
      const q = m.mb_key ? `&k=${encodeURIComponent(key)}` : '';
      const map = new Map(
        inline.results.map((a) => [String(a.content_id).replace(/^<|>$/g, '').toLowerCase(), a.id]),
      );
      body = body.replace(/cid:([^"'\s>)]+)/gi, (full, cid) => {
        let cidKey = cid;
        try { cidKey = decodeURIComponent(cid); } catch { /* keep raw */ }
        cidKey = cidKey.replace(/^<|>$/g, '').toLowerCase();
        const id = map.get(cidKey);
        return id ? `${origin}/api/attachments/${id}?inline=1${q}` : full;
      });
    }
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<base target="_blank">${base}</head><body>${body}</body></html>`;

  const csp = [
    "sandbox allow-popups allow-popups-to-escape-sandbox",
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "font-src data:",
    allowImg ? "img-src 'self' data: https: http:" : "img-src 'self' data:",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join('; ');

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': csp,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    },
  });
});

add('GET', '/api/attachments/:id', async ({ request, env, params, url }) => {
  const a = await env.DB.prepare(
    `SELECT a.*, mb.access_key AS mb_key, mb.expires_at AS mb_expires
     FROM attachments a JOIN messages m ON m.id = a.message_id
     JOIN mailboxes mb ON mb.id = m.mailbox_id WHERE a.id = ?`,
  )
    .bind(params.id)
    .first();
  if (!a) return new Response('Not found', { status: 404 });
  if (a.mb_expires <= nowSec()) return new Response('附件已随邮箱销毁', { status: 410 });
  const key = readAccessKey(request, url);
  if (a.mb_key && !safeEqual(key, a.mb_key)) return new Response('访问密钥无效', { status: 403 });

  const rl = await rateLimit(env, `att:${clientIp(request)}`, 300, 60);
  if (!rl.allowed) return new Response('下载过于频繁', { status: 429 });

  if (!a.content) return new Response('附件未保存（超出容量限制）', { status: 410 });
  const bytes = Uint8Array.from(atob(a.content), (c) => c.charCodeAt(0));
  const ascii = (a.filename || 'file').replace(/[^\x20-\x7e]/g, '_').replace(/["\\']/g, '_');
  // RFC 5987 的 ext-value 里单引号是分隔符，必须编码，否则还能拼出畸形头
  const utf8Name = encodeURIComponent(a.filename || 'file').replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
  // 只有位图允许内联；SVG / HTML 一律强制下载，避免在本站 origin 里执行脚本
  const inline = url.searchParams.get('inline') === '1' && isInlineSafeImage(a.mime);
  const safeMime = inline ? a.mime : 'application/octet-stream';
  return new Response(bytes, {
    headers: {
      'content-type': safeMime,
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${utf8Name}`,
      'content-length': String(bytes.byteLength),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'referrer-policy': 'no-referrer',
    },
  });
});

/* -------------------------------- 账号找回 ------------------------------- */

add('POST', '/api/auth/login', async ({ request, env }) => {
  const ip = clientIp(request);
  const rl = await rateLimit(env, `login:${ip}`, 10, 600);
  if (!rl.allowed) return fail('尝试过于频繁，请 10 分钟后再试', 429);

  const body = await request.json().catch(() => ({}));
  const address = cleanText(body.address, 120).toLowerCase();
  const password = (body.password || '').toString();
  if (!address || !password) return fail('请输入邮箱地址和密码', 400);

  const mb = await env.DB.prepare('SELECT * FROM mailboxes WHERE address = ?').bind(address).first();
  if (!mb || !mb.pw_hash) return fail('邮箱不存在或未设置密码', 404);
  if (mb.expires_at <= nowSec()) return fail('邮箱已过期', 410);
  const hash = await hashPassword(password, mb.pw_salt);
  if (!safeEqual(hash, mb.pw_hash)) return fail('密码不正确', 401);
  // 登录成功等于证明所有权，把访问密钥一并交还，换设备后也能直接读信
  return json({ ok: true, mailbox: pubMailbox(mb, { withKey: true }) });
});

add('POST', '/api/auth/recover', async ({ request, env }) => {
  const ip = clientIp(request);
  const rl = await rateLimit(env, `recover:${ip}`, 8, 600);
  if (!rl.allowed) return fail('尝试过于频繁，请 10 分钟后再试', 429);

  const body = await request.json().catch(() => ({}));
  const password = (body.password || '').toString();
  if (password.length < 4) return fail('密码至少 4 位', 400);
  const key = await recoveryKey(env, password);
  const rows = await env.DB.prepare(
    'SELECT * FROM mailboxes WHERE recovery_key = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 50',
  )
    .bind(key, nowSec())
    .all();
  if (!rows.results.length) return fail('没有找到使用该密码的邮箱，或已全部过期', 404);
  return json({
    ok: true,
    mailboxes: rows.results.map((mb) => pubMailbox(mb, { withKey: true })),
  });
});

/* ------------------------------- 开放 API v1 ------------------------------ */

async function requireApiKey(request, env) {
  const auth = request.headers.get('authorization') || '';
  const raw = auth.toLowerCase().startsWith('bearer ')
    ? auth.slice(7).trim()
    : (request.headers.get('x-api-key') || '').trim();
  if (!raw) return null;
  const hash = await sha256Hex(raw);
  const row = await env.DB.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0')
    .bind(hash)
    .first();
  if (!row) return null;
  await env.DB.prepare('UPDATE api_keys SET last_used = ?, calls = calls + 1 WHERE id = ?')
    .bind(nowSec(), row.id)
    .run();
  return row;
}

async function apiKeyGuard(request, env, handler) {
  const key = await requireApiKey(request, env);
  if (!key) return fail('无效的 API Key，请携带 Authorization: Bearer <key>', 401, { 'www-authenticate': 'Bearer' });
  const rl = await rateLimit(env, `v1:${key.id}`, 600, 3600);
  if (!rl.allowed) return fail('API 调用频率超限', 429);
  return handler(key);
}

add('GET', '/api/v1/domains', async ({ request, env }) =>
  apiKeyGuard(request, env, async () => json({ ok: true, domains: await allowedDomains(env) })));

add('POST', '/api/v1/mailboxes', async ({ request, env }) =>
  apiKeyGuard(request, env, async () => {
    const body = await request.json().catch(() => ({}));
    const result = await createMailbox(env, body);
    if (result.error) return fail(result.error, result.status || 400);
    return json({ ok: true, mailbox: result.mailbox }, 201);
  }));

add('GET', '/api/v1/mailboxes/:address', async ({ request, env, params }) =>
  apiKeyGuard(request, env, async () => {
    const mb = await env.DB.prepare('SELECT * FROM mailboxes WHERE address = ?')
      .bind(params.address.toLowerCase())
      .first();
    if (!mb) return fail('邮箱不存在', 404);
    return json({ ok: true, mailbox: pubMailbox(mb) });
  }));

add('DELETE', '/api/v1/mailboxes/:address', async ({ request, env, params }) =>
  apiKeyGuard(request, env, async () => {
    const mb = await env.DB.prepare('SELECT id FROM mailboxes WHERE address = ?')
      .bind(params.address.toLowerCase())
      .first();
    if (!mb) return fail('邮箱不存在', 404);
    const msgs = await env.DB.prepare('SELECT id FROM messages WHERE mailbox_id = ?').bind(mb.id).all();
    const ids = msgs.results.map((r) => r.id);
    const stmts = [];
    if (ids.length) {
      const p = ids.map(() => '?').join(',');
      stmts.push(env.DB.prepare(`DELETE FROM attachments WHERE message_id IN (${p})`).bind(...ids));
      stmts.push(env.DB.prepare(`DELETE FROM messages WHERE id IN (${p})`).bind(...ids));
    }
    stmts.push(env.DB.prepare('DELETE FROM mailboxes WHERE id = ?').bind(mb.id));
    await env.DB.batch(stmts);
    return json({ ok: true });
  }));

add('GET', '/api/v1/mailboxes/:address/messages', async ({ request, env, params, url }) =>
  apiKeyGuard(request, env, async () => {
    const mb = await env.DB.prepare('SELECT * FROM mailboxes WHERE address = ?')
      .bind(params.address.toLowerCase())
      .first();
    if (!mb) return fail('邮箱不存在', 404);
    if (mb.expires_at <= nowSec()) return fail('邮箱已过期', 410);
    const since = parseInt(url.searchParams.get('since') || '0', 10);
    const limit = clamp(parseInt(url.searchParams.get('limit') || '50', 10), 1, 100);
    const rows = await env.DB.prepare(
      `SELECT id, from_name, from_addr, to_addr, subject, snippet, is_read, attach_count, raw_size, received_at, code
       FROM messages WHERE mailbox_id = ? AND received_at > ? ORDER BY received_at DESC LIMIT ?`,
    )
      .bind(mb.id, since, limit)
      .all();
    return json({
      ok: true,
      mailbox: pubMailbox(mb),
      messages: rows.results.map((m) => ({
        id: m.id, from: m.from_addr, fromName: m.from_name, to: m.to_addr, subject: m.subject,
        snippet: m.snippet, isRead: !!m.is_read, attachments: m.attach_count, size: m.raw_size,
        code: m.code, receivedAt: m.received_at,
        url: `${url.origin}/api/messages/${m.id}`,
      })),
    });
  }));

add('GET', '/api/v1/messages/:id', async ({ request, env, params }) =>
  apiKeyGuard(request, env, async () => {
    const m = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(params.id).first();
    if (!m) return fail('邮件不存在', 404);
    const atts = await env.DB.prepare('SELECT id, filename, mime, size, truncated FROM attachments WHERE message_id = ?')
      .bind(m.id)
      .all();
    return json({
      ok: true,
      message: {
        id: m.id, mailbox: m.to_addr, from: m.from_addr, fromName: m.from_name, to: m.to_addr,
        subject: m.subject, text: m.body_text, html: m.body_html, code: m.code,
        headers: JSON.parse(m.headers || '[]'), size: m.raw_size, receivedAt: m.received_at,
        attachments: atts.results.map((a) => ({ id: a.id, filename: a.filename, mime: a.mime, size: a.size, truncated: !!a.truncated })),
      },
    });
  }));

/* --------------------------------- 管理端 -------------------------------- */

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

/* --------------------------------- 入口 ---------------------------------- */

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
