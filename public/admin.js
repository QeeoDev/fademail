/* FadeMail · 管理后台逻辑 */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ic = (name) => `<svg><use href="#i-${name}"/></svg>`;

const LS_THEME = 'fm.theme';

const state = {
  tab: 'overview',
  overview: null,
  mailboxes: { q: '', page: 1, size: 20, total: 0, rows: [] },
  domains: [],
  keys: [],
  events: [],
  settings: null,
  settingsDomains: [],
  account: null,
  loading: false,
};

/* -------------------------------- 基础工具 -------------------------------- */

function fmtTime(sec) {
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtAgo(sec) {
  if (!sec) return '—';
  const diff = Date.now() / 1000 - sec;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  return fmtTime(sec);
}

function fmtLeft(sec) {
  const ms = sec * 1000 - Date.now();
  if (ms <= 0) return '已过期';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}

function fmtSize(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`.trim();
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 260);
  }, 2400);
}

/* --------------------------------- 主题 ---------------------------------- */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#ffffff' : '#1b1c1e');
  try { localStorage.setItem(LS_THEME, theme); } catch (e) { /* ignore */ }
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(LS_THEME); } catch (e) { /* ignore */ }
  if (saved === 'light' || saved === 'dark') return applyTheme(saved);
  applyTheme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

/* --------------------------------- 请求 ---------------------------------- */

async function api(path, { method = 'GET', body, csrf = false } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (csrf) headers['x-admin-csrf'] = '1';
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch (e) {
    throw new Error('网络连接失败');
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* 非 JSON */ }
  // 站点门禁 Cookie 失效：刷新让 Worker 展示输入密码页（区别于后台登录态 401）
  if (res.headers.get('x-fm-code') === 'gate-required') {
    location.reload();
    throw new Error('需要先通过站点门禁');
  }
  if (res.status === 401) {
    showLogin();
    throw new Error('登录已过期，请重新登录');
  }
  if (!res.ok) throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
  return data;
}

/* -------------------------------- 弹层 ----------------------------------- */

function openModal(title, html) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="ad-modal-root">
    <div class="mask" data-close></div>
    <div class="ad-modal" role="dialog" aria-modal="true">
      <button class="icon-btn close" data-close aria-label="关闭">${ic('close')}</button>
      <h3>${esc(title)}</h3>
      <div id="modal-body">${html}</div>
    </div>
  </div>`;
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  $$('[data-close]', root).forEach((el) => el.addEventListener('click', close));
  return { root, close };
}

/* -------------------------------- 视图切换 -------------------------------- */

function showLogin() {
  $('#login-view').hidden = false;
  $('#dash-view').hidden = true;
  $('#btn-logout').hidden = true;
  const boot = $('#boot-card');
  if (boot) boot.hidden = true;
  const card = $('#login-card');
  if (card) card.hidden = false;
  const loginUser = $('#login-user');
  if (loginUser) loginUser.focus();
}

function showDash() {
  $('#login-view').hidden = true;
  $('#dash-view').hidden = false;
  $('#btn-logout').hidden = false;
}

/** 首次登录还在用默认密码时，顶栏给个提示 */
function renderBanner() {
  const host = $('#dash-view');
  if (!host) return;
  const old = $('#dash-banner');
  if (old) old.remove();
  if (!(state.account && state.account.mustChange)) return;
  const el = document.createElement('div');
  el.id = 'dash-banner';
  el.className = 'banner warn';
  el.innerHTML = `当前仍在使用初始密码，请前往 <b>设置</b> 修改账号与密码。
    <button class="btn outline sm" id="banner-goto">去修改</button>`;
  host.prepend(el);
  const gotoBtn = $('#banner-goto');
  if (gotoBtn) gotoBtn.addEventListener('click', () => switchTab('settings'));
}

/* -------------------------------- 总览 ----------------------------------- */

function statCard(label, value, sub = '') {
  return `<div class="card stat">
    <div class="label">${esc(label)}</div>
    <div class="value">${esc(value)}</div>
    ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
  </div>`;
}

function renderOverview() {
  const o = state.overview;
  if (!o) return `<div class="card empty-line">加载中…</div>`;
  const s = o.stats;

  const domains = o.domains.length
    ? `<div class="table-wrap"><table class="ad-table">
        <thead><tr><th>域名</th><th>状态</th><th class="right">邮箱数</th><th class="right">生效中</th></tr></thead>
        <tbody>${o.domains.map((d) => `<tr>
          <td class="mono">${esc(d.domain)}${d.isDefault ? ' <span class="chip ok">默认</span>' : ''}</td>
          <td>${d.enabled ? '<span class="chip ok">启用</span>' : '<span class="chip off">停用</span>'}</td>
          <td class="right">${d.mailboxes}</td>
          <td class="right">${d.active}</td>
        </tr>`).join('')}</tbody>
      </table></div>`
    : `<div class="empty-line">还没有配置可用域名</div>`;

  const events = o.events.length
    ? `<div class="event-list">${o.events.map((e) => `<div class="event">
        <span class="kind">${esc(e.kind)}</span>
        <span class="ref">${esc(e.ref || '—')}${e.detail ? ` · ${esc(e.detail)}` : ''}</span>
        <span class="ip">${esc(e.ip || '')}</span>
        <span class="time">${fmtAgo(e.at)}</span>
      </div>`).join('')}</div>`
    : `<div class="empty-line">暂无活动</div>`;

  const top = o.top.length
    ? `<div class="table-wrap"><table class="ad-table">
        <thead><tr><th>邮箱</th><th class="right">邮件数</th><th class="right">剩余</th></tr></thead>
        <tbody>${o.top.map((m) => `<tr>
          <td class="mono">${esc(m.address)}</td>
          <td class="right">${m.messages}</td>
          <td class="right muted">${esc(fmtLeft(m.expiresAt))}</td>
        </tr>`).join('')}</tbody>
      </table></div>`
    : `<div class="empty-line">暂无邮箱</div>`;

  return `
    <div class="ad-grid">
      ${statCard('生效中邮箱', s.activeMailboxes, `累计 ${s.totalMailboxes}`)}
      ${statCard('邮件总数', s.messages, `未读 ${s.unread}`)}
      ${statCard('附件', s.attachments, fmtSize(s.attachmentBytes))}
      ${statCard('24 小时', `+${s.newMailboxes24h}`, `新邮件 ${s.newMessages24h}`)}
    </div>

    <div class="ad-grid two ad-section">
      <div class="card">
        <div class="ad-section-head" style="padding:14px 16px 0">
          <h2>域名</h2><span class="grow"></span>
          <button class="btn outline sm" data-goto="domains">管理</button>
        </div>
        ${domains}
      </div>
      <div class="card">
        <div class="ad-section-head" style="padding:14px 16px 0">
          <h2>最近活动</h2><span class="grow"></span>
          <button class="btn outline sm" data-goto="events">全部</button>
        </div>
        ${events}
      </div>
    </div>

    <div class="ad-section card">
      <div class="ad-section-head" style="padding:14px 16px 0">
        <h2>邮件最多的邮箱</h2><span class="grow"></span>
        <button class="btn outline sm" data-act="purge">${ic('broom')}立即清理过期</button>
      </div>
      ${top}
    </div>`;
}

/* -------------------------------- 邮箱 ----------------------------------- */

function renderMailboxes() {
  const m = state.mailboxes;
  const rows = m.rows.length
    ? m.rows.map((b) => `<tr data-id="${esc(b.id)}">
        <td>
          <div class="ad-addr mono">${esc(b.address)}</div>
          ${b.note ? `<div class="ad-note">${esc(b.note)}</div>` : ''}
        </td>
        <td class="nowrap">${b.protected ? '<span class="chip ok">受保护</span>' : '<span class="chip off">无密钥</span>'}
          ${b.hasPassword ? '<span class="chip ok">有密码</span>' : ''}</td>
        <td class="right">${b.messages}${b.unread ? ` <span class="chip warn">${b.unread} 未读</span>` : ''}</td>
        <td class="right muted nowrap">${esc(fmtLeft(b.expiresAt))}</td>
        <td class="right muted nowrap">${fmtTime(b.createdAt)}</td>
        <td>
          <div class="row-actions">
            <button class="btn outline sm" data-act="view" data-id="${esc(b.id)}">${ic('eye')}查看</button>
            <button class="btn outline sm" data-act="extend" data-id="${esc(b.id)}">${ic('clock')}延长</button>
            <button class="btn danger sm" data-act="del" data-id="${esc(b.id)}">${ic('trash')}</button>
          </div>
        </td>
      </tr>`).join('')
    : `<tr><td colspan="6" class="empty-line">没有匹配的邮箱</td></tr>`;

  const pages = Math.max(1, Math.ceil(m.total / m.size));

  return `<div class="ad-section card" style="margin-top:0">
    <div class="ad-section-head" style="padding:14px 16px">
      <div class="toolbar">
        <label class="search">${ic('search')}
          <input id="mb-search" placeholder="搜索地址或备注" value="${esc(m.q)}" autocomplete="off">
        </label>
        <span class="sub">共 ${m.total} 个邮箱</span>
      </div>
      <span class="grow"></span>
      <button class="btn outline sm" id="mb-reload">${ic('refresh')}刷新</button>
    </div>
    <div class="table-wrap"><table class="ad-table">
      <thead><tr>
        <th>邮箱</th><th>安全</th><th class="right">邮件</th><th class="right">剩余</th><th class="right">创建时间</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="ad-section-head" style="padding:10px 16px">
      <span class="sub">第 ${m.page} / ${pages} 页</span>
      <span class="grow"></span>
      <div class="pager">
        <button class="btn outline sm" data-act="page" data-page="${m.page - 1}" ${m.page <= 1 ? 'disabled' : ''}>${ic('left')}上一页</button>
        <button class="btn outline sm" data-act="page" data-page="${m.page + 1}" ${m.page >= pages ? 'disabled' : ''}>下一页${ic('right')}</button>
      </div>
    </div>
  </div>`;
}

/* -------------------------------- 域名 ----------------------------------- */

function renderDomains() {
  const rows = state.domains.length
    ? state.domains.map((d) => `<tr>
        <td class="mono">${esc(d.domain)}${d.is_default ? ' <span class="chip ok">默认</span>' : ''}</td>
        <td>${d.enabled ? '<span class="chip ok">启用</span>' : '<span class="chip off">停用</span>'}</td>
        <td class="right">${d.mailboxes || 0}</td>
        <td class="right muted nowrap">${fmtTime(d.created_at)}</td>
        <td>
          <div class="row-actions">
            <button class="btn outline sm" data-act="dom-default" data-domain="${esc(d.domain)}" ${d.is_default ? 'disabled' : ''}>设为默认</button>
            <button class="btn outline sm" data-act="dom-toggle" data-domain="${esc(d.domain)}" data-enabled="${d.enabled ? '0' : '1'}">${d.enabled ? '停用' : '启用'}</button>
          </div>
        </td>
      </tr>`).join('')
    : `<tr><td colspan="5" class="empty-line">还没有域名，先添加一个</td></tr>`;

  return `<div class="ad-section card" style="margin-top:0">
    <div class="ad-section-head" style="padding:14px 16px">
      <h2>收信域名</h2>
      <span class="sub">只有启用的域名会出现在前端的后缀下拉里</span>
      <span class="grow"></span>
    </div>
    <div style="padding:0 16px 14px" class="toolbar">
      <input id="new-domain" placeholder="mail.example.com" style="max-width:280px" autocomplete="off">
      <button class="btn primary sm" id="add-domain">${ic('plus')}添加域名</button>
    </div>
    <div class="table-wrap"><table class="ad-table">
      <thead><tr><th>域名</th><th>状态</th><th class="right">邮箱数</th><th class="right">添加时间</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

/* ------------------------------- API Key --------------------------------- */

function renderKeys() {
  const rows = state.keys.length
    ? state.keys.map((k) => `<tr>
        <td>${esc(k.name)}</td>
        <td class="mono muted">${esc(k.prefix)}…</td>
        <td class="right">${k.calls || 0}</td>
        <td class="right muted nowrap">${k.last_used ? fmtAgo(k.last_used) : '从未'}</td>
        <td>${k.revoked ? '<span class="chip off">已吊销</span>' : '<span class="chip ok">有效</span>'}</td>
        <td><div class="row-actions">
          ${k.revoked ? '' : `<button class="btn danger sm" data-act="key-del" data-id="${esc(k.id)}">吊销</button>`}
        </div></td>
      </tr>`).join('')
    : `<tr><td colspan="6" class="empty-line">还没有 API Key</td></tr>`;

  return `<div class="ad-section card" style="margin-top:0">
    <div class="ad-section-head" style="padding:14px 16px">
      <h2>开放 API 密钥</h2>
      <span class="sub">用于 /api/v1 接口，形如 fm_xxx</span>
      <span class="grow"></span>
    </div>
    <div style="padding:0 16px 14px" class="toolbar">
      <input id="new-key-name" placeholder="用途备注，例如 my-app" style="max-width:260px" autocomplete="off">
      <button class="btn primary sm" id="add-key">${ic('key')}生成密钥</button>
    </div>
    <div class="table-wrap"><table class="ad-table">
      <thead><tr><th>名称</th><th>前缀</th><th class="right">调用次数</th><th class="right">最近使用</th><th>状态</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

/* -------------------------------- 活动 ----------------------------------- */

function renderEvents() {
  const list = state.events.length
    ? `<div class="event-list">${state.events.map((e) => `<div class="event">
        <span class="kind">${esc(e.kind)}</span>
        <span class="ref">${esc(e.ref || '—')}${e.detail ? ` · ${esc(e.detail)}` : ''}</span>
        <span class="ip">${esc(e.ip || '')}</span>
        <span class="time">${fmtTime(e.created_at)}</span>
      </div>`).join('')}</div>`
    : `<div class="empty-line">暂无活动</div>`;
  return `<div class="ad-section card" style="margin-top:0">
    <div class="ad-section-head" style="padding:14px 16px">
      <h2>活动日志</h2>
      <span class="sub">最近 100 条</span>
      <span class="grow"></span>
      <button class="btn outline sm" data-act="events-reload">${ic('refresh')}刷新</button>
    </div>
    ${list}
  </div>`;
}

/* -------------------------------- 设置页 --------------------------------- */

function renderSettings() {
  const s = state.settings || {};
  const acc = state.account || {};
  const ttls = Array.isArray(s.ttls) ? s.ttls.join(', ') : '1, 6, 24, 168';
  const domains = (state.settingsDomains && state.settingsDomains.length)
    ? state.settingsDomains.map((d) => `<span class="chip mono">@${esc(d)}</span>`).join(' ')
    : '<span class="muted">暂无可用域名</span>';

  return `<div class="ad-grid two">
    <div class="card ad-form-card">
      <h3>站点信息</h3>
      <p class="muted">这里的配置会覆盖环境变量，保存后前台立即生效。</p>
      <form id="site-form" class="ad-form">
        <div class="field">
          <label class="field-label" for="st-brand">站点名称</label>
          <input id="st-brand" name="brand" maxlength="32" value="${esc(s.brand || 'FadeMail')}" required>
        </div>
        <div class="field">
          <label class="field-label" for="st-url">站点地址</label>
          <input id="st-url" name="siteUrl" value="${esc(s.siteUrl || '')}" placeholder="https://fademail.example.com" required>
        </div>
        <div class="field-row">
          <div class="field">
            <label class="field-label" for="st-default">默认有效期（小时）</label>
            <input id="st-default" name="defaultTtl" type="number" min="1" max="8760" value="${Number(s.defaultTtl) || 24}">
          </div>
          <div class="field">
            <label class="field-label" for="st-max">最长有效期（小时）</label>
            <input id="st-max" name="maxTtl" type="number" min="1" max="8760" value="${Number(s.maxTtl) || 720}">
          </div>
        </div>
        <div class="field">
          <label class="field-label" for="st-ttls">有效期预设（小时，逗号分隔）</label>
          <input id="st-ttls" name="ttls" value="${esc(ttls)}" placeholder="1, 6, 24, 168">
        </div>
        <div class="field">
          <label class="field-label" for="st-notice">首页提示（可选）</label>
          <input id="st-notice" name="notice" maxlength="200" value="${esc(s.notice || '')}" placeholder="例如：本服务仅用于接收验证码">
        </div>
        <div class="field">
          <label class="field-label">当前可用域名</label>
          <div class="chip-line">${domains}</div>
        </div>
        <button class="btn primary" type="submit">保存站点信息</button>
      </form>
    </div>

    <div class="card ad-form-card">
      <h3>管理员账号</h3>
      <p class="muted">修改账号或密码都需要先验证当前密码。${acc.mustChange ? '<br><b class="warn-text">当前仍是默认密码，请尽快修改。</b>' : ''}</p>
      <form id="account-form" class="ad-form">
        <div class="field">
          <label class="field-label" for="ac-user">账号</label>
          <input id="ac-user" name="username" value="${esc(acc.username || 'admin')}" maxlength="32" required>
        </div>
        <div class="field">
          <label class="field-label" for="ac-current">当前密码</label>
          <div class="pw">
            <input id="ac-current" name="currentPassword" type="password" autocomplete="current-password" placeholder="请输入当前密码以验证身份" required>
            <button type="button" class="pw-eye" tabindex="-1" aria-label="显示密码"><svg><use href="#i-eye"/></svg></button>
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label class="field-label" for="ac-new">新密码</label>
            <div class="pw">
              <input id="ac-new" name="newPassword" type="password" autocomplete="new-password" minlength="6" placeholder="留空表示不修改">
              <button type="button" class="pw-eye" tabindex="-1" aria-label="显示密码"><svg><use href="#i-eye"/></svg></button>
            </div>
          </div>
          <div class="field">
            <label class="field-label" for="ac-confirm">确认新密码</label>
            <div class="pw">
              <input id="ac-confirm" name="confirmPassword" type="password" autocomplete="new-password" placeholder="请再次输入新密码">
              <button type="button" class="pw-eye" tabindex="-1" aria-label="显示密码"><svg><use href="#i-eye"/></svg></button>
            </div>
          </div>
        </div>
        <button class="btn primary" type="submit">保存账号</button>
      </form>
      <div class="ad-note">上次修改：${acc.updatedAt ? esc(fmtTime(acc.updatedAt)) : '从未'}</div>
    </div>
  </div>`;
}

/* -------------------------------- 渲染 ----------------------------------- */

function renderPanel() {
  const panel = $('#panel');
  // 搜索框输入后重渲染会丢焦点，这里保留一下光标
  const wasSearch = document.activeElement && document.activeElement.id === 'mb-search';
  if (state.loading) panel.innerHTML = `<div class="card empty-line">加载中…</div>`;
  else if (state.tab === 'overview') panel.innerHTML = renderOverview();
  else if (state.tab === 'mailboxes') panel.innerHTML = renderMailboxes();
  else if (state.tab === 'domains') panel.innerHTML = renderDomains();
  else if (state.tab === 'keys') panel.innerHTML = renderKeys();
  else if (state.tab === 'settings') panel.innerHTML = renderSettings();
  else panel.innerHTML = renderEvents();

  $$('#tabs .ad-tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === state.tab));

  if (wasSearch && state.tab === 'mailboxes') {
    const el = $('#mb-search');
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }
}

/* -------------------------------- 数据加载 -------------------------------- */

async function loadOverview() {
  state.overview = await api('/api/admin/overview');
}

async function loadMailboxes(page = state.mailboxes.page) {
  const { q, size } = state.mailboxes;
  const data = await api(`/api/admin/mailboxes?q=${encodeURIComponent(q)}&page=${page}&size=${size}`);
  state.mailboxes = { q, size, page: data.page, total: data.total, rows: data.mailboxes };
}

async function loadDomains() {
  const data = await api('/api/admin/domains');
  state.domains = data.domains;
}

async function loadKeys() {
  const data = await api('/api/admin/keys');
  state.keys = data.keys;
}

async function loadEvents() {
  const data = await api('/api/admin/events?limit=100');
  state.events = data.events;
}

async function loadSettings() {
  const [conf, account] = await Promise.all([api('/api/admin/settings'), api('/api/admin/account')]);
  state.settings = conf.settings;
  state.settingsDomains = conf.domains || [];
  state.account = account;
}

async function reload(showToast = false) {
  state.loading = true;
  renderPanel();
  try {
    if (state.tab === 'overview') await loadOverview();
    else if (state.tab === 'mailboxes') await loadMailboxes();
    else if (state.tab === 'domains') await loadDomains();
    else if (state.tab === 'keys') await loadKeys();
    else if (state.tab === 'settings') await loadSettings();
    else await loadEvents();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    state.loading = false;
    renderPanel();
    if (showToast) toast('已刷新', 'ok');
  }
}

async function switchTab(tab) {
  state.tab = tab;
  if (tab === 'overview') state.mailboxes.page = 1;
  await reload();
  renderBanner();
}

/* -------------------------------- 交互 ----------------------------------- */

async function viewMailbox(id) {
  const data = await api(`/api/admin/mailboxes/${encodeURIComponent(id)}`);
  const b = data.mailbox;
  const list = data.messages.length
    ? `<div class="ad-msg-list">${data.messages.map((m) => `
        <div class="msg" data-msg="${esc(m.id)}">
          <div class="line1">
            <span class="subject">${esc(m.subject || '(无主题)')}</span>
            <span class="grow" style="flex:1"></span>
            <span class="meta">${fmtAgo(m.receivedAt)}</span>
          </div>
          <div class="meta">${esc(m.fromAddr)} · ${fmtSize(m.size)}${m.code ? ` · 验证码 ${esc(m.code)}` : ''}${m.isRead ? '' : ' · 未读'}</div>
        </div>`).join('')}</div>`
    : `<div class="empty-line">这个邮箱还没有收到邮件</div>`;

  const total = b.messageCount != null ? b.messageCount : data.messages.length;
  const { root } = openModal(b.address, `
    <div class="toolbar" style="margin-bottom:14px">
      <span class="chip ${b.protected ? 'ok' : 'off'}">${b.protected ? '受保护' : '无密钥'}</span>
      <span class="chip">${total} 封邮件</span>
      <span class="chip">剩余 ${esc(fmtLeft(b.expiresAt))}</span>
      ${b.hasPassword ? '<span class="chip ok">有找回密码</span>' : ''}
      <span class="grow" style="flex:1"></span>
      <button class="btn outline sm" data-act="mailbox-extend" data-id="${esc(b.id)}">${ic('clock')}延长</button>
    </div>
    ${list}
  `);

  $$('.msg', root).forEach((el) => el.addEventListener('click', () => viewMessage(el.dataset.msg)));
  $$('[data-act="mailbox-extend"]', root).forEach((el) =>
    el.addEventListener('click', () => extendMailbox(el.dataset.id)));
}

async function viewMessage(id) {
  const { message } = await api(`/api/admin/messages/${encodeURIComponent(id)}`);
  const headers = (message.headers || []).map((h) => `${h.k}: ${h.v}`).join('\n');
  openModal(message.subject || '(无主题)', `
    <div class="toolbar" style="margin-bottom:12px">
      <span class="chip">${esc(message.fromAddr)}</span>
      <span class="chip">→ ${esc(message.toAddr || message.mailbox)}</span>
      <span class="chip">${fmtSize(message.size)}</span>
      <span class="chip">${fmtTime(message.receivedAt)}</span>
      ${message.hasHtml ? '<span class="chip ok">含 HTML</span>' : ''}
    </div>
    ${message.attachments && message.attachments.length ? `<div class="toolbar" style="margin-bottom:12px">${message.attachments.map((a) => `<span class="chip">${esc(a.filename)} · ${fmtSize(a.size)}</span>`).join('')}</div>` : ''}
    <pre>${esc(message.text || '(无纯文本正文)')}</pre>
    ${headers ? `<h3 style="margin:16px 0 8px;font-size:13px">邮件头</h3><pre>${esc(headers)}</pre>` : ''}
  `);
}

async function extendMailbox(id) {
  const { root, close } = openModal('延长有效期', `
    <div class="field">
      <label class="field-label">增加时长</label>
      <select id="ext-hours">
        <option value="1">1 小时</option>
        <option value="6">6 小时</option>
        <option value="24" selected>24 小时</option>
        <option value="72">3 天</option>
        <option value="168">7 天</option>
      </select>
    </div>
    <button class="btn primary block" id="ext-ok">确认延长</button>
  `);
  $('#ext-ok', root).addEventListener('click', async () => {
    const btn = $('#ext-ok', root);
    btn.disabled = true;
    try {
      await api(`/api/admin/mailboxes/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { ttlHours: parseInt($('#ext-hours', root).value, 10) },
        csrf: true,
      });
      close();
      toast('已延长', 'ok');
      await reload();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
  });
}

async function removeMailbox(id) {
  if (!window.confirm('确定要删除这个邮箱及其全部邮件吗？此操作不可恢复。')) return;
  try {
    await api(`/api/admin/mailboxes/${encodeURIComponent(id)}`, { method: 'DELETE', csrf: true });
    toast('已删除', 'ok');
    await reload();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* -------------------------------- 事件绑定 -------------------------------- */

function bindEvents() {
  // 密码可见切换（登录页与设置页共用）
  document.addEventListener('click', (e) => {
    const eye = e.target.closest('.pw-eye');
    if (!eye) return;
    const input = eye.parentElement.querySelector('input');
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    eye.classList.toggle('on', show);
    const useEl = $('use', eye);
    if (useEl) useEl.setAttribute('href', show ? '#i-eye-off' : '#i-eye');
    eye.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
  });

  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.ad-tab');
    if (tab && tab.dataset.tab !== state.tab) switchTab(tab.dataset.tab);
  });

  $('#panel').addEventListener('click', async (e) => {
    const goto = e.target.closest('[data-goto]');
    if (goto) return switchTab(goto.dataset.goto);

    const act = e.target.closest('[data-act]');
    if (!act) return;
    const { act: name, id, page, domain, enabled } = act.dataset;

    if (name === 'purge') {
      act.disabled = true;
      try {
        const r = await api('/api/admin/purge', { method: 'POST', csrf: true });
        toast(`已清理 ${r.purged || 0} 个过期邮箱`, 'ok');
        await reload();
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        act.disabled = false;
      }
    } else if (name === 'view') {
      try { await viewMailbox(id); } catch (err) { toast(err.message, 'err'); }
    } else if (name === 'extend') {
      extendMailbox(id).catch((err) => toast(err.message, 'err'));
    } else if (name === 'del') {
      removeMailbox(id);
    } else if (name === 'page') {
      const p = parseInt(page, 10);
      if (Number.isFinite(p) && p > 0) {
        state.mailboxes.page = p;
        await reload();
      }
    } else if (name === 'dom-default') {
      try {
        await api(`/api/admin/domains/${encodeURIComponent(domain)}`, { method: 'PATCH', body: { isDefault: true }, csrf: true });
        toast('已设为默认', 'ok');
        await reload();
      } catch (err) { toast(err.message, 'err'); }
    } else if (name === 'dom-toggle') {
      try {
        await api(`/api/admin/domains/${encodeURIComponent(domain)}`, {
          method: 'PATCH', body: { enabled: enabled === '1' }, csrf: true,
        });
        toast(enabled === '1' ? '已启用' : '已停用', 'ok');
        await reload();
      } catch (err) { toast(err.message, 'err'); }
    } else if (name === 'key-del') {
      if (!window.confirm('吊销后使用该密钥的请求会立即失败，确定吗？')) return;
      try {
        await api(`/api/admin/keys/${encodeURIComponent(id)}`, { method: 'DELETE', csrf: true });
        toast('已吊销', 'ok');
        await reload();
      } catch (err) { toast(err.message, 'err'); }
    } else if (name === 'events-reload') {
      await reload();
    }
  });

  // 搜索（防抖）
  let timer = null;
  $('#panel').addEventListener('input', (e) => {
    if (e.target.id !== 'mb-search') return;
    const q = e.target.value;
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.mailboxes.q = q;
      state.mailboxes.page = 1;
      reload();
    }, 300);
  });

  $('#panel').addEventListener('keydown', (e) => {
    if (e.target.id === 'mb-search' && e.key === 'Enter') {
      state.mailboxes.q = e.target.value;
      state.mailboxes.page = 1;
      reload();
    }
    if (e.target.id === 'new-domain' && e.key === 'Enter') { const ad = $('#add-domain'); if (ad) ad.click(); }
    if (e.target.id === 'new-key-name' && e.key === 'Enter') { const ak = $('#add-key'); if (ak) ak.click(); }
  });

  $('#panel').addEventListener('click', async (e) => {
    if (e.target.closest('#mb-reload')) return reload();
    if (e.target.closest('#add-domain')) {
      const input = $('#new-domain');
      const domain = input.value.trim().toLowerCase();
      if (!domain) return toast('请输入域名', 'err');
      try {
        await api('/api/admin/domains', { method: 'POST', body: { domain }, csrf: true });
        input.value = '';
        toast('已添加', 'ok');
        await reload();
      } catch (err) { toast(err.message, 'err'); }
      return;
    }
    if (e.target.closest('#add-key')) {
      const input = $('#new-key-name');
      try {
        const r = await api('/api/admin/keys', { method: 'POST', body: { name: input.value.trim() || undefined }, csrf: true });
        input.value = '';
        openModal('新的 API Key', `
          <p class="sub" style="margin:0 0 10px;font-size:13px;color:var(--muted)">只显示这一次，请立即保存：</p>
          <pre>${esc(r.key)}</pre>
        `);
        await reload();
      } catch (err) { toast(err.message, 'err'); }
    }
  });

  // 设置页的两个表单
  $('#panel').addEventListener('submit', async (e) => {
    if (e.target.id !== 'site-form' && e.target.id !== 'account-form') return;
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      if (form.id === 'site-form') {
        const ttls = form.ttls.value
          .split(',')
          .map((v) => parseInt(v.trim(), 10))
          .filter((n) => Number.isFinite(n) && n > 0);
        const r = await api('/api/admin/settings', {
          method: 'PATCH',
          csrf: true,
          body: {
            brand: form.brand.value.trim(),
            siteUrl: form.siteUrl.value.trim(),
            notice: form.notice.value.trim(),
            ttls,
            defaultTtl: parseInt(form.defaultTtl.value, 10),
            maxTtl: parseInt(form.maxTtl.value, 10),
          },
        });
        state.settings = { ...(state.settings || {}), ...r.settings };
        toast('站点信息已保存', 'ok');
      } else {
        const newPassword = form.newPassword.value;
        if (newPassword && newPassword !== form.confirmPassword.value) {
          throw new Error('两次输入的新密码不一致');
        }
        const r = await api('/api/admin/account', {
          method: 'PATCH',
          csrf: true,
          body: {
            username: form.username.value.trim(),
            currentPassword: form.currentPassword.value,
            newPassword: newPassword || undefined,
          },
        });
        state.account = {
          username: r.username,
          mustChange: !!r.mustChange,
          updatedAt: Math.floor(Date.now() / 1000),
        };
        form.currentPassword.value = '';
        form.newPassword.value = '';
        form.confirmPassword.value = '';
        toast('账号信息已保存', 'ok');
        renderBanner();
      }
      renderPanel();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  $('#btn-refresh').addEventListener('click', () => reload(true));
  $('#btn-theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  });

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#login-btn');
    const err = $('#login-error');
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      const res = await api('/api/admin/login', {
        method: 'POST',
        body: { username: $('#login-user').value.trim(), password: $('#login-pass').value },
      });
      $('#login-pass').value = '';
      state.account = { username: res.username, mustChange: !!res.mustChange };
      showDash();
      await switchTab(res.mustChange ? 'settings' : 'overview');
      renderBanner();
      if (res.mustChange) toast('当前是默认密码，请先修改', 'err');
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = '登录';
    }
  });

  $('#btn-logout').addEventListener('click', async () => {
    try { await api('/api/admin/logout', { method: 'POST', csrf: true }); } catch (e) { /* ignore */ }
    state.overview = null;
    showLogin();
    toast('已退出', 'ok');
  });
}

/* -------------------------------- 启动 ----------------------------------- */

async function boot() {
  initTheme();
  try {
    bindEvents();
  } catch (err) {
    const boot = $('#boot-card');
    if (boot) boot.innerHTML = `<h1>页面初始化失败</h1><p>${esc(err.message || err)}</p>`;
    return;
  }
  try {
    const me = await api('/api/admin/me');
    state.account = { username: me.username, mustChange: !!me.mustChange };
    showDash();
    await switchTab('overview');
    renderBanner();
  } catch (e) {
    // 未登录 / 会话过期：api() 内部已切到登录页
    showLogin();
  }
}

boot().catch((err) => {
  const boot = $('#boot-card');
  if (boot) boot.innerHTML = `<h1>页面加载出错</h1><p>${esc(err.message || err)}</p>`;
});
