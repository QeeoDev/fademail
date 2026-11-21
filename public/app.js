/* FadeMail · 前端逻辑 */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* 出错时给用户一个可见提示，而不是留白屏 */
function showBootError() {
  const bar = document.getElementById('boot-error');
  if (bar) bar.hidden = false;
}
window.addEventListener('error', (e) => {
  console.error('[app] runtime error', e.message, e.filename, e.lineno);
  showBootError();
});

const LS = {
  saved: 'fm.saved',
  active: 'fm.active',
  theme: 'fm.theme',
  notify: 'fm.notify',
  auto: 'fm.auto',
  images: 'fm.images',
  domain: 'fm.domain',
  collapsed: 'fm.collapsed',
};
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const MAX_SAVED = 30;

const state = {
  config: null,
  mailbox: null,
  messages: [],
  summary: {},
  activeId: null,
  openId: null,
  openMsg: null,
  openToken: 0,
  filter: 'all',
  query: '',
  sig: '',
  notify: false,
  autoRefresh: true,
  showImages: false,
  textMode: false,
  polling: false,
  listScroll: 0,
  tick: 0,
  connected: true,
  keyBlocked: false,
  confirmResolve: null,
};

/* -------------------------------- 基础工具 -------------------------------- */

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function randomLocal(n = 10) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

function fmtTime(sec) {
  const d = new Date(sec * 1000);
  const now = new Date();
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return hm;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function dayKey(sec) {
  const d = new Date(sec * 1000);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((today - target) / 86400000);
  if (diff <= 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff < 7) return `${diff} 天前`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtLeft(ms) {
  if (ms <= 0) return '已过期';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d} 天 ${h} 小时`;
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
  return `${pad(m)}:${pad(sec)}`;
}

function fmtSize(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDate(sec) {
  return new Date(sec * 1000).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`.trim();
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .28s, transform .28s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 300);
  }, 2800);
}

/**
 * 统一请求封装。
 * 邮箱访问密钥（accessKey）通过 x-mailbox-key 头携带，服务端据此判断是否有权读信；
 * timeout 保证请求不会无限挂着。
 */
async function api(path, { method = 'GET', body, timeout = 15000, key } = {}) {
  // 老内核没有 AbortController：只是失去"超时中止"能力，请求本身照常工作
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
  const secret = key === undefined ? ((state.mailbox && state.mailbox.accessKey) || '') : key;
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (secret) headers['x-mailbox-key'] = secret;
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl ? ctrl.signal : undefined,
    });
  } catch (e) {
    throw Object.assign(new Error(e && e.name === 'AbortError' ? '请求超时，请稍后重试' : '网络连接失败，请检查网络'), { status: 0 });
  } finally {
    if (timer) clearTimeout(timer);
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* 非 JSON 响应 */ }
  // 门禁 Cookie 失效：刷新让 Worker 直接展示输入密码页
  if (res.headers.get('x-fm-code') === 'gate-required') {
    location.reload();
    throw Object.assign(new Error('需要先通过站点门禁'), { status: 401 });
  }
  if (!res.ok) {
    throw Object.assign(new Error(data.error || `请求失败（HTTP ${res.status}）`), { status: res.status });
  }
  return data;
}

async function copyText(text, tip = '已复制') {
  let ok = true;
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch (e) {
      ok = false;
    }
  }
  toast(ok ? tip : '复制失败，请手动选择', ok ? 'ok' : 'err');
  return ok;
}

/* --------------------------------- 存储 ---------------------------------- */

const loadSaved = () => {
  try {
    const list = JSON.parse(localStorage.getItem(LS.saved) || '[]');
    return Array.isArray(list) ? list.filter((m) => m && m.id && m.address) : [];
  } catch (e) {
    return [];
  }
};

const saveSaved = (list) => {
  try { localStorage.setItem(LS.saved, JSON.stringify(list.slice(0, MAX_SAVED))); } catch (e) { /* 隐私模式下可能失败 */ }
};

/** 读取本地保存的邮箱访问密钥 */
function savedKey(id) {
  const hit = loadSaved().find((m) => m.id === id);
  return (hit && hit.key) || '';
}

function upsertSaved(mb) {
  const list = loadSaved();
  const idx = list.findIndex((m) => m.id === mb.id);
  const item = {
    id: mb.id,
    address: mb.address,
    note: mb.note || '',
    expiresAt: mb.expiresAt,
    createdAt: mb.createdAt || Math.floor(Date.now() / 1000),
  };
  // 密钥只在创建 / 找回时下发，其他时候保留本地已有的
  const key = mb.accessKey || (idx >= 0 ? list[idx].key : '');
  if (key) item.key = key;
  // 已存在时原位更新，避免轮询把顺序刷成「当前邮箱总在第一位」
  if (idx >= 0) list[idx] = { ...list[idx], ...item };
  else list.unshift(item);
  saveSaved(list);
  renderSidebar();
}

function removeSaved(id) {
  saveSaved(loadSaved().filter((m) => m.id !== id));
  delete state.summary[id];
  renderSidebar();
}

/** 清空当前选中状态：有别的可用邮箱就切过去，否则回到首屏 */
function resetToIdle() {
  state.mailbox = null;
  state.activeId = null;
  state.messages = [];
  state.openId = null;
  state.openMsg = null;
  state.sig = '';
  state.keyBlocked = false;
  try { localStorage.removeItem(LS.active); } catch (e) { /* ignore */ }

  const next = pruneSaved().find((m) => (m.expiresAt || 0) * 1000 > Date.now());
  if (next) {
    selectMailbox(next.id);
    return;
  }
  renderTop();
  renderPanels();
}

/** 只从本机列表移除，服务端邮箱与邮件不受影响 */
function forgetActiveMailbox() {
  const id = state.activeId;
  if (!id) return toast('请先选择一个邮箱', 'err');
  removeSaved(id);
  resetToIdle();
  toast('已从列表移除，服务端邮箱不受影响', 'ok');
}

/** 清理早已过期（超过 1 天）的本地记录 */
function pruneSaved() {
  const list = loadSaved();
  const kept = list.filter((m) => (m.expiresAt || 0) * 1000 > Date.now() - 86400000);
  if (kept.length !== list.length) saveSaved(kept);
  return kept;
}

/* --------------------------------- 主题 ---------------------------------- */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#ffffff' : '#1b1c1e');
  try { localStorage.setItem(LS.theme, theme); } catch (e) { /* ignore */ }
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  if (state.openId && state.openMsg) applyFrame();
}

/* -------------------------------- 桌面通知 -------------------------------- */

function bellIcon() {
  const btn = $('#btn-bell');
  btn.innerHTML = `<svg><use href="#${state.notify ? 'i-bell' : 'i-bell-off'}"/></svg>`;
  btn.title = state.notify ? '桌面通知已开启，点击关闭' : '开启新邮件桌面通知';
  btn.style.color = state.notify ? 'var(--brand)' : '';
}

async function toggleBell() {
  if (!('Notification' in window)) return toast('当前浏览器不支持桌面通知', 'err');
  if (state.notify) {
    state.notify = false;
    localStorage.setItem(LS.notify, '0');
    bellIcon();
    return toast('已关闭桌面通知');
  }
  if (Notification.permission === 'denied') {
    return toast('通知已被浏览器拒绝，请在站点设置中允许后重试', 'err');
  }
  const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (p !== 'granted') return toast('未获得通知权限', 'err');
  state.notify = true;
  localStorage.setItem(LS.notify, '1');
  bellIcon();
  toast('桌面通知已开启', 'ok');
}

function notifyNew(list) {
  if (!state.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return;
  list.slice(0, 3).forEach((m) => {
    const n = new Notification(m.subject || '(无主题)', {
      body: `${m.fromName || m.fromAddr}\n${(m.snippet || '').slice(0, 120)}`,
      tag: m.id,
    });
    n.onclick = () => {
      window.focus();
      openMessage(m.id);
      n.close();
    };
  });
}

function siteTitle() {
  const conf = state.config || {};
  const custom = String(conf.title || '').trim();
  if (custom) return custom;
  return `${conf.brand || 'FadeMail'} · 临时邮箱`;
}

function updateTitle() {
  const unread = state.messages.filter((m) => !m.isRead).length;
  const base = siteTitle();
  document.title = unread > 0 ? `(${unread}) ${base}` : base;
}

/** 站点图标：图片 / emoji 文字 / 默认信封 SVG 三选一 */
function paintLogo(el, logo) {
  if (!el) return;
  const v = String(logo || '').trim();
  if (/^data:image\//.test(v) || /^\/[^\s"'<>]*$/.test(v)) {
    el.innerHTML = '';
    const img = document.createElement('img');
    img.src = v;
    img.alt = '';
    el.appendChild(img);
    return;
  }
  if (v) {
    el.innerHTML = '<span class="logo-char"></span>';
    const span = $('.logo-char', el);
    if (span) span.textContent = v.slice(0, 8);
    return;
  }
  el.innerHTML = '<svg><use href="#i-logo"/></svg>';
}

/** 把后台配置的站点名称 / 标题 / 图标应用到页面 */
function applyBranding() {
  const conf = state.config || {};
  const logo = String(conf.logo || '');
  const brand = String(conf.brand || 'FadeMail');
  const nameEl = $('#brand-name');
  if (nameEl) nameEl.textContent = brand;
  const brandLink = $('.brand');
  if (brandLink) brandLink.title = brand;
  paintLogo($('.brand-logo'), logo);
  paintLogo($('.hero-logo'), logo);
  updateTitle();
  if (/^data:image\//.test(logo)) {
    const icon = $('link[rel="icon"]');
    if (icon) icon.setAttribute('href', logo);
  }
  const og = $('meta[property="og:title"]');
  if (og) og.setAttribute('content', siteTitle());
}

/* -------------------------------- 侧边栏 --------------------------------- */

function renderSidebar() {
  const list = pruneSaved();
  const ul = $('#saved-list');
  $('#saved-empty').hidden = list.length > 0;
  const count = $('#saved-count');
  count.hidden = list.length === 0;
  count.textContent = list.length;

  ul.innerHTML = list.map((m) => {
    const info = state.summary[m.id];
    const expired = (m.expiresAt || 0) * 1000 <= Date.now();
    const unread = (info && info.unread) || 0;
    const [local, domain] = String(m.address).split('@');
    const status = expired ? '已过期' : `剩余 ${fmtLeft(m.expiresAt * 1000 - Date.now())}`;
    const on = m.id === state.activeId ? ' on' : '';
    // 有备注时用备注当标题，副标题显示完整地址；否则标题是前缀，副标题只显示域名
    const title = m.note || local || m.address;
    const subtitle = m.note ? `${m.address} · ${status}` : `@${domain || ''} · ${status}`;
    return `<li class="mb-item${on}" data-id="${esc(m.id)}" title="${esc(m.address)}">
      <span class="mb-ico"><svg><use href="#${unread ? 'i-mail-open' : 'i-mail'}"/></svg></span>
      <span class="mb-text">
        <span class="mb-addr">${esc(title)}</span>
        <span class="mb-sub">${esc(subtitle)}</span>
      </span>
      ${unread ? `<span class="mb-unread">${unread > 99 ? '99+' : unread}</span>` : ''}
    </li>`;
  }).join('');
}

async function refreshSummary() {
  const list = loadSaved();
  if (!list.length) {
    state.summary = {};
    renderSidebar();
    return;
  }
  try {
    const ids = list.slice(0, 40).map((m) => m.id).join(',');
    const data = await api(`/api/summary?ids=${encodeURIComponent(ids)}`);
    const map = {};
    let dirty = false;
    for (const item of data.items || []) {
      map[item.id] = item;
      // 用服务端数据校准本地缓存（到期时间 / 备注可能在其他设备改过）
      const local = list.find((m) => m.id === item.id);
      if (local && (local.expiresAt !== item.expiresAt || local.note !== item.note)) {
        local.expiresAt = item.expiresAt;
        local.note = item.note;
        dirty = true;
      }
    }
    state.summary = map;
    const stale = list.filter((m) => !map[m.id] && (m.expiresAt || 0) * 1000 <= Date.now());
    if (stale.length) dirty = true;
    if (dirty) saveSaved(list.filter((m) => !stale.some((s) => s.id === m.id)));
    renderSidebar();
  } catch (e) {
    /* 摘要失败不影响主流程 */
  }
}

function openSidebar() {
  $('#app').classList.add('sb-open');
  $('#sb-mask').hidden = false;
}
function closeSidebar() {
  $('#app').classList.remove('sb-open');
  $('#sb-mask').hidden = true;
}

/* ------------------------------- 创建邮箱表单 ------------------------------ */

/** 带「显示 / 隐藏」按钮的密码输入框，样式见 style.css 的 .pw */
function pwInput({ id = '', name = '', placeholder = '', autocomplete = 'new-password', maxlength = 64 } = {}) {
  const attrs = [
    id ? `id="${id}"` : '',
    name ? `name="${name}"` : '',
    'type="password"',
    `maxlength="${maxlength}"`,
    autocomplete ? `autocomplete="${autocomplete}"` : '',
    placeholder ? `placeholder="${esc(placeholder)}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<div class="pw">
    <input ${attrs}>
    <button type="button" class="pw-eye" tabindex="-1" aria-label="显示密码"><svg><use href="#i-eye"/></svg></button>
  </div>`;
}

function createFormHTML() {
  return `<form class="create-box" data-create autocomplete="off">
    <div class="create-row">
      <input name="local" placeholder="输入地址前缀，留空则由系统随机生成" maxlength="30" spellcheck="false" autocapitalize="off">
      <button type="button" class="icon-btn" data-dice title="随机一个前缀"><svg><use href="#i-dice"/></svg></button>
    </div>
    <div class="create-meta">
      <div class="dd" data-dd>
        <input type="hidden" name="domain" value="">
        <button type="button" class="dd-btn" aria-haspopup="listbox" aria-expanded="false">
          <span data-dd-label>@…</span>
          <svg class="dd-caret"><use href="#i-chevron"/></svg>
        </button>
        <div class="dd-menu" role="listbox" hidden></div>
      </div>
      <div class="ttl-chips" data-chips>
        <button type="button" data-ttl="1">1 小时</button>
        <button type="button" data-ttl="6">6 小时</button>
        <button type="button" data-ttl="24" class="on">24 小时</button>
        <button type="button" data-ttl="168">7 天</button>
        <button type="button" data-ttl="custom">自定义</button>
      </div>
    </div>
    <div class="create-adv" hidden>
      <div class="field">
        <label class="field-label">有效期（小时）</label>
        <input type="number" name="ttlValue" min="1" max="${(state.config && state.config.maxTtl) || 720}" value="${(state.config && state.config.defaultTtl) || 24}" inputmode="numeric">
      </div>
      <div class="field">
        <label class="field-label">备注 <em>可选</em></label>
        <input name="note" maxlength="80" placeholder="用途备注，例如：注册 ChatGPT">
      </div>
      <div class="field" style="grid-column:1/-1">
        <label class="field-label">找回密码 <em>可选</em></label>
        ${pwInput({ name: 'password', placeholder: '至少 6 位，且不能与其他邮箱重复' })}
      </div>
    </div>
    <div class="create-foot">
      <button type="button" class="link-toggle" data-adv>
        <svg><use href="#i-chevron"/></svg><span>更多选项</span>
      </button>
      <button class="btn primary" type="submit">生成邮箱</button>
    </div>
    <p class="form-error" data-error hidden></p>
  </form>`;
}

/** 域名下拉：原生 select 的弹层没法跟随主题，这里自己画一个 */
function wireDomainPicker(form) {
  const dd = $('[data-dd]', form);
  if (!dd) return;
  const input = $('input[name="domain"]', dd);
  const btn = $('.dd-btn', dd);
  const menu = $('.dd-menu', dd);
  const label = $('[data-dd-label]', dd);
  const domains = (state.config && state.config.domains) || [];

  let current = '';
  try { current = localStorage.getItem(LS.domain) || ''; } catch (e) { /* ignore */ }
  if (!domains.includes(current)) current = domains[0] || '';

  const sync = () => {
    $$('button[data-v]', menu).forEach((b) => {
      const on = b.dataset.v === current;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    input.value = current;
    label.textContent = current ? `@${current}` : '未配置域名';
    label.title = current ? `@${current}` : '';
  };

  menu.innerHTML = domains.length
    ? domains.map((d) => `<button type="button" role="option" data-v="${esc(d)}">@${esc(d)}</button>`).join('')
    : '<div class="dd-empty">后台还没有配置可用域名</div>';

  const close = () => {
    dd.classList.remove('open');
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    $$('.dd.open').forEach((other) => {
      if (other !== dd) {
        other.classList.remove('open');
        const m = $('.dd-menu', other);
        if (m) m.hidden = true;
      }
    });
    dd.classList.add('open');
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    const activeOpt = $('button[data-v].on', menu);
    if (activeOpt) activeOpt.scrollIntoView({ block: 'nearest' });
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (dd.classList.contains('open')) close();
    else open();
  });

  menu.addEventListener('click', (e) => {
    const opt = e.target.closest('button[data-v]');
    if (!opt) return;
    current = opt.dataset.v;
    try { localStorage.setItem(LS.domain, current); } catch (e) { /* ignore */ }
    sync();
    close();
  });

  dd.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      close();
      btn.focus();
    }
    if (e.key === 'ArrowDown' && !dd.classList.contains('open')) {
      e.preventDefault();
      open();
    }
  });

  sync();
}

function wireCreateForm(root) {
  const form = $('[data-create]', root);
  if (!form) return;
  wireDomainPicker(form);
  const adv = $('.create-adv', form);
  const chips = $('[data-chips]', form);
  const toggle = $('[data-adv]', form);
  const errBox = $('[data-error]', form);
  const ttlInput = $('[name="ttlValue"]', form);
  const chipBtns = $$('button[data-ttl]', chips);
  const defaultTtl = (state.config && state.config.defaultTtl) || 24;

  /** 芯片和输入框是同一个值：选中的小时数要回填到输入框，两处永远一致 */
  const applyTtl = (hours) => {
    const h = String(hours);
    const target = chipBtns.find((b) => b.dataset.ttl === h)
      || chipBtns.find((b) => b.dataset.ttl === 'custom');
    chipBtns.forEach((b) => b.classList.toggle('on', b === target));
    form.dataset.ttl = target ? target.dataset.ttl : h;
    ttlInput.value = h;
  };
  applyTtl(defaultTtl);

  toggle.addEventListener('click', () => {
    adv.hidden = !adv.hidden;
    toggle.classList.toggle('open', !adv.hidden);
    if (!adv.hidden && form.dataset.ttl === 'custom') ttlInput.focus();
  });

  $('[data-dice]', form).addEventListener('click', () => {
    $('[name="local"]', form).value = randomLocal(10);
  });

  chips.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-ttl]');
    if (!btn) return;
    if (btn.dataset.ttl !== 'custom') return applyTtl(btn.dataset.ttl);
    chipBtns.forEach((b) => b.classList.toggle('on', b === btn));
    form.dataset.ttl = 'custom';
    adv.hidden = false;
    toggle.classList.add('open');
    ttlInput.focus();
    try { ttlInput.select(); } catch (e) { /* number 输入框可能不支持全选 */ }
  });

  // 手动填了小时数就自动切到「自定义」，同时清掉预设芯片的高亮
  ttlInput.addEventListener('input', () => {
    form.dataset.ttl = 'custom';
    chipBtns.forEach((b) => b.classList.toggle('on', b.dataset.ttl === 'custom'));
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.hidden = true;
    const btn = $('[type="submit"]', form);
    const ttlRaw = form.dataset.ttl;
    const ttl = ttlRaw === 'custom'
      ? parseInt(ttlInput.value, 10) || defaultTtl
      : parseInt(ttlRaw, 10) || defaultTtl;
    if (ttl < 1) return (errBox.textContent = '有效期至少 1 小时', (errBox.hidden = false));

    const origin = btn.textContent;
    btn.disabled = true;
    btn.textContent = '生成中…';
    try {
      const { mailbox } = await api('/api/mailboxes', {
        method: 'POST',
        body: {
          local: $('[name="local"]', form).value.trim().toLowerCase() || undefined,
          domain: $('[name="domain"]', form).value || undefined,
          ttlHours: ttl,
          note: $('[name="note"]', form).value.trim() || undefined,
          password: $('[name="password"]', form).value || undefined,
        },
      });
      closeModal();
      adoptMailbox(mailbox);
      copyText(mailbox.address, '邮箱已生成，地址已复制');
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = origin;
    }
  });
}

function mountHeroForm() {
  const slot = $('#create-slot');
  if (!slot || slot.dataset.ready === '1') return;
  slot.innerHTML = createFormHTML();
  wireCreateForm(slot);
  slot.dataset.ready = '1';
}

/* -------------------------------- 顶栏渲染 -------------------------------- */

function renderTop() {
  const mb = state.mailbox;
  $('#addr-box').hidden = !mb;
  $('#btn-more').hidden = !mb;
  // 没有邮箱时刷新 / 通知没有意义，收起来让首屏更干净
  $('#btn-refresh').hidden = !mb;
  $('#btn-bell').hidden = !mb;
  if (!mb) return;
  $('#addr-text').textContent = mb.address || '—';
  updateClock();
}

function updateClock() {
  const mb = state.mailbox;
  if (!mb) return;
  const left = (mb.expiresAt || 0) * 1000 - Date.now();
  const pill = $('#state-pill');
  const time = $('#left-time');
  if (left <= 0) {
    pill.className = 'state-pill dead';
    pill.innerHTML = '<i></i>已过期';
    time.textContent = '邮件已清理';
    return;
  }
  pill.className = `state-pill${left < 3600 * 1000 ? ' warn' : ''}`;
  pill.innerHTML = '<i></i>生效中';
  time.textContent = `剩余 ${fmtLeft(left)}`;
}

function setConnected(ok) {
  state.connected = ok;
  const dot = $('#status-dot');
  if (dot) dot.classList.toggle('off', !ok);
  const label = $('#sb-status');
  if (label) label.textContent = ok ? '已连接' : '连接异常';
}

/* -------------------------------- 面板切换 -------------------------------- */

function renderPanels() {
  renderTop();
  const hasMailbox = !!state.mailbox;
  $('#hero').hidden = hasMailbox;
  $('#reader').hidden = !state.openId;
  $('#inbox').hidden = !hasMailbox || !!state.openId;

  if (!hasMailbox) {
    mountHeroForm();
    return;
  }
  if (state.openId) {
    renderReader();
  } else {
    renderList();
  }
}

/* -------------------------------- 邮件列表 -------------------------------- */

function emptyHTML(kind) {
  const mb = state.mailbox;
  if (kind === 'search') {
    return `<div class="empty">
      <div class="empty-art"><svg><use href="#i-search"/></svg></div>
      <h3>没有匹配的邮件</h3>
      <p>换个关键词试试，或清除搜索条件。</p>
    </div>`;
  }
  if (kind === 'unread') {
    return `<div class="empty">
      <div class="empty-art"><svg><use href="#i-mail-open"/></svg></div>
      <h3>没有未读邮件</h3>
      <p>当前收件箱里的邮件都读过了。</p>
    </div>`;
  }
  return `<div class="empty">
    <div class="empty-art"><svg><use href="#i-inbox"/></svg></div>
    <h3>等待第一封邮件</h3>
    <p>将下面的地址填入需要验证的网站，新邮件会自动显示在这里。</p>
    <div class="empty-addr"><code>${esc((mb && mb.address) || '')}</code></div>
    <button class="btn outline sm" data-act="copy-addr" style="margin-top:12px">复制邮箱地址</button>
  </div>`;
}

function highlight(text, q) {
  const safe = esc(text);
  if (!q) return safe;
  try {
    return safe.replace(new RegExp(`(${reEsc(esc(q))})`, 'gi'), '<mark>$1</mark>');
  } catch (e) {
    return safe;
  }
}

function filteredMessages() {
  const q = state.query.trim().toLowerCase();
  let list = state.messages;
  if (state.filter === 'unread') list = list.filter((m) => !m.isRead);
  if (q) {
    list = list.filter((m) =>
      `${m.fromName || ''} ${m.fromAddr || ''} ${m.subject || ''} ${m.snippet || ''}`.toLowerCase().includes(q));
  }
  return list;
}

function renderList({ keepScroll = true } = {}) {
  const box = $('#mail-list');
  const content = $('#content');
  const scroll = keepScroll ? content.scrollTop : 0;
  const all = state.messages;
  const unread = all.filter((m) => !m.isRead).length;

  $('#list-count').textContent = all.length ? `共 ${all.length} 封` : '';
  const tabNum = $('#tab-unread');
  tabNum.hidden = unread === 0;
  tabNum.textContent = unread > 99 ? '99+' : unread;

  const list = filteredMessages();
  if (!list.length) {
    box.innerHTML = emptyHTML(state.query.trim() ? 'search' : state.filter === 'unread' ? 'unread' : 'empty');
  } else {
    const groups = new Map();
    for (const m of list) {
      const key = dayKey(m.receivedAt);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    box.innerHTML = [...groups.entries()].map(([label, items]) => `
      <div class="day-label">${esc(label)}</div>
      ${items.map(mailRowHTML).join('')}
    `).join('');
  }

  if (keepScroll) content.scrollTop = scroll;
  updateTitle();
}

function mailRowHTML(m) {
  const q = state.query.trim();
  const initial = (m.fromName || m.fromAddr || '?').trim().charAt(0) || '?';
  const badges = [];
  if (m.code) badges.push(`<span class="mini-badge code">${esc(m.code)}</span>`);
  if (m.attachCount) badges.push(`<span class="mini-badge"><svg><use href="#i-clip"/></svg>${m.attachCount}</span>`);
  return `<article class="mail-row${m.isRead ? '' : ' unread'}${m.id === state.openId ? ' active' : ''}" data-id="${esc(m.id)}">
    <div class="mail-avatar">${esc(initial)}</div>
    <div class="mail-body">
      <div class="mail-line1">
        <span class="mail-from">${highlight(m.fromName || m.fromAddr || '未知发件人', q)}</span>
        <span class="mail-time">${fmtTime(m.receivedAt)}</span>
      </div>
      <div class="mail-subject">${highlight(m.subject || '(无主题)', q)}</div>
      <div class="mail-snippet">${highlight(m.snippet || '(无正文)', q)}</div>
    </div>
    ${badges.length ? `<div class="mail-badges">${badges.join('')}</div>` : ''}
  </article>`;
}

/* -------------------------------- 邮箱切换 -------------------------------- */

function adoptMailbox(mb) {
  // 选中已有邮箱时接口不会回传密钥，这里从本地补齐
  state.mailbox = { ...mb, accessKey: mb.accessKey || savedKey(mb.id) };
  state.activeId = mb.id;
  state.messages = [];
  state.openId = null;
  state.openMsg = null;
  state.sig = '';
  state.listScroll = 0;
  state.keyBlocked = false;
  // 上一个邮箱的请求可能还在路上，放开锁让新邮箱立刻拉取（旧请求回来会因 id 不匹配被丢弃）
  state.polling = false;
  state.query = '';
  state.filter = 'all';
  const input = $('#search-input');
  if (input) input.value = '';
  $('#search-clear').hidden = true;
  $$('.tab').forEach((t) => t.classList.toggle('on', t.dataset.filter === 'all'));
  try { localStorage.setItem(LS.active, mb.id); } catch (e) { /* ignore */ }
  upsertSaved(mb);
  $('#content').scrollTop = 0;
  renderTop();
  renderPanels();
  poll(true);
}

async function selectMailbox(id) {
  if (!id) return;
  if (state.activeId === id) {
    closeReader();
    renderPanels();
    return;
  }
  try {
    const { mailbox } = await api(`/api/mailboxes/${encodeURIComponent(id)}`, { key: savedKey(id) });
    adoptMailbox(mailbox);
    closeSidebar();
  } catch (err) {
    if (err.status === 403) return promptAccessKey();
    removeSaved(id);
    toast(err.message, 'err');
    // 邮箱在服务端已经没了（销毁 / 数据清理）：无论之前有没有选中它，都要退回可用状态，
    // 否则首屏和收件箱都不显示，页面会变成一片空白。
    if (!state.mailbox || state.mailbox.id === id) resetToIdle();
  }
}

/* -------------------------------- 轮询收信 -------------------------------- */

async function poll(force = false) {
  const mb = state.mailbox;
  if (!mb || state.polling || state.keyBlocked) return;
  const expired = (mb.expiresAt || 0) * 1000 <= Date.now();
  if (expired && !force) return;

  state.polling = true;
  const id = mb.id;
  try {
    const data = await api(`/api/mailboxes/${encodeURIComponent(id)}/messages?limit=100`);
    if (!state.mailbox || state.mailbox.id !== id) return;

    const known = new Set(state.messages.map((m) => m.id));
    const fresh = (data.messages || []).filter((m) => !known.has(m.id));
    state.messages = data.messages || [];
    state.mailbox = { ...state.mailbox, ...data.mailbox };
    state.summary[id] = {
      id,
      unread: data.unread || 0,
      total: data.total || state.messages.length,
      expiresAt: state.mailbox.expiresAt,
      address: state.mailbox.address,
    };
    upsertSaved(state.mailbox);

    const sig = `${state.messages.map((m) => `${m.id}:${m.isRead ? 1 : 0}`).join('|')}#${state.messages.length}`;
    if (sig !== state.sig) {
      state.sig = sig;
      if (!state.openId) renderList();
      else updateTitle();
      renderSidebar();
    }
    renderTop();
    if (fresh.length) notifyNew(fresh);
    setConnected(true);
  } catch (err) {
    if (err.status === 403) {
      state.keyBlocked = true;
      renderList();
      promptAccessKey();
      return;
    }
    if (err.status === 410 || err.status === 404) {
      if (state.mailbox && state.mailbox.id === id) {
        state.mailbox.expiresAt = Math.min(state.mailbox.expiresAt || 0, Math.floor(Date.now() / 1000));
        renderTop();
        if (err.status === 404) {
          removeSaved(id);
          state.mailbox = null;
          state.activeId = null;
          state.messages = [];
          state.openId = null;
          renderTop();
          renderPanels();
          toast('该邮箱已被销毁', 'err');
        }
      }
    } else if (err.status === 0) {
      setConnected(false);
    }
  } finally {
    state.polling = false;
  }
}

/* -------------------------------- 邮件阅读 ------------------------------- */

function frameSrc(msg) {
  const theme = document.documentElement.dataset.theme;
  const key = (state.mailbox && state.mailbox.accessKey) || '';
  const q = `theme=${theme}&img=${state.showImages ? 1 : 0}`;
  return `/api/messages/${encodeURIComponent(msg.id)}/html?${q}${key ? `&k=${encodeURIComponent(key)}` : ''}`;
}

/** 没有访问密钥时的引导：找回密码 or 重新创建 */
async function promptAccessKey() {
  const go = await confirmDialog({
    title: '这个邮箱受访问保护',
    message: '当前浏览器没有它的访问密钥，无法读取邮件。可用创建时设置的「找回密码」恢复访问，或重新生成一个临时邮箱。',
    confirmText: '密码找回',
  });
  if (go) openRecover();
}

function textDoc(msg) {
  const dark = document.documentElement.dataset.theme === 'dark';
  const body = esc(msg.text || '(这封邮件没有纯文本内容)');
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:20px;font:14px/1.75 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
    color:${dark ? '#e6e8ea' : '#1a1d21'};background:${dark ? '#1b1c1e' : '#fff'};word-break:break-word}
    pre{white-space:pre-wrap;word-break:break-word;font:inherit;margin:0}
  </style><pre>${body}</pre>`;
}

function applyFrame() {
  const msg = state.openMsg;
  const frame = $('#v-frame');
  if (!msg || !frame) return;
  if (state.textMode) {
    frame.removeAttribute('src');
    frame.srcdoc = textDoc(msg);
  } else {
    frame.removeAttribute('srcdoc');
    frame.src = frameSrc(msg);
  }
}

async function openMessage(id) {
  const token = ++state.openToken;
  state.listScroll = $('#content').scrollTop;

  // 先在本地标记已读，列表状态立即可见
  const local = state.messages.find((m) => m.id === id);
  if (local) local.isRead = true;
  state.openId = id;
  state.openMsg = null;
  state.textMode = false;
  renderPanels();
  $('#content').scrollTop = 0;
  $('#reader').innerHTML = `<div class="reader-inner"><div class="empty"><p>正在加载邮件…</p></div></div>`;

  try {
    const { message } = await api(`/api/messages/${encodeURIComponent(id)}`);
    if (token !== state.openToken) return;
    state.openMsg = message;
    renderReader();
    renderSidebar();
    refreshSummary();
  } catch (err) {
    if (token !== state.openToken) return;
    if (err.status === 403) {
      state.keyBlocked = true;
      closeReader();
      return promptAccessKey();
    }
    $('#reader').innerHTML = `<div class="reader-inner">
      <div class="reader-bar"><button class="icon-btn" id="v-back" title="返回"><svg><use href="#i-back"/></svg></button></div>
      <div class="empty">
        <div class="empty-art"><svg><use href="#i-close"/></svg></div>
        <h3>打开失败</h3><p>${esc(err.message)}</p>
      </div></div>`;
    $('#v-back').addEventListener('click', closeReader);
  }
}

function closeReader() {
  state.openToken++;
  state.openId = null;
  state.openMsg = null;
  state.textMode = false;
  const reader = $('#reader');
  if (reader) reader.innerHTML = '';
  renderPanels();
  $('#content').scrollTop = state.listScroll;
}

function renderReader() {
  const msg = state.openMsg;
  const box = $('#reader');
  if (!msg) return;
  const atts = msg.attachments || [];
  const headers = msg.headers || [];

  box.innerHTML = `<div class="reader-inner">
    <div class="reader-bar">
      <button class="icon-btn" id="v-back" title="返回列表（Esc）"><svg><use href="#i-back"/></svg></button>
      <span class="meta">${fmtTime(msg.receivedAt)} · ${fmtSize(msg.size)}</span>
      <span class="spacer"></span>
      <button class="icon-btn" id="v-unread" title="标为未读"><svg><use href="#i-unread"/></svg></button>
      <button class="icon-btn danger" id="v-del" title="删除邮件"><svg><use href="#i-trash"/></svg></button>
    </div>

    <h1 class="reader-subject">${esc(msg.subject || '(无主题)')}</h1>

    <div class="reader-from">
      <div class="mail-avatar">${esc((msg.fromName || msg.fromAddr || '?').trim().charAt(0) || '?')}</div>
      <div class="who">
        <div class="name">${esc(msg.fromName || msg.fromAddr)}</div>
        <div class="mail">${esc(msg.fromAddr)}</div>
      </div>
      <div class="to">发给 ${esc(msg.toAddr || '')}</div>
    </div>

    ${msg.code ? `<div class="code-box">
      <span>识别到验证码</span><code id="v-code">${esc(msg.code)}</code>
      <button id="v-copy-code">复制</button>
    </div>` : ''}

    <div class="reader-tools">
      ${msg.hasHtml ? `<button class="tool-btn" id="v-mode"><svg><use href="#i-code"/></svg><span>纯文本</span></button>` : ''}
      ${msg.hasHtml ? `<button class="tool-btn${state.showImages ? ' on' : ''}" id="v-img"><svg><use href="#i-eye"/></svg><span>${state.showImages ? '隐藏图片' : '显示图片'}</span></button>` : ''}
      <button class="tool-btn" id="v-headers"><svg><use href="#i-mail"/></svg><span>邮件头</span></button>
      <a class="tool-btn" href="${frameSrc(msg)}" target="_blank" rel="noopener noreferrer"><svg><use href="#i-external"/></svg><span>新窗口</span></a>
    </div>

    <div class="frame-wrap"><iframe id="v-frame" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" title="邮件正文"></iframe></div>

    <p class="reader-safety">
      <svg><use href="#i-shield"/></svg>
      正文在沙箱中渲染，脚本已禁用${state.showImages ? '' : '，远程图片已拦截'}；附件一律以下载方式提供
    </p>

    ${atts.length ? `<div class="attachments">${atts.map((a) => `
      <a class="att" href="/api/attachments/${esc(a.id)}${state.mailbox && state.mailbox.accessKey ? `?k=${encodeURIComponent(state.mailbox.accessKey)}` : ''}" download="${esc(a.filename)}">
        <svg><use href="#i-download"/></svg>
        <span>${esc(a.filename)}</span>
        <small>${a.truncated ? '未保存' : fmtSize(a.size)}</small>
      </a>`).join('')}</div>` : ''}

    ${headers.length ? `<div class="headers-box" id="v-headers-box" hidden>
      ${headers.map((h) => `<div><b>${esc(h.k)}</b>: ${esc(h.v)}</div>`).join('')}
    </div>` : ''}
  </div>`;

  applyFrame();

  $('#v-back').addEventListener('click', closeReader);

  $('#v-del').addEventListener('click', async () => {
    const yes = await confirmDialog({
      title: '删除这封邮件',
      message: `「${esc(msg.subject || '(无主题)')}」将被永久删除，无法恢复。`,
      confirmText: '删除',
      danger: true,
    });
    if (!yes) return;
    try {
      await api(`/api/messages/${encodeURIComponent(msg.id)}`, { method: 'DELETE' });
      state.messages = state.messages.filter((m) => m.id !== msg.id);
      state.sig = '';
      closeReader();
      toast('邮件已删除', 'ok');
      refreshSummary();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $('#v-unread').addEventListener('click', async () => {
    try {
      await api(`/api/messages/${encodeURIComponent(msg.id)}`, { method: 'PATCH', body: { isRead: false } });
      const item = state.messages.find((m) => m.id === msg.id);
      if (item) item.isRead = false;
      state.sig = '';
      closeReader();
      toast('已标为未读', 'ok');
      refreshSummary();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  const vCopyCode = $('#v-copy-code');
  if (vCopyCode) vCopyCode.addEventListener('click', () => copyText(msg.code, '验证码已复制'));

  const vImgBtn = $('#v-img');
  if (vImgBtn) vImgBtn.addEventListener('click', (e) => {
    state.showImages = !state.showImages;
    localStorage.setItem(LS.images, state.showImages ? '1' : '0');
    e.currentTarget.classList.toggle('on', state.showImages);
    $('span', e.currentTarget).textContent = state.showImages ? '隐藏图片' : '显示图片';
    // 切回 HTML 视图，同时把「纯文本」按钮状态复位
    state.textMode = false;
    const modeBtn = $('#v-mode');
    if (modeBtn) {
      modeBtn.classList.remove('on');
      $('span', modeBtn).textContent = '纯文本';
    }
    applyFrame();
  });

  const vModeBtn = $('#v-mode');
  if (vModeBtn) vModeBtn.addEventListener('click', (e) => {
    state.textMode = !state.textMode;
    e.currentTarget.classList.toggle('on', state.textMode);
    $('span', e.currentTarget).textContent = state.textMode ? 'HTML' : '纯文本';
    applyFrame();
  });

  const vHeadersBtn = $('#v-headers');
  if (vHeadersBtn) vHeadersBtn.addEventListener('click', (e) => {
    const el = $('#v-headers-box');
    if (!el) return toast('这封邮件没有可显示的头部信息');
    el.hidden = !el.hidden;
    e.currentTarget.classList.toggle('on', !el.hidden);
  });
}

/* ------------------------------- 邮箱操作 -------------------------------- */

async function copyAddress() {
  if (!state.mailbox) return toast('请先生成邮箱', 'err');
  const btn = $('#addr-btn');
  const ok = await copyText(state.mailbox.address, '邮箱地址已复制');
  if (ok && btn) {
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1400);
  }
}

async function readAll() {
  if (!state.mailbox) return;
  try {
    await api(`/api/mailboxes/${encodeURIComponent(state.mailbox.id)}/read-all`, { method: 'POST' });
    state.messages.forEach((m) => { m.isRead = true; });
    state.sig = '';
    renderList();
    if (state.openMsg) state.openMsg.isRead = true;
    toast('已全部标为已读', 'ok');
    poll(true);
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function clearInbox() {
  if (!state.mailbox) return;
  const yes = await confirmDialog({
    title: '清空收件箱',
    message: `将删除该邮箱内的全部 <b>${state.messages.length}</b> 封邮件，邮箱本身保留。此操作不可撤销。`,
    confirmText: '清空',
    danger: true,
  });
  if (!yes) return;
  try {
    const { removed } = await api(`/api/mailboxes/${encodeURIComponent(state.mailbox.id)}/messages`, { method: 'DELETE' });
    state.messages = [];
    state.sig = '';
    state.openId = null;
    state.openMsg = null;
    renderTop();
    renderPanels();
    toast(`已清空 ${removed || 0} 封邮件`, 'ok');
    refreshSummary();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function openExtend() {
  if (!state.mailbox) return;
  const maxTtl = (state.config && state.config.maxTtl) || 720;
  openModal('延长有效期', `
    <p class="form-note">当前到期时间：<b>${fmtDate(state.mailbox.expiresAt)}</b><br>
      延长后会以原到期时间（或现在，取较晚者）为起点顺延，最长不超过 ${Math.round(maxTtl / 24)} 天。</p>
    <div class="chips" id="ext-chips">
      <button data-add="1">+1 小时</button>
      <button data-add="6">+6 小时</button>
      <button data-add="24" class="on">+24 小时</button>
      <button data-add="168">+7 天</button>
    </div>
    <div class="field" style="margin-top:14px">
      <label class="field-label">自定义小时数</label>
      <input id="ext-custom" type="number" min="1" max="${maxTtl}" placeholder="例如 48" inputmode="numeric">
    </div>
    <p class="form-error" id="ext-err" hidden></p>
    <button class="btn primary block" id="ext-ok">确认延长</button>`);

  let add = 24;
  $('#ext-chips').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-add]');
    if (!b) return;
    $$('#ext-chips button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    add = parseInt(b.dataset.add, 10);
    $('#ext-custom').value = '';
  });
  $('#ext-custom').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    if (v > 0) {
      add = v;
      $$('#ext-chips button').forEach((x) => x.classList.remove('on'));
    }
  });
  $('#ext-ok').addEventListener('click', async () => {
    const btn = $('#ext-ok');
    btn.disabled = true;
    btn.textContent = '处理中…';
    try {
      const { mailbox } = await api(`/api/mailboxes/${encodeURIComponent(state.mailbox.id)}`, {
        method: 'PATCH',
        body: { ttlHours: add },
      });
      state.mailbox = { ...state.mailbox, ...mailbox };
      upsertSaved(state.mailbox);
      renderTop();
      closeModal();
      toast(`已延长 ${add} 小时`, 'ok');
      refreshSummary();
    } catch (err) {
      const e = $('#ext-err');
      e.textContent = err.message;
      e.hidden = false;
      btn.disabled = false;
      btn.textContent = '确认延长';
    }
  });
}

function openNote() {
  if (!state.mailbox) return;
  openModal('邮箱备注', `
    <p class="form-note">备注只保存在你的浏览器和这封邮箱记录里，用于区分用途。</p>
    <div class="field">
      <label class="field-label" for="note-input">备注（最多 80 字）</label>
      <input id="note-input" maxlength="80" value="${esc(state.mailbox.note || '')}" placeholder="例如：注册某论坛">
    </div>
    <button class="btn primary block" id="note-ok">保存备注</button>`);
  const input = $('#note-input');
  input.focus();
  input.select();

  const save = async () => {
    const btn = $('#note-ok');
    btn.disabled = true;
    try {
      const { mailbox } = await api(`/api/mailboxes/${encodeURIComponent(state.mailbox.id)}`, {
        method: 'PATCH',
        body: { note: input.value },
      });
      state.mailbox = { ...state.mailbox, ...mailbox };
      upsertSaved(state.mailbox);
      renderTop();
      closeModal();
      toast('备注已保存', 'ok');
      refreshSummary();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
  };
  $('#note-ok').addEventListener('click', save);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
}

function openPassword() {
  if (!state.mailbox) return;
  const has = !!state.mailbox.hasPassword;
  openModal(has ? '修改找回密码' : '设置找回密码', `
    <p class="form-note">
      设置后可凭此密码在任意设备找回该邮箱；密码只保存不可逆指纹。
      每个邮箱的找回密码必须唯一，不能与其他邮箱重复。
    </p>
    ${has ? `<div class="field">
      <label class="field-label" for="pw-current">当前密码</label>
      ${pwInput({ id: 'pw-current', placeholder: '请输入当前密码', autocomplete: 'current-password' })}
    </div>` : ''}
    <div class="field">
      <label class="field-label" for="pw-new">${has ? '新密码' : '密码'}</label>
      ${pwInput({ id: 'pw-new', placeholder: '6-64 位，不得与其他邮箱重复', autocomplete: 'new-password' })}
    </div>
    <p class="form-error" id="pw-err" hidden></p>
    <button class="btn primary block" id="pw-ok">${has ? '更新密码' : '设置密码'}</button>
    ${has ? '<button class="btn outline block" id="pw-clear" style="margin-top:8px">清除密码</button>' : ''}`);

  const submit = async (password) => {
    const btn = $('#pw-ok');
    btn.disabled = true;
    try {
      await api(`/api/mailboxes/${encodeURIComponent(state.mailbox.id)}/password`, {
        method: 'POST',
        body: { password, current: (($('#pw-current') || {}).value || undefined) },
      });
      state.mailbox = { ...state.mailbox, hasPassword: !!password };
      upsertSaved(state.mailbox);
      closeModal();
      toast(password ? '密码已更新' : '密码已清除', 'ok');
    } catch (err) {
      const e = $('#pw-err');
      e.textContent = err.message;
      e.hidden = false;
      btn.disabled = false;
    }
  };

  $('#pw-ok').addEventListener('click', () => {
    const pw = $('#pw-new').value;
    if (pw.length < 6) return toast('找回密码至少 6 位', 'err');
    submit(pw);
  });
  const pwClearBtn = $('#pw-clear');
  if (pwClearBtn) pwClearBtn.addEventListener('click', () => submit(''));
  $('#pw-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#pw-ok').click(); });
  ($('#pw-current') || $('#pw-new')).focus();
}

async function burnMailbox() {
  if (!state.mailbox) return;
  const yes = await confirmDialog({
    title: '销毁邮箱',
    message: `将永久删除 <b>${esc(state.mailbox.address)}</b> 及其全部邮件，无法恢复。确定继续？`,
    confirmText: '确认销毁',
    danger: true,
  });
  if (!yes) return;
  const id = state.mailbox.id;
  try {
    await api(`/api/mailboxes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    removeSaved(id);
    state.mailbox = null;
    state.activeId = null;
    state.messages = [];
    state.openId = null;
    state.openMsg = null;
    state.sig = '';
    try { localStorage.removeItem(LS.active); } catch (e) { /* ignore */ }
    renderTop();
    renderPanels();
    toast('邮箱已销毁', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* --------------------------------- 弹层 ---------------------------------- */

function openModal(title, html, { wide = false } = {}) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal-root .modal').classList.toggle('wide', wide);
  $('#modal-root').hidden = false;
  closeMenu();
}

function closeModal() {
  if (state.confirmResolve) {
    state.confirmResolve(false);
    state.confirmResolve = null;
  }
  $('#modal-root').hidden = true;
  $('#modal-body').innerHTML = '';
}

function confirmDialog({ title, message, confirmText = '确定', danger = false }) {
  return new Promise((resolve) => {
    openModal(title, `
      <p class="form-note">${message}</p>
      <div class="modal-actions">
        <button class="btn outline" data-close>取消</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" id="cf-ok">${esc(confirmText)}</button>
      </div>`);
    state.confirmResolve = resolve;
    $('#cf-ok').addEventListener('click', () => {
      state.confirmResolve = null;
      $('#modal-root').hidden = true;
      $('#modal-body').innerHTML = '';
      resolve(true);
    });
  });
}

function closeMenu() {
  $('#more-menu').hidden = true;
}

function toggleMenu() {
  const menu = $('#more-menu');
  menu.hidden = !menu.hidden;
}

/* ------------------------------- 找回 / 设置 ------------------------------ */

function openRecover() {
  openModal('用密码找回邮箱', `
    <p class="form-note">输入创建邮箱时设置的找回密码。服务端只保存不可逆指纹，不存储明文。</p>
    <div class="field">
      <label class="field-label" for="r-pw">找回密码</label>
      ${pwInput({ id: 'r-pw', placeholder: '请输入创建时设置的找回密码', autocomplete: 'current-password' })}
    </div>
    <button class="btn primary block" id="r-ok">查找邮箱</button>
    <div id="r-result"></div>`);

  const run = async () => {
    const pw = $('#r-pw').value;
    if (pw.length < 6) return toast('找回密码至少 6 位', 'err');
    const box = $('#r-result');
    const btn = $('#r-ok');
    box.innerHTML = '<p class="form-note">查找中…</p>';
    btn.disabled = true;
    try {
      const { mailboxes } = await api('/api/auth/recover', { method: 'POST', body: { password: pw } });
      if (!mailboxes.length) {
        box.innerHTML = '<p class="form-note">没有找到使用该密码的邮箱，或已全部过期。</p>';
        return;
      }
      box.innerHTML = `<p class="form-note">找到 ${mailboxes.length} 个邮箱：</p>
        <div class="pick-list">${mailboxes.map((m) => `
          <div class="pick-item" data-open="${esc(m.id)}" data-addr="${esc(m.address)}">
            <svg style="width:15px;height:15px;color:var(--muted)"><use href="#i-mail"/></svg>
            <span class="pi-addr">${esc(m.address)}</span>
            <span class="pi-left">${m.expiresAt * 1000 > Date.now() ? `剩余 ${fmtLeft(m.expiresAt * 1000 - Date.now())}` : '已过期'}</span>
          </div>`).join('')}</div>`;
      $$('[data-open]', box).forEach((el) => {
        el.addEventListener('click', () => {
          const mb = mailboxes.find((m) => m.id === el.dataset.open);
          closeModal();
          if (!mb) return;
          adoptMailbox(mb);
          toast('已切换到该邮箱', 'ok');
        });
      });
    } catch (err) {
      box.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
    } finally {
      btn.disabled = false;
    }
  };
  $('#r-ok').addEventListener('click', run);
  $('#r-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  $('#r-pw').focus();
}

function openSettings() {
  const theme = document.documentElement.dataset.theme;
  openModal('设置', `
    <div class="setting-row">
      <div class="st-main">
        <div class="st-title">自动刷新收件箱</div>
        <div class="st-desc">每 6 秒检查一次新邮件</div>
      </div>
      <button class="switch${state.autoRefresh ? ' on' : ''}" data-toggle="auto" aria-label="自动刷新"></button>
    </div>
    <div class="setting-row">
      <div class="st-main">
        <div class="st-title">桌面通知</div>
        <div class="st-desc">新邮件到达时弹系统通知</div>
      </div>
      <button class="switch${state.notify ? ' on' : ''}" data-toggle="notify" aria-label="桌面通知"></button>
    </div>
    <div class="setting-row">
      <div class="st-main">
        <div class="st-title">默认显示邮件图片</div>
        <div class="st-desc">关闭可防止营销邮件的追踪像素泄露 IP</div>
      </div>
      <button class="switch${state.showImages ? ' on' : ''}" data-toggle="images" aria-label="显示图片"></button>
    </div>
    <div class="setting-row">
      <div class="st-main">
        <div class="st-title">深色模式</div>
        <div class="st-desc">当前：${theme === 'dark' ? '深色' : '浅色'}</div>
      </div>
      <button class="switch${theme === 'dark' ? ' on' : ''}" data-toggle="theme" aria-label="深色模式"></button>
    </div>
    <div class="setting-row">
      <div class="st-main">
        <div class="st-title">邮箱访问保护</div>
        <div class="st-desc">${
          state.mailbox
            ? state.mailbox.accessKey
              ? '已启用：读信需要本机保存的访问密钥'
              : '旧版邮箱：未绑定访问密钥，建议重新生成'
            : '新建邮箱默认开启，密钥只存在本机浏览器'
        }</div>
      </div>
      <span class="st-badge${state.mailbox && state.mailbox.accessKey ? ' ok' : ''}">${state.mailbox && state.mailbox.accessKey ? '已保护' : '未保护'}</span>
    </div>
    <div class="setting-row">
      <div class="st-main">
        <div class="st-title">服务状态</div>
        <div class="st-desc" id="health-text">点击右侧按钮检测</div>
      </div>
      <button class="btn outline sm" id="health-check">检测</button>
    </div>
    <div class="setting-row">
      <div class="st-main">
        <div class="st-title">清理过期记录</div>
        <div class="st-desc">移除本地列表中已失效的邮箱（不影响服务端）</div>
      </div>
      <button class="btn outline sm" id="clean-local">清理</button>
    </div>
    <div class="setting-row">
      <div class="st-main">
        <div class="st-title">开源地址</div>
        <div class="st-desc">FadeMail 已在 GitHub 开源，欢迎 Star / Issue</div>
      </div>
      <a class="btn outline sm" href="https://github.com/QeeoDev/fademail" target="_blank" rel="noopener noreferrer" aria-label="在 GitHub 上查看 FadeMail（新标签页打开）">
        <svg><use href="#i-github"/></svg><span>GitHub</span>
      </a>
    </div>`);
}

/* 设置面板用事件委托，避免重复打开时叠加监听器 */
async function handleSettingsClick(e) {
  const sw = e.target.closest('[data-toggle]');
  if (sw) {
    const key = sw.dataset.toggle;
    if (key === 'auto') {
      state.autoRefresh = !state.autoRefresh;
      localStorage.setItem(LS.auto, state.autoRefresh ? '1' : '0');
      sw.classList.toggle('on', state.autoRefresh);
      toast(state.autoRefresh ? '已开启自动刷新' : '已关闭自动刷新');
    } else if (key === 'notify') {
      await toggleBell();
      sw.classList.toggle('on', state.notify);
    } else if (key === 'images') {
      state.showImages = !state.showImages;
      localStorage.setItem(LS.images, state.showImages ? '1' : '0');
      sw.classList.toggle('on', state.showImages);
      if (state.openMsg) applyFrame();
    } else if (key === 'theme') {
      toggleTheme();
      const dark = document.documentElement.dataset.theme === 'dark';
      sw.classList.toggle('on', dark);
      const stRow = sw.closest('.setting-row');
      const desc = stRow ? stRow.querySelector('.st-desc') : null;
      if (desc) desc.textContent = `当前：${dark ? '深色' : '浅色'}`;
    }
    return;
  }

  if (e.target.closest('#health-check')) {
    const btn = $('#health-check');
    btn.disabled = true;
    btn.textContent = '检测中…';
    try {
      const h = await api('/api/health');
      $('#health-text').textContent = `数据库 ${h.db} · 活跃邮箱 ${h.mailboxes} · ${h.latencyMs}ms`;
    } catch (err) {
      $('#health-text').textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = '检测';
    }
    return;
  }

  if (e.target.closest('#clean-local')) {
    const list = loadSaved();
    const kept = list.filter((m) => (m.expiresAt || 0) * 1000 > Date.now() || m.id === state.activeId);
    saveSaved(kept);
    renderSidebar();
    const btn = $('#clean-local');
    btn.textContent = '已清理';
    btn.disabled = true;
    toast(`已移除 ${list.length - kept.length} 条记录`, 'ok');
  }
}

/* ------------------------------- API 文档 -------------------------------- */

function openApiDocs() {
  const origin = location.origin;
  const cfg = state.config || {};
  const domain = (cfg.domains && cfg.domains[0]) || 'example.com';
  openModal('开放 API', `
    <div class="md">
      <p>基于 REST，返回 JSON。带 <code>/v1</code> 的接口需要 API Key；其余为前端自用接口。</p>
      <h4>鉴权</h4>
      <pre>Authorization: Bearer fm_xxxxxxxx
# 或
X-API-Key: fm_xxxxxxxx</pre>
      <h4>接口</h4>
      <div class="endpoint"><span class="method get">GET</span><code>/api/v1/domains</code><em>可用域名</em></div>
      <div class="endpoint"><span class="method post">POST</span><code>/api/v1/mailboxes</code><em>创建邮箱</em></div>
      <div class="endpoint"><span class="method get">GET</span><code>/api/v1/mailboxes/{address}</code><em>查询邮箱</em></div>
      <div class="endpoint"><span class="method get">GET</span><code>/api/v1/mailboxes/{address}/messages</code><em>邮件列表</em></div>
      <div class="endpoint"><span class="method get">GET</span><code>/api/v1/messages/{id}</code><em>邮件详情</em></div>
      <div class="endpoint"><span class="method del">DELETE</span><code>/api/v1/mailboxes/{address}</code><em>销毁邮箱</em></div>

      <h4>创建邮箱</h4>
      <pre>curl -X POST ${origin}/api/v1/mailboxes \\
  -H "Authorization: Bearer fm_xxx" \\
  -H "content-type: application/json" \\
  -d '{"local":"demo","domain":"${esc(domain)}","ttlHours":24,"note":"测试"}'</pre>

      <h4>拉取邮件</h4>
      <pre>curl "${origin}/api/v1/mailboxes/demo@${esc(domain)}/messages?since=0" \\
  -H "Authorization: Bearer fm_xxx"</pre>

      <h4>申请 API Key</h4>
      <p>API Key 由站点管理员单独发放，请私下联系管理员获取，不要在公共频道贴出。</p>
    </div>`, { wide: true });
}

/* -------------------------------- 事件绑定 ------------------------------- */

function bindEvents() {
  // 侧边栏
  $('#btn-new').addEventListener('click', () => {
    if (!state.mailbox && !$('#hero').hidden) {
      const input = $('#create-slot [name="local"]');
      if (input) input.focus();
      $('#content').scrollTop = 0;
      return;
    }
    openModal('新建临时邮箱', createFormHTML());
    wireCreateForm($('#modal-body'));
    const modalLocal = $('#modal-body [name="local"]');
    if (modalLocal) modalLocal.focus();
  });

  $('#btn-collapse').addEventListener('click', () => {
    const app = $('#app');
    app.classList.toggle('collapsed');
    localStorage.setItem(LS.collapsed, app.classList.contains('collapsed') ? '1' : '0');
  });

  $('#btn-expand').addEventListener('click', () => {
    $('#app').classList.remove('collapsed');
    localStorage.setItem(LS.collapsed, '0');
  });
  $('#btn-menu').addEventListener('click', openSidebar);
  $('#sb-mask').addEventListener('click', closeSidebar);

  $('#saved-list').addEventListener('click', (e) => {
    const li = e.target.closest('[data-id]');
    if (li) selectMailbox(li.dataset.id);
  });

  // 顶栏
  $('#addr-btn').addEventListener('click', copyAddress);
  $('#btn-refresh').addEventListener('click', async () => {
    if (!state.mailbox) return toast('请先生成邮箱', 'err');
    await poll(true);
    if (state.connected) toast('已刷新', 'ok');
  });
  $('#btn-bell').addEventListener('click', toggleBell);
  $('#btn-more').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu();
  });
  $('#more-menu').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    closeMenu();
    const act = btn.dataset.act;
    if (act === 'extend') openExtend();
    else if (act === 'note') openNote();
    else if (act === 'password') openPassword();
    else if (act === 'read-all') readAll();
    else if (act === 'clear') clearInbox();
    else if (act === 'forget') forgetActiveMailbox();
    else if (act === 'burn') burnMailbox();
  });
  document.addEventListener('click', (e) => {
    const eye = e.target.closest('.pw-eye');
    if (eye) {
      const input = eye.parentElement.querySelector('input');
      if (input) {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        eye.classList.toggle('on', show);
        const useEl = $('use', eye);
        if (useEl) useEl.setAttribute('href', show ? '#i-eye-off' : '#i-eye');
        eye.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
      }
      return;
    }
    if (!$('#more-menu').hidden && !e.target.closest('#more-menu') && !e.target.closest('#btn-more')) closeMenu();
    // 点空白处收起域名下拉
    $$('.dd.open').forEach((dd) => {
      if (dd.contains(e.target)) return;
      dd.classList.remove('open');
      const menu = $('.dd-menu', dd);
      if (menu) menu.hidden = true;
      const ddBtn = $('.dd-btn', dd);
      if (ddBtn) ddBtn.setAttribute('aria-expanded', 'false');
    });
  });

  // 内容区
  $('#mail-list').addEventListener('click', (e) => {
    const copyBtn = e.target.closest('[data-act="copy-addr"]');
    if (copyBtn) return copyAddress();
    const row = e.target.closest('.mail-row[data-id]');
    if (row) openMessage(row.dataset.id);
  });

  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn) {
      state.filter = btn.dataset.filter;
      $$('.tab').forEach((t) => t.classList.toggle('on', t === btn));
      renderList({ keepScroll: false });
      return;
    }
    const act = e.target.closest('[data-act]');
    if (act && act.dataset.act === 'read-all') readAll();
  });

  const search = $('#search-input');
  search.addEventListener('input', () => {
    state.query = search.value;
    $('#search-clear').hidden = !search.value;
    renderList({ keepScroll: false });
  });
  $('#search-clear').addEventListener('click', () => {
    search.value = '';
    state.query = '';
    $('#search-clear').hidden = true;
    renderList({ keepScroll: false });
    search.focus();
  });

  // 侧边栏底部
  $$('.sb-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      closeSidebar();
      if (act === 'recover') openRecover();
      else if (act === 'api') openApiDocs();
      else if (act === 'settings') openSettings();
    });
  });

  $('#btn-theme').addEventListener('click', toggleTheme);

  // 弹层
  $('#modal-root').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeModal();
  });
  $('#modal-body').addEventListener('click', (e) => {
    if (!e.target.closest('[data-toggle]') && !e.target.closest('#health-check') && !e.target.closest('#clean-local')) return;
    handleSettingsClick(e);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#modal-root').hidden) return closeModal();
      if (!$('#more-menu').hidden) return closeMenu();
      if ($('#app').classList.contains('sb-open')) return closeSidebar();
      if (state.openId) return closeReader();
      return;
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') {
      if (!state.mailbox || state.openId) return;
      e.preventDefault();
      $('#search-input').focus();
    } else if (e.key === 'r' || e.key === 'R') {
      if (state.mailbox) { e.preventDefault(); poll(true); }
    } else if (e.key === 'c' || e.key === 'C') {
      if (state.mailbox) { e.preventDefault(); copyAddress(); }
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      poll(true);
      refreshSummary();
    }
  });

  window.addEventListener('online', () => { setConnected(true); poll(true); });
  window.addEventListener('offline', () => setConnected(false));
}

/* --------------------------------- 初始化 -------------------------------- */

async function init() {
  const savedTheme = localStorage.getItem(LS.theme);
  applyTheme(savedTheme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  state.notify = localStorage.getItem(LS.notify) === '1'
    && 'Notification' in window && Notification.permission === 'granted';
  state.autoRefresh = localStorage.getItem(LS.auto) !== '0';
  state.showImages = localStorage.getItem(LS.images) === '1';
  if (localStorage.getItem(LS.collapsed) === '1' && window.innerWidth > 860) {
    $('#app').classList.add('collapsed');
  }
  bellIcon();
  // 旧缓存 HTML 可能缺少新元素，绑定失败也不能让整页停摆
  try {
    bindEvents();
  } catch (err) {
    console.error('[app] bindEvents failed', err);
    showBootError();
  }

  try {
    state.config = await api('/api/config');
    setConnected(true);
  } catch (err) {
    setConnected(false);
    toast('无法连接服务端：' + err.message, 'err');
    state.config = { domains: [], ttls: [1, 6, 24, 168], defaultTtl: 24, maxTtl: 720 };
  }
  applyBranding();

  const notice = $('#hero-notice');
  if (notice) {
    const text = String((state.config && state.config.notice) || '').trim();
    notice.textContent = text;
    notice.hidden = !text;
  }

  renderSidebar();
  mountHeroForm();

  const saved = pruneSaved();
  const lastId = localStorage.getItem(LS.active);
  const target = saved.find((m) => m.id === lastId) || saved[0];
  if (target) {
    try {
      const { mailbox } = await api(`/api/mailboxes/${encodeURIComponent(target.id)}`, {
        key: target.key || '',
      });
      adoptMailbox(mailbox);
    } catch (err) {
      // 只有确认邮箱不存在才清掉本地记录；缺密钥的保留，让用户走密码找回
      if (err.status !== 403) removeSaved(target.id);
      renderPanels();
    }
  } else {
    renderPanels();
  }

  refreshSummary();

  setInterval(() => {
    state.tick++;
    if (state.mailbox) updateClock();
    if (state.tick % 30 === 0) {
      renderSidebar();
      refreshSummary();
    }
  }, 1000);

  setInterval(() => {
    if (!state.autoRefresh || document.hidden) return;
    poll();
  }, 6000);

  // 老内核（Chrome < 74）的 MediaQueryList 没有 addEventListener，只有 addListener
  const mqDark = window.matchMedia('(prefers-color-scheme: dark)');
  const onSchemeChange = (e) => {
    if (!localStorage.getItem(LS.theme)) applyTheme(e.matches ? 'dark' : 'light');
  };
  if (mqDark.addEventListener) mqDark.addEventListener('change', onSchemeChange);
  else if (mqDark.addListener) mqDark.addListener(onSchemeChange);
}

init().catch((err) => {
  console.error('[app] init failed', err);
  showBootError();
  // 兜底：至少让首屏可见，不至于一片空白
  const hero = $('#hero');
  if (hero) hero.hidden = false;
  const inbox = $('#inbox');
  if (inbox) inbox.hidden = true;
});
