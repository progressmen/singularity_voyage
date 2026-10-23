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
import { homedir } from 'node:os'
import { join } from 'node:path'

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

/** Web 搜索提供方支持的协议类型。 */
export type SvSearchProviderKind = 'tavily' | 'bocha'

/** Web 搜索提供方配置（Tavily 兼容或博查原生 API）。 */
export interface SvSearchConfig {
  /** 搜索 API 协议类型，决定请求形状与认证方式。 */
  provider: SvSearchProviderKind
  /** 搜索 API 根地址（tavily: https://api.tavily.com；bocha: https://api.bochaai.com）。 */
  baseURL: string
  /** API 密钥；空字符串表示未配置。 */
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

/** 邮件通道配置（SMTP）。 */
export interface SvMailConfig {
  /** 是否启用邮件通道（提醒与摘要都受它控制）。 */
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
  llm: SvLlmConfig
  search: SvSearchConfig
  mail: SvMailConfig
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

export class ConfigStore {
  private state: SvStoreShape

  constructor(defaults: { llm: SvLlmConfig; search: SvSearchConfig; mail?: SvMailConfig }) {
    this.state = {
      llm: { ...defaults.llm },
      search: { ...defaults.search },
      mail: { ...defaultMailConfig(), ...defaults.mail },
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
    const record = parsed as Partial<{ llm: Partial<SvLlmConfig>; search: Partial<SvSearchConfig>; mail: Partial<SvMailConfig> }>
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
    if (typeof record.search === 'object' && record.search !== null) {
      const search = record.search
      if (search.provider === 'tavily' || search.provider === 'bocha') this.state.search.provider = search.provider
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
  }

  /**
   * 应用一份补丁并持久化。apiKey 缺省表示“不变”；空字符串表示清除。
   * @param patch - 待应用的字段补丁。
   * @returns 应用后的脱敏状态。
   */
  async update(patch: {
    llm?: { provider?: unknown; baseURL?: unknown; model?: unknown; apiKey?: unknown; contextWindow?: unknown; maxTokens?: unknown }
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
    if (patch.search !== undefined) {
      const search = patch.search
      if (search.provider !== undefined) {
        if (search.provider !== 'tavily' && search.provider !== 'bocha') throw new Error('搜索 provider 必须是 tavily 或 bocha')
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
      search: {
        provider: this.state.search.provider,
        baseURL: this.state.search.baseURL,
        hasApiKey: this.state.search.apiKey.length > 0,
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
