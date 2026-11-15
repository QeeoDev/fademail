/**
 * FadeMail · 邮箱找回（/api/auth/*）
 *
 * 用「地址 + 密码」登录换回访问密钥，或用「密码」模糊找回名下全部邮箱。
 */
import { add } from './router.js';
import { pubMailbox } from './common.js';
import {
  json, fail, nowSec, rateLimit, clientIp, cleanText, hashPassword, safeEqual, recoveryKey,
} from '../lib.js';

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
