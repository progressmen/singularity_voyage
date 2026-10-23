/**
 * Singularity Voyage 宿主插件。
 *
 * Cordis 组合形式：
 *  - `ctx.llm.registerAdapter` —— 自定义 OpenAI 兼容 LLM 路由（token/API 可配置）；
 *  - `ctx.web.registerSearchProvider` —— Tavily 兼容搜索提供方（token/API 可配置）；
 *  - `ctx.agents` —— SV 聊天会话的创建/恢复与事件转发；
 *  - `ctx.webServer` —— /sv 前端页面与 API。
 *
 * 非密钥配置经组合包 patch 行注入（支持 SV_LLM_BASE_URL 等环境变量）；
 * 密钥只进入 $DSH_HOME/sv/config.json 或 SV_*_API_KEY 环境变量。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { ChatManager } from './chat.ts'
import { ConfigStore, inferLlmProvider, type SvLlmProviderId, type SvMailConfig } from './config-store.ts'
import { registerSvRoutes } from './http.ts'
import { SV_PROVIDER_ID, SvOpenAiCompatAdapter } from './llm-adapter.ts'
import { svError, svErrorTrace, svLog, installSvLogSink } from './log.ts'
import { MailNotifier } from './mail-notifier.ts'
import { createMemoryExtractor } from './memory-extractor.ts'
import { MemoryStore } from './memory-store.ts'
import { ReminderService } from './reminders.ts'
import { SvSearchProvider } from './search-provider.ts'
import { SessionStore } from './sessions-store.ts'
import type { SvSessionStore } from './sessions-store.ts'
import { PgSessionStore } from './sessions-postgres.ts'
import { TasksStore } from './tasks-store.ts'
import { registerMemoryTools, registerTaskTools } from './tools.ts'

/** Cordis loader 显示的插件名。 */
export const name = '@singularity-voyage/sv-app'

/** 等待这些服务就绪后再激活（base/web-app 层提供）。 */
export const inject = ['llm', 'web', 'agents', 'webServer', 'tools', 'systemPrompt']

/** 组合包 patch 行注入的非密钥配置。 */
export interface Config {
  /** LLM 供应商预设：deepseek | qwen | ark | openai | custom。 */
  llmProvider?: string
  /** OpenAI 兼容 API 根地址（部署默认值，可被 SV 页面覆盖）。 */
  llmBaseURL: string
  /** 默认模型 id。 */
  llmModel: string
  /** 搜索提供方协议：tavily | bocha（也可经 SV_SEARCH_PROVIDER / WEB_SEARCH_PROVIDER 环境变量给出）。 */
  searchProvider?: string
}

const LLM_PROVIDERS = new Set(['deepseek', 'qwen', 'ark', 'openai', 'custom'])

/** 归一化搜索协议；未知取值回退 tavily（页面设置可改）。 */
function normalizeSearchProvider(value: string | undefined): 'tavily' | 'bocha' {
  return value !== undefined && value.trim().toLowerCase() === 'bocha' ? 'bocha' : 'tavily'
}

/** 归一化 LLM 预设；未知取值按端点反推。 */
function normalizeLlmProvider(value: string | undefined, baseURL: string): SvLlmProviderId {
  const trimmed = value?.trim().toLowerCase()
  if (trimmed !== undefined && LLM_PROVIDERS.has(trimmed)) return trimmed as SvLlmProviderId
  return inferLlmProvider(baseURL)
}

/** 读取正整数环境变量；非法或缺省返回 undefined。 */
function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim().length === 0) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** 读取布尔环境变量：1/true/yes/on 为真，0/false/no/off 为假；缺省回落默认值。 */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase()
  if (raw === undefined || raw.length === 0) return fallback
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false
  return fallback
}

/** 邮件配置的部署默认值（页面保存后以 config.json 为准）。 */
function mailDefaults(): SvMailConfig {
  const user = (process.env.SV_MAIL_USER ?? '').trim()
  const secure = envBool('SV_MAIL_SECURE', true)
  const digestAt = (process.env.SV_MAIL_DIGEST_AT ?? '').trim()
  return {
    enabled: envBool('SV_MAIL_ENABLED', (process.env.SV_MAIL_HOST ?? '').trim().length > 0),
    host: (process.env.SV_MAIL_HOST ?? '').trim(),
    port: envPositiveInt('SV_MAIL_PORT') ?? (secure ? 465 : 587),
    secure,
    user,
    password: process.env.SV_MAIL_PASSWORD ?? '',
    from: (process.env.SV_MAIL_FROM ?? '').trim() || user,
    to: (process.env.SV_MAIL_TO ?? '').trim() || user,
    notifyOnReminder: envBool('SV_MAIL_NOTIFY_ON_REMINDER', true),
    digestAt: /^([01]\d|2[0-3]):[0-5]\d$/.test(digestAt) ? digestAt : '',
  }
}

/**
 * 激活 SV 宿主插件。
 * @param ctx - 插件上下文。
 * @param config - patch 行配置。
 */
export async function apply(ctx: Context, config: Partial<Config> = {}): Promise<void> {
  // dsh 默认不把 logger 输出打到控制台；这里只为 sv-app 自己装一个 stdout 出口。
  installSvLogSink(ctx.logger)

  const baseURL = (config.llmBaseURL ?? process.env.SV_LLM_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  const llmProvider = normalizeLlmProvider(config.llmProvider ?? process.env.SV_LLM_PROVIDER, baseURL)
  const provider = normalizeSearchProvider(config.searchProvider ?? process.env.SV_SEARCH_PROVIDER ?? process.env.WEB_SEARCH_PROVIDER)
  const isBocha = provider === 'bocha'
  const retryAttempts = envPositiveInt('SV_SEARCH_RETRY_ATTEMPTS')
  const searchTimeoutMs = envPositiveInt('SV_SEARCH_API_TIMEOUT_MS')
  const retryBudgetMs = envPositiveInt('SV_SEARCH_RETRY_BUDGET_MS')
  const store = new ConfigStore({
    llm: {
      provider: llmProvider,
      baseURL,
      model: config.llmModel ?? process.env.SV_LLM_MODEL ?? 'deepseek-chat',
      apiKey: process.env.SV_LLM_API_KEY ?? '',
    },
    search: {
      provider,
      baseURL: (isBocha
        ? process.env.SV_SEARCH_BOCHA_BASE_URL ?? 'https://api.bochaai.com'
        : process.env.SV_SEARCH_BASE_URL ?? 'https://api.tavily.com'
      ).replace(/\/+$/, ''),
      apiKey: isBocha
        ? process.env.SV_SEARCH_BOCHA_API_KEY ?? process.env.BOCHA_API_KEY ?? ''
        : process.env.SV_SEARCH_API_KEY ?? '',
      ...(isBocha && process.env.BOCHA_FRESHNESS !== undefined && process.env.BOCHA_FRESHNESS.length > 0
        ? { freshness: process.env.BOCHA_FRESHNESS }
        : {}),
      ...(retryAttempts !== undefined ? { retryAttempts } : {}),
      ...(searchTimeoutMs !== undefined ? { timeoutMs: searchTimeoutMs } : {}),
      ...(retryBudgetMs !== undefined ? { budgetMs: retryBudgetMs } : {}),
    },
    mail: mailDefaults(),
  })
  try {
    await store.load()
  } catch (error) {
    ctx.logger.warn(svLog('index', 'config_load_failed', { err: svError(error) }))
    ctx.logger.debug(svLog('index', 'config_load_failed_trace', { stack: svErrorTrace(error) }))
  }

  const databaseUrl = (process.env.SV_DATABASE_URL ?? process.env.DATABASE_URL ?? '').trim()
  const sessions: SvSessionStore = databaseUrl.length > 0 ? new PgSessionStore(databaseUrl) : new SessionStore()
  try {
    await sessions.load()
  } catch (error) {
    ctx.logger.warn(svLog('index', 'session_index_load_failed', { err: svError(error) }))
  }
  ctx.logger.info(svLog('index', 'session_store_ready', { backend: databaseUrl.length > 0 ? 'postgres' : 'file' }))

  const memory = new MemoryStore()
  try {
    await memory.load()
  } catch (error) {
    ctx.logger.warn(svLog('index', 'memory_load_failed', { err: svError(error) }))
  }

  const tasks = new TasksStore()
  try {
    await tasks.load()
  } catch (error) {
    ctx.logger.warn(svLog('index', 'tasks_load_failed', { err: svError(error) }))
  }

  const reminders = new ReminderService(tasks, (event, fields) => {
    ctx.logger.warn(svLog('reminders', event, fields))
  })
  // 邮件通道：到期提醒在页面弹窗之外再发一封，另按 digestAt 发每日摘要。
  const mailer = new MailNotifier({
    config: () => store.mail,
    tasks,
    log: (event, fields) => ctx.logger.warn(svLog('mail', event, fields)),
  })
  const unsubscribeMail = reminders.subscribe(event => {
    void mailer.notifyReminder(event.task)
  })
  mailer.start()
  reminders.start()
  ctx.effect(() => () => {
    unsubscribeMail()
    mailer.stop()
    reminders.stop()
  })

  ctx.llm.registerAdapter([SV_PROVIDER_ID], new SvOpenAiCompatAdapter(() => store.llm))
  ctx.web.registerSearchProvider(new SvSearchProvider(() => store.search))

  registerMemoryTools(ctx, memory)
  registerTaskTools(ctx, tasks)

  // 每轮 Prompt 组装时注入记忆与待办（system-prompt 注册表，作用于全部会话）。
  const recallQuery = (context: { agent?: { id: unknown } }): string =>
    chat.latestUserText(context.agent === undefined ? undefined : String(context.agent.id))
  ctx.systemPrompt.section({
    name: 'sv:memory-recall',
    order: 9500,
    interpolate: false,
    text: context => {
      const blocks = [
        tasks.promptBlock(),
        memory.promptBlock(recallQuery(context)),
      ].filter(block => block.length > 0)
      return blocks.join('\n\n')
    },
  })

  // turn 结束后异步抽取记忆；失败只告警，不影响对话。
  const extract = createMemoryExtractor(ctx, () => ({ provider: SV_PROVIDER_ID, model: store.llm.model }))
  const chat = new ChatManager(ctx, store, sessions, {
    onTurnComplete({ sessionId, userText, assistantText }) {
      void extract({ userText, assistantText })
        .then(candidates => (candidates.length === 0 ? undefined : memory.remember(candidates, { sessionId, note: 'auto-extract' })))
        .then(written => {
          if (written !== undefined && written.length > 0) {
            ctx.logger.info(svLog('memory', 'memory_extracted', { sessionId, count: written.length }))
          }
        })
        .catch(error => {
          ctx.logger.warn(svLog('memory', 'memory_extract_failed', { sessionId, err: svError(error) }))
        })
    },
  })
  registerSvRoutes(ctx, chat, store, sessions, memory, tasks, reminders, mailer)
  ctx.logger.info(svLog('index', 'surface_ready', { path: '/sv/' }))
}
