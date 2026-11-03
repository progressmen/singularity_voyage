/**
 * Super-agent 运行历史持久化单测：保存/加载回环、损坏文件、历史上限与文件权限。
 * 通过 SV_HOME 指向临时目录，避免污染真实 $DSH_HOME。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { SuperAgentRunStore } from '../src/superagent-store.ts'
import { SUPER_AGENT_HISTORY_LIMIT, type SuperAgentRunView } from '../src/superagent.ts'

let home: string
const savedHome = process.env.SV_HOME

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'sv-superagent-store-'))
  process.env.SV_HOME = home
})

after(async () => {
  if (savedHome === undefined) delete process.env.SV_HOME
  else process.env.SV_HOME = savedHome
  await rm(home, { recursive: true, force: true })
})

function makeRun(id: string, startedAt: number, status: SuperAgentRunView['status'] = 'succeeded'): SuperAgentRunView {
  const run: SuperAgentRunView = {
    id,
    goal: `目标 ${id}`,
    status,
    startedAt,
    workers: [{
      index: 0,
      title: '任务',
      prompt: '执行任务',
      status: 'succeeded',
      attempts: 1,
      startedAt,
      output: '结果',
      durationMs: 12,
    }],
  }
  if (status === 'succeeded') run.summary = '汇总'
  if (status !== 'running') {
    run.finishedAt = startedAt + 20
    run.durationMs = 20
  }
  return run
}

test('保存后重新加载能恢复运行与 Worker 输出', async () => {
  const store = new SuperAgentRunStore()
  await store.save([makeRun('a', 200), makeRun('b', 100, 'failed')])

  const next = new SuperAgentRunStore()
  await next.load()
  const runs = next.list()

  assert.equal(runs.length, 2)
  assert.equal(runs[0]?.id, 'a')
  assert.equal(runs[0]?.summary, '汇总')
  assert.equal(runs[0]?.workers[0]?.output, '结果')
  assert.equal(runs[1]?.status, 'failed')
})

test('写入文件权限为 0600', async () => {
  const store = new SuperAgentRunStore()
  await store.save([makeRun('mode', 1)])
  const info = await stat(join(home, 'superagent-runs.json'))
  assert.equal(info.mode & 0o777, 0o600)
})

test('损坏文件按空历史处理', async () => {
  await writeFile(join(home, 'superagent-runs.json'), '{ not json', 'utf8')
  const store = new SuperAgentRunStore()
  await store.load()
  assert.deepEqual(store.list(), [])
})

test('只保留最近 N 条并按开始时间倒序', async () => {
  const store = new SuperAgentRunStore()
  const runs = Array.from({ length: SUPER_AGENT_HISTORY_LIMIT + 5 }, (_, index) =>
    makeRun(`run-${index}`, index))
  await store.save(runs)

  const next = new SuperAgentRunStore()
  await next.load()
  const loaded = next.list()
  assert.equal(loaded.length, SUPER_AGENT_HISTORY_LIMIT)
  assert.equal(loaded[0]?.id, `run-${SUPER_AGENT_HISTORY_LIMIT + 4}`)
  for (let index = 1; index < loaded.length; index += 1) {
    assert.ok((loaded[index - 1]?.startedAt ?? 0) >= (loaded[index]?.startedAt ?? 0))
  }
})

test('加载时丢弃缺少 id / goal 的条目，并兼容顶层数组格式', async () => {
  const payload = [
    makeRun('good', 10),
    { goal: '没有 id' },
    { id: 'no-goal' },
  ]
  await writeFile(join(home, 'superagent-runs.json'), JSON.stringify(payload), 'utf8')
  const store = new SuperAgentRunStore()
  await store.load()
  assert.deepEqual(store.list().map(run => run.id), ['good'])
})

test('保存内容包含版本字段且可读', async () => {
  const store = new SuperAgentRunStore()
  await store.save([makeRun('version', 1)])
  const parsed = JSON.parse(await readFile(join(home, 'superagent-runs.json'), 'utf8')) as {
    version?: number
    runs?: unknown[]
  }
  assert.equal(parsed.version, 1)
  assert.equal(parsed.runs?.length, 1)
})
