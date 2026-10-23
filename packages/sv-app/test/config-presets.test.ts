/**
 * ConfigStore 预设与校验单测：provider 反推、切换回填、搜索韧性参数。
 * 通过 SV_HOME 指向临时目录，避免污染真实 $DSH_HOME。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { ConfigStore, inferLlmProvider, SV_LLM_PRESETS } from '../src/config-store.ts'

let home: string
const savedHome = process.env.SV_HOME

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'sv-config-'))
  process.env.SV_HOME = home
})

after(async () => {
  if (savedHome === undefined) delete process.env.SV_HOME
  else process.env.SV_HOME = savedHome
  await rm(home, { recursive: true, force: true })
})

function defaults() {
  return {
    llm: { provider: 'custom' as const, baseURL: '', model: '', apiKey: '' },
    search: { provider: 'tavily' as const, baseURL: '', apiKey: '' },
  }
}

test('inferLlmProvider 按端点反推预设', () => {
  assert.equal(inferLlmProvider('https://api.deepseek.com'), 'deepseek')
  assert.equal(inferLlmProvider('https://api.deepseek.com/'), 'deepseek')
  assert.equal(inferLlmProvider('https://DASHSCOPE.aliyuncs.com/compatible-mode/v1/'), 'qwen')
  assert.equal(inferLlmProvider('https://ark.cn-beijing.volces.com/api/v3'), 'ark')
  assert.equal(inferLlmProvider('https://api.openai.com/v1'), 'openai')
  assert.equal(inferLlmProvider('https://example.com/v1'), 'custom')
  assert.equal(inferLlmProvider(''), 'custom')
})

test('预设表覆盖四个供应商且端点合法', () => {
  for (const [id, preset] of Object.entries(SV_LLM_PRESETS)) {
    assert.ok(preset.baseURL.startsWith('https://'), `${id} baseURL`)
    assert.ok(preset.model.length > 0, `${id} model`)
  }
})

test('update 切换 provider 时回填预设端点与模型', async () => {
  const store = new ConfigStore(defaults())
  const state = await store.update({ llm: { provider: 'deepseek' } })
  assert.equal(state.llm.provider, 'deepseek')
  assert.equal(state.llm.baseURL, SV_LLM_PRESETS.deepseek.baseURL)
  assert.equal(state.llm.model, SV_LLM_PRESETS.deepseek.model)
})

test('update 同一补丁显式给出的端点/模型不被预设覆盖', async () => {
  const store = new ConfigStore(defaults())
  const state = await store.update({ llm: { provider: 'qwen', baseURL: 'https://my-proxy.example.com/v1', model: 'my-model' } })
  assert.equal(state.llm.baseURL, 'https://my-proxy.example.com/v1')
  assert.equal(state.llm.model, 'my-model')
})

test('update 拒绝非法 provider 与非法模型', async () => {
  const store = new ConfigStore(defaults())
  await assert.rejects(() => store.update({ llm: { provider: 'gpt' } }), /provider/)
  await assert.rejects(() => store.update({ llm: { model: '' } }), /模型 id/)
})

test('update 搜索韧性参数：正整数校验、null 清除', async () => {
  const store = new ConfigStore(defaults())
  const state = await store.update({ search: { retryAttempts: 3, timeoutMs: 5000, budgetMs: 10000 } })
  assert.equal(state.search.retryAttempts, 3)
  assert.equal(state.search.timeoutMs, 5000)
  assert.equal(state.search.budgetMs, 10000)

  await assert.rejects(() => store.update({ search: { retryAttempts: 0 } }), /正整数/)
  await assert.rejects(() => store.update({ search: { timeoutMs: -1 } }), /正整数/)

  const cleared = await store.update({ search: { retryAttempts: null, timeoutMs: null, budgetMs: null } })
  assert.equal(cleared.search.retryAttempts, undefined)
  assert.equal(cleared.search.timeoutMs, undefined)
  assert.equal(cleared.search.budgetMs, undefined)
})

test('publicState 不泄漏密钥明文', async () => {
  const store = new ConfigStore(defaults())
  await store.update({ llm: { apiKey: 'sk-secret' }, search: { apiKey: 'search-secret' } })
  const json = JSON.stringify(store.publicState())
  assert.ok(!json.includes('sk-secret'))
  assert.ok(!json.includes('search-secret'))
})

test('load 兼容无 provider 字段的旧配置（按端点反推）', async () => {
  await writeFile(join(home, 'config.json'), JSON.stringify({
    llm: { baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'k1' },
    search: { provider: 'bocha', baseURL: 'https://api.bochaai.com', retryAttempts: 5 },
  }), 'utf8')
  const store = new ConfigStore(defaults())
  await store.load()
  assert.equal(store.llm.provider, 'deepseek')
  assert.equal(store.llm.apiKey, 'k1')
  assert.equal(store.search.retryAttempts, 5)

  const state = store.publicState()
  assert.equal(state.search.provider, 'bocha')
  assert.equal(state.search.retryAttempts, 5)
})

test('load 忽略非法韧性字段', async () => {
  await writeFile(join(home, 'config.json'), JSON.stringify({
    search: { retryAttempts: 'x', timeoutMs: 0, budgetMs: -5 },
  }), 'utf8')
  const store = new ConfigStore(defaults())
  await store.load()
  assert.equal(store.search.retryAttempts, undefined)
  assert.equal(store.search.timeoutMs, undefined)
  assert.equal(store.search.budgetMs, undefined)
})

test('update 邮件配置：校验端口与摘要时间，密码不回传', async () => {
  const store = new ConfigStore(defaults())
  const state = await store.update({
    mail: {
      enabled: true,
      host: 'smtp.qq.com',
      port: 465,
      secure: true,
      user: 'me@qq.com',
      password: 'app-pass',
      to: 'me@qq.com',
      notifyOnReminder: true,
      digestAt: '08:30',
    },
  })
  assert.equal(state.mail.enabled, true)
  assert.equal(state.mail.host, 'smtp.qq.com')
  assert.equal(state.mail.hasPassword, true)
  assert.equal(state.mail.from, 'me@qq.com', '发件人留空回落到账号')
  assert.equal(state.mail.digestAt, '08:30')
  assert.ok(!JSON.stringify(state).includes('app-pass'))

  await assert.rejects(() => store.update({ mail: { port: 0 } }), /端口/)
  await assert.rejects(() => store.update({ mail: { digestAt: '8:3' } }), /HH:mm/)
  await assert.rejects(() => store.update({ mail: { enabled: 'yes' } }), /布尔值/)

  const cleared = await store.update({ mail: { digestAt: '' } })
  assert.equal(cleared.mail.digestAt, '')
})

test('load 读取 mail 节并忽略非法摘要时间', async () => {
  await writeFile(join(home, 'config.json'), JSON.stringify({
    mail: {
      enabled: true,
      host: 'smtp.163.com',
      port: 587,
      secure: false,
      user: 'a@163.com',
      password: 'p1',
      to: 'a@163.com,b@163.com',
      digestAt: '99:99',
    },
  }), 'utf8')
  const store = new ConfigStore(defaults())
  await store.load()
  assert.equal(store.mail.enabled, true)
  assert.equal(store.mail.host, 'smtp.163.com')
  assert.equal(store.mail.port, 587)
  assert.equal(store.mail.secure, false)
  assert.equal(store.mail.to, 'a@163.com,b@163.com')
  assert.equal(store.mail.digestAt, '')
  assert.equal(store.publicState().mail.hasPassword, true)
})
