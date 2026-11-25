/**
 * 个人知识库：把笔记、工作区文件与网页导入成可检索的本地知识。
 *
 * 设计取舍：
 *  - 本地优先：文档与分块写入 `$DSH_HOME/sv/knowledge.json`（0600），不上传；
 *  - 词面检索：复用记忆模块的分词（ASCII 词 + 中文二元组），在内存里维护
 *    token → chunk 的倒排索引，检索时按 IDF 加权；不引入向量库与额外依赖；
 *  - 可溯源：每个命中都带 docId / chunkId / 来源，回答与页面都能回到原文；
 *  - 可纠正：用户可在知识页删除文档，删除后下一轮不再召回。
 *
 * 每个文档按 Markdown 标题与段落切块（上限 900 字符），块内保留所属标题，
 * 便于展示「来自哪一节」。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { svDataDir } from './config-store.ts'
import { tokenize } from './memory-store.ts'

/** 知识来源类型。 */
export const KNOWLEDGE_SOURCE_KINDS = ['text', 'file', 'url'] as const
export type KnowledgeSourceKind = (typeof KNOWLEDGE_SOURCE_KINDS)[number]

/** 来源类型的中文标签。 */
export const KNOWLEDGE_SOURCE_LABELS: Record<KnowledgeSourceKind, string> = {
  text: '手动',
  file: '文件',
  url: '网页',
}

/** 文档里的一个检索块。 */
export interface KnowledgeChunk {
  /** 稳定 id：`<docId>#<index>`。 */
  id: string
  index: number
  text: string
  /** 块所属的 Markdown 标题（无标题时省略）。 */
  heading?: string
  chars: number
}

/** 一篇知识文档。 */
export interface KnowledgeDoc {
  id: string
  title: string
  /** 展示用来源：工作区相对路径、URL 或「手动导入」。 */
  source: string
  sourceKind: KnowledgeSourceKind
  /** 正文归一化后的哈希，用于重复导入去重。 */
  hash: string
  chars: number
  chunks: KnowledgeChunk[]
  createdAt: number
  updatedAt: number
}

/** 导入输入。 */
export interface KnowledgeIngestInput {
  text: string
  title?: string
  source?: string
  sourceKind?: KnowledgeSourceKind
}

/** 导入结果。 */
export interface KnowledgeIngestResult {
  doc: KnowledgeDoc
  /** true 表示命中已有文档并按新内容更新。 */
  duplicate: boolean
}

/** 检索命中。 */
export interface KnowledgeHit {
  docId: string
  title: string
  source: string
  sourceKind: KnowledgeSourceKind
  chunkId: string
  chunkIndex: number
  heading?: string
  snippet: string
  score: number
}

/** 文档摘要（列表与工具返回）。 */
export interface KnowledgeDocSummary {
  id: string
  title: string
  source: string
  sourceKind: KnowledgeSourceKind
  chars: number
  chunks: number
  createdAt: number
  updatedAt: number
}

interface KnowledgeFile {
  version: 1
  docs: KnowledgeDoc[]
}

/** 单篇文档正文字符上限（导入更长内容直接拒绝，避免知识库无界增长）。 */
export const MAX_KNOWLEDGE_DOC_CHARS = 500_000
const MAX_DOCS = 200
const MAX_CHUNK_CHARS = 900
const MAX_CHUNKS = 600
const MAX_TITLE = 120
const MAX_SOURCE = 500
const MAX_SNIPPET = 320

const SOURCE_KIND_SET = new Set<string>(KNOWLEDGE_SOURCE_KINDS)

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function isSourceKind(value: unknown): value is KnowledgeSourceKind {
  return typeof value === 'string' && SOURCE_KIND_SET.has(value)
}

function hashOf(text: string): string {
  return createHash('sha256').update(text.toLowerCase().replace(/\s+/g, '').trim()).digest('hex')
}

/** 从正文提取默认标题：首个 Markdown 标题 → 首个非标题行 → 来源。 */
export function defaultKnowledgeTitle(text: string, source?: string): string {
  const heading = /^\s*#{1,6}\s+(.+)$/m.exec(text)?.[1]?.trim()
  const firstLine = text
    .split('\n')
    .map(line => line.trim())
    .find(line => line.length > 0 && !/^#{1,6}\s+/.test(line))
  return clip(heading ?? firstLine ?? source ?? '未命名笔记', MAX_TITLE)
}

/** 把超长段落按句读切成不超过 max 的片段。 */
function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text]
  const parts: string[] = []
  let rest = text
  while (rest.length > max) {
    let cut = -1
    for (const mark of ['\n', '。', '！', '？', '.', '；', ';']) {
      const index = rest.lastIndexOf(mark, max)
      if (index > max / 2) cut = Math.max(cut, index + 1)
    }
    if (cut < 0) cut = max
    const head = rest.slice(0, cut).trim()
    if (head.length > 0) parts.push(head)
    rest = rest.slice(cut).trim()
  }
  if (rest.length > 0) parts.push(rest)
  return parts
}

/**
 * 切块：按空行分段，Markdown 标题变化时另起一块；
 * 单块超过 900 字符时按句读继续切分。
 */
export function chunkKnowledgeText(text: string, maxChunks = MAX_CHUNKS): Array<{ text: string; heading?: string }> {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  if (normalized.length === 0) return []
  const blocks = normalized.split(/\n{2,}/)
  const out: Array<{ text: string; heading?: string }> = []
  let heading: string | undefined
  let buffer: string[] = []
  let bufferChars = 0

  const flush = (): boolean => {
    const content = buffer.join('\n\n').trim()
    buffer = []
    bufferChars = 0
    if (content.length === 0) return false
    for (const part of splitLong(content, MAX_CHUNK_CHARS)) {
      if (part.trim().length === 0) continue
      out.push({ text: part, ...(heading === undefined ? {} : { heading }) })
      if (out.length >= maxChunks) return true
    }
    return false
  }

  for (const block of blocks) {
    const trimmed = block.trim()
    if (trimmed.length === 0) continue
    const headingMatch = /^#{1,6}\s+(.+)$/.exec(trimmed)
    // 标题单独成段时切换上下文；标题下若紧接着正文，正文进入新块。
    if (headingMatch !== null) {
      if (flush()) break
      heading = headingMatch[1]!.trim()
      buffer.push(trimmed)
      bufferChars = trimmed.length
      continue
    }
    if (bufferChars > 0 && bufferChars + trimmed.length + 2 > MAX_CHUNK_CHARS) {
      if (flush()) break
    }
    buffer.push(trimmed)
    bufferChars += trimmed.length + 2
  }
  if (out.length < maxChunks) flush()
  return out
}

/** 文档摘要视图。 */
export function knowledgeDocSummary(doc: KnowledgeDoc): KnowledgeDocSummary {
  return {
    id: doc.id,
    title: doc.title,
    source: doc.source,
    sourceKind: doc.sourceKind,
    chars: doc.chars,
    chunks: doc.chunks.length,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

/** 文档详情视图（含分块正文；chunks 由数量换成数组）。 */
export type KnowledgeDocDetail = Omit<KnowledgeDocSummary, 'chunks'> & { chunks: KnowledgeChunk[] }

/** 文档详情视图。 */
export function knowledgeDocView(doc: KnowledgeDoc): KnowledgeDocDetail {
  const { chunks: _chunkCount, ...summary } = knowledgeDocSummary(doc)
  return { ...summary, chunks: doc.chunks.map(chunk => ({ ...chunk })) }
}

/** 生成命中片段：围绕第一个查询词截取窗口。 */
function snippetOf(text: string, tokens: readonly string[]): string {
  const lower = text.toLowerCase()
  let start = 0
  for (const token of tokens) {
    const index = lower.indexOf(token)
    if (index >= 0 && (start === 0 || index < start)) start = index
  }
  const from = Math.max(0, start - 40)
  const slice = text.slice(from, from + MAX_SNIPPET)
  return `${from > 0 ? '…' : ''}${slice.trim()}${from + MAX_SNIPPET < text.length ? '…' : ''}`
}

export class KnowledgeStore {
  private docs: KnowledgeDoc[] = []
  private readonly dir: string
  private readonly index = new Map<string, Set<string>>()
  private readonly chunkRefs = new Map<string, { doc: KnowledgeDoc; chunk: KnowledgeChunk }>()
  private totalChunks = 0
  private tail: Promise<void> = Promise.resolve()

  constructor(dir?: string) {
    this.dir = dir ?? svDataDir()
  }

  private get file(): string {
    return join(this.dir, 'knowledge.json')
  }

  /** 读取持久化文件；缺失或损坏时从空知识库开始。 */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      return
    }
    try {
      const parsed = JSON.parse(raw) as Partial<KnowledgeFile>
      if (parsed.version !== 1 || !Array.isArray(parsed.docs)) return
      this.docs = []
      for (const doc of parsed.docs) {
        const normalized = sanitizeDoc(doc)
        if (normalized !== undefined) this.docs.push(normalized)
      }
      this.docs.sort((a, b) => b.updatedAt - a.updatedAt)
      this.rebuildIndex()
    } catch {
      // 损坏文件按空知识库处理；用户可以重新导入
    }
  }

  /** 全部文档（按更新时间倒序）。 */
  list(): KnowledgeDoc[] {
    return this.docs
  }

  get(id: string): KnowledgeDoc | undefined {
    return this.docs.find(doc => doc.id === id)
  }

  /**
   * 导入或更新一篇文档；相同正文哈希视为同一篇，更新标题/来源与分块。
   * @throws 正文为空或超过 50 万字符。
   */
  async ingest(input: KnowledgeIngestInput): Promise<KnowledgeIngestResult> {
    const text = input.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
    if (text.length === 0) throw new Error('知识内容不能为空')
    if (text.length > MAX_KNOWLEDGE_DOC_CHARS) {
      throw new Error(`知识内容过长（上限 ${MAX_KNOWLEDGE_DOC_CHARS} 字符）`)
    }
    const rawChunks = chunkKnowledgeText(text)
    if (rawChunks.length === 0) throw new Error('知识内容不能为空')
    const hash = hashOf(text)
    const title = clip((input.title ?? '').trim() || defaultKnowledgeTitle(text, input.source), MAX_TITLE)
    const sourceKind = input.sourceKind ?? 'text'
    if (!isSourceKind(sourceKind)) throw new Error('知识来源类型非法')
    const source = clip((input.source ?? '').trim() || '手动导入', MAX_SOURCE)
    const now = Date.now()

    const existing = this.docs.find(doc => doc.hash === hash)
    if (existing !== undefined) {
      existing.title = title
      existing.source = source
      existing.sourceKind = sourceKind
      existing.chars = text.length
      existing.chunks = makeChunks(existing.id, rawChunks)
      existing.updatedAt = now
      this.docs.sort((a, b) => b.updatedAt - a.updatedAt)
      this.rebuildIndex()
      await this.persist()
      return { doc: existing, duplicate: true }
    }

    const id = randomUUID()
    const doc: KnowledgeDoc = {
      id,
      title,
      source,
      sourceKind,
      hash,
      chars: text.length,
      chunks: makeChunks(id, rawChunks),
      createdAt: now,
      updatedAt: now,
    }
    this.docs.unshift(doc)
    this.prune()
    this.rebuildIndex()
    await this.persist()
    return { doc, duplicate: false }
  }

  /** 删除文档；未知 id 返回 false。 */
  async remove(id: string): Promise<boolean> {
    const index = this.docs.findIndex(doc => doc.id === id)
    if (index < 0) return false
    this.docs.splice(index, 1)
    this.rebuildIndex()
    await this.persist()
    return true
  }

  /** 清空全部知识文档与索引（隐私清空与恢复用）。 */
  async clear(): Promise<void> {
    this.docs = []
    this.rebuildIndex()
    await this.persist()
  }

  /**
   * 检索知识库：倒排索引命中后按 IDF 加权，返回片段与来源。
   * @param query - 用户问题或检索词。
   * @param limit - 返回条数上限，默认 5。
   */
  search(query: string, limit = 5): KnowledgeHit[] {
    const tokens = [...new Set(tokenize(query))]
    if (tokens.length === 0) return []
    const scores = new Map<string, number>()
    for (const token of tokens) {
      const postings = this.index.get(token)
      if (postings === undefined || postings.size === 0) continue
      const idf = Math.log((this.totalChunks + 1) / (postings.size + 1)) + 1
      for (const key of postings) {
        scores.set(key, (scores.get(key) ?? 0) + idf)
      }
    }
    const hits: KnowledgeHit[] = []
    const max = Math.min(50, Math.max(1, Math.trunc(limit)))
    const normalizedQuery = query.replace(/\s+/g, '').toLowerCase()
    for (const [key, score] of scores) {
      const ref = this.chunkRefs.get(key)
      if (ref === undefined) continue
      let boosted = score
      // 完整短语出现在同一块里时额外加权，避免只命中零散字词。
      if (normalizedQuery.length >= 2 && ref.chunk.text.toLowerCase().replace(/\s+/g, '').includes(normalizedQuery)) {
        boosted += tokens.length * 2
      }
      hits.push({
        docId: ref.doc.id,
        title: ref.doc.title,
        source: ref.doc.source,
        sourceKind: ref.doc.sourceKind,
        chunkId: ref.chunk.id,
        chunkIndex: ref.chunk.index,
        ...(ref.chunk.heading === undefined ? {} : { heading: ref.chunk.heading }),
        snippet: snippetOf(ref.chunk.text, tokens),
        score: Number(boosted.toFixed(3)),
      })
    }
    hits.sort((a, b) => b.score - a.score || (this.get(b.docId)?.updatedAt ?? 0) - (this.get(a.docId)?.updatedAt ?? 0))
    return hits.slice(0, max)
  }

  /**
   * 生成注入 System Prompt 的知识段落；没有命中时返回空串。
   * @param query - 当前用户输入。
   * @param limit - 最多注入几条，默认 3。
   */
  promptBlock(query: string, limit = 3): string {
    const hits = this.search(query, limit)
    if (hits.length === 0) return ''
    const lines = ['## 个人知识（来自本地知识库，可能与当前问题相关）']
    hits.forEach((hit, index) => {
      lines.push(`- [K${index + 1}] [${hit.title}](sv-knowledge:${hit.docId}) · 来源：${hit.source}`)
      lines.push(`  ${clip(hit.snippet.replace(/\s+/g, ' ').trim(), 220)}`)
    })
    lines.push('使用这些内容时，请保留形如 [标题](sv-knowledge:文档id) 的引用链接，不要编造知识库中没有的事实。')
    return lines.join('\n')
  }

  private rebuildIndex(): void {
    this.index.clear()
    this.chunkRefs.clear()
    this.totalChunks = 0
    for (const doc of this.docs) {
      for (const chunk of doc.chunks) {
        const key = chunk.id
        this.chunkRefs.set(key, { doc, chunk })
        this.totalChunks += 1
        const tokens = tokenize(`${doc.title}\n${chunk.heading ?? ''}\n${chunk.text}`)
        for (const token of tokens) {
          let postings = this.index.get(token)
          if (postings === undefined) {
            postings = new Set()
            this.index.set(token, postings)
          }
          postings.add(key)
        }
      }
    }
  }

  private prune(): void {
    if (this.docs.length <= MAX_DOCS) return
    this.docs.sort((a, b) => b.updatedAt - a.updatedAt)
    this.docs.splice(MAX_DOCS)
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task)
    this.tail = next.then(() => undefined, () => undefined)
    return next
  }

  private async persist(): Promise<void> {
    return this.run(async () => {
      await mkdir(this.dir, { recursive: true })
      const file: KnowledgeFile = { version: 1, docs: this.docs }
      const temp = `${this.file}.tmp`
      await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, this.file)
    })
  }
}

function makeChunks(docId: string, raw: Array<{ text: string; heading?: string }>): KnowledgeChunk[] {
  return raw.map((item, index) => ({
    id: `${docId}#${index}`,
    index,
    text: clip(item.text, MAX_CHUNK_CHARS + 120),
    ...(item.heading === undefined ? {} : { heading: item.heading }),
    chars: item.text.length,
  }))
}

function sanitizeDoc(value: unknown): KnowledgeDoc | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Partial<KnowledgeDoc>
  if (typeof record.id !== 'string' || record.id.length === 0) return undefined
  if (typeof record.title !== 'string' || record.title.trim().length === 0) return undefined
  const sourceKind = isSourceKind(record.sourceKind) ? record.sourceKind : 'text'
  const source = typeof record.source === 'string' && record.source.length > 0 ? record.source : '手动导入'
  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : Date.now()
  const updatedAt = typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : createdAt
  if (!Array.isArray(record.chunks)) return undefined
  const chunks: KnowledgeChunk[] = []
  for (const item of record.chunks) {
    if (typeof item !== 'object' || item === null) continue
    const chunk = item as Partial<KnowledgeChunk>
    if (typeof chunk.text !== 'string' || chunk.text.trim().length === 0) continue
    const index = typeof chunk.index === 'number' && Number.isInteger(chunk.index) && chunk.index >= 0
      ? chunk.index
      : chunks.length
    chunks.push({
      id: `${record.id}#${index}`,
      index,
      text: clip(chunk.text, MAX_CHUNK_CHARS + 120),
      ...(typeof chunk.heading === 'string' && chunk.heading.length > 0 ? { heading: clip(chunk.heading, 200) } : {}),
      chars: typeof chunk.chars === 'number' && Number.isFinite(chunk.chars) ? chunk.chars : chunk.text.length,
    })
  }
  chunks.sort((a, b) => a.index - b.index)
  if (chunks.length === 0) return undefined
  const chars = typeof record.chars === 'number' && Number.isFinite(record.chars)
    ? record.chars
    : chunks.reduce((sum, chunk) => sum + chunk.chars, 0)
  return {
    id: record.id,
    title: clip(record.title.trim(), MAX_TITLE),
    source: clip(source, MAX_SOURCE),
    sourceKind,
    hash: typeof record.hash === 'string' && record.hash.length > 0 ? record.hash : hashOf(chunks.map(chunk => chunk.text).join('\n\n')),
    chars,
    chunks,
    createdAt,
    updatedAt,
  }
}
