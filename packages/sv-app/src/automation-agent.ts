/**
 * 定时任务型自动化的执行后端：用隔离 Agent 跑一条 prompt，收集文本输出。
 *
 * 与 Super-agent Worker 同一套隔离方式：新建临时会话、复用完整工具面与
 * 系统提示，完成后 dispose；不进入用户会话列表。取消沿 AbortSignal 传导到
 * 模型请求，超时由 AutomationService 负责。
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { AgentHandle, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Automation } from './automation-store.ts'
import type { AutomationPromptRunner } from './automation-runtime.ts'
import type { ConfigStore } from './config-store.ts'
import { SV_PROVIDER_ID } from './llm-adapter.ts'
import { svError, svLog } from './log.ts'

/** 自动化任务的提示词：明确这是一次离线执行，不面向实时对话。 */
export function automationTaskPrompt(automation: Automation): string {
  return [
    '这是 Singularity Voyage 的定时自动化任务，不是实时对话。',
    `任务标题：${automation.title}`,
    `任务：${automation.prompt ?? automation.title}`,
    '',
    '要求：',
    '- 直接执行并输出结果，不要向用户提问，不要等待确认。',
    '- 先给结论，再给关键依据；控制在 800 字以内。',
    '- 需要引用来源时写明标题或 URL；不要编造未获取到的信息。',
    '- 输出会原样进入用户的收件箱，请写成可独立阅读的一段结果。',
  ].join('\n')
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

/** 创建生产环境的 prompt 执行器。 */
export function createAutomationPromptRunner(ctx: Context, store: ConfigStore): AutomationPromptRunner {
  return async (automation, signal) => {
    if (signal.aborted) throw new Error('已取消')
    const sessionId = randomUUID()
    let messageBuf = ''
    let output = ''
    let failure: string | undefined

    const onFrame = (frame: AssistantStreamFrame): void => {
      switch (frame.type) {
        case 'start':
          messageBuf = ''
          break
        case 'chunk': {
          const chunk = frame.chunk
          if (chunk.type === 'text-delta') {
            messageBuf += chunk.text
          } else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
            failure = chunk.reason.failure.message
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
        signal,
        setup: agentCtx => {
          agentCtx.on('agent/assistant-stream', ({ frame }) => {
            onFrame(frame)
          })
        },
      })
    } catch (error) {
      ctx.logger.warn(svLog('automation', 'agent_create_failed', {
        automationId: automation.id,
        err: svError(error),
      }))
      throw error
    }

    ctx.logger.info(svLog('automation', 'agent_started', {
      automationId: automation.id,
      sessionId,
    }))
    try {
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: automationTaskPrompt(automation) }],
        source: { kind: 'user' },
      }))
      await abortable(handle.agent.whenIdle(), signal)
      if (failure !== undefined) throw new Error(failure)
      if (output.trim().length === 0) throw new Error('自动化任务没有产生文本输出')
      ctx.logger.info(svLog('automation', 'agent_succeeded', {
        automationId: automation.id,
        sessionId,
        chars: output.length,
      }))
      return output.trim()
    } catch (error) {
      ctx.logger.warn(svLog('automation', 'agent_failed', {
        automationId: automation.id,
        sessionId,
        err: svError(error),
      }))
      throw error
    } finally {
      handle.agent.cancel({ kind: 'parent' })
      try {
        await handle.dispose()
      } catch (error) {
        ctx.logger.warn(svLog('automation', 'agent_dispose_failed', {
          automationId: automation.id,
          sessionId,
          err: svError(error),
        }))
      }
    }
  }
}
