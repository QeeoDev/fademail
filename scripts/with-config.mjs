#!/usr/bin/env node
/**
 * wrangler 命令包装：自动选择配置文件。
 *
 *   存在 wrangler.local.jsonc（不入库的私有配置）→ 用它
 *   否则                                          → 用 wrangler.jsonc（仓库模板）
 *
 * 用法：node scripts/with-config.mjs <wrangler 子命令与参数…>
 *   npm run deploy          → node scripts/with-config.mjs deploy
 *   npm run db:init:remote  → node scripts/with-config.mjs d1 execute … --remote
 *
 * 实现说明：直接用 node 跑 wrangler 的 bin/wrangler.js，绕开 npx.cmd ——
 * 新版 Node 在 Windows 上禁止 spawn .cmd（CVE-2024-27980，EINVAL 静默失败）。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const localCfg = path.join(root, 'wrangler.local.jsonc');
const cfg = existsSync(localCfg) ? localCfg : path.join(root, 'wrangler.jsonc');
const wranglerBin = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

if (!existsSync(wranglerBin)) {
  console.error('找不到 wrangler，先执行 npm install');
  process.exit(1);
}

const args = process.argv.slice(2);
console.log(`[with-config] 配置文件: ${path.relative(root, cfg)}`);
const r = spawnSync(process.execPath, [wranglerBin, ...args, '--config', cfg], {
  stdio: 'inherit',
  cwd: root,
});
if (r.error) {
  console.error('执行失败:', r.error.message);
  process.exit(1);
}
process.exit(r.status ?? 1);
