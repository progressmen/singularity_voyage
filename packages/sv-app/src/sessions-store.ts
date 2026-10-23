/**
 * SV 会话索引与 transcript 投影。
 *
 * dsh 的会话 JSONL 是唯一事实源；本模块只维护产品面需要的轻量投影：
 *  - 会话索引（id / 标题 / 时间 / 轮次），供 `/sv/api/sessions` 列表；
 *  - 对话记录（user/assistant 条目 + 工具摘要），供前端跨浏览器恢复历史。
 *
 * 默认写入本地文件（`sessions.json` + `transcripts/<sessionId>.jsonl`）；
 * 配置 `SV_DATABASE_URL` 后由 {@linkcode PgSessionStore} 写入 PostgreSQL。
 *
 * 投影写入失败只告警，不阻塞对话主链路；删除索引即可重建。
 */
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { svDataDir } from './config-store.ts'

/** 会话索引条目。 */
export interface SessionIndexEntry {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  turns: number
}

/** transcript 中一条工具摘要（kind 由前端按工具名分类，这里不重复存）。 */
export interface TranscriptToolEntry {
  name: string
  /** 参数摘要（已截断）。 */
  args?: string
  isError?: boolean
  durationMs?: number
}

/** transcript 条目。 */
export interface TranscriptEntry {
  ts: number
  role: 'user' | 'assistant'
  text: string
  reasoning?: string
  tools?: TranscriptToolEntry[]
}

/** 会话投影存储（文件 / PostgreSQL 共用接口）。 */
export interface SvSessionStore {
  /** 载入索引到内存。 */
  load(): Promise<void>
  /** 当前索引（按 updatedAt 倒序）。 */
  list(): SessionIndexEntry[]
  has(id: string): boolean
  /** 确保索引中存在该会话。 */
  register(id: string): Promise<void>
  /** 追加一条用户消息；首条用户文本作为会话标题。 */
  recordUser(id: string, text: string, ts?: number): Promise<void>
  /** 追加一条 assistant 消息并累计轮次。 */
  recordAssistant(
    id: string,
    text: string,
    reasoning: string,
    tools: TranscriptToolEntry[],
    ts?: number,
  ): Promise<void>
  /** 读取一个会话的对话记录。 */
  messages(id: string): Promise<TranscriptEntry[]>
  /** 删除索引条目与对话记录。 */
  remove(id: string): Promise<boolean>
  /** 重命名会话；未知 id 返回 false。 */
  rename(id: string, title: string): Promise<boolean>
}

interface SessionsFile {
  version: 1
  sessions: SessionIndexEntry[]
}

/** assistant 文本单条上限。 */
const MAX_TEXT = 100_000
/** 单个 transcript 文件条目上限（超出丢弃最旧）。 */
const MAX_ENTRIES = 500
/** 合法会话 id（用于文件名前校验，杜绝路径穿越）。 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
/** 未命名会话的占位标题。 */
export const UNTITLED = '新对话'

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

export class SessionStore implements SvSessionStore {
  private index = new Map<string, SessionIndexEntry>()
  private readonly dir: string
  private tail: Promise<void> = Promise.resolve()

  constructor(dir?: string) {
    this.dir = dir ?? svDataDir()
  }

  private get indexFile(): string {
    return join(this.dir, 'sessions.json')
  }

  private transcriptDir(): string {
    return join(this.dir, 'transcripts')
  }

  private transcriptFile(id: string): string {
    return join(this.transcriptDir(), `${id}.jsonl`)
  }

  /** 读取索引文件到内存（缺失或损坏时从空开始）。 */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.indexFile, 'utf8')
    } catch {
      return
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SessionsFile>
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return
      this.index = new Map()
      for (const entry of parsed.sessions) {
        if (typeof entry?.id === 'string' && entry.id.length > 0) {
          this.index.set(entry.id, {
            id: entry.id,
            title: typeof entry.title === 'string' && entry.title.length > 0 ? entry.title : UNTITLED,
            createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
            updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
            turns: typeof entry.turns === 'number' && entry.turns >= 0 ? entry.turns : 0,
          })
        }
      }
    } catch {
      // 损坏的索引按空处理（投影可重建）
    }
  }

  /** 当前索引（按 updatedAt 倒序）。 */
  list(): SessionIndexEntry[] {
    return [...this.index.values()].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
  }

  has(id: string): boolean {
    return this.index.has(id)
  }

  /** 确保索引中存在该会话。 */
  async register(id: string): Promise<void> {
    if (this.index.has(id)) return
    const now = Date.now()
    this.index.set(id, { id, title: UNTITLED, createdAt: now, updatedAt: now, turns: 0 })
    await this.persistIndex()
  }

  /** 追加一条用户消息；首条用户文本作为会话标题。 */
  async recordUser(id: string, text: string, ts: number = Date.now()): Promise<void> {
    const entry = this.index.get(id)
    if (entry !== undefined) {
      if (entry.title === UNTITLED && text.trim().length > 0) entry.title = truncate(text.trim(), 24)
      entry.updatedAt = ts
      await this.persistIndex()
    }
    await this.appendTranscript(id, { ts, role: 'user', text: truncate(text, MAX_TEXT) })
  }

  /** 追加一条 assistant 消息并累计轮次。 */
  async recordAssistant(
    id: string,
    text: string,
    reasoning: string,
    tools: TranscriptToolEntry[],
    ts: number = Date.now(),
  ): Promise<void> {
    const entry = this.index.get(id)
    if (entry !== undefined) {
      entry.updatedAt = ts
      entry.turns += 1
      await this.persistIndex()
    }
    const record: TranscriptEntry = { ts, role: 'assistant', text: truncate(text, MAX_TEXT) }
    if (reasoning.length > 0) record.reasoning = truncate(reasoning, MAX_TEXT)
    if (tools.length > 0) record.tools = tools.map(tool => ({
      name: tool.name,
      ...(tool.args !== undefined ? { args: tool.args } : {}),
      ...(tool.isError === true ? { isError: true } : {}),
      ...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {}),
    }))
    await this.appendTranscript(id, record)
  }

  /** 读取一个会话的 transcript（坏行跳过；未知 id 返回空）。 */
  async messages(id: string): Promise<TranscriptEntry[]> {
    if (!SESSION_ID_RE.test(id)) return []
    let raw: string
    try {
      raw = await readFile(this.transcriptFile(id), 'utf8')
    } catch {
      return []
    }
    const out: TranscriptEntry[] = []
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        const parsed = JSON.parse(line) as TranscriptEntry
        if ((parsed.role === 'user' || parsed.role === 'assistant') && typeof parsed.text === 'string') {
          out.push(parsed)
        }
      } catch {
        // 坏行跳过
      }
    }
    return out
  }

  /** 重命名会话；未知 id 返回 false。 */
  async rename(id: string, title: string): Promise<boolean> {
    const entry = this.index.get(id)
    if (entry === undefined) return false
    entry.title = title
    await this.persistIndex()
    return true
  }

  /** 删除索引条目与 transcript 文件。 */
  async remove(id: string): Promise<boolean> {
    const existed = this.index.delete(id)
    if (existed) await this.persistIndex()
    if (!SESSION_ID_RE.test(id)) return existed
    try {
      await rm(this.transcriptFile(id), { force: true })
    } catch {
      // 文件删除失败不影响索引删除
    }
    return existed
  }

  /** 串行化所有写操作，避免并发读-改-写交错。 */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task)
    this.tail = next.then(() => undefined, () => undefined)
    return next
  }

  private async persistIndex(): Promise<void> {
    return this.run(async () => {
      await mkdir(this.dir, { recursive: true })
      const file: SessionsFile = { version: 1, sessions: this.list() }
      const temp = `${this.indexFile}.tmp`
      await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, this.indexFile)
    })
  }

  private async appendTranscript(id: string, entry: TranscriptEntry): Promise<void> {
    return this.run(async () => {
      if (!SESSION_ID_RE.test(id)) return
      const file = this.transcriptFile(id)
      await mkdir(this.transcriptDir(), { recursive: true })
      await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
      // 超上限时丢弃最旧（重写文件）
      const lines = (await readFile(file, 'utf8')).split('\n').filter(line => line.trim().length > 0)
      if (lines.length > MAX_ENTRIES) {
        const kept = lines.slice(lines.length - MAX_ENTRIES)
        await writeFile(file, `${kept.join('\n')}\n`, { mode: 0o600 })
      }
    })
  }
}
