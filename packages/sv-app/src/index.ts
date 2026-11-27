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
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { ApprovalCenter, type HostApprovalRequest } from './approval-center.ts'
import { AuthStore } from './auth.ts'
import { ApprovalStore } from './approval-store.ts'
import { ConnectorService } from './connector-runtime.ts'
import { ConnectorStore } from './connector-store.ts'
import { BriefingService, BRIEFING_SYSTEM, buildBriefingPrompt } from './briefing.ts'
import { createAutomationPromptRunner } from './automation-agent.ts'
import { AutomationService } from './automation-runtime.ts'
import { AutomationStore } from './automation-store.ts'
import { ChatManager } from './chat.ts'
import { ConfigStore, defaultTtsConfig, inferLlmProvider, type SvBriefingConfig, type SvLlmProviderId, type SvMailConfig } from './config-store.ts'
import { registerSvRoutes, type SvToolView } from './http.ts'
import { SkillManager } from './skill-manager.ts'
import { InboxStore, INBOX_KIND_LABELS } from './inbox-store.ts'
import { KnowledgeStore } from './knowledge-store.ts'
import { fetchUrlPage } from './knowledge-source.ts'
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
import { resolveSuperAgentConfig } from './superagent.ts'
import { createSuperAgentRuntime } from './superagent-runtime.ts'
import { SuperAgentRunStore } from './superagent-store.ts'
import { TasksStore, formatTaskTime } from './tasks-store.ts'
import { normalizeTtsUrl, type SvTtsConfig } from './tts.ts'
import { UsageStore } from './usage-store.ts'
import { registerAutomationTools, registerDesktopGuard, registerImageTools, registerInboxTools, registerKnowledgeTools, registerMemoryTools, registerTaskTools } from './tools.ts'

/** Cordis loader 显示的插件名。 */
export const name = '@singularity-voyage/sv-app'

/** 等待这些服务就绪后再激活（base/web-app 层提供）。 */
export const inject = ['llm', 'web', 'agents', 'webServer', 'tools', 'systemPrompt', 'schedule', 'approval']

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
  /** Super-agent 开关；缺省读 SV_SUPERAGENT_ENABLED，默认关闭。 */
  superAgent?: boolean
  /** Super-agent Worker 并发上限（默认 3）。 */
  superAgentMaxConcurrency?: number
  /** Router 单轮最多拆出的子任务数（默认 8）。 */
  superAgentMaxSubtasks?: number
  /** 单个 Worker 单次尝试的超时毫秒（默认 180000）。 */
  superAgentWorkerTimeoutMs?: number
  /** Worker 失败后的额外重试次数（默认 1）。 */
  superAgentRetryAttempts?: number
  /** watchdog 巡检间隔毫秒（默认 5000）。 */
  superAgentWatchdogIntervalMs?: number
}

const LLM_PROVIDERS = new Set(['deepseek', 'qwen', 'ark', 'openai', 'custom'])

/** 归一化搜索协议；unknown 取值回退 tavily（页面设置可改）。 */
function normalizeSearchProvider(value: string | undefined): 'tavily' | 'bocha' | 'deepseek' {
  const provider = value?.trim().toLowerCase()
  if (provider === 'bocha') return 'bocha'
  if (provider === 'deepseek') return 'deepseek'
  return 'tavily'
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

/** 每日简报的部署默认值（页面保存后以 config.json 为准）。 */
function briefingDefaults(): SvBriefingConfig {
  const time = (process.env.SV_BRIEFING_AT ?? '08:30').trim()
  return {
    enabled: envBool('SV_BRIEFING_ENABLED', true),
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : '08:30',
    email: envBool('SV_BRIEFING_EMAIL', false),
  }
}

/** 语音合成的部署默认值（页面保存后以 config.json 为准）。 */
function ttsDefaults(): SvTtsConfig {
  const base = defaultTtsConfig()
  const model = (process.env.SV_TTS_MODEL ?? '').trim()
  const voice = (process.env.SV_TTS_VOICE ?? '').trim()
  const rate = Number(process.env.SV_TTS_RATE ?? '')
  return {
    baseURL: normalizeTtsUrl(process.env.SV_TTS_BASE_URL ?? '') ?? base.baseURL,
    model: model.length > 0 ? model : base.model,
    voice: voice.length > 0 ? voice : base.voice,
    rate: Number.isFinite(rate) && rate >= 0.5 && rate <= 2 ? rate : base.rate,
    apiKey: process.env.SV_TTS_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '',
  }
}

/** 收件箱条目标题：取文本首行并截断，避免把整段回复塞进列表。 */
function inboxTitle(prefix: string, text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return `${prefix}${line.length === 0 ? '（无文本输出）' : line.length <= 40 ? line : `${line.slice(0, 40)}…`}`
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
  const requestedSearch = config.searchProvider ?? process.env.SV_SEARCH_PROVIDER ?? process.env.WEB_SEARCH_PROVIDER
  // 未显式配置搜索协议时：DeepSeek 模型默认走官方 Search API（复用模型 Key）
  const provider = requestedSearch === undefined || requestedSearch.trim().length === 0
    ? (llmProvider === 'deepseek' ? 'deepseek' : 'tavily')
    : normalizeSearchProvider(requestedSearch)
  const isBocha = provider === 'bocha'
  const isDeepSeekSearch = provider === 'deepseek'
  const retryAttempts = envPositiveInt('SV_SEARCH_RETRY_ATTEMPTS')
  const searchTimeoutMs = envPositiveInt('SV_SEARCH_API_TIMEOUT_MS')
  const retryBudgetMs = envPositiveInt('SV_SEARCH_RETRY_BUDGET_MS')
  // Super-agent 的启动默认值仍支持 patch / 环境变量；页面保存后以 config.json 为准
  const superAgentDefaults = resolveSuperAgentConfig(config)
  const store = new ConfigStore({
    llm: {
      provider: llmProvider,
      baseURL,
      model: config.llmModel ?? process.env.SV_LLM_MODEL ?? 'deepseek-chat',
      apiKey: process.env.SV_LLM_API_KEY ?? '',
    },
    search: {
      provider,
      // SV_SEARCH_BASE_URL 是 Tavily 兼容端点的覆盖项；DeepSeek 官方搜索默认 api.deepseek.com
      baseURL: (isBocha
        ? process.env.SV_SEARCH_BOCHA_BASE_URL ?? 'https://api.bochaai.com'
        : isDeepSeekSearch
          ? 'https://api.deepseek.com'
          : process.env.SV_SEARCH_BASE_URL ?? 'https://api.tavily.com'
      ).replace(/\/+$/, ''),
      apiKey: isBocha
        ? process.env.SV_SEARCH_BOCHA_API_KEY ?? process.env.BOCHA_API_KEY ?? ''
        : isDeepSeekSearch
          // 独立搜索密钥可选；留空时运行期回落到模型 API Key
          ? process.env.DEEPSEEK_API_KEY ?? ''
          : process.env.SV_SEARCH_API_KEY ?? '',
      ...(isBocha && process.env.BOCHA_FRESHNESS !== undefined && process.env.BOCHA_FRESHNESS.length > 0
        ? { freshness: process.env.BOCHA_FRESHNESS }
        : {}),
      ...(retryAttempts !== undefined ? { retryAttempts } : {}),
      ...(searchTimeoutMs !== undefined ? { timeoutMs: searchTimeoutMs } : {}),
      ...(retryBudgetMs !== undefined ? { budgetMs: retryBudgetMs } : {}),
    },
    mail: mailDefaults(),
    briefing: briefingDefaults(),
    tts: ttsDefaults(),
    superAgent: superAgentDefaults,
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

  // 账号与登录态同样落在 PostgreSQL；未配置数据库时跳过登录校验（页面隐藏退出入口）。
  const auth = databaseUrl.length > 0 ? new AuthStore(databaseUrl) : undefined
  if (auth === undefined) {
    ctx.logger.warn(svLog('index', 'auth_disabled', { reason: 'SV_DATABASE_URL 未配置' }))
  } else {
    ctx.effect(() => () => {
      void auth.close()
    })
    try {
      await auth.load()
      ctx.logger.info(svLog('index', 'auth_store_ready'))
    } catch (error) {
      // 数据库暂不可用时保留登录校验，下一次登录请求会重试建表。
      ctx.logger.warn(svLog('index', 'auth_store_load_failed', { err: svError(error) }))
      ctx.logger.debug(svLog('index', 'auth_store_load_failed_trace', { stack: svErrorTrace(error) }))
    }
  }

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

  // 收件箱：每日简报、到期提醒与后台任务结果的统一落点。
  const inbox = new InboxStore()
  try {
    await inbox.load()
  } catch (error) {
    ctx.logger.warn(svLog('index', 'inbox_load_failed', { err: svError(error) }))
  }

  // 个人知识库：笔记/文件/网页导入后的本地检索与引用来源。
  const knowledge = new KnowledgeStore()
  try {
    await knowledge.load()
  } catch (error) {
    ctx.logger.warn(svLog('index', 'knowledge_load_failed', { err: svError(error) }))
  }

  // 自动化：网页变化 / 关键词监控 / 定时任务。
  const automations = new AutomationStore()
  try {
    await automations.load()
  } catch (error) {
    ctx.logger.warn(svLog('index', 'automations_load_failed', { err: svError(error) }))
  }

  // 本地用量统计：每次模型请求的 token 消耗按天/按模型累计。
  const usage = new UsageStore()
  try {
    await usage.load()
  } catch (error) {
    ctx.logger.warn(svLog('index', 'usage_load_failed', { err: svError(error) }))
  }

  // 审批审计：记录工具操作的一次性授权与结果。
  const approvals = new ApprovalStore()
  try {
    await approvals.load()
  } catch (error) {
    ctx.logger.warn(svLog('index', 'approval_load_failed', { err: svError(error) }))
  }
  try {
    const stale = await approvals.failPending()
    if (stale > 0) ctx.logger.info(svLog('approval', 'approval_stale_cleared', { count: stale }))
  } catch (error) {
    ctx.logger.warn(svLog('approval', 'approval_stale_failed', { err: svError(error) }))
  }
  const approvalCenter = new ApprovalCenter(approvals, {
    log: (event, fields) => {
      if (event.endsWith('_unavailable')) ctx.logger.warn(svLog('approval', event, fields))
      else ctx.logger.info(svLog('approval', event, fields))
    },
  })
  // 宿主审批瀑布：前置 answerer，页面在线时等待用户回答，否则 fail-closed。
  const offApproval = (ctx.on as unknown as (
    name: string,
    handler: (request: HostApprovalRequest) => Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>,
    options?: { prepend?: boolean },
  ) => () => void)('approval/request', request => approvalCenter.request(request), { prepend: true })
  ctx.effect(() => offApproval)

  // 只读连接器：邮件 / 日历 / Slack / Notion / RSS 的定时拉取与统一事件流。
  const connectors = new ConnectorStore()
  try {
    await connectors.load()
  } catch (error) {
    ctx.logger.warn(svLog('index', 'connectors_load_failed', { err: svError(error) }))
  }
  const connectorService = new ConnectorService({
    store: connectors,
    log: (event, fields) => {
      if (event.endsWith('_failed')) ctx.logger.warn(svLog('connector', event, fields))
      else ctx.logger.info(svLog('connector', event, fields))
    },
  })
  connectorService.start()
  ctx.effect(() => () => connectorService.stop())

  const reminders = new ReminderService(tasks, (event, fields) => {
    ctx.logger.warn(svLog('reminders', event, fields))
  })
  // 邮件通道：到期提醒在页面弹窗之外再发一封，另按 digestAt 发每日摘要。
  const mailer = new MailNotifier({
    config: () => store.mail,
    tasks,
    log: (event, fields) => ctx.logger.warn(svLog('mail', event, fields)),
  })
  const unsubscribeReminder = reminders.subscribe(event => {
    const task = event.task
    const body = [
      `**${task.title}**`,
      ...task.dueAt === undefined ? [] : [`到期时间：${formatTaskTime(task.dueAt)}`],
      ...task.notes === undefined || task.notes.length === 0 ? [] : [task.notes],
    ].join('\n\n')
    void inbox.add({
      kind: 'reminder',
      title: `待办提醒：${task.title}`,
      body,
      taskId: task.id,
      ...task.sessionId === undefined ? {} : { sessionId: task.sessionId },
    }).catch(error => {
      ctx.logger.warn(svLog('inbox', 'reminder_store_failed', { taskId: task.id, err: svError(error) }))
    })
    void mailer.notifyReminder(task)
  })
  mailer.start()
  reminders.start()
  ctx.effect(() => () => {
    unsubscribeReminder()
    mailer.stop()
    reminders.stop()
  })

  // attachments 由 dsh-web-app 层提供；缺省时图片消息会被跳过而不是静默发送空内容。
  ctx.llm.registerAdapter([SV_PROVIDER_ID], new SvOpenAiCompatAdapter(
    () => store.llm,
    () => ctx.get('attachments'),
    (model, report) => {
      void usage.record(model, {
        inputTokens: report.inputTokens,
        outputTokens: report.outputTokens,
        ...report.cacheReadTokens === undefined ? {} : { cacheReadTokens: report.cacheReadTokens },
      }).catch(error => {
        ctx.logger.warn(svLog('usage', 'usage_record_failed', { err: svError(error) }))
      })
    },
  ))
  ctx.web.registerSearchProvider(new SvSearchProvider(() => store.search, () => store.llm.apiKey))

  // 每日简报：到点汇总今日待办、昨日对话与未读收件箱；模型失败时用模板回落。
  const briefing = new BriefingService({
    config: () => store.briefing,
    mail: () => store.mail,
    tasks,
    sessions,
    inbox,
    log: (event, fields) => {
      if (event.endsWith('_failed')) ctx.logger.warn(svLog('briefing', event, fields))
      else ctx.logger.info(svLog('briefing', event, fields))
    },
    generate: async (input, signal) => {
      let text = ''
      let failure: string | undefined
      for await (const chunk of ctx.llm.stream({
        provider: SV_PROVIDER_ID,
        model: store.llm.model,
        system: BRIEFING_SYSTEM,
        messages: [createUserMessage({
          content: [{ type: 'text', text: buildBriefingPrompt(input) }],
          source: { kind: 'user' },
        })],
        maxTokens: 800,
        temperature: 0.3,
        signal,
      })) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'finish' && chunk.reason.kind === 'error') failure = chunk.reason.failure.message
      }
      if (failure !== undefined) throw new Error(failure)
      return text.trim()
    },
  })
  briefing.start()
  ctx.effect(() => () => briefing.stop())

  // 自动化执行器：到期扫描；prompt 类型用隔离 Agent，web/keyword 走 ctx.web.fetch。
  const automationService = new AutomationService({
    store: automations,
    inbox,
    mail: () => store.mail,
    config: () => store.automations,
    fetchPage: (url, signal) => fetchUrlPage(ctx, url, signal),
    runPrompt: createAutomationPromptRunner(ctx, store),
    log: (event, fields) => {
      if (event.endsWith('_failed')) ctx.logger.warn(svLog('automation', event, fields))
      else ctx.logger.info(svLog('automation', event, fields))
    },
  })
  automationService.start()
  ctx.effect(() => () => automationService.stop())

  registerMemoryTools(ctx, memory)
  registerTaskTools(ctx, tasks)
  registerInboxTools(ctx, inbox)
  registerKnowledgeTools(ctx, knowledge)
  registerImageTools(ctx)
  registerAutomationTools(ctx, automations)
  registerDesktopGuard(ctx)

  // 回答配图：先调用 image_search 拿可靠图片，再用 https 地址嵌入；宁可不配图也不放失效链接。
  ctx.systemPrompt.section({
    name: 'sv:answer-images',
    order: 9530,
    interpolate: false,
    text: () => '回答配图：正文涉及产品外观、菜品、人物、地点、场景、图表截图等更适合看图说明的内容时，先调用 image_search 搜索相关图片，再从返回结果里挑选 1-3 张，用 Markdown 图片语法 ![中文短语说明](图片地址) 插到相关段落后。image_search 没有返回结果时就只写文字，不要自己编造、拼接或猜测图片地址，也不要引用需要登录的地址。',
  })

  // 每轮 Prompt 组装时注入记忆与待办（system-prompt 注册表，作用于全部会话）。
  const recallQuery = (context: { agent?: { id: unknown } }): string =>
    chat.latestUserText(context.agent === undefined ? undefined : String(context.agent.id))
  // 个人知识召回：只注入本次最相关的少量片段，带 [K1] 编号与来源，正文可按需再检索。
  ctx.systemPrompt.section({
    name: 'sv:knowledge-recall',
    order: 9450,
    interpolate: false,
    text: context => knowledge.promptBlock(recallQuery(context)),
  })
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

  ctx.systemPrompt.section({
    name: 'sv:reminder-routing',
    order: 9510,
    interpolate: false,
    text: () => '提醒与定时任务的选型：用户要在某个时间点收到提醒、或让助手届时继续处理，调用 schedule_create（提醒会回到本会话）；只是记录一件要做的事、需要清单勾选或邮件提醒，调用 task_create。',
  })

  // 收件箱摘要：只给未读标题与数量，正文按需用 inbox_list 读取，避免每轮注入整份简报。
  ctx.systemPrompt.section({
    name: 'sv:inbox',
    order: 9515,
    interpolate: false,
    text: () => {
      const unread = inbox.list({ unreadOnly: true, limit: 5 })
      if (unread.length === 0) return ''
      const lines = [
        '## 收件箱',
        `未读 ${inbox.unreadCount()} 条：`,
        ...unread.map(item => `- [${INBOX_KIND_LABELS[item.kind]}] ${item.title}`),
        '需要查看正文时调用 inbox_list。',
      ]
      return lines.join('\n')
    },
  })

  // 桌面操作（dsh-computer-use）：工具由第三方 bundle 注册，这里只给选型与
  // 安全规则。核心约束是「先观察、再操作、再验证」，窗口变化后重新定位，
  // 以及有外部副作用的动作先征得用户同意。
  ctx.systemPrompt.section({
    name: 'sv:computer-use',
    order: 9520,
    interpolate: false,
    text: () => [
      '桌面操作：用户要求操作本机应用界面（打开应用、查看窗口、点击、输入、滚动、拖拽）时，用 app_list / app_launch 定位应用，screen_observe 观察目标窗口，再用 computer_click / computer_double_click / computer_right_click / computer_type / computer_key / computer_scroll / computer_drag 操作，最后重新 screen_observe 验证结果。',
      '打开或前置应用只能用 app_launch：默认会前置到前台，只有明确要求后台启动时才传 bring_to_front: false。不要用终端命令（open、osascript、cliclick、AppleScript）启动或操作 GUI 应用，也不要让用户去装 cliclick——桌面操作统一走 computer_* 工具，只有这样才有观察快照校验和审批护栏。',
      '动作完成后界面可能弹出新窗口、对话框或切换页面：这时必须重新 screen_observe（可传 window="标题子串" 定位新窗口），不要复用旧元素编号。目标窗口不在当前桌面或已最小化时，screen_observe 会自动把它前置到前台；若前置失败，请告诉用户切换桌面。',
      '坐标与成本：整窗截图每次都会占用图片 token，先定位再动手，不要每点一下都截全屏。观测里的「截图像素 W×H」就是点击坐标的空间，按图内像素估位置（Retina 截图常是窗口逻辑尺寸的 2 倍，不要按 pt 算）。输入数字或短文本优先专用 computer_key（自绘界面没有文本控件，computer_type 会被拒绝）；只在确实看不清时用 screen_zoom 放大局部。',
      '发送与提交：输入完成后优先用 computer_key(key="return") 发送，不要去点发送按钮；回车只会换行时用 cmd+return / ctrl+return，最后才点击发送按钮。发送后验证输入框清空或消息气泡出现即可，不要重复按 Enter，也不要反复点击发送。',
      '浏览器与地址栏：cmd+t / cmd+l 后焦点已经在地址栏，直接 computer_type 输入完整 https:// URL，再 computer_key(key="return") 提交，不要先点击地址栏。computer_type 的文本不要包含换行；地址被当成搜索词时先检查是否缺少 https:// 或焦点在页面搜索框，修正后只重试一次。',
      '应用与窗口：app_list 已列出应用名时，app_launch 直接用该名称（默认前置），不要先猜 bundle id 或中文名；screen_observe 找不到窗口时，从错误列出的「应用 · 标题 · window_id」里选，进程名不一定等于窗口标题。',
      'Electron/Canvas 界面（微信、飞书等，AX 树为空）：先点击目标输入框，再 computer_type；快捷键只负责打开面板，不代表输入框已聚焦。',
      '授权与止损：用户已经明确给出对象与内容（如「给某某发：你好吗？」）就视为已授权，直接执行，不要反复自我确认。同一个工具、同一个错误连续失败 2 次就必须停下：一次说清卡在哪（窗口不在当前桌面 / 缺少文字输入控件 / 元素不在快照里），并告诉用户需要他做什么（切到某应用的桌面、手动打开某个窗口、或提供窗口标题）；不要连续十几次换着花样重试。',
      '规则：先观察再操作；优先用 element 编号，坐标仅在 AX 不可用时使用；删除、支付、转账、退出登录等不可逆操作先向用户确认（发送消息在用户已指定对象与内容时视为已授权）；密码、验证码与密钥由用户本人输入，不要代为填写。',
    ].join('\n'),
  })

  // turn 结束后异步抽取记忆；失败只告警，不影响对话。
  const extract = createMemoryExtractor(ctx, () => ({ provider: SV_PROVIDER_ID, model: store.llm.model }))
  const chat = new ChatManager(ctx, store, sessions, {
    onTurnComplete({ sessionId, userText, assistantText, attended }) {
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
      // 页面已关闭时本轮在后台完成：把结果放进收件箱，避免「跑完了但没人知道」。
      if (!attended) {
        void inbox.add({
          kind: 'agent',
          title: inboxTitle('后台回复已完成：', userText.length > 0 ? userText : assistantText),
          body: assistantText,
          sessionId,
        }).catch(error => {
          ctx.logger.warn(svLog('inbox', 'background_turn_store_failed', { sessionId, err: svError(error) }))
        })
      }
    },
    // 宿主直接投递到会话的轮次（例如定时任务到点后继续处理）没有页面 SSE，
    // 统一记为「定时任务回复」。
    onDetachedTurn({ sessionId, assistantText }) {
      void inbox.add({
        kind: 'agent',
        title: inboxTitle('定时任务回复：', assistantText),
        body: assistantText,
        sessionId,
      }).catch(error => {
        ctx.logger.warn(svLog('inbox', 'detached_turn_store_failed', { sessionId, err: svError(error) }))
      })
    },
  })
  // Super-agent 运行时始终创建，但开关由 config.json 控制（设置页可即时开关/调限额）；
  // 关闭时 /sv 页面隐藏入口、运行接口返回 404。
  const { enabled: _superAgentEnabled, ...initialSuperAgentOptions } = store.superAgent
  // 运行历史落 $DSH_HOME/sv/superagent-runs.json；进程重启后仍能在页面看到。
  const runStore = new SuperAgentRunStore()
  try {
    await runStore.load()
  } catch (error) {
    ctx.logger.warn(svLog('index', 'superagent_history_load_failed', { err: svError(error) }))
  }
  const superAgent = createSuperAgentRuntime(ctx, store, initialSuperAgentOptions, {
    initialRuns: runStore.list(),
    onChange: runs => {
      void runStore.save(runs).catch(error => {
        ctx.logger.warn(svLog('superagent', 'history_save_failed', { err: svError(error) }))
      })
    },
  })
  // 用 config.json 的最终值覆盖构造时的默认值
  superAgent.applyConfig(store.superAgent)
  ctx.logger.info(svLog('index', 'superagent_ready', {
    enabled: superAgent.enabled,
    maxConcurrency: superAgent.limits.maxConcurrency,
    maxSubtasks: superAgent.limits.maxSubtasks,
    workerTimeoutMs: superAgent.limits.workerTimeoutMs,
    retryAttempts: superAgent.limits.retryAttempts,
    history: runStore.list().length,
  }))

  // 技能管理：列表 / 新建 / 启停 / 删除，数据来自宿主技能注册表。
  const skillManager = new SkillManager(ctx, process.cwd())

  // / 斜杠菜单的工具列表：直接取当前可见工具，包含 computer-use / MCP / 内置工具。
  const listTools = async (): Promise<SvToolView[]> => {
    return ctx.tools.schemas()
      .filter(tool => tool.name !== 'skill')
      .map(tool => ({ name: tool.name, description: tool.description }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  registerSvRoutes(
    ctx,
    chat,
    store,
    sessions,
    memory,
    tasks,
    inbox,
    knowledge,
    automations,
    automationService,
    reminders,
    mailer,
    briefing,
    ctx.schedule,
    skillManager,
    listTools,
    superAgent,
    {
      clearSuperAgentHistory: async () => {
        superAgent.clearHistory()
      },
      restoreSuperAgentHistory: async () => {
        await runStore.load()
        superAgent.restoreHistory(runStore.list())
      },
      usageSnapshot: () => usage.snapshot(store.usage),
    },
    {
      approvals: approvalCenter,
      connectors: connectorService,
      connectorStore: connectors,
    },
    auth,
  )
  ctx.logger.info(svLog('index', 'surface_ready', { path: '/sv/' }))
}
