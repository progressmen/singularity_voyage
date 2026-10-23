/**
 * 个人长期记忆存储。
 *
 * 与会话日志的分工：会话 JSONL 保存原文与来源，本模块保存「当前有效结论」。
 * 每条记忆带 kind / 来源 / 置信度，用户可以在 /sv 页面查看、修改、删除；
 * 删除后不再参与 Prompt 召回。
 *
 * 默认写入 `$DSH_HOME/sv/memory.json`（0600）；写入串行化并原子替换，
 * 读取失败时按空记忆启动，不影响对话主链路。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { svDataDir } from './config-store.ts'

/** 记忆类型。 */
export const MEMORY_KINDS = ['fact', 'preference', 'person', 'project', 'decision'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

/** 类型的中文标签（供 Prompt 与页面展示）。 */
export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  fact: '事实',
  preference: '偏好',
  person: '人物',
  project: '项目',
  decision: '决定',
}

/** 记忆来源：自动抽取来自某个会话，手动写入没有会话 id。 */
export interface MemorySource {
  sessionId?: string
  /** 补充说明，例如 `auto-extract` / `manual`。 */
  note?: string
}

/** 一条记忆。 */
export interface MemoryEntry {
  id: string
  kind: MemoryKind
  text: string
  tags: string[]
  /** 0–1，自动抽取的默认 0.6，手动写入的默认 0.9。 */
  confidence: number
  source: MemorySource
  createdAt: number
  updatedAt: number
}

/** 抽取器产出的候选记忆（尚未落入存储）。 */
export interface MemoryCandidate {
  kind: MemoryKind
  text: string
  tags?: string[]
  confidence?: number
}

/** 页面可修改的字段。 */
export interface MemoryPatch {
  kind?: MemoryKind
  text?: string
  tags?: string[]
  confidence?: number
}

interface MemoryFile {
  version: 1
  memories: MemoryEntry[]
}

/** 记忆条数上限（超出时丢弃最久未更新的）。 */
const MAX_ENTRIES = 2000
/** 单条记忆正文上限。 */
const MAX_TEXT = 500
/** 单个标签长度上限。 */
const MAX_TAG = 32

const KIND_SET = new Set<string>(MEMORY_KINDS)

function isKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && KIND_SET.has(value)
}

function clampConfidence(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0, value))
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** 归一化用于去重：忽略大小写、空白与标点。 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 分词：ASCII 词 + 中文二元组（单字查询保留单字）。 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const out = new Set<string>()
  for (const match of lower.matchAll(/[a-z0-9]{2,}/g)) out.add(match[0])
  const cjk = lower.replace(/[^\u4e00-\u9fff]/g, '')
  if (cjk.length === 1) out.add(cjk)
  for (let index = 0; index + 1 < cjk.length; index++) out.add(cjk.slice(index, index + 2))
  return [...out]
}

/** Prompt 与页面共用的视图。 */
export function memoryView(entry: MemoryEntry): {
  id: string
  kind: MemoryKind
  text: string
  tags: string[]
  confidence: number
  updatedAt: number
  source: MemorySource
} {
  return {
    id: entry.id,
    kind: entry.kind,
    text: entry.text,
    tags: entry.tags,
    confidence: entry.confidence,
    updatedAt: entry.updatedAt,
    source: entry.source,
  }
}

export class MemoryStore {
  private entries = new Map<string, MemoryEntry>()
  private readonly dir: string
  private tail: Promise<void> = Promise.resolve()

  constructor(dir?: string) {
    this.dir = dir ?? svDataDir()
  }

  private get file(): string {
    return join(this.dir, 'memory.json')
  }

  /** 读取持久化文件；缺失或损坏时从空记忆开始。 */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      return
    }
    try {
      const parsed = JSON.parse(raw) as Partial<MemoryFile>
      if (parsed.version !== 1 || !Array.isArray(parsed.memories)) return
      this.entries = new Map()
      for (const entry of parsed.memories) {
        const normalized = this.sanitize(entry)
        if (normalized !== undefined) this.entries.set(normalized.id, normalized)
      }
    } catch {
      // 损坏文件按空处理；用户可从页面重新添加
    }
  }

  /** 全部记忆（按更新时间倒序）。 */
  list(): MemoryEntry[] {
    return [...this.entries.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): MemoryEntry | undefined {
    return this.entries.get(id)
  }

  /**
   * 写入候选记忆：正文归一化后相同则合并（置信度取高、标签取并集），否则新增。
   * @param candidates - 抽取器或页面提交的候选。
   * @param source - 来源信息。
   * @returns 实际写入或更新的条目。
   */
  async remember(candidates: readonly MemoryCandidate[], source: MemorySource): Promise<MemoryEntry[]> {
    const written: MemoryEntry[] = []
    const now = Date.now()
    for (const candidate of candidates) {
      const text = candidate.text.trim()
      if (!isKind(candidate.kind) || text.length === 0) continue
      const kind = candidate.kind
      const tags = (candidate.tags ?? []).map(tag => tag.trim()).filter(tag => tag.length > 0 && tag.length <= MAX_TAG)
      const confidence = clampConfidence(candidate.confidence, source.note === 'manual' ? 0.9 : 0.6)
      const existing = [...this.entries.values()].find(entry => entry.kind === kind && normalize(entry.text) === normalize(text))
      if (existing !== undefined) {
        existing.text = clip(text, MAX_TEXT)
        existing.tags = [...new Set([...existing.tags, ...tags])]
        existing.confidence = Math.max(existing.confidence, confidence)
        existing.source = { ...source }
        existing.updatedAt = now
        written.push(existing)
        continue
      }
      const entry: MemoryEntry = {
        id: randomUUID(),
        kind,
        text: clip(text, MAX_TEXT),
        tags: [...new Set(tags)],
        confidence,
        source: { ...source },
        createdAt: now,
        updatedAt: now,
      }
      this.entries.set(entry.id, entry)
      written.push(entry)
    }
    if (written.length === 0) return []
    this.prune()
    await this.persist()
    return written
  }

  /** 修改一条记忆；未知 id 返回 undefined。 */
  async update(id: string, patch: MemoryPatch): Promise<MemoryEntry | undefined> {
    const entry = this.entries.get(id)
    if (entry === undefined) return undefined
    if (patch.kind !== undefined) {
      if (!isKind(patch.kind)) throw new Error('记忆类型非法')
      entry.kind = patch.kind
    }
    if (patch.text !== undefined) {
      const text = patch.text.trim()
      if (text.length === 0) throw new Error('记忆内容不能为空')
      entry.text = clip(text, MAX_TEXT)
    }
    if (patch.tags !== undefined) {
      entry.tags = [...new Set(patch.tags.map(tag => tag.trim()).filter(tag => tag.length > 0 && tag.length <= MAX_TAG))]
    }
    if (patch.confidence !== undefined) entry.confidence = clampConfidence(patch.confidence, entry.confidence)
    entry.updatedAt = Date.now()
    await this.persist()
    return entry
  }

  /** 删除一条记忆；未知 id 返回 false。 */
  async remove(id: string): Promise<boolean> {
    const existed = this.entries.delete(id)
    if (existed) await this.persist()
    return existed
  }

  /**
   * 按查询召回记忆：词重叠为主，标签命中与近期更新加权；空查询返回最近的记忆。
   * @param query - 当前用户输入。
   * @param limit - 返回条数上限。
   */
  recall(query: string, limit = 6): MemoryEntry[] {
    const queryTokens = tokenize(query.trim())
    // 查询里的单个 CJK 字（如「猫」）对二元组文本做子串匹配，保证单字也能召回。
    const singleChars = [...new Set(query.trim().match(/[\u4e00-\u9fff]/g) ?? [])]
      .filter(char => queryTokens.includes(char))
    const tokenSet = new Set(queryTokens)
    const scored: Array<{ entry: MemoryEntry; hits: number; score: number }> = []
    for (const entry of this.entries.values()) {
      const haystackText = `${entry.text} ${entry.tags.join(' ')}`
      const haystack = new Set(tokenize(haystackText))
      let hits = 0
      for (const token of tokenSet) if (haystack.has(token)) hits += 1
      for (const char of singleChars) if (haystackText.includes(char)) hits += 1
      const recency = Math.max(0, 1 - (Date.now() - entry.updatedAt) / (30 * 24 * 60 * 60 * 1000))
      scored.push({ entry, hits, score: hits * 2 + entry.confidence + recency * 0.5 })
    }
    const filtered = queryTokens.length === 0 ? scored : scored.filter(item => item.hits > 0)
    return filtered
      .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)
      .slice(0, Math.max(1, limit))
      .map(item => item.entry)
  }

  /** 生成注入 System Prompt 的记忆段落；没有命中时返回空串。 */
  promptBlock(query: string, limit = 6): string {
    const hits = this.recall(query, limit)
    if (hits.length === 0) return ''
    const lines = hits.map(entry => `- [${MEMORY_KIND_LABELS[entry.kind]}] ${clip(entry.text, 160)}`)
    return `## 长期记忆（可能与当前对话相关，仅供参考）\n${lines.join('\n')}`
  }

  /** 校验并规范化从文件读到的条目。 */
  private sanitize(value: unknown): MemoryEntry | undefined {
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Partial<MemoryEntry>
    if (typeof record.id !== 'string' || record.id.length === 0) return undefined
    if (!isKind(record.kind) || typeof record.text !== 'string' || record.text.trim().length === 0) return undefined
    const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : Date.now()
    const updatedAt = typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : createdAt
    return {
      id: record.id,
      kind: record.kind,
      text: clip(record.text.trim(), MAX_TEXT),
      tags: Array.isArray(record.tags)
        ? [...new Set(record.tags.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0 && tag.length <= MAX_TAG))]
        : [],
      confidence: clampConfidence(record.confidence, 0.6),
      source: typeof record.source === 'object' && record.source !== null ? { ...record.source } : {},
      createdAt,
      updatedAt,
    }
  }

  /** 超出上限时丢弃最久未更新的条目。 */
  private prune(): void {
    if (this.entries.size <= MAX_ENTRIES) return
    const sorted = this.list()
    for (const entry of sorted.slice(MAX_ENTRIES)) this.entries.delete(entry.id)
  }

  /** 串行化写操作，避免并发读-改-写交错。 */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task)
    this.tail = next.then(() => undefined, () => undefined)
    return next
  }

  private async persist(): Promise<void> {
    return this.run(async () => {
      await mkdir(this.dir, { recursive: true })
      const file: MemoryFile = { version: 1, memories: this.list() }
      const temp = `${this.file}.tmp`
      await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, this.file)
    })
  }
}
