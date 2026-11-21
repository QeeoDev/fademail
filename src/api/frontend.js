/**
 * FadeMail · 前端 API（/api/*）
 *
 * 网页界面自用的接口：站点配置、邮箱增删改查、批量未读数。
 */
import { add } from './router.js';
import {
  TTL_PRESETS, readSettings, allowedDomains, createMailbox, requireMailbox,
  checkMailboxAccess, pubMailbox, bumpSeen, passwordTaken,
} from './common.js';
import {
  json, fail, clamp, nowSec, clientIp, rateLimit, hashPassword, safeEqual,
  randomId, recoveryKey, siteUrl, cleanText, logEvent,
} from '../lib.js';

/* ------------------------------- 站点配置 -------------------------------- */

add('GET', '/api/config', async ({ env, url }) => {
  const [domains, conf] = await Promise.all([allowedDomains(env), readSettings(env)]);
  const maxTtl = clamp(parseInt(conf.maxTtl ?? env.MAX_TTL_HOURS ?? 720, 10), 1, 8760);
  const presets = Array.isArray(conf.ttls) && conf.ttls.length ? conf.ttls : TTL_PRESETS;
  const ttls = presets.filter((h) => h >= 1 && h <= maxTtl).sort((a, b) => a - b);
  return json({
    ok: true,
    brand: conf.brand || env.BRAND || 'FadeMail',
    title: conf.title || `${conf.brand || env.BRAND || 'FadeMail'} · 临时邮箱`,
    logo: conf.logo || '',
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

/* ------------------------------- 邮箱操作 -------------------------------- */

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

/* ------------------------------- 邮件列表 -------------------------------- */

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
