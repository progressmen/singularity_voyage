-- Singularity Voyage PostgreSQL 表结构（唯一事实源）
--
-- 服务启动时会自动执行本文件建表；迁移到新数据库时手动执行：
--   psql "$SV_DATABASE_URL" -f packages/sv-app/sql/schema.sql
-- 全部语句幂等（IF NOT EXISTS），可重复执行。

-- ── 会话投影 ────────────────────────────────────────────────────────────
-- 会话索引：标题、创建/更新时间、轮次与 token 用量。
CREATE TABLE IF NOT EXISTS sv_sessions (
  id text PRIMARY KEY,
  title text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  turns integer NOT NULL DEFAULT 0,
  usage jsonb
);
-- 兼容早期未包含 usage 列的已有库。
ALTER TABLE sv_sessions ADD COLUMN IF NOT EXISTS usage jsonb;

-- 对话记录：user/assistant 条目与工具摘要（jsonb）。
CREATE TABLE IF NOT EXISTS sv_messages (
  id bigserial PRIMARY KEY,
  session_id text NOT NULL REFERENCES sv_sessions(id) ON DELETE CASCADE,
  ts bigint NOT NULL,
  role text NOT NULL,
  body text NOT NULL,
  reasoning text,
  tools jsonb
);
CREATE INDEX IF NOT EXISTS sv_messages_session_idx
  ON sv_messages (session_id, ts, id);

-- ── 账号与登录态 ────────────────────────────────────────────────────────
-- 登录账号：密码只保存 scrypt 哈希。
CREATE TABLE IF NOT EXISTS sv_users (
  id bigserial PRIMARY KEY,
  username text NOT NULL,
  password_hash text NOT NULL,
  created_at bigint NOT NULL,
  last_login_at bigint
);
-- 账号名不区分大小写唯一。
CREATE UNIQUE INDEX IF NOT EXISTS sv_users_username_idx
  ON sv_users (lower(username));

-- 登录会话：只保存 Cookie 令牌的 SHA-256 哈希与过期时间。
CREATE TABLE IF NOT EXISTS sv_auth_sessions (
  token_hash text PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES sv_users(id) ON DELETE CASCADE,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  last_seen_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS sv_auth_sessions_expires_idx
  ON sv_auth_sessions (expires_at);
