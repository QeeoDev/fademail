#!/usr/bin/env node
/**
 * CI 部署配置生成：读取仓库里的 wrangler.jsonc 模板，用环境变量里的
 * 真实值替换对应字段，生成 wrangler.deploy.jsonc 供 wrangler deploy 使用。
 *
 * 必需环境变量：
 *   SITE_DOMAIN     站点主域名，如 mail.example.com（Route / SITE_URL / CORS 都用它）
 *   ZONE_NAME       该域名所在的 Cloudflare zone，如 example.com
 *   MAIL_DOMAINS    收信域名，逗号分隔，如 mail.example.com,fademail.example.com
 *   D1_DATABASE_ID  D1 数据库 ID
 * 可选环境变量：
 *   WORKER_NAME        默认 fademail
 *   D1_DATABASE_NAME   默认 fademail
 *   ALLOWED_ORIGINS    默认 https://<SITE_DOMAIN>
 *   DEFAULT_TTL_HOURS  默认 24
 *   MAX_TTL_HOURS      默认 720
 *   BRAND              默认 FadeMail
 *
 * 只替换 JSON 字符串值，不解析/重排文件，模板里的注释原样保留。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const env = (k) => (process.env[k] || '').trim();

const siteDomain = env('SITE_DOMAIN');
const zoneName = env('ZONE_NAME');
const mailDomains = env('MAIL_DOMAINS');
const d1Id = env('D1_DATABASE_ID');
const workerName = env('WORKER_NAME') || 'fademail';
const d1Name = env('D1_DATABASE_NAME') || 'fademail';

const missing = [
  ['SITE_DOMAIN', siteDomain],
  ['ZONE_NAME', zoneName],
  ['MAIL_DOMAINS', mailDomains],
  ['D1_DATABASE_ID', d1Id],
].filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`缺少必需环境变量: ${missing.join(', ')}`);
  process.exit(1);
}

const siteUrl = `https://${siteDomain}`;
const allowedOrigins = env('ALLOWED_ORIGINS') || siteUrl;
const defaultTtl = env('DEFAULT_TTL_HOURS') || '24';
const maxTtl = env('MAX_TTL_HOURS') || '720';
const brand = env('BRAND') || 'FadeMail';

let text = readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8');

/** 替换 "KEY": "value" 的 value，整个文件只允许出现一次（函数式替换，避免 $ 转义问题） */
const setVar = (key, value) => {
  const re = new RegExp(`("${key}"\\s*:\\s*")([^"]*)(")`);
  if (!re.test(text)) throw new Error(`模板里找不到字段: ${key}`);
  text = text.replace(re, (_m, p1, _p2, p3) => `${p1}${value}${p3}`);
};

// 顶层字段（模板中同名键各只出现一次）
const setJson = (key, value) => setVar(key, value);

setJson('name', workerName);
setJson('database_name', d1Name);
setJson('database_id', d1Id);
setJson('pattern', `${siteDomain}/*`);
setJson('zone_name', zoneName);
setJson('MAIL_DOMAINS', mailDomains);
setJson('SITE_URL', siteUrl);
setJson('ALLOWED_ORIGINS', allowedOrigins);
setJson('DEFAULT_TTL_HOURS', defaultTtl);
setJson('MAX_TTL_HOURS', maxTtl);
setJson('BRAND', brand);

const out = path.join(root, 'wrangler.deploy.jsonc');
writeFileSync(out, text);
// 注意：Actions 日志是公开的，这里绝不能打印域名 / zone / D1 ID 等真实值
const mailCount = mailDomains.split(',').filter(Boolean).length;
console.log(`已生成 ${out}`);
console.log(`  worker: ${workerName}`);
console.log(`  site:   https://***（已隐藏）`);
console.log(`  mail:   ${mailCount} 个收信域名（已隐藏）`);
console.log(`  d1:     ${d1Name}（ID 已隐藏）`);
