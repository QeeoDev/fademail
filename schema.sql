-- FadeMail · 临时邮箱服务 数据库结构（可重复执行）
-- 需要完全重置本地库时：删除 .wrangler/state 后重新执行

CREATE TABLE IF NOT EXISTS mailboxes (
  id            TEXT PRIMARY KEY,
  address       TEXT NOT NULL UNIQUE,
  local_part    TEXT NOT NULL,
  domain        TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  pw_salt       TEXT,
  pw_hash       TEXT,
  recovery_key  TEXT,
  access_key    TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL DEFAULT 0,
  msg_count     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mailboxes_expires ON mailboxes(expires_at);
CREATE INDEX IF NOT EXISTS idx_mailboxes_recovery ON mailboxes(recovery_key);
CREATE INDEX IF NOT EXISTS idx_mailboxes_domain ON mailboxes(domain);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  mailbox_id    TEXT NOT NULL,
  from_name     TEXT NOT NULL DEFAULT '',
  from_addr     TEXT NOT NULL DEFAULT '',
  to_addr       TEXT NOT NULL DEFAULT '',
  subject       TEXT NOT NULL DEFAULT '(无主题)',
  snippet       TEXT NOT NULL DEFAULT '',
  body_text     TEXT NOT NULL DEFAULT '',
  body_html     TEXT NOT NULL DEFAULT '',
  headers       TEXT NOT NULL DEFAULT '[]',
  code          TEXT,
  raw_size      INTEGER NOT NULL DEFAULT 0,
  attach_count  INTEGER NOT NULL DEFAULT 0,
  is_read       INTEGER NOT NULL DEFAULT 0,
  received_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_mailbox ON messages(mailbox_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_received ON messages(received_at);

CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  content     TEXT,
  truncated   INTEGER NOT NULL DEFAULT 0,
  content_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

CREATE TABLE IF NOT EXISTS domains (
  domain      TEXT PRIMARY KEY,
  enabled     INTEGER NOT NULL DEFAULT 1,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,
  prefix      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER NOT NULL DEFAULT 0,
  calls       INTEGER NOT NULL DEFAULT 0,
  revoked     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rate_limits (
  k             TEXT PRIMARY KEY,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL
);

-- 站点配置：管理后台可覆盖品牌名 / 站点地址 / 有效期选项
CREATE TABLE IF NOT EXISTS settings (
  k           TEXT PRIMARY KEY,
  v           TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 管理后台账号（单账号，id 固定为 1；首次登录自动创建 admin / 123456）
CREATE TABLE IF NOT EXISTS admin_accounts (
  id          INTEGER PRIMARY KEY,
  username    TEXT NOT NULL,
  pw_salt     TEXT NOT NULL,
  pw_hash     TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL
);

-- 管理后台的活动流：创建 / 销毁 / 过期清理 / 管理操作
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  ref         TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT '',
  ip          TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
