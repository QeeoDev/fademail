/**
 * FadeMail · API 公共层
 *
 * 站点配置读写、管理账号、邮箱的存取 / 访问校验 / 创建，
 * 被前端 API、开放 API v1、管理端共同复用。
 */
import {
  fail, nowSec, randomStr, randomId, hashPassword, safeEqual, recoveryKey, clamp,
  cleanText, LOCAL_RE, RESERVED, logEvent,
} from '../lib.js';

export const TTL_PRESETS = [1, 6, 24, 168];

/* -------------------------------- 站点配置 -------------------------------- */

const SETTING_KEYS = ['brand', 'siteUrl', 'ttls', 'defaultTtl', 'maxTtl', 'notice'];

/** 读取后台可编辑的站点配置（没写过的项回落到环境变量） */
export async function readSettings(env) {
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

export async function writeSetting(env, k, v) {
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
export async function ensureAdminAccount(env) {
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

export async function verifyAdminPassword(account, password) {
  if (!account || !password) return false;
  const hash = await hashPassword(password, account.pw_salt);
  return safeEqual(hash, account.pw_hash);
}

/* ------------------------------- 邮箱公共 -------------------------------- */

/**
 * 对外邮箱信息。accessKey 是访问邮件的凭据，
 * 只有在「刚创建 / 密码找回」这种能证明所有权的场景才返回。
 */
export function pubMailbox(mb, { withKey = false } = {}) {
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
export function readAccessKey(request, url) {
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
export function checkMailboxAccess(request, url, mb) {
  if (!mb.access_key) return null;
  const key = readAccessKey(request, url);
  if (!key) return fail('该邮箱已启用访问保护，请用创建它的浏览器打开，或通过密码找回', 403, { 'x-fm-code': 'key-required' });
  if (!safeEqual(key, mb.access_key)) return fail('访问密钥不正确', 403, { 'x-fm-code': 'key-invalid' });
  return null;
}

export async function loadMailbox(env, id) {
  if (!id) return null;
  const mb = await env.DB.prepare('SELECT * FROM mailboxes WHERE id = ?').bind(id).first();
  if (!mb) return null;
  if (mb.expires_at <= nowSec()) return { ...mb, expired: true };
  return mb;
}

export async function allowedDomains(env) {
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

export async function createMailbox(env, opts = {}) {
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
export async function passwordTaken(env, password, exceptId = '') {
  const rkey = await recoveryKey(env, password);
  const row = await env.DB.prepare(
    'SELECT id FROM mailboxes WHERE recovery_key = ? AND id != ? LIMIT 1',
  )
    .bind(rkey, exceptId)
    .first();
  return !!row;
}

export async function requireMailbox(env, id) {
  const mb = await loadMailbox(env, id);
  if (!mb) return { error: fail('邮箱不存在或已被销毁', 404) };
  if (mb.expired) return { error: fail('邮箱已过期', 410) };
  return { mailbox: mb };
}

export async function bumpSeen(env, id) {
  await env.DB.prepare('UPDATE mailboxes SET last_seen_at = ? WHERE id = ?').bind(nowSec(), id).run();
}
