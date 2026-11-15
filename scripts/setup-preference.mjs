#!/usr/bin/env node
/**
 * 把站点主域名切到 Cloudflare 优选线路（Worker Route + 灰云 A 记录）。
 *
 * 原理：
 *   1. 删掉 Worker 的 Custom Domain —— 它会强制把 DNS 做成橙云，无法优选；
 *   2. 给主域名加 Worker Route（<主域名>/*），Worker 仍按 Host 接管请求；
 *   3. 主域名 DNS 改成「仅 DNS（灰云）」的多条 A 记录，指向实测最快的 Cloudflare 香港节点；
 *   4. 证书继续由 zone 的 Universal SSL 覆盖，TLS 不受影响。
 *
 * 用法（PowerShell）：
 *   $env:CF_API_TOKEN="<token>"; $env:ZONE_NAME="example.com"
 *   node scripts/setup-preference.mjs              # 执行
 *   $env:DRY_RUN="1"; node scripts/setup-preference.mjs   # 只看计划，不动线上
 *
 * Token 权限：Zone:Read、DNS:Edit、Workers Routes:Edit、Workers Scripts:Edit
 *
 * 可选环境变量：
 *   ZONE_NAME   必填，站点域名所在 zone，如 example.com
 *   PREF_HOST   默认 fademail.<ZONE_NAME>
 *   WORKER_NAME 默认 fademail
 *   PREF_IPS    默认下面 4 个实测较快的香港节点，逗号分隔
 */
import https from 'node:https';

const API = 'https://api.cloudflare.com/client/v4';
// cmd 的 `set X=1 && ...` 会给值带上尾随空格，统一 trim
const env = (k) => (process.env[k] || '').trim();
const token = env('CF_API_TOKEN');
const zoneName = env('ZONE_NAME');
const host = env('PREF_HOST') || (zoneName ? `fademail.${zoneName}` : '');
const script = env('WORKER_NAME') || 'fademail';
const dryRun = env('DRY_RUN') === '1';
const ips = (process.env.PREF_IPS || '104.25.245.145,172.66.194.92,172.66.129.80,172.66.214.228')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!token || !zoneName) {
  console.error('缺少 CF_API_TOKEN / ZONE_NAME（ZONE_NAME 为站点域名所在 zone，如 example.com）');
  process.exit(1);
}

const log = (...a) => console.log(...a);

async function cf(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok && json.success !== false, status: res.status, json };
}

/** 用指定 IP + 正确 SNI 验证边缘是否已经能返回站点 */
function verifyIp(ip) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: ip,
        port: 443,
        servername: host,
        path: '/',
        method: 'HEAD',
        headers: { Host: host, 'user-agent': 'fademail-pref-check' },
        rejectUnauthorized: false,
        timeout: 8000,
      },
      (res) => {
        res.resume();
        resolve({ ip, status: res.statusCode });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ ip, status: 'timeout' }); });
    req.on('error', (e) => { req.destroy(); resolve({ ip, status: e.code || e.message }); });
    req.end();
  });
}

// ---------- 1. 定位资源 ----------
const zoneRes = await cf(`/zones?name=${encodeURIComponent(zoneName)}`);
const zone = zoneRes.json?.result?.[0];
if (!zoneRes.ok || !zone) {
  console.error('找不到 zone:', zoneName, JSON.stringify(zoneRes.json?.errors || zoneRes.status));
  process.exit(2);
}
const zoneId = zone.id;
const accountId = zone.account?.id;
log(`zone: ${zoneName} (${zoneId})  account: ${accountId}  plan: ${zone.plan?.name || '?'}`);
log(`目标: ${host} → route ${host}/* + 灰云 A 记录 ${ips.join(' / ')}`);

const dnsRes = await cf(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(host)}&per_page=100`);
const records = dnsRes.json?.result || [];
log('\n现有 DNS:');
for (const r of records) log(`  ${r.type.padEnd(6)} ${r.name} → ${r.content}  proxied=${r.proxied}`);

const domainRes = await cf(`/accounts/${accountId}/workers/domains`);
const customDomain = (domainRes.json?.result || []).find((d) => d.hostname === host);
log(`现有 Custom Domain: ${customDomain ? `${customDomain.id} (${customDomain.service})` : '无'}`);

const routeRes = await cf(`/zones/${zoneId}/workers/routes`);
const routes = routeRes.json?.result || [];
const existingRoute = routes.find((r) => r.pattern === `${host}/*`);
log(`现有 Route: ${existingRoute ? `${existingRoute.id} → ${existingRoute.script}` : '无'}`);

if (dryRun) {
  log('\n[DRY_RUN] 计划：删 Custom Domain → 清冲突 A/AAAA/CNAME → 写灰云 A 记录 → 建 Route → 验证');
  process.exit(0);
}

// ---------- 2. 变更（记录回滚所需信息） ----------
const undo = [];

try {
  if (customDomain) {
    const del = await cf(`/accounts/${accountId}/workers/domains/${customDomain.id}`, { method: 'DELETE' });
    if (!del.ok) throw new Error(`删除 Custom Domain 失败: ${JSON.stringify(del.json?.errors)}`);
    undo.push(async () => {
      await cf(`/accounts/${accountId}/workers/domains`, {
        method: 'PUT',
        body: { environment: 'production', hostname: host, service: script, zone_id: zoneId },
      });
    });
    log('1) 已删除 Custom Domain');
  } else {
    log('1) 无需删除 Custom Domain');
  }

  // Custom Domain 删除后 CF 通常会自动清掉它建的记录，这里兜底
  const again = await cf(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(host)}&per_page=100`);
  for (const r of again.json?.result || []) {
    if (!['A', 'AAAA', 'CNAME'].includes(r.type)) continue;
    const del = await cf(`/zones/${zoneId}/dns_records/${r.id}`, { method: 'DELETE' });
    if (del.ok) log(`2) 清理记录 ${r.type} ${r.content}`);
  }

  for (const ip of ips) {
    const created = await cf(`/zones/${zoneId}/dns_records`, {
      method: 'POST',
      body: { type: 'A', name: host, content: ip, ttl: 60, proxied: false },
    });
    if (!created.ok) throw new Error(`写 A 记录 ${ip} 失败: ${JSON.stringify(created.json?.errors)}`);
    const id = created.json.result.id;
    undo.push(async () => { await cf(`/zones/${zoneId}/dns_records/${id}`, { method: 'DELETE' }); });
  }
  log(`3) 已写入 ${ips.length} 条灰云 A 记录（TTL 60）`);

  if (!existingRoute) {
    const created = await cf(`/zones/${zoneId}/workers/routes`, {
      method: 'POST',
      body: { pattern: `${host}/*`, script },
    });
    if (!created.ok) throw new Error(`建 Route 失败: ${JSON.stringify(created.json?.errors)}`);
    const id = created.json.result.id;
    undo.push(async () => { await cf(`/zones/${zoneId}/workers/routes/${id}`, { method: 'DELETE' }); });
    log('4) 已创建 Worker Route');
  } else {
    log('4) Route 已存在，跳过');
  }

  // ---------- 3. 验证 ----------
  log('\n5) 验证各优选 IP：');
  const checks = [];
  for (const ip of ips) checks.push(await verifyIp(ip));
  for (const c of checks) log(`   ${c.ip} → ${c.status}`);

  if (!checks.some((c) => c.status === 200)) {
    throw new Error('所有优选 IP 都没返回 200，已回滚');
  }

  log(`\n完成。本机 DNS 缓存需要刷新（TTL 60），可用：`);
  log(`  ipconfig /flushdns  然后浏览器再访问 https://${host}`);
  log('\n注意：后续 npx wrangler deploy 只更新 Route，不会再改 DNS。');
} catch (e) {
  console.error('\n失败:', e.message);
  log('开始回滚…');
  for (const fn of undo.reverse()) {
    try { await fn(); } catch (err) { console.error('  回滚步骤失败:', err.message); }
  }
  log('已回滚。若站点仍未恢复，请在面板把 Custom Domain 重新绑一次。');
  process.exit(3);
}
