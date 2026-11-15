// 本地开发用：投递一封测试邮件到 wrangler dev
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const to = process.argv[2] || 'demo@mail.example.com';
const base = process.argv[3] || 'http://127.0.0.1:8787';

const html = `<!doctype html><html><body style="font-family:-apple-system,sans-serif;padding:8px">
<h2 style="color:#111">验证你的邮箱</h2>
<p>你的验证码是 <b style="font-size:22px;letter-spacing:3px">824913</b>，10 分钟内有效。</p>
<p><img src="cid:logo123" width="48" height="48" alt="logo"></p>
<p><a href="https://example.com/verify?token=abc">点击这里完成验证</a></p>
<p style="color:#888;font-size:12px">这是一封自动发送的测试邮件。</p>
<img src="https://example.com/pixel.gif" width="1" height="1">
</body></html>`;
const text = '验证你的邮箱\n\n你的验证码是 824913，10 分钟内有效。\n';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const raw = [
  'From: "FadeMail =?UTF-8?B?' + b64('测试') + '?=" <no-reply@example.com>',
  `To: ${to}`,
  'Subject: =?UTF-8?B?' + b64('FadeMail 测试邮件 · 你的验证码') + '?=',
  `Date: ${new Date().toUTCString()}`,
  `Message-ID: <test-${Date.now()}@example.com>`,
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="outer"',
  '',
  '--outer',
  'Content-Type: multipart/alternative; boundary="alt"',
  '',
  '--alt',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: base64',
  '',
  b64(text),
  '--alt',
  'Content-Type: text/html; charset=utf-8',
  'Content-Transfer-Encoding: base64',
  '',
  b64(html),
  '--alt--',
  '',
  '--outer',
  'Content-Type: image/png; name="logo.png"',
  'Content-Disposition: inline; filename="logo.png"',
  'Content-ID: <logo123>',
  'Content-Transfer-Encoding: base64',
  '',
  png,
  '',
  '--outer',
  'Content-Type: text/plain; name="readme.txt"',
  'Content-Disposition: attachment; filename="readme.txt"',
  'Content-Transfer-Encoding: base64',
  '',
  b64('hello attachment 中文内容'),
  '--outer--',
  '',
].join('\r\n');

const res = await fetch(`${base}/cdn-cgi/handler/email?from=no-reply@example.com&to=${encodeURIComponent(to)}`, {
  method: 'POST',
  headers: { 'content-type': 'message/rfc822' },
  body: raw,
});
console.log('deliver:', res.status, (await res.text()).slice(0, 300));
