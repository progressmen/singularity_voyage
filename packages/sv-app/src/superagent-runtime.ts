/**
 * Super-agent 的真实运行时：把 {@linkcode SuperAgentRunner} 接到 dsh 的
 * 模型与 Agent 运行时上。
 *
 * - Router 拆解 / 汇总：直接用 `ctx.llm.stream` 做一次性模型调用，
 *   不占用会话、也不进入聊天历史；
 * - Worker：用 `ctx.agents.create` 建立隔离会话，复用现有 Agent Loop、
 *   工具与系统提示，完成后 dispose；
 * - 所有密钥仍只来自 ConfigStore，不放宽任何权限。
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { AgentHandle, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ConfigStore } from './config-store.ts'
import { SV_PROVIDER_ID } from './llm-adapter.ts'
import { svError, svLog } from './log.ts'
import {
  isFatalProviderFailure,
  parseSuperAgentPlan,
  parseSuperAgentPlanSalvage,
  SuperAgentFatalError,
  SuperAgentRunner,
  type SuperAgentDeps,
  type SuperAgentEvent,
  type SuperAgentOptions,
  type SuperAgentPlan,
  type SuperAgentPlanItem,
  type SuperAgentRunView,
  type SuperAgentSurface,
  type SuperAgentWorkerContext,
  type SuperAgentWorkerRecord,
  type SuperAgentWorkerResult,
} from './superagent.ts'

/** Router 的拆解提示词。 */
const PLANNER_SYSTEM = [
  '你是 Super-agent 的 Router（任务拆解器）。把用户目标拆成可以并行执行的子任务。',
  '规则：',
  '- 子任务之间不要有顺序依赖；有依赖的步骤合并进同一个子任务。',
  '- 每个子任务必须自包含：执行者看不到本次对话，只能看到你写的 prompt。',
  '- 子任务要能独立验收，避免「继续上一步」这类指代。',
  '- 最多 4 个子任务；每个 prompt 控制在 120 个汉字以内，不要写长篇要求清单。',
  '- 只输出 JSON，不要 Markdown 代码块，不要解释；第一个字符必须是 {，最后一个字符必须是 }。',
  '输出格式：{"subtasks":[{"title":"不超过 20 字的短标题","prompt":"完整、自包含的执行指令"}]}',
  '如果目标本身不可拆分，就只输出 1 个子任务。',
].join('\n')

/** 第一次输出被截断或无法解析时的重试提示词。 */
const PLANNER_RETRY_SYSTEM = `${PLANNER_SYSTEM}\n上一次输出不完整或无法解析。这次请更严格：最多 4 个子任务，每个 prompt 不超过 100 个汉字，只输出一个完整闭合的 JSON 对象，不要任何前后缀。`

/** Router 的汇总提示词。 */
const SUMMARY_SYSTEM = [
  '你是 Super-agent 的 Router（结果汇总器）。根据总目标和各 Worker 的结果，给用户一份最终答复。',
  '要求：',
  '- 先给一句话结论，再按子任务列出关键结果，合并重复信息。',
  '- 保留具体数据、文件路径、命令与依据；不要编造 Worker 未提供的事实。',
  '- 未完成的子任务要如实说明原因与影响。',
  '- 直接输出给用户看的正文，不要输出 JSON。',
].join('\n')

/** Worker 的系统提示词。 */
const WORKER_SYSTEM = [
  '你是 Singularity Voyage 的 Super-agent Worker。',
  '你只处理分配给你的一个子任务，独立完成并返回结果。',
  '不要向用户提问，不要等待确认；需要信息时使用可用工具自行获取。',
  '完成后给出可被 Router 汇总的简洁结果：结论 + 关键依据 / 产出。',
].join('\n')

/** 汇总输入里单条 Worker 输出的上限，避免上下文爆炸。 */
const SUMMARY_OUTPUT_LIMIT = 6_000

/** 模型一次性调用的输出上限。 */
const PLANNER_MAX_TOKENS = 2_500
const PLANNER_RETRY_MAX_TOKENS = 1_800
const SUMMARY_MAX_TOKENS = 3_000

/** 一次性模型调用的结果；truncated 表示触发 max_tokens。 */
interface CollectedText {
  text: string
  truncated: boolean
}

/** 上游失败的最小结构（来自 StreamChunk 的 finish.reason.failure）。 */
interface ProviderFailure {
  message: string
  code: string
  status?: number
}

/** 把上游失败转成异常；认证/余额类标记为不可重试。 */
function providerError(failure: ProviderFailure): Error {
  if (!isFatalProviderFailure(failure)) return new Error(failure.message)
  const actionable = failure.status === 402
    ? '模型账户余额不足（HTTP 402）。请更换 API Key 或为当前模型账户充值后重试。'
    : '模型认证失败。请在设置中检查 API Key 是否有效。'
  return new SuperAgentFatalError(`${actionable} 原始错误：${failure.message}`, {
    code: failure.code,
    ...failure.status === undefined ? {} : { status: failure.status },
  })
}

/** 从任意 chunk 流里收集文本；失败 finish 转为异常，max-tokens 标记截断。 */
async function collectText(
  ctx: Context,
  store: ConfigStore,
  system: string,
  prompt: string,
  signal: AbortSignal,
  maxTokens: number,
): Promise<CollectedText> {
  let text = ''
  let failure: ProviderFailure | undefined
  let truncated = false
  for await (const chunk of ctx.llm.stream({
    provider: SV_PROVIDER_ID,
    model: store.llm.model,
    system,
    messages: [createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    })],
    maxTokens,
    temperature: 0.2,
    signal,
  })) {
    if (chunk.type === 'text-delta') {
      text += chunk.text
    } else if (chunk.type === 'finish') {
      if (chunk.reason.kind === 'error') failure = chunk.reason.failure
      else if (chunk.reason.kind === 'max-tokens') truncated = true
    }
  }
  if (failure !== undefined) throw providerError(failure)
  return { text, truncated }
}

/** Worker 的完整任务文本：总目标只作上下文，避免 Worker 重复执行整件事。 */
function workerPrompt(goal: string, item: SuperAgentPlanItem): string {
  return [
    `总目标（仅供理解上下文，不要重复执行）：${goal}`,
    '',
    `你的子任务：${item.prompt}`,
    '',
    '请直接开始并完成这个子任务。',
  ].join('\n')
}

/** 汇总输入：逐个子任务列出状态与输出。 */
function summaryPrompt(goal: string, workers: readonly SuperAgentWorkerRecord[]): string {
  const sections = workers.map(worker => {
    const head = `## 子任务 ${worker.index + 1}：${worker.title}（${worker.status}，尝试 ${worker.attempts} 次）`
    if (worker.status === 'succeeded') {
      const output = worker.output?.trim() ?? ''
      const clipped = output.length <= SUMMARY_OUTPUT_LIMIT
        ? output
        : `${output.slice(0, SUMMARY_OUTPUT_LIMIT)}…（已截断）`
      return `${head}\n${clipped.length > 0 ? clipped : '（无文本输出）'}`
    }
    return `${head}\n失败原因：${worker.error ?? worker.status}`
  })
  return [`# 总目标\n${goal}`, '', '# 各 Worker 结果', '', ...sections].join('\n')
}

/** 用外部 signal 中断 Promise。 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('已取消'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('已取消'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** 建立隔离 Worker 会话并执行一个子任务。 */
function createWorker(
  ctx: Context,
  store: ConfigStore,
): SuperAgentDeps['runWorker'] {
  return async (item: SuperAgentPlanItem, context: SuperAgentWorkerContext): Promise<SuperAgentWorkerResult> => {
    const goal = context.goal
    const sessionId = randomUUID()
    let messageBuf = ''
    let output = ''
    let failure: ProviderFailure | undefined

    const onFrame = (frame: AssistantStreamFrame): void => {
      switch (frame.type) {
        case 'start':
          messageBuf = ''
          break
        case 'chunk': {
          const chunk = frame.chunk
          if (chunk.type === 'text-delta') {
            messageBuf += chunk.text
            context.onText(chunk.text)
          } else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
            failure = chunk.reason.failure
          }
          break
        }
        case 'end':
          if (frame.outcome.kind === 'committed' && frame.outcome.eventType === 'assistant/message') {
            const text = messageBuf.trim()
            if (text.length > 0) output = output.length === 0 ? text : `${output}\n\n${text}`
            messageBuf = ''
          }
          break
      }
    }

    let handle: AgentHandle
    try {
      handle = await ctx.agents.create({
        sessionId: SessionId(sessionId),
        meta: { cwd: process.cwd(), origin: 'subagent', delegationDepth: 1 },
        agentOptions: { provider: SV_PROVIDER_ID, model: store.llm.model },
        signal: context.signal,
        setup: agentCtx => {
          agentCtx.on('agent/assistant-stream', ({ frame }) => {
            onFrame(frame)
          })
        },
      })
    } catch (error) {
      ctx.logger.warn(svLog('superagent', 'worker_create_failed', {
        runId: context.runId,
        index: context.index,
        err: svError(error),
      }))
      throw error
    }

    context.onSession(sessionId)
    ctx.logger.info(svLog('superagent', 'worker_started', {
      runId: context.runId,
      index: context.index,
      attempt: context.attempt,
      sessionId,
    }))

    try {
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: workerPrompt(goal, item) }],
        source: { kind: 'user' },
      }))
      await abortable(handle.agent.whenIdle(), context.signal)
      if (failure !== undefined) throw providerError(failure)
      if (output.trim().length === 0) throw new Error('Worker 未产生文本输出')
      ctx.logger.info(svLog('superagent', 'worker_succeeded', {
        runId: context.runId,
        index: context.index,
        sessionId,
        chars: output.length,
      }))
      return { output: output.trim(), sessionId }
    } catch (error) {
      ctx.logger.warn(svLog('superagent', 'worker_failed', {
        runId: context.runId,
        index: context.index,
        sessionId,
        err: svError(error),
      }))
      throw error
    } finally {
      handle.agent.cancel({ kind: 'parent' })
      try {
        await handle.dispose()
      } catch (error) {
        ctx.logger.warn(svLog('superagent', 'worker_dispose_failed', {
          runId: context.runId,
          index: context.index,
          err: svError(error),
        }))
      }
    }
  }
}

/** Super-agent 服务：实现 /sv 路由与状态查询需要的接口。 */
export class SuperAgentService implements SuperAgentSurface {
  private currentEnabled = true
  readonly limits: SuperAgentOptions

  constructor(private readonly runner: SuperAgentRunner) {
    this.limits = runner.options
  }

  get enabled(): boolean {
    return this.currentEnabled
  }

  /** 页面保存后即时应用：开关对 UI/路由生效，限额对下一轮运行生效。 */
  applyConfig(config: {
    enabled: boolean
    maxConcurrency: number
    maxSubtasks: number
    workerTimeoutMs: number
    retryAttempts: number
    watchdogIntervalMs: number
  }): void {
    this.currentEnabled = config.enabled
    this.limits.maxConcurrency = config.maxConcurrency
    this.limits.maxSubtasks = config.maxSubtasks
    this.limits.workerTimeoutMs = config.workerTimeoutMs
    this.limits.retryAttempts = config.retryAttempts
    this.limits.watchdogIntervalMs = config.watchdogIntervalMs
  }

  runs(): SuperAgentRunView[] {
    return this.runner.list()
  }

  /** 清空已结束的运行历史（数据清空用）。 */
  clearHistory(): void {
    this.runner.clearHistory()
  }

  /** 从持久化快照恢复历史（数据恢复用）。 */
  restoreHistory(runs: readonly SuperAgentRunView[]): void {
    this.runner.restore(runs)
  }

  run(
    goal: string,
    subtasks: readonly string[] | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<SuperAgentEvent> {
    return this.runner.run(goal, subtasks === undefined ? {} : { subtasks }, signal)
  }

  retry(runId: string, index: number, signal: AbortSignal): AsyncGenerator<SuperAgentEvent> {
    return this.runner.retry(runId, index, signal)
  }

  stop(runId: string): boolean {
    return this.runner.stop(runId)
  }
}

/** 运行时的可选注入：历史恢复与持久化回调。 */
export interface SuperAgentRuntimeOptions {
  /** 上次进程持久化的运行历史。 */
  initialRuns?: readonly SuperAgentRunView[]
  /** 运行视图变化时的持久化回调。 */
  onChange?: (runs: readonly SuperAgentRunView[]) => void
}

/**
 * 组装真实运行时。
 * @param ctx - 插件上下文。
 * @param store - 配置存储（模型 / 密钥）。
 * @param options - 已解析的运行参数。
 * @param runtimeOptions - 历史恢复与持久化回调。
 * @returns 可直接交给 /sv 路由的服务。
 */
export function createSuperAgentRuntime(
  ctx: Context,
  store: ConfigStore,
  options: SuperAgentOptions,
  runtimeOptions: SuperAgentRuntimeOptions = {},
): SuperAgentService {
  const deps: SuperAgentDeps = {
    async plan(goal: string, signal: AbortSignal): Promise<SuperAgentPlan> {
      const first = await collectText(ctx, store, PLANNER_SYSTEM, goal, signal, PLANNER_MAX_TOKENS)
      // 输出被 max_tokens 截断时不做正式解析（外层 JSON 未闭合），直接走重试。
      const plan = first.truncated
        ? undefined
        : parseSuperAgentPlan(first.text, options.maxSubtasks)
      if (plan !== undefined) return plan

      ctx.logger.warn(svLog('superagent', 'planner_retry', {
        chars: first.text.length,
        truncated: first.truncated,
      }))
      if (signal.aborted) throw new Error('Router 拆解已取消')

      const retry = await collectText(ctx, store, PLANNER_RETRY_SYSTEM, goal, signal, PLANNER_RETRY_MAX_TOKENS)
      const retryPlan = parseSuperAgentPlan(retry.text, options.maxSubtasks)
        ?? parseSuperAgentPlanSalvage(retry.text, options.maxSubtasks)
      if (retryPlan !== undefined) return retryPlan

      // 重试仍失败：从第一次输出里打捞完整的子任务对象，避免直接退化为单任务。
      const salvaged = parseSuperAgentPlanSalvage(first.text, options.maxSubtasks)
      if (salvaged !== undefined) {
        ctx.logger.warn(svLog('superagent', 'planner_salvaged', {
          subtasks: salvaged.subtasks.length,
          truncated: retry.truncated || first.truncated,
        }))
        return salvaged
      }

      const preview = (retry.text || first.text).replace(/\s+/g, ' ').trim().slice(0, 120)
      ctx.logger.warn(svLog('superagent', 'planner_parse_failed', {
        chars: (retry.text || first.text).length,
        truncated: retry.truncated || first.truncated,
      }))
      throw new Error(
        `Router 输出无法解析为子任务 JSON（${retry.truncated || first.truncated ? '被截断' : '格式不符'}${
          preview.length > 0 ? `；预览：${preview}` : ''
        }）`,
      )
    },
    runWorker: createWorker(ctx, store),
    async summarize(
      goal: string,
      workers: readonly SuperAgentWorkerRecord[],
      signal: AbortSignal,
    ): Promise<string> {
      try {
        const collected = await collectText(
          ctx,
          store,
          SUMMARY_SYSTEM,
          summaryPrompt(goal, workers),
          signal,
          SUMMARY_MAX_TOKENS,
        )
        // 汇总被截断时交给 runner 的纯文本兜底，避免返回半句话。
        if (collected.truncated) throw new Error('汇总输出被 max_tokens 截断')
        return collected.text.trim()
      } catch (error) {
        ctx.logger.warn(svLog('superagent', 'summary_failed', { err: svError(error) }))
        throw error
      }
    },
    ...runtimeOptions.onChange === undefined ? {} : { onChange: runtimeOptions.onChange },
  }
  const runner = new SuperAgentRunner(deps, options)
  if (runtimeOptions.initialRuns !== undefined && runtimeOptions.initialRuns.length > 0) {
    runner.restore(runtimeOptions.initialRuns)
  }
  return new SuperAgentService(runner)
}
