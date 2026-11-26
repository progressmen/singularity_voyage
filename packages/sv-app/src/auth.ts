/**
 * 登录账号与登录态存储（PostgreSQL）。
 *
 * 配置 `SV_DATABASE_URL`（或 `DATABASE_URL`）后启用：
 *  - `sv_users`：账号、scrypt 密码哈希、创建时间与最近登录时间；
 *  - `sv_auth_sessions`：登录令牌的 SHA-256 哈希与过期时间（Cookie 只保存原始令牌）。
 *
 * 表结构与索引在首次访问时自动创建；首个管理员账号由登录页初始化时写入。
 */
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import pg from 'pg'
import { applySchema } from './pg-schema.ts'

/** 登录 Cookie 名。 */
export const AUTH_COOKIE = 'sv_session'
/** 登录态有效期（秒），默认 7 天。 */
export const AUTH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60

/** scrypt 派生密钥长度（字节）。 */
const SCRYPT_KEYLEN = 64
/** 登录态有效期（毫秒）。 */
const SESSION_TTL_MS = AUTH_COOKIE_MAX_AGE * 1000
/** `last_seen_at` 的最小写库间隔，避免每个请求都更新一次。 */
const TOUCH_INTERVAL_MS = 10 * 60 * 1000

/** 已登录账号的对外视图（不暴露密码哈希）。 */
export interface AuthUser {
  /** `sv_users.id`（pg 的 bigint 以字符串返回）。 */
  id: string
  username: string
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function scrypt(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, SCRYPT_KEYLEN, (error, key) => {
      if (error === null) resolve(key)
      else reject(error)
    })
  })
}

/** 生成可写入数据库的密码哈希：scrypt:<salt hex>:<hash hex>。 */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const key = await scrypt(password, salt)
  return `scrypt:${salt}:${key.toString('hex')}`
}

/** 定长比较密码哈希；格式不符直接视为失败。 */
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split(':')
  if (scheme !== 'scrypt' || salt === undefined || hash === undefined) return false
  const expected = Buffer.from(hash, 'hex')
  if (expected.length !== SCRYPT_KEYLEN) return false
  const actual = await scrypt(password, salt)
  return timingSafeEqual(actual, expected)
}

/** 校验并归一化账号：2-40 个字符，不能包含空白或控制字符。 */
function normalizeUsername(raw: string): string {
  const username = raw.trim()
  if (!/^[^\s\u0000-\u001f\u007f]{2,40}$/u.test(username)) {
    throw new Error('账号需为 2-40 个字符，且不能包含空白')
  }
  return username
}

function validatePassword(password: string): void {
  if (password.length < 8 || password.length > 128) throw new Error('密码长度需为 8-128 个字符')
}

/** PostgreSQL 唯一约束冲突（账号重复）。 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
}

type UserRow = {
  id: string
  username: string
  password_hash: string
}

export class AuthStore {
  private readonly pool: InstanceType<typeof pg.Pool>
  private schemaReady: Promise<void> | undefined

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 5_000 })
    this.pool.on('error', (error: Error) => {
      console.error(`[sv] PostgreSQL 空闲连接异常: ${error.message}`)
    })
  }

  /** 关闭连接池。 */
  async close(): Promise<void> {
    await this.pool.end()
  }

  private schema(): Promise<void> {
    if (this.schemaReady === undefined) {
      this.schemaReady = applySchema(this.pool).catch((error: unknown) => {
        this.schemaReady = undefined
        throw error
      })
    }
    return this.schemaReady
  }

  /** 建立表结构；启动时调用，失败后下次访问会重试。 */
  async load(): Promise<void> {
    await this.schema()
  }

  /** 是否已存在账号（决定登录页是否进入首次初始化模式）。 */
  async hasUsers(): Promise<boolean> {
    await this.schema()
    const { rows } = await this.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM sv_users',
    )
    return Number(rows[0]?.count ?? '0') > 0
  }

  /** 创建账号（首个管理员由登录页初始化时调用）。 */
  async createUser(rawUsername: string, rawPassword: string): Promise<AuthUser> {
    const username = normalizeUsername(rawUsername)
    validatePassword(rawPassword)
    await this.schema()
    const passwordHash = await hashPassword(rawPassword)
    try {
      const { rows } = await this.pool.query<{ id: string }>(
        `INSERT INTO sv_users (username, password_hash, created_at)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [username, passwordHash, Date.now()],
      )
      const id = rows[0]?.id
      if (id === undefined) throw new Error('账号创建失败')
      return { id, username }
    } catch (error) {
      if (isUniqueViolation(error)) throw new Error('该账号已存在')
      throw error
    }
  }

  /** 校验账号密码；账号不存在或密码错误都返回 undefined。 */
  async verifyCredentials(rawUsername: string, password: string): Promise<AuthUser | undefined> {
    const username = rawUsername.trim()
    if (username.length === 0 || password.length === 0) return undefined
    await this.schema()
    const { rows } = await this.pool.query<UserRow>(
      'SELECT id, username, password_hash FROM sv_users WHERE lower(username) = lower($1)',
      [username],
    )
    const row = rows[0]
    if (row === undefined) return undefined
    const ok = await verifyPassword(password, row.password_hash).catch(() => false)
    if (!ok) return undefined
    void this.pool.query('UPDATE sv_users SET last_login_at = $2 WHERE id = $1', [row.id, Date.now()])
      .catch(() => {})
    return { id: row.id, username: row.username }
  }

  /** 创建登录会话，返回写入 Cookie 的原始令牌（数据库只存哈希）。 */
  async createSession(userId: string): Promise<string> {
    await this.schema()
    const token = randomBytes(32).toString('base64url')
    const now = Date.now()
    await this.pool.query('DELETE FROM sv_auth_sessions WHERE expires_at < $1', [now])
    await this.pool.query(
      `INSERT INTO sv_auth_sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $3)`,
      [hashToken(token), userId, now, now + SESSION_TTL_MS],
    )
    return token
  }

  /** 校验令牌并返回当前账号；令牌不存在或已过期返回 undefined。 */
  async sessionUser(token: string): Promise<AuthUser | undefined> {
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return undefined
    await this.schema()
    const now = Date.now()
    const { rows } = await this.pool.query<{ id: string; username: string; last_seen_at: string }>(
      `SELECT u.id, u.username, s.last_seen_at
         FROM sv_auth_sessions s
         JOIN sv_users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > $2`,
      [hashToken(token), now],
    )
    const row = rows[0]
    if (row === undefined) return undefined
    if (Number(row.last_seen_at) < now - TOUCH_INTERVAL_MS) {
      void this.pool.query(
        'UPDATE sv_auth_sessions SET last_seen_at = $2 WHERE token_hash = $1',
        [hashToken(token), now],
      ).catch(() => {})
    }
    return { id: row.id, username: row.username }
  }

  /** 退出登录：删除该令牌对应的会话。 */
  async deleteSession(token: string): Promise<void> {
    await this.schema()
    await this.pool.query('DELETE FROM sv_auth_sessions WHERE token_hash = $1', [hashToken(token)])
  }
}
