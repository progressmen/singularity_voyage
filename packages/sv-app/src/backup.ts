/**
 * 数据闭环：备份、恢复、按域清空与使用/健康统计。
 *
 * 备份是单个 JSON 文件，内容为 `$DSH_HOME/sv` 下的产品数据：
 * 记忆、待办、收件箱、知识库、自动化与运行历史、邮件摘要状态、会话投影。
 * 明确排除 `config.json`（含 API Key 与 SMTP 密码）与 dsh 原始会话日志。
 *
 * 恢复会先清空同名文件与 transcripts 目录，再写入备份并让各 store 重新
 * load()；包含会话投影，但不触碰 `.dsh/sessions` 或 Postgres 中的原始日志。
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { svDataDir } from './config-store.ts'
import type { AutomationStore } from './automation-store.ts'
import type { InboxStore } from './inbox-store.ts'
import type { KnowledgeStore } from './knowledge-store.ts'
import type { MemoryStore } from './memory-store.ts'
import type { SvSessionStore, SessionBackup } from './sessions-store.ts'
import type { UsageSnapshot } from './usage-store.ts'
import type { TasksStore } from './tasks-store.ts'

/** 备份包版本。 */
export const BACKUP_VERSION = 1

/** 参与备份 / 恢复的固定文件（不含 config.json）。 */
export const BACKUP_FILE_NAMES = [
  'memory.json',
  'tasks.json',
  'inbox.json',
  'knowledge.json',
  'automations.json',
  'automation-runs.json',
  'superagent-runs.json',
  'mail-state.json',
  'sessions.json',
  'approvals.json',
  'connectors.json',
  'connector-events.json',
] as const

/** transcript 相对路径白名单。 */
const TRANSCRIPT_RE = /^transcripts\/[A-Za-z0-9_-]{1,128}\.jsonl$/
const TRANSCRIPT_NAME_RE = /^[A-Za-z0-9_-]{1,128}\.jsonl$/
/** 单文件恢复上限 32MB；整包上限 100MB。 */
const MAX_RESTORE_FILE_BYTES = 32 * 1024 * 1024
const MAX_RESTORE_TOTAL_BYTES = 100 * 1024 * 1024

/** 可清空的数据域。 */
export const DATA_DOMAINS = ['memory', 'tasks', 'inbox', 'knowledge', 'automations', 'sessions', 'superagent', 'approvals', 'connectors', 'all'] as const
export type DataDomain = (typeof DATA_DOMAINS)[number]

/** 每个数据域对应的固定文件名（按域导出用）。 */
const DOMAIN_FILES: Record<Exclude<DataDomain, 'all'>, readonly string[]> = {
  memory: ['memory.json'],
  tasks: ['tasks.json'],
  inbox: ['inbox.json'],
  knowledge: ['knowledge.json'],
  automations: ['automations.json', 'automation-runs.json'],
  sessions: ['sessions.json'],
  superagent: ['superagent-runs.json'],
  approvals: ['approvals.json'],
  connectors: ['connectors.json', 'connector-events.json'],
}

/** 备份包。 */
export interface BackupBundle {
  version: typeof BACKUP_VERSION
  app: 'singularity-voyage'
  exportedAt: number
  /** 相对 `$DSH_HOME/sv` 的路径 → 文本内容。 */
  files: Record<string, string>
  /** 会话投影快照（PostgreSQL 后端也能完整导出；旧备份可能没有）。 */
  sessions?: SessionBackup
}

/** 恢复与清空需要的 store 集合。 */
export interface BackupStores {
  memory: MemoryStore
  tasks: TasksStore
  inbox: InboxStore
  knowledge: KnowledgeStore
  automations: AutomationStore
  sessions: SvSessionStore
  /** 审批审计（未挂载时省略）。 */
  approvals?: { load(): Promise<void>; clear(): Promise<void>; failPending(): Promise<number> }
  /** 连接器与事件流（未挂载时省略）。 */
  connectors?: { load(): Promise<void>; clear(): Promise<void> }
  /** 清空 Super-agent 运行历史（未启用时省略）。 */
  clearSuperAgentHistory?: () => Promise<void>
  /** 恢复后从落盘快照重载 Super-agent 历史（未启用时省略）。 */
  restoreSuperAgentHistory?: () => Promise<void>
}

/** 单个数据文件的状态。 */
export interface DataFileStatus {
  name: string
  bytes: number
  /** 是否包含在备份包里。 */
  backup: boolean
}

/** 数据页使用的使用/健康快照。 */
export interface DataStatus {
  dataDir: string
  backend: 'file' | 'postgres'
  uptimeMs: number
  counts: {
    sessions: number
    memories: number
    tasksPending: number
    tasksTotal: number
    inboxTotal: number
    inboxUnread: number
    knowledgeDocs: number
    knowledgeChunks: number
    automations: number
    automationRuns: number
  }
  usage: {
    sessionsWithUsage: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    totalTokens: number
  }
  files: DataFileStatus[]
  transcripts: { count: number; bytes: number }
  backupBytes: number
  /** 本地用量与费用估算（未挂载用量统计时省略）。 */
  usageCost?: UsageSnapshot
}

/** 导出备份：读取现有产品数据文件与 transcript 投影。 */
export async function createBackup(stores?: BackupStores, domain?: DataDomain): Promise<BackupBundle> {
  const dir = svDataDir()
  const files: Record<string, string> = {}
  const full = domain === undefined || domain === 'all'
  const wanted = full ? BACKUP_FILE_NAMES : DOMAIN_FILES[domain] ?? []
  for (const name of wanted) {
    try {
      files[name] = await readFile(join(dir, name), 'utf8')
    } catch {
      // 文件不存在表示该域为空，不写入备份
    }
  }
  const includeSessions = full || domain === 'sessions'
  if (includeSessions) {
    const transcriptDir = join(dir, 'transcripts')
    let names: string[] = []
    try {
      names = (await readdir(transcriptDir)).filter(name => TRANSCRIPT_NAME_RE.test(name)).sort()
    } catch {
      names = []
    }
    for (const name of names) {
      try {
        files[`transcripts/${name}`] = await readFile(join(transcriptDir, name), 'utf8')
      } catch {
        // 单个 transcript 读取失败不影响整体备份
      }
    }
  }
  const bundle: BackupBundle = {
    version: BACKUP_VERSION,
    app: 'singularity-voyage',
    exportedAt: Date.now(),
    files,
  }
  // 会话快照让 PostgreSQL 后端也能把对话带上；旧文件后端同样适用。
  if (includeSessions && stores?.sessions !== undefined) {
    bundle.sessions = await stores.sessions.exportAll()
  }
  return bundle
}

function isAllowedPath(path: string): boolean {
  return (BACKUP_FILE_NAMES as readonly string[]).includes(path) || TRANSCRIPT_RE.test(path)
}

/**
 * 恢复备份：校验 → 清空同名数据 → 写入 → 各 store 重新加载。
 * @throws 备份格式非法、路径越界、单文件或整包超过上限、JSON 无法解析。
 */
export async function restoreBackup(stores: BackupStores, bundle: unknown): Promise<{ files: number }> {
  if (typeof bundle !== 'object' || bundle === null) throw new Error('备份内容必须是 JSON 对象')
  const record = bundle as Partial<BackupBundle>
  if (record.version !== BACKUP_VERSION) throw new Error(`不支持的备份版本：${String(record.version)}`)
  if (typeof record.files !== 'object' || record.files === null || Array.isArray(record.files)) {
    throw new Error('备份缺少 files')
  }
  const entries = Object.entries(record.files)
  if (entries.length === 0 && record.sessions === undefined) throw new Error('备份为空')
  let total = 0
  for (const [path, value] of entries) {
    if (typeof value !== 'string') throw new Error(`备份文件内容必须是字符串：${path}`)
    if (!isAllowedPath(path)) throw new Error(`备份包含不支持的路径：${path}`)
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes > MAX_RESTORE_FILE_BYTES) throw new Error(`备份文件过大：${path}`)
    total += bytes
    if (total > MAX_RESTORE_TOTAL_BYTES) throw new Error('备份包过大（上限 100MB）')
    if (path.endsWith('.json')) {
      try {
        JSON.parse(value)
      } catch {
        throw new Error(`备份文件不是合法 JSON：${path}`)
      }
    }
  }
  if (record.sessions !== undefined) {
    if (typeof record.sessions !== 'object' || record.sessions === null
      || !Array.isArray((record.sessions as SessionBackup).sessions)
      || typeof (record.sessions as SessionBackup).transcripts !== 'object'
      || (record.sessions as SessionBackup).transcripts === null) {
      throw new Error('备份的 sessions 字段格式非法')
    }
  }

  const dir = svDataDir()
  await mkdir(dir, { recursive: true })
  // 先用“空”表示恢复完整状态：删除已知数据文件与旧 transcript。
  for (const name of BACKUP_FILE_NAMES) {
    await rm(join(dir, name), { force: true })
  }
  await rm(join(dir, 'transcripts'), { recursive: true, force: true })
  await mkdir(join(dir, 'transcripts'), { recursive: true })

  for (const [path, value] of entries) {
    const target = join(dir, path)
    const temp = `${target}.restore.tmp`
    await writeFile(temp, value, { mode: 0o600 })
    await rename(temp, target)
  }

  await stores.memory.load()
  await stores.tasks.load()
  await stores.inbox.load()
  await stores.knowledge.load()
  await stores.automations.load()
  if (record.sessions !== undefined) await stores.sessions.importAll(record.sessions)
  else await stores.sessions.load()
  await stores.approvals?.load()
  await stores.approvals?.failPending()
  await stores.connectors?.load()
  await stores.restoreSuperAgentHistory?.()
  return { files: entries.length }
}

/** 按域清空；all 表示除配置与原始会话日志外的全部产品数据。 */
export async function clearData(stores: BackupStores, domain: DataDomain): Promise<void> {
  if (domain === 'all') {
    for (const name of DATA_DOMAINS) {
      if (name === 'all') continue
      await clearData(stores, name)
    }
    return
  }
  if (domain === 'memory') return stores.memory.clear()
  if (domain === 'tasks') return stores.tasks.clear()
  if (domain === 'inbox') return stores.inbox.clear()
  if (domain === 'knowledge') return stores.knowledge.clear()
  if (domain === 'automations') return stores.automations.clear()
  if (domain === 'sessions') return stores.sessions.clear()
  if (domain === 'superagent') return stores.clearSuperAgentHistory?.()
  if (domain === 'approvals') return stores.approvals?.clear()
  if (domain === 'connectors') return stores.connectors?.clear()
  throw new Error(`未知数据域：${String(domain)}`)
}

/** 统计使用与数据量，供数据页展示。 */
export async function dataStatus(stores: BackupStores, usageCost?: UsageSnapshot): Promise<DataStatus> {
  const dir = svDataDir()
  const sessions = stores.sessions.list()
  const usage = sessions.reduce((sum, entry) => {
    if (entry.usage === undefined) return sum
    sum.sessionsWithUsage += 1
    sum.inputTokens += entry.usage.inputTokens
    sum.outputTokens += entry.usage.outputTokens
    sum.cacheReadTokens += entry.usage.cacheReadTokens
    sum.totalTokens += entry.usage.totalTokens
    return sum
  }, { sessionsWithUsage: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 })

  const files: DataFileStatus[] = []
  let backupBytes = 0
  for (const name of BACKUP_FILE_NAMES) {
    let bytes = 0
    try {
      const info = await stat(join(dir, name))
      bytes = info.size
    } catch {
      bytes = 0
    }
    files.push({ name, bytes, backup: true })
    backupBytes += bytes
  }
  try {
    const info = await stat(join(dir, 'config.json'))
    files.push({ name: 'config.json（含密钥，不备份）', bytes: info.size, backup: false })
  } catch {
    // 尚未保存过配置
  }
  try {
    const info = await stat(join(dir, 'usage.json'))
    files.push({ name: 'usage.json（用量统计，不备份）', bytes: info.size, backup: false })
  } catch {
    // 尚未产生用量
  }

  let transcriptCount = 0
  let transcriptBytes = 0
  try {
    const names = (await readdir(join(dir, 'transcripts'))).filter(name => TRANSCRIPT_NAME_RE.test(name))
    transcriptCount = names.length
    for (const name of names) {
      try {
        const info = await stat(join(dir, 'transcripts', name))
        transcriptBytes += info.size
      } catch {
        // 单个文件不可读时忽略大小
      }
    }
  } catch {
    transcriptCount = 0
  }
  backupBytes += transcriptBytes

  const tasks = stores.tasks.list(true)
  const knowledge = stores.knowledge.list()
  return {
    dataDir: dir,
    backend: (process.env.SV_DATABASE_URL ?? process.env.DATABASE_URL ?? '').trim().length > 0 ? 'postgres' : 'file',
    uptimeMs: Math.round(process.uptime() * 1000),
    counts: {
      sessions: sessions.length,
      memories: stores.memory.list().length,
      tasksPending: tasks.filter(task => task.status === 'pending').length,
      tasksTotal: tasks.length,
      inboxTotal: stores.inbox.list({ limit: 500 }).length,
      inboxUnread: stores.inbox.unreadCount(),
      knowledgeDocs: knowledge.length,
      knowledgeChunks: knowledge.reduce((sum, doc) => sum + doc.chunks.length, 0),
      automations: stores.automations.list().length,
      automationRuns: stores.automations.listRuns(undefined, 500).length,
    },
    usage,
    files,
    transcripts: { count: transcriptCount, bytes: transcriptBytes },
    backupBytes,
    ...usageCost === undefined ? {} : { usageCost },
  }
}
