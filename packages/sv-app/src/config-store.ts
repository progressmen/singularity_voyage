/**
 * SV 运行时配置存储：保存自定义 LLM 与 Web 搜索的 token / API 端点。
 *
 * 三层取值（后者覆盖前者）：
 *   1. Cordis patch 行 config（由 SV_LLM_BASE_URL 等环境变量注入的部署默认值）；
 *   2. 环境变量中的密钥（SV_LLM_API_KEY / SV_SEARCH_API_KEY）；
 *   3. 持久化文件 $DSH_HOME/sv/config.json（SV 页面保存后写入，优先级最高）。
 *
 * 持久化文件中的空字符串密钥视为「未设置」，不覆盖环境变量提供的默认值，
 * 因此 .env / 环境变量预置的密钥在页面从未保存过密钥时始终生效。
 *
 * 密钥永不进入 Cordis 配置面、日志或任何 API 响应体。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SUPER_AGENT_DEFAULTS, type SvSuperAgentConfig } from './superagent.ts'

/** LLM 供应商预设 id（决定默认 baseURL 与模型，页面可覆盖）。 */
export type SvLlmProviderId = 'deepseek' | 'qwen' | 'ark' | 'openai' | 'custom'

/** 供应商预设：切换 provider 时回填的默认端点与模型。 */
export const SV_LLM_PRESETS: Record<Exclude<SvLlmProviderId, 'custom'>, { baseURL: string; model: string }> = {
  deepseek: { baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' },
  qwen: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-max' },
  ark: { baseURL: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-1-6-250615' },
  openai: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
}

/** 按 baseURL 反推 provider（匹配预设端点则为该预设，否则 custom）。 */
export function inferLlmProvider(baseURL: string): SvLlmProviderId {
  const normalized = baseURL.replace(/\/+$/, '').toLowerCase()
  for (const [id, preset] of Object.entries(SV_LLM_PRESETS)) {
    if (preset.baseURL.replace(/\/+$/, '').toLowerCase() === normalized) return id as SvLlmProviderId
  }
  return 'custom'
}

/**
 * 各预设供应商常见的上下文窗口（tokens）。
 * 仅用于「上下文占用比例」的默认估算，设置页填写后以配置值为准；
 * custom 端点不猜测，返回 undefined（页面只显示占用量，不显示比例）。
 */
const DEFAULT_CONTEXT_WINDOWS: Record<Exclude<SvLlmProviderId, 'custom'>, number> = {
  deepseek: 1_000_000,
  qwen: 131_072,
  ark: 262_144,
  openai: 131_072,
}

/** 供应商默认上下文窗口；custom 返回 undefined。 */
export function defaultContextWindow(provider: SvLlmProviderId): number | undefined {
  return provider === 'custom' ? undefined : DEFAULT_CONTEXT_WINDOWS[provider]
}

function isLlmProvider(value: unknown): value is SvLlmProviderId {
  return value === 'deepseek' || value === 'qwen' || value === 'ark' || value === 'openai' || value === 'custom'
}

/** LLM 路由配置（OpenAI 兼容端点）。 */
export interface SvLlmConfig {
  /** 供应商预设 id。 */
  provider: SvLlmProviderId
  /** OpenAI 兼容 API 根地址，例如 https://api.deepseek.com 或 https://api.openai.com/v1。 */
  baseURL: string
  /** 模型 id。 */
  model: string
  /** API 密钥；空字符串表示未配置。 */
  apiKey: string
  /** 可选：上下文窗口（tokens）。 */
  contextWindow?: number
  /** 可选：每次请求的默认输出上限（tokens）。 */
  maxTokens?: number
}

/** 一份可保存的模型配置（多模型切换的最小单元）。 */
export interface SvLlmProfile extends SvLlmConfig {
  /** 稳定 id，用于快速切换与保存时定位。 */
  id: string
  /** 展示名称；留空时由模型 id 兜底。 */
  name: string
}

/** 脱敏后的模型配置（不含密钥明文）。 */
export interface SvLlmProfilePublic {
  id: string
  name: string
  provider: SvLlmProviderId
  baseURL: string
  model: string
  hasApiKey: boolean
  contextWindow?: number
  maxTokens?: number
}

/** Web 搜索提供方支持的协议类型。 */
export type SvSearchProviderKind = 'tavily' | 'bocha' | 'deepseek'

/**
 * Web 搜索提供方配置。
 *
 * - `tavily`：Tavily 兼容 API；
 * - `bocha`：博查原生 API；
 * - `deepseek`：DeepSeek 官方 Search API，未单独配置密钥时复用模型 API Key。
 */
export interface SvSearchConfig {
  /** 搜索 API 协议类型，决定请求形状与认证方式。 */
  provider: SvSearchProviderKind
  /** 搜索 API 根地址（tavily: https://api.tavily.com；bocha: https://api.bochaai.com；deepseek: https://api.deepseek.com）。 */
  baseURL: string
  /** API 密钥；空字符串表示未配置（deepseek 会回落到模型 API Key）。 */
  apiKey: string
  /** 博查专用：时效过滤（oneDay/oneWeek/oneMonth/oneYear/noLimit）。 */
  freshness?: string
  /** 失败后的额外重试次数（缺省用 SV_SEARCH_RETRY_ATTEMPTS 环境变量，再缺省 2）。 */
  retryAttempts?: number
  /** 单次请求超时毫秒（缺省用 SV_SEARCH_API_TIMEOUT_MS 环境变量，再缺省 15000）。 */
  timeoutMs?: number
  /** 重试阶段总预算毫秒（缺省用 SV_SEARCH_RETRY_BUDGET_MS 环境变量，再缺省 30000）。 */
  budgetMs?: number
}

/** 每日简报配置。 */
export interface SvBriefingConfig {
  /** 是否启用定时生成；手动「立即生成」不受此开关影响。 */
  enabled: boolean
  /** 每天生成时间（HH:mm，本地时区）；空字符串表示不生成。 */
  time: string
  /** 生成后是否额外发一封邮件（需要邮件通道已启用且 SMTP 配置完整）。 */
  email: boolean
}

/** 自动化全局设置。 */
export interface SvAutomationConfig {
  /** 全局暂停：暂停后调度扫描不再执行任何自动化。 */
  paused: boolean
  /** 静默时段开始（HH:mm）；空字符串表示不静默。 */
  quietStart: string
  /** 静默时段结束（HH:mm）。 */
  quietEnd: string
  /** 失败后的额外重试次数（0–5）。 */
  retryAttempts: number
}

/** 用量与费用估算配置。 */
export interface SvUsageConfig {
  /** 输入 token 单价（每百万 token，按用户填写币种）。 */
  inputPerMillion: number
  /** 输出 token 单价（每百万 token）。 */
  outputPerMillion: number
  /** 月度 token 预算；0 表示不限制。 */
  monthlyTokenBudget: number
}

/** 邮件通道配置（SMTP）。 */
export interface SvMailConfig {  /** 是否启用邮件通道（提醒与摘要都受它控制）。 */
  enabled: boolean
  /** SMTP 主机，例如 smtp.qq.com。 */
  host: string
  /** SMTP 端口；SSL 默认 465，STARTTLS 默认 587。 */
  port: number
  /** true = SSL 直连（465）；false = 明文连接后 STARTTLS（587）。 */
  secure: boolean
  /** SMTP 登录账号。 */
  user: string
  /** 应用专用密码；空字符串表示未配置。 */
  password: string
  /** 发件人地址；空则回落到 user。 */
  from: string
  /** 默认收件人（通常是自己），多个用英文逗号分隔；空则回落到 user。 */
  to: string
  /** 待办到期时是否额外发一封提醒邮件。 */
  notifyOnReminder: boolean
  /** 每日待办摘要发送时间（HH:mm，本地时区）；空字符串表示不发摘要。 */
  digestAt: string
}

interface SvStoreShape {
  /** 当前生效的模型配置（始终与 active profile 保持一致）。 */
  llm: SvLlmConfig
  /** 全部已保存的模型配置。 */
  models: SvLlmProfile[]
  /** 当前生效的模型配置 id。 */
  activeModelId: string
  /** Super-agent 开关与限额（页面可改）。 */
  superAgent: SvSuperAgentConfig
  search: SvSearchConfig
  mail: SvMailConfig
  briefing: SvBriefingConfig
  /** 自动化全局设置（暂停 / 静默时段 / 重试）。 */
  automations: SvAutomationConfig
  /** 用量与费用估算配置。 */
  usage: SvUsageConfig
}

/** 内置的每日简报缺省值：默认开启，只进收件箱，不额外发邮件。 */
export function defaultBriefingConfig(): SvBriefingConfig {
  return { enabled: true, time: '08:30', email: false }
}

/** 内置的自动化缺省值：不暂停、不静默、失败重试 1 次。 */
export function defaultAutomationConfig(): SvAutomationConfig {
  return { paused: false, quietStart: '', quietEnd: '', retryAttempts: 1 }
}

/** 内置的用量估算缺省值：未填写单价与预算，只展示 token。 */
export function defaultUsageConfig(): SvUsageConfig {
  return { inputPerMillion: 0, outputPerMillion: 0, monthlyTokenBudget: 0 }
}

/** 内置的邮件缺省值：未配置 SMTP 时通道处于关闭状态。 */
export function defaultMailConfig(): SvMailConfig {
  return {
    enabled: false,
    host: '',
    port: 465,
    secure: true,
    user: '',
    password: '',
    from: '',
    to: '',
    notifyOnReminder: true,
    digestAt: '',
  }
}

/** HH:mm（00:00–23:59）；空字符串表示关闭每日摘要。 */
const DIGEST_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** 脱敏快照：对外 API 只暴露“是否已配置密钥”，绝不回传密钥本身。 */
export interface SvPublicState {
  llm: { provider: SvLlmProviderId; baseURL: string; model: string; hasApiKey: boolean; contextWindow?: number; maxTokens?: number }
  /** 全部模型配置（脱敏），供设置页与顶栏快速切换使用。 */
  llmModels: SvLlmProfilePublic[]
  /** 当前生效的模型配置 id。 */
  activeModelId: string
  /** Super-agent 开关与限额。 */
  superAgent: SvSuperAgentConfig
  search: {
    provider: SvSearchProviderKind
    baseURL: string
    hasApiKey: boolean
    freshness?: string
    retryAttempts?: number
    timeoutMs?: number
    budgetMs?: number
  }
  mail: {
    enabled: boolean
    host: string
    port: number
    secure: boolean
    user: string
    hasPassword: boolean
    from: string
    to: string
    notifyOnReminder: boolean
    digestAt: string
  }
  briefing: SvBriefingConfig
  automations: SvAutomationConfig
  usage: SvUsageConfig
}

/** SV 数据目录：$DSH_HOME/sv（可用 SV_HOME 覆盖）。 */
export function svDataDir(): string {
  if (process.env.SV_HOME !== undefined && process.env.SV_HOME.length > 0) return process.env.SV_HOME
  const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(dshHome, 'sv')
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** 读取闭区间整数；越界或非法返回 undefined。 */
function rangedInt(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined
}

/** 读取非负数字；非法返回 undefined。 */
function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** 新模型配置的稳定 id。 */
function newProfileId(): string {
  return `m_${randomUUID()}`
}

/** profile → 运行时配置（只保留运行需要的字段）。 */
function profileConfig(profile: SvLlmProfile): SvLlmConfig {
  return {
    provider: profile.provider,
    baseURL: profile.baseURL,
    model: profile.model,
    apiKey: profile.apiKey,
    ...profile.contextWindow === undefined ? {} : { contextWindow: profile.contextWindow },
    ...profile.maxTokens === undefined ? {} : { maxTokens: profile.maxTokens },
  }
}

/** 把运行时配置写回 profile（含可选字段的增删）。 */
function applyConfig(profile: SvLlmProfile, llm: SvLlmConfig): void {
  profile.provider = llm.provider
  profile.baseURL = llm.baseURL
  profile.model = llm.model
  profile.apiKey = llm.apiKey
  if (llm.contextWindow === undefined) delete profile.contextWindow
  else profile.contextWindow = llm.contextWindow
  if (llm.maxTokens === undefined) delete profile.maxTokens
  else profile.maxTokens = llm.maxTokens
}

export class ConfigStore {
  private state: SvStoreShape

  constructor(defaults: {
    llm: SvLlmConfig
    search: SvSearchConfig
    mail?: SvMailConfig
    briefing?: SvBriefingConfig
    automations?: SvAutomationConfig
    usage?: SvUsageConfig
    /** 启动时的 Super-agent 默认值（来自 patch / 环境变量）。 */
    superAgent?: SvSuperAgentConfig
  }) {
    const llm = { ...defaults.llm }
    const activeModelId = newProfileId()
    this.state = {
      llm,
      models: [{ id: activeModelId, name: llm.model || '默认模型', ...llm }],
      activeModelId,
      superAgent: { enabled: false, ...SUPER_AGENT_DEFAULTS, ...defaults.superAgent },
      search: { ...defaults.search },
      mail: { ...defaultMailConfig(), ...defaults.mail },
      briefing: { ...defaultBriefingConfig(), ...defaults.briefing },
      automations: { ...defaultAutomationConfig(), ...defaults.automations },
      usage: { ...defaultUsageConfig(), ...defaults.usage },
    }
  }

  /** 当前生效的 LLM 配置（按请求读取，保存后立即生效）。 */
  get llm(): SvLlmConfig {
    return this.state.llm
  }

  /** 当前生效的搜索配置。 */
  get search(): SvSearchConfig {
    return this.state.search
  }

  /** 当前生效的邮件配置。 */
  get mail(): SvMailConfig {
    return this.state.mail
  }

  /** 每日简报开关、时间与邮件选项。 */
  get briefing(): SvBriefingConfig {
    return this.state.briefing
  }

  /** 自动化全局设置（暂停 / 静默时段 / 重试）。 */
  get automations(): SvAutomationConfig {
    return this.state.automations
  }

  /** 用量与费用估算配置。 */
  get usage(): SvUsageConfig {
    return this.state.usage
  }

  /** Super-agent 开关与限额（保存后即时应用）。 */
  get superAgent(): SvSuperAgentConfig {
    return this.state.superAgent
  }

  /** 按模型配置 id 取运行时配置（含密钥，仅供服务端内部使用）。 */
  llmConfig(id: string | undefined): SvLlmConfig | undefined {
    if (id === undefined) return undefined
    const profile = this.state.models.find(candidate => candidate.id === id)
    return profile === undefined ? undefined : profileConfig(profile)
  }

  /** 当前生效的模型配置条目。 */
  private activeProfile(): SvLlmProfile | undefined {
    return this.state.models.find(profile => profile.id === this.state.activeModelId) ?? this.state.models[0]
  }

  /** 把运行时配置写回当前生效条目。 */
  private syncActiveProfile(): void {
    const profile = this.activeProfile()
    if (profile !== undefined) applyConfig(profile, this.state.llm)
  }

  /** 用指定条目覆盖运行时配置。 */
  private activateProfile(id: unknown): void {
    const value = String(id ?? '').trim()
    const profile = this.state.models.find(candidate => candidate.id === value)
    if (profile === undefined) throw new Error('模型配置不存在')
    this.state.activeModelId = profile.id
    this.state.llm = profileConfig(profile)
  }

  /** 全部模型配置的脱敏视图。 */
  private modelViews(): SvLlmProfilePublic[] {
    return this.state.models.map(profile => ({
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      baseURL: profile.baseURL,
      model: profile.model,
      hasApiKey: profile.apiKey.length > 0,
      ...profile.contextWindow === undefined ? {} : { contextWindow: profile.contextWindow },
      ...profile.maxTokens === undefined ? {} : { maxTokens: profile.maxTokens },
    }))
  }

  private get file(): string {
    return join(svDataDir(), 'config.json')
  }

  /** 读取持久化文件并覆盖内存状态（文件中出现的字段优先）。 */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`sv-app: 无法解析 ${this.file}（请修复或删除该文件）`)
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const record = parsed as Partial<{
      llm: Partial<SvLlmConfig>
      models: unknown
      activeModelId: unknown
      superAgent: Partial<SvSuperAgentConfig>
      search: Partial<SvSearchConfig>
      mail: Partial<SvMailConfig>
      briefing: Partial<SvBriefingConfig>
      automations: Partial<SvAutomationConfig>
      usage: Partial<SvUsageConfig>
    }>
    if (typeof record.llm === 'object' && record.llm !== null) {
      const { llm } = record
      if (isLlmProvider(llm.provider)) this.state.llm.provider = llm.provider
      if (typeof llm.baseURL === 'string' && isHttpUrl(llm.baseURL)) {
        this.state.llm.baseURL = llm.baseURL.replace(/\/+$/, '')
        // 兼容无 provider 字段的旧配置：按端点反推
        if (!isLlmProvider(llm.provider)) this.state.llm.provider = inferLlmProvider(this.state.llm.baseURL)
      }
      if (typeof llm.model === 'string' && llm.model.trim().length > 0) this.state.llm.model = llm.model.trim()
      if (typeof llm.apiKey === 'string' && llm.apiKey.trim().length > 0) this.state.llm.apiKey = llm.apiKey.trim()
      const contextWindow = positiveInt(llm.contextWindow)
      if (contextWindow !== undefined) this.state.llm.contextWindow = contextWindow
      const maxTokens = positiveInt(llm.maxTokens)
      if (maxTokens !== undefined) this.state.llm.maxTokens = maxTokens
    }
    // 旧配置只有单个 llm：先把它同步到默认条目，再用 models（若有）整体覆盖
    this.syncActiveProfile()
    if (!Array.isArray(record.models) || record.models.length === 0) {
      // 单模型旧配置没有自定义名称，用实际模型 id 作为展示名
      const active = this.activeProfile()
      if (active !== undefined && this.state.llm.model.length > 0) active.name = this.state.llm.model
    }
    if (Array.isArray(record.models) && record.models.length > 0) {
      const models: SvLlmProfile[] = []
      for (const item of record.models) {
        if (typeof item !== 'object' || item === null) continue
        const raw = item as Record<string, unknown>
        if (typeof raw.baseURL !== 'string' || !isHttpUrl(raw.baseURL)) continue
        if (typeof raw.model !== 'string' || raw.model.trim().length === 0) continue
        const baseURL = raw.baseURL.replace(/\/+$/, '')
        const model = raw.model.trim()
        const provider = isLlmProvider(raw.provider) ? raw.provider : inferLlmProvider(baseURL)
        const id = typeof raw.id === 'string' && raw.id.trim().length > 0 ? raw.id.trim() : newProfileId()
        const name = typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim().slice(0, 60) : model
        const profile: SvLlmProfile = {
          id,
          name,
          provider,
          baseURL,
          model,
          apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
        }
        const contextWindow = positiveInt(raw.contextWindow)
        if (contextWindow !== undefined) profile.contextWindow = contextWindow
        const maxTokens = positiveInt(raw.maxTokens)
        if (maxTokens !== undefined) profile.maxTokens = maxTokens
        models.push(profile)
      }
      if (models.length > 0) {
        this.state.models = models
        const requested = typeof record.activeModelId === 'string' ? record.activeModelId : ''
        const active = models.find(profile => profile.id === requested) ?? models[0]!
        this.state.activeModelId = active.id
        this.state.llm = profileConfig(active)
      }
    }
    if (typeof record.superAgent === 'object' && record.superAgent !== null) {
      const superAgent = record.superAgent
      if (typeof superAgent.enabled === 'boolean') this.state.superAgent.enabled = superAgent.enabled
      const maxConcurrency = rangedInt(superAgent.maxConcurrency, 1, 8)
      if (maxConcurrency !== undefined) this.state.superAgent.maxConcurrency = maxConcurrency
      const maxSubtasks = rangedInt(superAgent.maxSubtasks, 1, 12)
      if (maxSubtasks !== undefined) this.state.superAgent.maxSubtasks = maxSubtasks
      const workerTimeoutMs = rangedInt(superAgent.workerTimeoutMs, 1_000, 3_600_000)
      if (workerTimeoutMs !== undefined) this.state.superAgent.workerTimeoutMs = workerTimeoutMs
      const retryAttempts = rangedInt(superAgent.retryAttempts, 0, 5)
      if (retryAttempts !== undefined) this.state.superAgent.retryAttempts = retryAttempts
      const watchdogIntervalMs = rangedInt(superAgent.watchdogIntervalMs, 100, 60_000)
      if (watchdogIntervalMs !== undefined) this.state.superAgent.watchdogIntervalMs = watchdogIntervalMs
    }
    if (typeof record.search === 'object' && record.search !== null) {
      const search = record.search
      if (search.provider === 'tavily' || search.provider === 'bocha' || search.provider === 'deepseek') {
        this.state.search.provider = search.provider
      }
      if (typeof search.baseURL === 'string' && isHttpUrl(search.baseURL)) this.state.search.baseURL = search.baseURL.replace(/\/+$/, '')
      if (typeof search.apiKey === 'string' && search.apiKey.trim().length > 0) this.state.search.apiKey = search.apiKey.trim()
      if (typeof search.freshness === 'string') {
        const value = search.freshness.trim()
        if (value.length > 0) this.state.search.freshness = value
        else delete this.state.search.freshness
      }
      const retryAttempts = positiveInt(search.retryAttempts)
      if (retryAttempts !== undefined) this.state.search.retryAttempts = retryAttempts
      const timeoutMs = positiveInt(search.timeoutMs)
      if (timeoutMs !== undefined) this.state.search.timeoutMs = timeoutMs
      const budgetMs = positiveInt(search.budgetMs)
      if (budgetMs !== undefined) this.state.search.budgetMs = budgetMs
    }
    if (typeof record.mail === 'object' && record.mail !== null) {
      const mail = record.mail
      if (typeof mail.enabled === 'boolean') this.state.mail.enabled = mail.enabled
      if (typeof mail.host === 'string' && mail.host.trim().length > 0) this.state.mail.host = mail.host.trim()
      const port = positiveInt(mail.port)
      if (port !== undefined && port <= 65535) this.state.mail.port = port
      if (typeof mail.secure === 'boolean') this.state.mail.secure = mail.secure
      if (typeof mail.user === 'string' && mail.user.trim().length > 0) this.state.mail.user = mail.user.trim()
      if (typeof mail.password === 'string' && mail.password.trim().length > 0) this.state.mail.password = mail.password.trim()
      if (typeof mail.from === 'string' && mail.from.trim().length > 0) this.state.mail.from = mail.from.trim()
      if (typeof mail.to === 'string' && mail.to.trim().length > 0) this.state.mail.to = mail.to.trim()
      if (typeof mail.notifyOnReminder === 'boolean') this.state.mail.notifyOnReminder = mail.notifyOnReminder
      if (typeof mail.digestAt === 'string' && DIGEST_TIME_RE.test(mail.digestAt.trim())) {
        this.state.mail.digestAt = mail.digestAt.trim()
      }
    }
    if (typeof record.briefing === 'object' && record.briefing !== null) {
      const briefing = record.briefing
      if (typeof briefing.enabled === 'boolean') this.state.briefing.enabled = briefing.enabled
      if (typeof briefing.time === 'string') {
        const value = briefing.time.trim()
        if (DIGEST_TIME_RE.test(value)) this.state.briefing.time = value
      }
      if (typeof briefing.email === 'boolean') this.state.briefing.email = briefing.email
    }
    if (typeof record.automations === 'object' && record.automations !== null) {
      const automation = record.automations
      if (typeof automation.paused === 'boolean') this.state.automations.paused = automation.paused
      if (typeof automation.quietStart === 'string') {
        const value = automation.quietStart.trim()
        if (value.length === 0) this.state.automations.quietStart = ''
        else if (DIGEST_TIME_RE.test(value)) this.state.automations.quietStart = value
      }
      if (typeof automation.quietEnd === 'string') {
        const value = automation.quietEnd.trim()
        if (value.length === 0) this.state.automations.quietEnd = ''
        else if (DIGEST_TIME_RE.test(value)) this.state.automations.quietEnd = value
      }
      const retryAttempts = rangedInt(automation.retryAttempts, 0, 5)
      if (retryAttempts !== undefined) this.state.automations.retryAttempts = retryAttempts
    }
    if (typeof record.usage === 'object' && record.usage !== null) {
      const usage = record.usage
      const inputPerMillion = nonNegativeNumber(usage.inputPerMillion)
      if (inputPerMillion !== undefined) this.state.usage.inputPerMillion = inputPerMillion
      const outputPerMillion = nonNegativeNumber(usage.outputPerMillion)
      if (outputPerMillion !== undefined) this.state.usage.outputPerMillion = outputPerMillion
      const monthlyTokenBudget = nonNegativeNumber(usage.monthlyTokenBudget)
      if (monthlyTokenBudget !== undefined) this.state.usage.monthlyTokenBudget = monthlyTokenBudget
    }
  }

  /**
   * 应用一份补丁并持久化。apiKey 缺省表示“不变”；空字符串表示清除。
   * @param patch - 待应用的字段补丁。
   * @returns 应用后的脱敏状态。
   */
  async update(patch: {
    llm?: { provider?: unknown; baseURL?: unknown; model?: unknown; apiKey?: unknown; contextWindow?: unknown; maxTokens?: unknown }
    /** 快速切换：直接指定生效的模型配置 id。 */
    activeModelId?: unknown
    /** 设置页保存：整体替换模型配置列表（缺省 apiKey 时按同 id 保留原密钥）。 */
    llmModels?: { models?: unknown; activeModelId?: unknown }
    superAgent?: {
      enabled?: unknown
      maxConcurrency?: unknown
      maxSubtasks?: unknown
      workerTimeoutMs?: unknown
      retryAttempts?: unknown
      watchdogIntervalMs?: unknown
    }
    search?: { baseURL?: unknown; apiKey?: unknown; provider?: unknown; freshness?: unknown; retryAttempts?: unknown; timeoutMs?: unknown; budgetMs?: unknown }
    mail?: {
      enabled?: unknown
      host?: unknown
      port?: unknown
      secure?: unknown
      user?: unknown
      password?: unknown
      from?: unknown
      to?: unknown
      notifyOnReminder?: unknown
      digestAt?: unknown
    }
    briefing?: { enabled?: unknown; time?: unknown; email?: unknown }
    automations?: { paused?: unknown; quietStart?: unknown; quietEnd?: unknown; retryAttempts?: unknown }
    usage?: { inputPerMillion?: unknown; outputPerMillion?: unknown; monthlyTokenBudget?: unknown }
  }): Promise<SvPublicState> {
    if (patch.llm !== undefined) {
      const { llm } = patch
      if (llm.provider !== undefined) {
        if (!isLlmProvider(llm.provider)) throw new Error('LLM provider 必须是 deepseek / qwen / ark / openai / custom')
        const next = llm.provider
        if (next !== this.state.llm.provider) {
          // 切换预设：同一补丁未显式给出端点/模型时，用预设默认值回填
          const preset = next === 'custom' ? undefined : SV_LLM_PRESETS[next]
          if (llm.baseURL === undefined && preset !== undefined) this.state.llm.baseURL = preset.baseURL
          if (llm.model === undefined && preset !== undefined) this.state.llm.model = preset.model
        }
        this.state.llm.provider = next
      }
      if (llm.baseURL !== undefined) {
        const value = String(llm.baseURL ?? '').trim().replace(/\/+$/, '')
        if (!isHttpUrl(value)) throw new Error('LLM baseURL 必须是 http(s) URL')
        this.state.llm.baseURL = value
      }
      if (llm.model !== undefined) {
        const value = String(llm.model ?? '').trim()
        if (value.length === 0) throw new Error('模型 id 不能为空')
        if (value.length > 200) throw new Error('模型 id 过长')
        this.state.llm.model = value
      }
      if (llm.apiKey !== undefined) {
        const value = String(llm.apiKey ?? '').trim()
        if (value.length > 4096) throw new Error('API key 过长')
        this.state.llm.apiKey = value
      }
      if (llm.contextWindow !== undefined) {
        if (llm.contextWindow === null) {
          delete this.state.llm.contextWindow
        } else {
          const value = positiveInt(llm.contextWindow)
          if (value === undefined) throw new Error('contextWindow 必须是正整数')
          this.state.llm.contextWindow = value
        }
      }
      if (llm.maxTokens !== undefined) {
        if (llm.maxTokens === null) {
          delete this.state.llm.maxTokens
        } else {
          const value = positiveInt(llm.maxTokens)
          if (value === undefined) throw new Error('maxTokens 必须是正整数')
          this.state.llm.maxTokens = value
        }
      }
    }
    // llm 补丁只改「当前生效」条目，随后同步回模型列表
    this.syncActiveProfile()
    if (patch.llmModels !== undefined) {
      const { models: rawModels, activeModelId: rawActive } = patch.llmModels
      if (rawModels !== undefined) {
        if (!Array.isArray(rawModels) || rawModels.length === 0) throw new Error('至少保留一个模型配置')
        if (rawModels.length > 20) throw new Error('模型配置不能超过 20 个')
        const existing = new Map(this.state.models.map(profile => [profile.id, profile]))
        const next: SvLlmProfile[] = []
        const used = new Set<string>()
        for (const item of rawModels) {
          if (typeof item !== 'object' || item === null) throw new Error('模型配置格式错误')
          const raw = item as Record<string, unknown>
          const id = typeof raw.id === 'string' && raw.id.trim().length > 0 ? raw.id.trim() : newProfileId()
          if (used.has(id)) throw new Error('模型配置 id 重复')
          used.add(id)
          const previous = existing.get(id)
          const provider = raw.provider === undefined ? previous?.provider ?? 'custom' : raw.provider
          if (!isLlmProvider(provider)) throw new Error('LLM provider 必须是 deepseek / qwen / ark / openai / custom')
          const baseURL = raw.baseURL === undefined
            ? previous?.baseURL ?? ''
            : String(raw.baseURL ?? '').trim().replace(/\/+$/, '')
          if (!isHttpUrl(baseURL)) throw new Error('LLM baseURL 必须是 http(s) URL')
          const model = raw.model === undefined ? previous?.model ?? '' : String(raw.model ?? '').trim()
          if (model.length === 0) throw new Error('模型 id 不能为空')
          if (model.length > 200) throw new Error('模型 id 过长')
          const apiKey = raw.apiKey === undefined ? previous?.apiKey ?? '' : String(raw.apiKey ?? '').trim()
          if (apiKey.length > 4096) throw new Error('API key 过长')
          const rawName = raw.name === undefined ? previous?.name ?? model : String(raw.name ?? '').trim()
          const profile: SvLlmProfile = {
            id,
            name: (rawName.length > 0 ? rawName : model).slice(0, 60),
            provider,
            baseURL,
            model,
            apiKey,
          }
          if (raw.contextWindow === undefined) {
            if (previous?.contextWindow !== undefined) profile.contextWindow = previous.contextWindow
          } else if (raw.contextWindow !== null) {
            const value = positiveInt(raw.contextWindow)
            if (value === undefined) throw new Error('contextWindow 必须是正整数')
            profile.contextWindow = value
          }
          if (raw.maxTokens === undefined) {
            if (previous?.maxTokens !== undefined) profile.maxTokens = previous.maxTokens
          } else if (raw.maxTokens !== null) {
            const value = positiveInt(raw.maxTokens)
            if (value === undefined) throw new Error('maxTokens 必须是正整数')
            profile.maxTokens = value
          }
          next.push(profile)
        }
        this.state.models = next
        const requested = typeof rawActive === 'string' && rawActive.trim().length > 0
          ? rawActive.trim()
          : this.state.activeModelId
        const active = next.find(profile => profile.id === requested) ?? next[0]!
        this.state.activeModelId = active.id
        this.state.llm = profileConfig(active)
      } else if (rawActive !== undefined) {
        this.activateProfile(rawActive)
      }
    }
    if (patch.activeModelId !== undefined) this.activateProfile(patch.activeModelId)
    if (patch.superAgent !== undefined) {
      const superAgent = patch.superAgent
      if (superAgent.enabled !== undefined) {
        if (typeof superAgent.enabled !== 'boolean') throw new Error('Super-agent 开关必须是布尔值')
        this.state.superAgent.enabled = superAgent.enabled
      }
      const limits: Array<[
        key: 'maxConcurrency' | 'maxSubtasks' | 'workerTimeoutMs' | 'retryAttempts' | 'watchdogIntervalMs',
        min: number,
        max: number,
        label: string,
      ]> = [
        ['maxConcurrency', 1, 8, '并发数'],
        ['maxSubtasks', 1, 12, '子任务上限'],
        ['workerTimeoutMs', 1_000, 3_600_000, '单次超时（ms）'],
        ['retryAttempts', 0, 5, '重试次数'],
        ['watchdogIntervalMs', 100, 60_000, '巡检间隔（ms）'],
      ]
      for (const [key, min, max, label] of limits) {
        const raw = superAgent[key]
        if (raw === undefined) continue
        const value = rangedInt(raw, min, max)
        if (value === undefined) throw new Error(`Super-agent ${label}必须是 ${min}–${max} 的整数`)
        this.state.superAgent[key] = value
      }
    }
    if (patch.search !== undefined) {
      const search = patch.search
      if (search.provider !== undefined) {
        if (search.provider !== 'tavily' && search.provider !== 'bocha' && search.provider !== 'deepseek') {
          throw new Error('搜索 provider 必须是 tavily、bocha 或 deepseek')
        }
        this.state.search.provider = search.provider
      }
      if (search.baseURL !== undefined) {
        const value = String(search.baseURL ?? '').trim().replace(/\/+$/, '')
        if (!isHttpUrl(value)) throw new Error('搜索 baseURL 必须是 http(s) URL')
        this.state.search.baseURL = value
      }
      if (search.apiKey !== undefined) {
        const value = String(search.apiKey ?? '').trim()
        if (value.length > 4096) throw new Error('API key 过长')
        this.state.search.apiKey = value
      }
      if (search.freshness !== undefined) {
        if (search.freshness === null) {
          delete this.state.search.freshness
        } else {
          const value = String(search.freshness).trim()
          if (value.length > 0) this.state.search.freshness = value
          else delete this.state.search.freshness
        }
      }
      const optionalPositive: Array<[key: 'retryAttempts' | 'timeoutMs' | 'budgetMs', label: string]> = [
        ['retryAttempts', '重试次数'],
        ['timeoutMs', '单次超时'],
        ['budgetMs', '重试预算'],
      ]
      for (const [key, label] of optionalPositive) {
        const raw = search[key]
        if (raw === undefined) continue
        if (raw === null) {
          delete this.state.search[key]
          continue
        }
        const value = positiveInt(raw)
        if (value === undefined) throw new Error(`搜索 ${label} 必须是正整数`)
        this.state.search[key] = value
      }
    }
    if (patch.mail !== undefined) {
      const mail = patch.mail
      const booleanField: Array<[key: 'enabled' | 'secure' | 'notifyOnReminder', label: string]> = [
        ['enabled', '启用开关'],
        ['secure', 'SSL 开关'],
        ['notifyOnReminder', '到期提醒开关'],
      ]
      for (const [key, label] of booleanField) {
        const raw = mail[key]
        if (raw === undefined) continue
        if (typeof raw !== 'boolean') throw new Error(`邮件 ${label} 必须是布尔值`)
        this.state.mail[key] = raw
      }
      const textField: Array<[key: 'host' | 'user' | 'password' | 'from' | 'to', label: string, max: number]> = [
        ['host', 'SMTP 主机', 200],
        ['user', '账号', 200],
        ['password', '应用密码', 512],
        ['from', '发件人', 320],
        ['to', '收件人', 1000],
      ]
      for (const [key, label, max] of textField) {
        const raw = mail[key]
        if (raw === undefined) continue
        const value = String(raw ?? '').trim()
        if (value.length > max) throw new Error(`邮件 ${label} 过长`)
        if (/[\r\n]/.test(value)) throw new Error(`邮件 ${label} 不能包含换行`)
        this.state.mail[key] = value
      }
      if (mail.port !== undefined) {
        const value = positiveInt(mail.port)
        if (value === undefined || value > 65535) throw new Error('邮件端口必须是 1–65535 的整数')
        this.state.mail.port = value
      }
      if (mail.digestAt !== undefined) {
        const value = mail.digestAt === null ? '' : String(mail.digestAt).trim()
        if (value.length > 0 && !DIGEST_TIME_RE.test(value)) throw new Error('每日摘要时间必须是 HH:mm（如 08:30）')
        this.state.mail.digestAt = value
      }
      // 发件人/收件人留空时回落到账号，与 mailer.py 的解析保持一致
      if (this.state.mail.from.length === 0) this.state.mail.from = this.state.mail.user
      if (this.state.mail.to.length === 0) this.state.mail.to = this.state.mail.user
    }
    if (patch.briefing !== undefined) {
      const briefing = patch.briefing
      if (briefing.enabled !== undefined) {
        if (typeof briefing.enabled !== 'boolean') throw new Error('简报启用开关必须是布尔值')
        this.state.briefing.enabled = briefing.enabled
      }
      if (briefing.time !== undefined) {
        const value = briefing.time === null ? '' : String(briefing.time).trim()
        if (value.length > 0 && !DIGEST_TIME_RE.test(value)) throw new Error('每日简报时间必须是 HH:mm（如 08:30）')
        this.state.briefing.time = value
      }
      if (briefing.email !== undefined) {
        if (typeof briefing.email !== 'boolean') throw new Error('简报邮件开关必须是布尔值')
        this.state.briefing.email = briefing.email
      }
    }
    if (patch.automations !== undefined) {
      const automation = patch.automations
      if (automation.paused !== undefined) {
        if (typeof automation.paused !== 'boolean') throw new Error('自动化暂停开关必须是布尔值')
        this.state.automations.paused = automation.paused
      }
      for (const [key, label] of [['quietStart', '静默开始'], ['quietEnd', '静默结束']] as const) {
        const raw = automation[key]
        if (raw === undefined) continue
        const value = raw === null ? '' : String(raw).trim()
        if (value.length > 0 && !DIGEST_TIME_RE.test(value)) throw new Error(`静默${label}时间必须是 HH:mm（如 22:00）`)
        this.state.automations[key] = value
      }
      if (automation.retryAttempts !== undefined) {
        const value = rangedInt(automation.retryAttempts, 0, 5)
        if (value === undefined) throw new Error('自动化重试次数必须是 0–5 的整数')
        this.state.automations.retryAttempts = value
      }
    }
    if (patch.usage !== undefined) {
      const usage = patch.usage
      for (const [key, label] of [
        ['inputPerMillion', '输入单价'],
        ['outputPerMillion', '输出单价'],
        ['monthlyTokenBudget', '月度预算'],
      ] as const) {
        const raw = usage[key]
        if (raw === undefined) continue
        if (raw === null) {
          this.state.usage[key] = 0
          continue
        }
        const value = nonNegativeNumber(raw)
        if (value === undefined) throw new Error(`${label}必须是非负数字`)
        this.state.usage[key] = value
      }
    }
    await this.persist()
    return this.publicState()
  }

  /** 脱敏状态（不含密钥明文）。 */
  publicState(): SvPublicState {
    return {
      llm: {
        provider: this.state.llm.provider,
        baseURL: this.state.llm.baseURL,
        model: this.state.llm.model,
        hasApiKey: this.state.llm.apiKey.length > 0,
        ...this.state.llm.contextWindow === undefined ? {} : { contextWindow: this.state.llm.contextWindow },
        ...this.state.llm.maxTokens === undefined ? {} : { maxTokens: this.state.llm.maxTokens },
      },
      llmModels: this.modelViews(),
      activeModelId: this.state.activeModelId,
      superAgent: { ...this.state.superAgent },
      search: {
        provider: this.state.search.provider,
        baseURL: this.state.search.baseURL,
        // deepseek 官方搜索复用模型 Key，未单独配置也算「可用」
        hasApiKey: this.state.search.apiKey.length > 0
          || (this.state.search.provider === 'deepseek' && this.state.llm.apiKey.length > 0),
        ...this.state.search.freshness === undefined ? {} : { freshness: this.state.search.freshness },
        ...this.state.search.retryAttempts === undefined ? {} : { retryAttempts: this.state.search.retryAttempts },
        ...this.state.search.timeoutMs === undefined ? {} : { timeoutMs: this.state.search.timeoutMs },
        ...this.state.search.budgetMs === undefined ? {} : { budgetMs: this.state.search.budgetMs },
      },
      mail: {
        enabled: this.state.mail.enabled,
        host: this.state.mail.host,
        port: this.state.mail.port,
        secure: this.state.mail.secure,
        user: this.state.mail.user,
        hasPassword: this.state.mail.password.length > 0,
        from: this.state.mail.from,
        to: this.state.mail.to,
        notifyOnReminder: this.state.mail.notifyOnReminder,
        digestAt: this.state.mail.digestAt,
      },
      briefing: { ...this.state.briefing },
      automations: { ...this.state.automations },
      usage: { ...this.state.usage },
    }
  }

  private async persist(): Promise<void> {
    const dir = svDataDir()
    await mkdir(dir, { recursive: true })
    const target = this.file
    const temp = `${target}.tmp`
    await writeFile(temp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, target)
  }
}
