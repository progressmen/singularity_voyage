/**
 * 用量与费用统计：按天、按模型累计 token 消耗。
 *
 * 每次模型请求结束时由适配器上报一次 usage（不是每个流式分片），
 * 写入 `$DSH_HOME/sv/usage.json`（0600、原子替换）。数据页据此展示
 * 每日用量、分模型汇总，并按用户配置的单价估算费用与月度预算占用。
 *
 * 这里只做本地估算，不替代供应商账单；单价与预算都由用户在设置页填写。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { svDataDir } from './config-store.ts'
import type { SvUsageConfig } from './config-store.ts'

/** 一组累计 token。 */
export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** 请求次数（一次模型调用计一次）。 */
  requests: number
}

/** 某一天的用量。 */
export interface UsageDay {
  /** YYYY-MM-DD（本地时区）。 */
  day: string
  totals: UsageTotals
  byModel: Record<string, UsageTotals>
}

/** 数据页使用的用量快照。 */
export interface UsageSnapshot {
  totals: UsageTotals
  byModel: Record<string, UsageTotals>
  /** 最近若干天（按日期升序，只包含有记录的日期）。 */
  days: UsageDay[]
  cost: {
    inputPerMillion: number
    outputPerMillion: number
    input: number
    output: number
    total: number
  }
  budget: {
    monthlyTokenBudget: number
    monthTokens: number
    percent: number
    exceeded: boolean
  }
}

/** 适配器上报的最小 usage 形状。 */
export interface UsageReport {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
}

interface UsageFile {
  version: 1
  /** YYYY-MM-DD → model → totals。 */
  days: Record<string, Record<string, UsageTotals>>
}

/** 保留天数：一年内的滚动窗口。 */
const MAX_DAYS = 366
/** 最近展示天数。 */
const RECENT_DAYS = 14

function emptyTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, requests: 0 }
}

function addTotals(target: UsageTotals, report: UsageReport): void {
  target.inputTokens += Math.max(0, Math.round(report.inputTokens))
  target.outputTokens += Math.max(0, Math.round(report.outputTokens))
  target.cacheReadTokens += Math.max(0, Math.round(report.cacheReadTokens ?? 0))
  target.requests += 1
}

function localDay(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function isTotals(value: unknown): value is UsageTotals {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return ['inputTokens', 'outputTokens', 'cacheReadTokens', 'requests']
    .every(key => typeof record[key] === 'number' && Number.isFinite(record[key]) && (record[key] as number) >= 0)
}

export class UsageStore {
  private days: Record<string, Record<string, UsageTotals>> = {}
  private readonly dir: string
  private tail: Promise<void> = Promise.resolve()

  constructor(dir?: string) {
    this.dir = dir ?? svDataDir()
  }

  private get file(): string {
    return join(this.dir, 'usage.json')
  }

  /** 读取持久化用量；缺失或损坏时从空开始。 */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      return
    }
    try {
      const parsed = JSON.parse(raw) as Partial<UsageFile>
      if (parsed.version !== 1 || typeof parsed.days !== 'object' || parsed.days === null) return
      this.days = {}
      for (const [day, models] of Object.entries(parsed.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || typeof models !== 'object' || models === null) continue
        const clean: Record<string, UsageTotals> = {}
        for (const [model, totals] of Object.entries(models)) {
          if (isTotals(totals)) clean[model] = { ...totals }
        }
        if (Object.keys(clean).length > 0) this.days[day] = clean
      }
    } catch {
      // 损坏文件按空用量处理（只影响统计展示）
    }
  }

  /** 记录一次模型调用的用量并立即落盘。 */
  async record(model: string, report: UsageReport): Promise<void> {
    const day = localDay()
    const models = this.days[day] ?? {}
    const key = model.trim().length > 0 ? model.trim() : 'unknown'
    const totals = models[key] ?? emptyTotals()
    addTotals(totals, report)
    models[key] = totals
    this.days[day] = models
    this.prune()
    await this.run(async () => {
      await mkdir(this.dir, { recursive: true })
      const file: UsageFile = { version: 1, days: this.days }
      const temp = `${this.file}.tmp`
      await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, this.file)
    })
  }

  /** 清空用量统计。 */
  async clear(): Promise<void> {
    this.days = {}
    await this.run(async () => {
      await mkdir(this.dir, { recursive: true })
      const temp = `${this.file}.tmp`
      await writeFile(temp, `${JSON.stringify({ version: 1, days: {} }, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, this.file)
    })
  }

  /** 生成数据页快照（含费用估算与月度预算占用）。 */
  snapshot(config: SvUsageConfig): UsageSnapshot {
    const totals = emptyTotals()
    const byModel: Record<string, UsageTotals> = {}
    for (const models of Object.values(this.days)) {
      for (const [model, item] of Object.entries(models)) {
        const target = byModel[model] ?? emptyTotals()
        target.inputTokens += item.inputTokens
        target.outputTokens += item.outputTokens
        target.cacheReadTokens += item.cacheReadTokens
        target.requests += item.requests
        byModel[model] = target
        totals.inputTokens += item.inputTokens
        totals.outputTokens += item.outputTokens
        totals.cacheReadTokens += item.cacheReadTokens
        totals.requests += item.requests
      }
    }
    const days: UsageDay[] = Object.keys(this.days)
      .sort()
      .slice(-RECENT_DAYS)
      .map(day => {
        const models = this.days[day] ?? {}
        const dayTotals = emptyTotals()
        for (const item of Object.values(models)) {
          dayTotals.inputTokens += item.inputTokens
          dayTotals.outputTokens += item.outputTokens
          dayTotals.cacheReadTokens += item.cacheReadTokens
          dayTotals.requests += item.requests
        }
        return { day, totals: dayTotals, byModel: models }
      })

    const input = (totals.inputTokens / 1_000_000) * config.inputPerMillion
    const output = (totals.outputTokens / 1_000_000) * config.outputPerMillion
    const month = localDay().slice(0, 7)
    let monthTokens = 0
    for (const [day, models] of Object.entries(this.days)) {
      if (!day.startsWith(month)) continue
      for (const item of Object.values(models)) monthTokens += item.inputTokens + item.outputTokens
    }
    const budget = Math.max(0, config.monthlyTokenBudget)
    return {
      totals,
      byModel,
      days,
      cost: {
        inputPerMillion: config.inputPerMillion,
        outputPerMillion: config.outputPerMillion,
        input: Number(input.toFixed(4)),
        output: Number(output.toFixed(4)),
        total: Number((input + output).toFixed(4)),
      },
      budget: {
        monthlyTokenBudget: budget,
        monthTokens,
        percent: budget > 0 ? Math.min(100, (monthTokens / budget) * 100) : 0,
        exceeded: budget > 0 && monthTokens >= budget,
      },
    }
  }

  private prune(): void {
    const keys = Object.keys(this.days).sort()
    if (keys.length <= MAX_DAYS) return
    for (const key of keys.slice(0, keys.length - MAX_DAYS)) delete this.days[key]
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task)
    this.tail = next.then(() => undefined, () => undefined)
    return next
  }
}
