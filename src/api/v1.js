/**
 * FadeMail · 开放 API v1（/api/v1/*）
 *
 * 面向第三方脚本的公开接口，凭 API Key 调用（Authorization: Bearer / X-API-Key）。
 */
import { add } from './router.js';
import { allowedDomains, createMailbox, pubMailbox } from './common.js';
import { json, fail, clamp, nowSec, rateLimit, sha256Hex } from '../lib.js';

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
