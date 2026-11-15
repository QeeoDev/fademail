/**
 * FadeMail · 邮件 API（/api/messages、/api/attachments）
 *
 * 读信、已读标记、正文沙箱渲染与附件下载。
 */
import { add } from './router.js';
import { readAccessKey, checkMailboxAccess } from './common.js';
import {
  json, fail, nowSec, rateLimit, clientIp, safeEqual, sanitizeEmailHtml, isInlineSafeImage,
} from '../lib.js';

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
