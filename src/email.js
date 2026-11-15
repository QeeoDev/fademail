/**
 * FadeMail · 收信 Worker
 * Email Routing（catch-all）→ 本 Worker → 解析 → 写入 D1
 */
import PostalMime from 'postal-mime';
import { nowSec, randomId } from './lib.js';

const MAX_RAW = 12 * 1024 * 1024;      // 原始邮件上限
const MAX_ATTACH_EACH = 450 * 1024;    // 单个附件上限（D1 单行限制约 1MB）
const MAX_ATTACH_TOTAL = 800 * 1024;   // 附件总量上限
const MAX_ATTACH_COUNT = 50;           // 附件个数上限，避免一封邮件塞几千条 INSERT
const MAX_HTML_BYTES = 380 * 1024;     // 正文 HTML 字节上限（D1 单行 1MB）
const MAX_TEXT_BYTES = 180 * 1024;     // 正文纯文本字节上限

const utf8 = new TextEncoder();
const utf8dec = new TextDecoder();

/** 按 UTF-8 字节数截断，避免中文邮件把 D1 单行撑爆导致整封邮件入库失败 */
function fitBytes(str, maxBytes) {
  if (!str) return '';
  const bytes = utf8.encode(str);
  if (bytes.length <= maxBytes) return str;
  return utf8dec.decode(bytes.subarray(0, maxBytes)).replace(/\uFFFD+$/, '');
}

const KEEP_HEADERS = [
  'from', 'to', 'cc', 'reply-to', 'date', 'subject', 'message-id',
  'return-path', 'authentication-results', 'received-spf', 'x-mailer', 'list-unsubscribe',
];

function snippetOf(text, html) {
  let s = (text || '').replace(/\s+/g, ' ').trim();
  if (!s && html) {
    s = html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return s.slice(0, 200);
}

/** 从正文里猜验证码，方便一键复制 */
function extractCode(subject, text) {
  const src = `${subject || ''}\n${text || ''}`.slice(0, 4000);
  const patterns = [
    /(?:验证码|校验码|动态码|确认码|激活码|安全码|verification code|verify code|passcode|one[-\s]?time code|otp|code)[^\dA-Za-z]{0,24}([0-9]{4,8}|[A-Z0-9]{5,8})/i,
    /(?:^|[\s（(【])([0-9]{6})(?:[\s）)】]|$)/,
  ];
  for (const re of patterns) {
    const m = src.match(re);
    if (m) return m[1];
  }
  return null;
}

/** 附件内容统一转成 base64 字符串，兼容 postal-mime 的两种输出 */
function toBase64(content) {
  if (typeof content === 'string') return content;
  if (!content) return '';
  const bytes = content instanceof ArrayBuffer ? new Uint8Array(content) : new Uint8Array(content.buffer || content);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** 支持 local+tag@domain 这种加号别名，路由到 local@domain 的邮箱 */
async function findMailbox(env, to) {
  const direct = await env.DB.prepare('SELECT id, address, expires_at FROM mailboxes WHERE address = ?')
    .bind(to)
    .first();
  if (direct) return direct;
  const at = to.lastIndexOf('@');
  if (at <= 0) return null;
  const local = to.slice(0, at);
  const plus = local.indexOf('+');
  if (plus <= 0) return null;
  const base = `${local.slice(0, plus)}${to.slice(at)}`;
  return env.DB.prepare('SELECT id, address, expires_at FROM mailboxes WHERE address = ?')
    .bind(base)
    .first();
}

export async function handleEmail(message, env) {
  const to = (message.to || '').toLowerCase().trim();
  const now = nowSec();

  if (!to) {
    message.setReject('缺少收件人');
    return;
  }

  const mailbox = await findMailbox(env, to);

  if (!mailbox) {
    message.setReject('收件地址不存在，请先在该服务创建临时邮箱');
    return;
  }
  if (mailbox.expires_at <= now) {
    message.setReject('该临时邮箱已过期');
    return;
  }
  if ((message.rawSize || 0) > MAX_RAW) {
    message.setReject('邮件体积超出限制（12MB）');
    return;
  }

  const raw = await new Response(message.raw).arrayBuffer();
  let parsed;
  try {
    parsed = await PostalMime.parse(raw, { attachmentEncoding: 'base64' });
  } catch (e) {
    console.error('[email] parse failed', to, e && e.message);
    message.setReject('邮件解析失败');
    return;
  }

  const fromAddr = (parsed.from?.address || message.from || '').toLowerCase().slice(0, 200);
  const fromName = (parsed.from?.name || '').slice(0, 120);
  const subject = (parsed.subject || '(无主题)').slice(0, 300);
  const bodyText = fitBytes(parsed.text || '', MAX_TEXT_BYTES);
  const bodyHtml = fitBytes(parsed.html || '', MAX_HTML_BYTES);
  const code = extractCode(subject, bodyText || snippetOf('', bodyHtml));

  const headers = (parsed.headers || [])
    .filter((h) => KEEP_HEADERS.includes(String(h.key).toLowerCase()))
    .map((h) => ({ k: String(h.key).toLowerCase(), v: String(h.value).slice(0, 800) }))
    .slice(0, 20);

  const id = randomId(18);
  const stmts = [
    env.DB.prepare(
      `INSERT INTO messages (id, mailbox_id, from_name, from_addr, to_addr, subject, snippet, body_text, body_html,
        headers, code, raw_size, attach_count, is_read, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).bind(
      id, mailbox.id, fromName, fromAddr, to, subject,
      snippetOf(bodyText, bodyHtml), bodyText, bodyHtml,
      JSON.stringify(headers), code, message.rawSize || raw.byteLength,
      (parsed.attachments || []).length, now,
    ),
  ];

  let budget = MAX_ATTACH_TOTAL;
  for (const att of (parsed.attachments || []).slice(0, MAX_ATTACH_COUNT)) {
    const b64 = toBase64(att.content);
    const approxSize = Math.floor((b64.length * 3) / 4);
    const tooBig = approxSize > MAX_ATTACH_EACH || approxSize > budget;
    if (!tooBig) budget -= approxSize;
    stmts.push(
      env.DB.prepare(
        'INSERT INTO attachments (id, message_id, filename, mime, size, content, truncated, content_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        randomId(16),
        id,
        (att.filename || 'attachment').slice(0, 180),
        (att.mimeType || 'application/octet-stream').slice(0, 120),
        approxSize,
        tooBig ? null : b64,
        tooBig ? 1 : 0,
        (att.contentId || '').slice(0, 120) || null,
      ),
    );
  }

  stmts.push(env.DB.prepare('UPDATE mailboxes SET msg_count = msg_count + 1 WHERE id = ?').bind(mailbox.id));

  try {
    await env.DB.batch(stmts);
  } catch (err) {
    // 入库失败（超限 / 单条语句异常）：退化成只存摘要，至少不让用户「收不到任何东西」
    console.error('[email] store failed, fallback to summary', err && err.message);
    await env.DB.prepare(
      `INSERT INTO messages (id, mailbox_id, from_name, from_addr, to_addr, subject, snippet,
        body_text, body_html, headers, code, raw_size, attach_count, is_read, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, '[]', ?, ?, 0, 0, ?)`,
    )
      .bind(
        id, mailbox.id, fromName.slice(0, 80), fromAddr, to, subject.slice(0, 120),
        '（邮件内容超出存储上限，仅保留基本信息）', fitBytes(bodyText, 20000), code,
        message.rawSize || raw.byteLength, (parsed.attachments || []).length, now,
      )
      .run()
      .catch(() => {});
    await env.DB.prepare('UPDATE mailboxes SET msg_count = msg_count + 1 WHERE id = ?')
      .bind(mailbox.id)
      .run()
      .catch(() => {});
  }
  console.log(`[email] stored ${id} for ${to} from ${fromAddr} (${message.rawSize} bytes)`);
}
