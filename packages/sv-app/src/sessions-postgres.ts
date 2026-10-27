/**
 * PostgreSQL 会话投影存储。
 *
 * 配置 `SV_DATABASE_URL`（或 `DATABASE_URL`）后启用：
 *  - `sv_sessions`：会话索引（id / 标题 / 创建时间 / 更新时间 / 轮次）；
 *  - `sv_messages`：对话记录（user/assistant 条目 + 工具摘要 jsonb）。
 *
 * 表结构与索引在首次访问时自动创建；写入串行由数据库事务语义保证，
 * 单条会话记录超过上限时删除最旧条目。
 */
import pg from 'pg'
import { normalizeUsage, UNTITLED } from './sessions-store.ts'
import type {
  SessionIndexEntry,
  SessionUsage,
  SvSessionStore,
  TranscriptEntry,
  TranscriptToolEntry,
} from './sessions-store.ts'

/** assistant 文本单条上限。 */
const MAX_TEXT = 100_000
/** 单个会话保留的条目上限（超出丢弃最旧）。 */
const MAX_ENTRIES = 500
/** 合法会话 id（杜绝异常输入写入数据库）。 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

type SessionRow = {
  id: string
  title: string
  created_at: string | number
  updated_at: string | number
  turns: string | number
  usage: unknown
}

type MessageRow = {
  ts: string | number
  role: string
  body: string
  reasoning: string | null
  tools: unknown
}

export class PgSessionStore implements SvSessionStore {
  private readonly pool: InstanceType<typeof pg.Pool>
  private readonly index = new Map<string, SessionIndexEntry>()
  private schemaReady: Promise<void> | undefined

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 5_000 })
    // 空闲连接被服务端断开不应导致进程崩溃
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
      this.schemaReady = this.ensureSchema().catch((error: unknown) => {
        this.schemaReady = undefined
        throw error
      })
    }
    return this.schemaReady
  }

  private async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sv_sessions (
        id text PRIMARY KEY,
        title text NOT NULL,
        created_at bigint NOT NULL,
        updated_at bigint NOT NULL,
        turns integer NOT NULL DEFAULT 0,
        usage jsonb
      );
      ALTER TABLE sv_sessions ADD COLUMN IF NOT EXISTS usage jsonb;
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
    `)
  }

  async load(): Promise<void> {
    await this.schema()
    const { rows } = await this.pool.query<SessionRow>(
      'SELECT id, title, created_at, updated_at, turns, usage FROM sv_sessions',
    )
    this.index.clear()
    for (const row of rows) {
      if (typeof row.id !== 'string' || row.id.length === 0) continue
      const usage = normalizeUsage(row.usage)
      this.index.set(row.id, {
        id: row.id,
        title: row.title.length > 0 ? row.title : UNTITLED,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        turns: Number(row.turns),
        ...usage === undefined ? {} : { usage },
      })
    }
  }

  list(): SessionIndexEntry[] {
    return [...this.index.values()].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
  }

  has(id: string): boolean {
    return this.index.has(id)
  }

  async register(id: string): Promise<void> {
    if (!SESSION_ID_RE.test(id)) return
    await this.schema()
    const now = Date.now()
    await this.pool.query(
      `INSERT INTO sv_sessions (id, title, created_at, updated_at, turns)
       VALUES ($1, $2, $3, $4, 0)
       ON CONFLICT (id) DO NOTHING`,
      [id, UNTITLED, now, now],
    )
    if (!this.index.has(id)) {
      this.index.set(id, { id, title: UNTITLED, createdAt: now, updatedAt: now, turns: 0 })
    }
  }

  async recordUser(id: string, text: string, ts: number = Date.now()): Promise<void> {
    await this.schema()
    const entry = this.index.get(id)
    const trimmed = text.trim()
    const title = trimmed.length > 0 && (entry === undefined || entry.title === UNTITLED)
      ? truncate(trimmed, 24)
      : undefined
    const nextTitle = title ?? UNTITLED
    // register() 与 recordUser() 是并发调用，这里用 upsert 保证行一定存在且标题只写一次。
    await this.pool.query(
      `INSERT INTO sv_sessions (id, title, created_at, updated_at, turns)
       VALUES ($1, $2, $3, $3, 0)
       ON CONFLICT (id) DO UPDATE
         SET title = CASE WHEN sv_sessions.title = $4 THEN $2 ELSE sv_sessions.title END,
             updated_at = $3`,
      [id, nextTitle, ts, UNTITLED],
    )
    if (entry === undefined) {
      this.index.set(id, { id, title: nextTitle, createdAt: ts, updatedAt: ts, turns: 0 })
    } else {
      if (title !== undefined) entry.title = title
      entry.updatedAt = ts
    }
    await this.insertMessage(id, { ts, role: 'user', text: truncate(text, MAX_TEXT) })
  }

  async recordAssistant(
    id: string,
    text: string,
    reasoning: string,
    tools: TranscriptToolEntry[],
    ts: number = Date.now(),
  ): Promise<void> {
    await this.schema()
    await this.pool.query(
      'UPDATE sv_sessions SET updated_at = $2, turns = turns + 1 WHERE id = $1',
      [id, ts],
    )
    const entry = this.index.get(id)
    if (entry !== undefined) {
      entry.updatedAt = ts
      entry.turns += 1
    }
    const record: TranscriptEntry = { ts, role: 'assistant', text: truncate(text, MAX_TEXT) }
    if (reasoning.length > 0) record.reasoning = truncate(reasoning, MAX_TEXT)
    if (tools.length > 0) {
      record.tools = tools.map(tool => ({
        name: tool.name,
        ...(tool.args !== undefined ? { args: tool.args } : {}),
        ...(tool.isError === true ? { isError: true } : {}),
        ...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {}),
      }))
    }
    await this.insertMessage(id, record)
  }

  async messages(id: string): Promise<TranscriptEntry[]> {
    if (!SESSION_ID_RE.test(id)) return []
    await this.schema()
    const { rows } = await this.pool.query<MessageRow>(
      `SELECT ts, role, body, reasoning, tools
         FROM sv_messages
        WHERE session_id = $1
        ORDER BY ts ASC, id ASC`,
      [id],
    )
    const out: TranscriptEntry[] = []
    for (const row of rows) {
      if (row.role !== 'user' && row.role !== 'assistant') continue
      const entry: TranscriptEntry = { ts: Number(row.ts), role: row.role, text: row.body }
      if (row.reasoning !== null && row.reasoning.length > 0) entry.reasoning = row.reasoning
      if (Array.isArray(row.tools) && row.tools.length > 0) entry.tools = row.tools as TranscriptToolEntry[]
      out.push(entry)
    }
    return out
  }

  async recordUsage(id: string, usage: SessionUsage): Promise<void> {
    if (!SESSION_ID_RE.test(id)) return
    await this.schema()
    await this.pool.query('UPDATE sv_sessions SET usage = $2 WHERE id = $1', [id, usage])
    const entry = this.index.get(id)
    if (entry !== undefined) entry.usage = usage
  }

  async rename(id: string, title: string): Promise<boolean> {
    if (!SESSION_ID_RE.test(id)) return false
    await this.schema()
    const result = await this.pool.query('UPDATE sv_sessions SET title = $2 WHERE id = $1', [id, title])
    const entry = this.index.get(id)
    if (entry !== undefined) entry.title = title
    return (result.rowCount ?? 0) > 0
  }

  async remove(id: string): Promise<boolean> {
    const existed = this.index.delete(id)
    await this.schema()
    const result = await this.pool.query('DELETE FROM sv_sessions WHERE id = $1', [id])
    return existed || (result.rowCount ?? 0) > 0
  }

  private async insertMessage(id: string, entry: TranscriptEntry): Promise<void> {
    if (!SESSION_ID_RE.test(id)) return
    await this.pool.query(
      `INSERT INTO sv_messages (session_id, ts, role, body, reasoning, tools)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        entry.ts,
        entry.role,
        entry.text,
        entry.reasoning ?? null,
        entry.tools === undefined ? null : JSON.stringify(entry.tools),
      ],
    )
    await this.pool.query(
      `DELETE FROM sv_messages
        WHERE id IN (
          SELECT id FROM sv_messages
           WHERE session_id = $1
           ORDER BY ts DESC, id DESC
          OFFSET $2
        )`,
      [id, MAX_ENTRIES],
    )
  }
}
