/**
 * 一键配置 Cloudflare Email Routing：
 *   启用路由 → 写入 MX/SPF 记录 → catch-all 指向 Worker →（可选）同步子域 MX
 *
 * 用法：
 *   CF_EMAIL_TOKEN=xxx CF_DNS_TOKEN=xxx ZONE_ID=xxx \
 *     node scripts/setup-email-routing.mjs [worker名] [zone名] [子域列表]
 *
 * 子域列表用逗号分隔，例如 mail.test 会把主域的 MX / SPF 复制到 mail.test.<zone>。
 */
const API = 'https://api.cloudflare.com/client/v4';
const token = process.env.CF_EMAIL_TOKEN;
const zoneId = process.env.ZONE_ID;
const dnsToken = process.env.CF_DNS_TOKEN || token;
const worker = process.argv[2] || 'fademail';
const zoneName = process.argv[3] || '';
const subdomains = (process.argv[4] || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!token || !zoneId) {
  console.error('缺少 CF_EMAIL_TOKEN / ZONE_ID');
  process.exit(1);
}
if (!zoneName) {
  console.error('缺少 zone 名：node scripts/setup-email-routing.mjs [worker名] [zone名] [子域列表]');
  process.exit(1);
}

async function cf(path, { method = 'GET', body, auth = token } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok && json.success, status: res.status, json };
}

const log = (...a) => console.log(...a);

// 1. 状态
let st = await cf(`/zones/${zoneId}/email/routing`);
log('1) 当前状态:', st.ok ? JSON.stringify(st.json.result) : `失败 ${st.status} ${JSON.stringify(st.json.errors)}`);

// 2. 启用
if (!st.ok || !st.json.result?.enabled) {
  const en = await cf(`/zones/${zoneId}/email/routing/enable`, { method: 'POST', body: {} });
  log('2) 启用:', en.ok ? 'OK' : `失败 ${JSON.stringify(en.json.errors)}`);
  if (!en.ok) process.exit(2);
} else {
  log('2) 已启用，跳过');
}

// 3. DNS（MX / SPF / DKIM）
const dns = await cf(`/zones/${zoneId}/email/routing/dns`, { method: 'POST', body: {}, auth: dnsToken });
log('3) 主域 DNS:', dns.ok ? 'OK' : `失败 ${JSON.stringify(dns.json.errors)}`);

// 4. 子域同步 MX / SPF
const ensureRecord = async (name, record) => {
  const created = await cf(`/zones/${zoneId}/dns_records`, {
    method: 'POST',
    auth: dnsToken,
    body: { type: record.type, name, content: record.content, ttl: 1, ...record.extra },
  });
  if (created.ok) return 'created';
  const msg = JSON.stringify(created.json.errors || []);
  return /already exists|duplicate/i.test(msg) ? 'exists' : `fail ${msg}`;
};

if (subdomains.length) {
  const mx = await cf(`/zones/${zoneId}/dns_records?type=MX&name=${encodeURIComponent(zoneName)}`, { auth: dnsToken });
  const txt = await cf(`/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(zoneName)}`, { auth: dnsToken });
  const mxRecords = (mx.json?.result || []).filter((r) => /mx\.cloudflare\.net$/i.test(r.content));
  const spf = (txt.json?.result || []).filter((r) => /v=spf1/i.test(r.content));

  if (!mxRecords.length) log('4) 子域: 主域还没有 MX，跳过了');

  for (const sub of subdomains) {
    const name = `${sub}.${zoneName}`;
    for (const r of mxRecords) {
      const r1 = await ensureRecord(name, { type: 'MX', content: r.content, extra: { priority: r.priority, proxied: false } });
      log(`4) ${name} MX ${r.content} (p${r.priority}):`, r1);
    }
    for (const r of spf) {
      const r1 = await ensureRecord(name, { type: 'TXT', content: r.content });
      log(`4) ${name} SPF:`, r1);
    }
  }
}

// 5. catch-all → Worker
const rule = {
  name: 'FadeMail catch-all',
  enabled: true,
  matchers: [{ type: 'all' }],
  actions: [{ type: 'worker', value: [worker] }],
};
const put = await cf(`/zones/${zoneId}/email/routing/rules/catch_all`, { method: 'PUT', body: rule });
log('5) catch-all →', worker, ':', put.ok ? 'OK' : `失败 ${JSON.stringify(put.json.errors)}`);

// 6. 校验
const check = await cf(`/zones/${zoneId}/email/routing/rules/catch_all`);
log('6) 校验:', JSON.stringify(check.json.result ?? check.json.errors));
const mx = await cf(`/zones/${zoneId}/dns_records?type=MX`, { auth: dnsToken });
if (mx.ok) {
  const list = mx.json.result.map((r) => `${r.name} → ${r.content}(p${r.priority})`);
  log('   MX:', list.join(', ') || '无');
}
log('\n域名:', zoneName, '→ 任意地址 @' + zoneName, subdomains.length ? '以及 @' + subdomains.map((s) => `${s}.${zoneName}`).join(' / ') : '', '都会投递到 Worker', worker);
