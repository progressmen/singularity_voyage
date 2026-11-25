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
  /** token 消耗与上下文占用统计（跨重启保留）。 */
  usage?: SessionUsage
}

/**
 * 会话 token 统计。
 *
 * `inputTokens` / `cacheReadTokens` 与 `contextTokens` 口径与 dsh 的
 * {@link TokenUsage} 一致：输入与缓存命中互不包含，上下文占用取最近一次
 * 模型请求的 prompt 总量（缓存读写 + 非缓存输入）。
 */
export interface SessionUsage {
  /** 累计非缓存输入 tokens。 */
  inputTokens: number
  /** 累计输出 tokens。 */
  outputTokens: number
  /** 累计缓存命中输入 tokens。 */
  cacheReadTokens: number
  /** 累计总量（含缓存与输出）。 */
  totalTokens: number
  /** 最近一次模型请求的 prompt tokens，即当前上下文占用。 */
  contextTokens: number
  /** 最近一次统计时的上下文窗口；未知时省略。 */
  contextWindow?: number
  /** 统计更新时间（epoch ms）。 */
  updatedAt: number
}

/** 解析持久化的 token 统计；关键字段缺失或非法时返回 undefined。 */
export function normalizeUsage(raw: unknown): SessionUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as Record<string, unknown>
  const count = (key: string): number | undefined => {
    const item = value[key]
    return typeof item === 'number' && Number.isFinite(item) && item >= 0 ? item : undefined
  }
  const inputTokens = count('inputTokens')
  const outputTokens = count('outputTokens')
  const totalTokens = count('totalTokens')
  const updatedAt = count('updatedAt')
  if (inputTokens === undefined || outputTokens === undefined
    || totalTokens === undefined || updatedAt === undefined) return undefined
  const usage: SessionUsage = {
    inputTokens,
    outputTokens,
    cacheReadTokens: count('cacheReadTokens') ?? 0,
    totalTokens,
    contextTokens: count('contextTokens') ?? 0,
    updatedAt,
  }
  const contextWindow = count('contextWindow')
  if (contextWindow !== undefined && contextWindow > 0) usage.contextWindow = contextWindow
  return usage
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

/** 会话全文检索命中。 */
export interface SessionSearchHit {
  sessionId: string
  title: string
  role: 'user' | 'assistant'
  /** 命中位置附近的片段。 */
  snippet: string
  ts: number
  /** 命中次数（用于排序）。 */
  score: number
}

/** 会话投影的可移植快照（跨文件 / PostgreSQL 备份恢复）。 */
export interface SessionBackup {
  sessions: SessionIndexEntry[]
  /** sessionId → 对话记录。 */
  transcripts: Record<string, TranscriptEntry[]>
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
  /** 记录会话的 token 统计（不改变排序时间与轮次）。 */
  recordUsage(id: string, usage: SessionUsage): Promise<void>
  /** 删除索引条目与对话记录。 */
  remove(id: string): Promise<boolean>
  /** 重命名会话；未知 id 返回 false。 */
  rename(id: string, title: string): Promise<boolean>
  /** 清空全部会话索引与对话记录（仅投影，不改 dsh 原始会话日志）。 */
  clear(): Promise<void>
  /** 全文检索会话投影（标题与正文）。 */
  search(query: string, limit?: number): Promise<SessionSearchHit[]>
  /** 导出全部会话索引与对话记录（备份用）。 */
  exportAll(): Promise<SessionBackup>
  /** 用快照整体替换当前会话投影（恢复用）。 */
  importAll(snapshot: SessionBackup): Promise<void>
}

/** 检索片段：围绕首个命中词截取窗口。 */
export function searchSnippet(text: string, query: string, max = 160): string {
  const lower = text.toLowerCase()
  const index = lower.indexOf(query.toLowerCase())
  if (index < 0) return clipSnippet(text, 0, max)
  const from = Math.max(0, index - 60)
  const slice = text.slice(from, from + max).trim()
  return `${from > 0 ? '…' : ''}${slice}${from + max < text.length ? '…' : ''}`
}

function clipSnippet(text: string, from: number, max: number): string {
  const slice = text.slice(from, from + max).trim()
  return `${from > 0 ? '…' : ''}${slice}${from + max < text.length ? '…' : ''}`
}

/** 统计子串出现次数（大小写不敏感）。 */
export function countOccurrences(text: string, query: string): number {
  if (query.length === 0) return 0
  const lower = text.toLowerCase()
  const needle = query.toLowerCase()
  let count = 0
  let index = lower.indexOf(needle)
  while (index >= 0) {
    count += 1
    index = lower.indexOf(needle, index + needle.length)
    if (count >= 1000) break
  }
  return count
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
          const usage = normalizeUsage((entry as { usage?: unknown }).usage)
          this.index.set(entry.id, {
            id: entry.id,
            title: typeof entry.title === 'string' && entry.title.length > 0 ? entry.title : UNTITLED,
            createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
            updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
            turns: typeof entry.turns === 'number' && entry.turns >= 0 ? entry.turns : 0,
            ...usage === undefined ? {} : { usage },
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

  /** 记录会话的 token 统计（不改变排序时间与轮次）。 */
  async recordUsage(id: string, usage: SessionUsage): Promise<void> {
    const entry = this.index.get(id)
    if (entry === undefined) return
    entry.usage = usage
    await this.persistIndex()
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

  /** 清空全部会话索引与 transcript；dsh 原始会话日志不受影响。 */
  async clear(): Promise<void> {
    this.index = new Map()
    await this.persistIndex()
    try {
      await rm(this.transcriptDir(), { recursive: true, force: true })
    } catch {
      // transcript 目录删除失败不阻塞索引清空
    }
  }

  /** 全文检索：标题命中加权，正文按出现次数累加。 */
  async search(query: string, limit = 20): Promise<SessionSearchHit[]> {
    const needle = query.trim()
    if (needle.length === 0) return []
    const max = Math.min(100, Math.max(1, Math.trunc(limit)))
    const hits: SessionSearchHit[] = []
    for (const entry of this.list()) {
      const titleHits = countOccurrences(entry.title, needle)
      if (titleHits > 0) {
        hits.push({
          sessionId: entry.id,
          title: entry.title,
          role: 'assistant',
          snippet: entry.title,
          ts: entry.updatedAt,
          score: titleHits * 5,
        })
      }
      for (const message of await this.messages(entry.id)) {
        const count = countOccurrences(message.text, needle)
        if (count === 0) continue
        hits.push({
          sessionId: entry.id,
          title: entry.title,
          role: message.role,
          snippet: searchSnippet(message.text, needle),
          ts: message.ts,
          score: count,
        })
      }
    }
    hits.sort((a, b) => b.score - a.score || b.ts - a.ts)
    return hits.slice(0, max)
  }

  /** 导出全部会话索引与对话记录。 */
  async exportAll(): Promise<SessionBackup> {
    const sessions = this.list().map(entry => ({ ...entry }))
    const transcripts: Record<string, TranscriptEntry[]> = {}
    for (const entry of sessions) {
      transcripts[entry.id] = await this.messages(entry.id)
    }
    return { sessions, transcripts }
  }

  /** 用快照整体替换当前会话投影：索引、transcript 目录都会先清空。 */
  async importAll(snapshot: SessionBackup): Promise<void> {
    const next = new Map<string, SessionIndexEntry>()
    for (const entry of snapshot.sessions ?? []) {
      if (typeof entry?.id !== 'string' || !SESSION_ID_RE.test(entry.id)) continue
      next.set(entry.id, {
        id: entry.id,
        title: typeof entry.title === 'string' && entry.title.length > 0 ? entry.title : UNTITLED,
        createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
        updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
        turns: typeof entry.turns === 'number' && entry.turns >= 0 ? entry.turns : 0,
        ...normalizeUsage(entry.usage) === undefined ? {} : { usage: normalizeUsage(entry.usage)! },
      })
    }
    this.index = next
    await this.persistIndex()
    await rm(this.transcriptDir(), { recursive: true, force: true })
    await mkdir(this.transcriptDir(), { recursive: true })
    for (const [id, entries] of Object.entries(snapshot.transcripts ?? {})) {
      if (!SESSION_ID_RE.test(id) || !Array.isArray(entries)) continue
      const lines = entries
        .filter(entry => entry !== null && typeof entry === 'object'
          && (entry.role === 'user' || entry.role === 'assistant')
          && typeof entry.text === 'string')
        .map(entry => JSON.stringify(entry))
      if (lines.length === 0) continue
      await writeFile(this.transcriptFile(id), `${lines.join('\n')}\n`, { mode: 0o600 })
    }
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
