/**
 * Super-agent 编排单测：拆解解析、并发分派、重试、超时/watchdog 与兜底汇总。
 * 全部使用注入的 fake plan / worker / summarize，不触发真实模型或会话。
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import {
  buildPlanFromSubtasks,
  fallbackPlan,
  isFatalProviderFailure,
  parseSuperAgentPlan,
  parseSuperAgentPlanSalvage,
  resolveSuperAgentConfig,
  SuperAgentFatalError,
  SuperAgentRunner,
  type SuperAgentDeps,
  type SuperAgentEvent,
  type SuperAgentOptions,
  type SuperAgentPlan,
  type SuperAgentPlanItem,
  type SuperAgentRunView,
  type SuperAgentWorkerContext,
  type SuperAgentWorkerRecord,
} from '../src/superagent.ts'

const ENV_KEYS = [
  'SV_SUPERAGENT_ENABLED',
  'SV_SUPERAGENT_MAX_CONCURRENCY',
  'SV_SUPERAGENT_MAX_SUBTASKS',
  'SV_SUPERAGENT_WORKER_TIMEOUT_MS',
  'SV_SUPERAGENT_RETRY_ATTEMPTS',
  'SV_SUPERAGENT_WATCHDOG_INTERVAL_MS',
] as const
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map(key => [key, process.env[key]]))

before(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})

after(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const FAST: SuperAgentOptions = {
  maxConcurrency: 3,
  maxSubtasks: 8,
  workerTimeoutMs: 200,
  retryAttempts: 0,
  watchdogIntervalMs: 20,
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function planOf(...titles: string[]): SuperAgentPlan {
  return { subtasks: titles.map(title => ({ title, prompt: `执行：${title}` })) }
}

function makeDeps(overrides: Partial<SuperAgentDeps> = {}): SuperAgentDeps {
  return {
    plan: async () => planOf('一', '二', '三'),
    runWorker: async (item: SuperAgentPlanItem) => ({ output: `完成 ${item.title}` }),
    summarize: async (_goal, workers) => `汇总 ${workers.length} 项`,
    ...overrides,
  }
}

async function collect(events: AsyncGenerator<SuperAgentEvent>): Promise<SuperAgentEvent[]> {
  const out: SuperAgentEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

test('parseSuperAgentPlan：支持代码块、数组与对象三种输出', () => {
  const fenced = parseSuperAgentPlan(
    '```json\n{"subtasks":[{"title":"调研","prompt":"调研 A 与 B 的差异"},{"prompt":"整理结论"}]}\n```',
    8,
  )
  assert.deepEqual(fenced, {
    subtasks: [
      { title: '调研', prompt: '调研 A 与 B 的差异' },
      { title: '整理结论', prompt: '整理结论' },
    ],
  })

  const array = parseSuperAgentPlan('["第一步：收集资料","第二步：写报告"]', 8)
  assert.equal(array?.subtasks.length, 2)
  assert.equal(array?.subtasks[1]?.title, '第二步：写报告')

  const tasksKey = parseSuperAgentPlan('{"tasks":[{"task":"查询天气"}]}', 8)
  assert.equal(tasksKey?.subtasks[0]?.prompt, '查询天气')

  assert.equal(parseSuperAgentPlan('没有 JSON 的普通回答', 8), undefined)
  assert.equal(parseSuperAgentPlan('{"subtasks":[]}', 8), undefined)
})

test('parseSuperAgentPlan 与 buildPlanFromSubtasks 都遵守数量上限', () => {
  const plan = parseSuperAgentPlan(
    JSON.stringify({ subtasks: Array.from({ length: 5 }, (_, index) => `任务 ${index}`) }),
    2,
  )
  assert.equal(plan?.subtasks.length, 2)

  const explicit = buildPlanFromSubtasks(['  A  ', '', 'B', 'C'], 2)
  assert.deepEqual(explicit.subtasks.map(item => item.prompt), ['A', 'B'])
  assert.equal(explicit.subtasks[0]?.title, 'A')

  assert.equal(fallbackPlan('做一件大事').subtasks[0]?.prompt, '做一件大事')
})

test('parseSuperAgentPlanSalvage：从被 max_tokens 截断的输出里打捞完整子任务', () => {
  const truncated = '{"subtasks":[{"title":"A","prompt":"做 A"},{"title":"B","prompt":"做 B"},{"title":"C","pro'
  assert.equal(parseSuperAgentPlan(truncated, 8), undefined)

  const salvaged = parseSuperAgentPlanSalvage(truncated, 8)
  assert.deepEqual(salvaged?.subtasks, [
    { title: 'A', prompt: '做 A' },
    { title: 'B', prompt: '做 B' },
  ])

  // 嵌套/无关对象不应被误当成子任务
  const noise = '说明：{"foo":"bar"} 然后 {"prompt":"真正的任务"}'
  assert.deepEqual(parseSuperAgentPlanSalvage(noise, 8)?.subtasks, [
    { title: '真正的任务', prompt: '真正的任务' },
  ])

  assert.equal(parseSuperAgentPlanSalvage('完全不是 JSON', 8), undefined)
})

test('resolveSuperAgentConfig：默认关闭，环境变量可开启并覆盖限额', () => {
  assert.deepEqual(resolveSuperAgentConfig({}), {
    enabled: false,
    maxConcurrency: 3,
    maxSubtasks: 8,
    workerTimeoutMs: 180_000,
    retryAttempts: 1,
    watchdogIntervalMs: 5_000,
  })

  process.env.SV_SUPERAGENT_ENABLED = 'true'
  process.env.SV_SUPERAGENT_MAX_CONCURRENCY = '99'
  process.env.SV_SUPERAGENT_WORKER_TIMEOUT_MS = 'abc'
  process.env.SV_SUPERAGENT_RETRY_ATTEMPTS = '0'
  const fromEnv = resolveSuperAgentConfig({})
  assert.equal(fromEnv.enabled, true)
  assert.equal(fromEnv.maxConcurrency, 8)
  assert.equal(fromEnv.workerTimeoutMs, 180_000)
  assert.equal(fromEnv.retryAttempts, 0)

  const fromConfig = resolveSuperAgentConfig({ superAgent: false, superAgentMaxSubtasks: 4 })
  assert.equal(fromConfig.enabled, false)
  assert.equal(fromConfig.maxSubtasks, 4)
})

test('Runner 按 maxConcurrency 并发执行，并把 goal 传给每个 Worker', async () => {
  let active = 0
  let peak = 0
  const goals = new Set<string>()
  const runner = new SuperAgentRunner(makeDeps({
    runWorker: async (item, context) => {
      goals.add(context.goal)
      active += 1
      peak = Math.max(peak, active)
      await delay(20)
      active -= 1
      return { output: `完成 ${item.title}` }
    },
  }), { ...FAST, maxConcurrency: 2 })

  const events = await collect(runner.run('并发目标', { subtasks: ['一', '二', '三'] }))
  const ends = events.filter(event => event.type === 'worker-end')
  const runEnd = events.find(event => event.type === 'run-end')

  assert.equal(peak, 2)
  assert.deepEqual([...goals], ['并发目标'])
  assert.equal(ends.length, 3)
  assert.equal(runEnd?.type === 'run-end' ? runEnd.status : undefined, 'succeeded')
  assert.equal(runner.list()[0]?.workers.length, 3)
})

test('Runner 在失败后按 retryAttempts 重试并保留最终状态', async () => {
  let attempts = 0
  const runner = new SuperAgentRunner(makeDeps({
    runWorker: async (item, context) => {
      attempts = context.attempt
      if (context.attempt === 1) throw new Error('第一次失败')
      return { output: `重试成功 ${item.title}` }
    },
  }), { ...FAST, maxConcurrency: 1, retryAttempts: 1 })

  const events = await collect(runner.run('重试目标', { subtasks: ['只有一个'] }))
  const starts = events.filter(event => event.type === 'worker-start')
  const retries = events.filter(event => event.type === 'worker-retry')
  const end = events.find(event => event.type === 'worker-end')

  assert.equal(attempts, 2)
  assert.equal(starts.length, 2)
  assert.equal(retries.length, 1)
  assert.equal(end?.type === 'worker-end' ? end.status : undefined, 'succeeded')
  assert.equal(end?.type === 'worker-end' ? end.attempts : undefined, 2)
})

test('Runner 的 watchdog/超时会把卡死的 Worker 标记为 timeout 并结束整轮', async () => {
  const runner = new SuperAgentRunner(makeDeps({
    runWorker: () => new Promise(() => {}),
  }), { ...FAST, maxConcurrency: 1, workerTimeoutMs: 40, watchdogIntervalMs: 10 })

  const startedAt = Date.now()
  const events = await collect(runner.run('超时目标', { subtasks: ['卡死'] }))
  const end = events.find(event => event.type === 'worker-end')
  const runEnd = events.find(event => event.type === 'run-end')

  assert.equal(end?.type === 'worker-end' ? end.status : undefined, 'timeout')
  assert.equal(runEnd?.type === 'run-end' ? runEnd.status : undefined, 'failed')
  assert.ok(Date.now() - startedAt < 1_000)
})

test('超时会按 retryAttempts 重试，并可在第二次成功', async () => {
  const attempts: number[] = []
  const runner = new SuperAgentRunner(makeDeps({
    runWorker: async (item, context) => {
      attempts.push(context.attempt)
      if (context.attempt === 1) return new Promise(() => {})
      return { output: `第二次成功 ${item.title}` }
    },
  }), { ...FAST, maxConcurrency: 1, workerTimeoutMs: 30, watchdogIntervalMs: 10, retryAttempts: 1 })

  const events = await collect(runner.run('超时重试', { subtasks: ['慢任务'] }))
  const starts = events.filter(event => event.type === 'worker-start')
  const retries = events.filter(event => event.type === 'worker-retry')
  const end = events.find(event => event.type === 'worker-end')
  const runEnd = events.find(event => event.type === 'run-end')

  assert.deepEqual(attempts, [1, 2])
  assert.equal(starts.length, 2)
  assert.equal(retries.length, 1)
  assert.equal(end?.type === 'worker-end' ? end.status : undefined, 'succeeded')
  assert.equal(end?.type === 'worker-end' ? end.attempts : undefined, 2)
  assert.equal(runEnd?.type === 'run-end' ? runEnd.status : undefined, 'succeeded')
})

test('手动重试：失败 Worker 可在原运行里重试并重新汇总', async () => {
  let badCalls = 0
  const runner = new SuperAgentRunner(makeDeps({
    runWorker: async (item) => {
      if (item.title === '坏任务') {
        badCalls += 1
        if (badCalls === 1) throw new Error('首次失败')
      }
      return { output: `完成 ${item.title}` }
    },
  }), { ...FAST, maxConcurrency: 2, retryAttempts: 0 })

  const first = await collect(runner.run('手动重试目标', { subtasks: ['好任务', '坏任务'] }))
  const firstEnd = first.find(event => event.type === 'run-end')
  assert.equal(firstEnd?.type === 'run-end' ? firstEnd.status : undefined, 'partial')
  const firstStart = first.find(event => event.type === 'run-start')
  const runId = firstStart?.type === 'run-start' ? firstStart.runId : ''
  assert.ok(runId.length > 0)

  const retryEvents = await collect(runner.retry(runId, 1))
  const retryStart = retryEvents.find(event => event.type === 'retry-start')
  const workerEnd = retryEvents.find(event => event.type === 'worker-end')
  const retryEnd = retryEvents.find(event => event.type === 'run-end')
  const summary = retryEvents.find(event => event.type === 'summary')

  assert.equal(retryStart?.type === 'retry-start' ? retryStart.index : undefined, 1)
  assert.equal(workerEnd?.type === 'worker-end' ? workerEnd.status : undefined, 'succeeded')
  assert.equal(workerEnd?.type === 'worker-end' ? workerEnd.attempts : undefined, 2)
  assert.equal(retryEnd?.type === 'run-end' ? retryEnd.status : undefined, 'succeeded')
  assert.match(summary?.type === 'summary' ? summary.text : '', /2 项/)

  await assert.rejects(() => collect(runner.retry(runId, 0)), /不需要重试/)
})

test('restore：重启后 running 运行降级为失败，未完成 Worker 标记取消', () => {
  const runner = new SuperAgentRunner(makeDeps(), FAST)
  const view: SuperAgentRunView = {
    id: 'restored-run',
    goal: '重启前的任务',
    status: 'running',
    startedAt: 1_000,
    workers: [
      { index: 0, title: '未完成', prompt: '执行 A', status: 'running', attempts: 1, startedAt: 1_000 },
      { index: 1, title: '已完成', prompt: '执行 B', status: 'succeeded', attempts: 1, startedAt: 1_000, output: 'ok' },
    ],
  }

  runner.restore([view])
  const restored = runner.list()[0]!

  assert.equal(restored.id, 'restored-run')
  assert.equal(restored.status, 'failed')
  assert.match(restored.error ?? '', /服务重启/)
  assert.equal(restored.workers[0]?.status, 'cancelled')
  assert.equal(restored.workers[1]?.status, 'succeeded')
})

test('onChange：运行状态变化会回调持久化快照', async () => {
  const snapshots: string[][] = []
  const runner = new SuperAgentRunner(makeDeps({
    onChange: runs => snapshots.push(runs.map(run => run.status)),
  }), FAST)

  await collect(runner.run('持久化目标', { subtasks: ['任务'] }))

  assert.ok(snapshots.length > 0)
  assert.ok(snapshots.some(statuses => statuses.includes('succeeded')))
})

test('认证/余额错误不重试，直接失败', async () => {
  let calls = 0
  const runner = new SuperAgentRunner(makeDeps({
    runWorker: async () => {
      calls += 1
      throw new SuperAgentFatalError('模型账户余额不足（HTTP 402）')
    },
  }), { ...FAST, maxConcurrency: 1, retryAttempts: 3 })

  const events = await collect(runner.run('余额不足', { subtasks: ['任务'] }))
  const starts = events.filter(event => event.type === 'worker-start')
  const retries = events.filter(event => event.type === 'worker-retry')
  const end = events.find(event => event.type === 'worker-end')

  assert.equal(calls, 1)
  assert.equal(starts.length, 1)
  assert.equal(retries.length, 0)
  assert.equal(end?.type === 'worker-end' ? end.status : undefined, 'failed')
  assert.match(end?.type === 'worker-end' ? end.error ?? '' : '', /余额不足/)
})

test('Router 遇到余额/认证错误直接失败，不再降级为单任务', async () => {
  const runner = new SuperAgentRunner(makeDeps({
    plan: async () => {
      throw new SuperAgentFatalError('模型账户余额不足（HTTP 402）')
    },
  }), FAST)

  const events = await collect(runner.run('余额不足'))
  const error = events.find(event => event.type === 'error')
  const runEnd = events.find(event => event.type === 'run-end')

  assert.equal(events.filter(event => event.type === 'worker-start').length, 0)
  assert.equal(runEnd?.type === 'run-end' ? runEnd.status : undefined, 'failed')
  assert.match(error?.type === 'error' ? error.message : '', /余额不足/)
})

test('isFatalProviderFailure：402/401/403 与 AUTH 视为不可重试', () => {
  assert.equal(isFatalProviderFailure({ status: 402 }), true)
  assert.equal(isFatalProviderFailure({ status: 401 }), true)
  assert.equal(isFatalProviderFailure({ status: 403 }), true)
  assert.equal(isFatalProviderFailure({ code: 'AUTH' }), true)
  assert.equal(isFatalProviderFailure({ code: 'INVALID_CREDENTIAL' }), true)
  assert.equal(isFatalProviderFailure({ status: 500, code: 'PROVIDER' }), false)
  assert.equal(isFatalProviderFailure({ status: 429, code: 'RATE_LIMIT' }), false)
})

test('单个 Worker 失败不影响其他 Worker，汇总仍会产出', async () => {
  const runner = new SuperAgentRunner(makeDeps({
    runWorker: async (item: SuperAgentPlanItem) => {
      if (item.title === '坏任务') throw new Error('故意失败')
      return { output: `好结果 ${item.title}` }
    },
    summarize: async (_goal, workers: readonly SuperAgentWorkerRecord[]) =>
      workers.map(worker => `${worker.title}:${worker.status}`).join('|'),
  }), FAST)

  const events = await collect(runner.run('混合目标', { subtasks: ['好任务一', '坏任务', '好任务二'] }))
  const runEnd = events.find(event => event.type === 'run-end')
  const summary = events.find(event => event.type === 'summary')

  assert.equal(runEnd?.type === 'run-end' ? runEnd.status : undefined, 'partial')
  assert.match(summary?.type === 'summary' ? summary.text : '', /坏任务:failed/)
})

test('Router 拆解失败时退化为单任务并继续执行', async () => {
  let planned = 0
  const runner = new SuperAgentRunner(makeDeps({
    plan: async () => {
      planned += 1
      throw new Error('模型不可用')
    },
  }), FAST)

  const events = await collect(runner.run('整体目标'))
  const plan = events.find(event => event.type === 'plan')
  const runEnd = events.find(event => event.type === 'run-end')
  const errors = events.filter(event => event.type === 'error')

  assert.equal(planned, 1)
  assert.equal(plan?.type === 'plan' ? plan.subtasks.length : undefined, 1)
  assert.equal(plan?.type === 'plan' ? plan.degraded : undefined, true)
  assert.ok(errors.length >= 1)
  assert.equal(runEnd?.type === 'run-end' ? runEnd.status : undefined, 'succeeded')
})

test('stop 会中止运行中的 Worker 并结束为 cancelled', async () => {
  const runner = new SuperAgentRunner(makeDeps({
    runWorker: (_item, context: SuperAgentWorkerContext) => new Promise((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true })
    }),
  }), { ...FAST, maxConcurrency: 1, workerTimeoutMs: 5_000, watchdogIntervalMs: 1_000 })

  const generator = runner.run('停止目标', { subtasks: ['长任务'] })
  const first = await generator.next()
  assert.equal(first.value.type, 'run-start')
  const runId = first.value.type === 'run-start' ? first.value.runId : ''
  assert.equal(runner.stop(runId), true)

  const rest = await collect(generator)
  const runEnd = rest.find(event => event.type === 'run-end')
  assert.equal(runEnd?.type === 'run-end' ? runEnd.status : undefined, 'cancelled')
})
