/**
 * 搜索韧性单测：resolveResilience 优先级与 withSearchRetry 重试/超时/预算语义。
 * 使用极短超时与 fake fn，不做真实网络调用。
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { resolveResilience, SEARCH_RETRY_DEFAULTS, SvSearchProvider, withSearchRetry } from '../src/search-provider.ts'

const ENV_KEYS = ['SV_SEARCH_RETRY_ATTEMPTS', 'SV_SEARCH_API_TIMEOUT_MS', 'SV_SEARCH_RETRY_BUDGET_MS'] as const
const saved = new Map<string, string | undefined>(ENV_KEYS.map(key => [key, process.env[key]]))

before(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})

after(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function searchConfig(extra: Record<string, unknown> = {}) {
  return { provider: 'tavily', baseURL: 'https://search.example.com', apiKey: '', ...extra } as Parameters<typeof resolveResilience>[0]
}

test('resolveResilience：页面配置 > 环境变量 > 缺省值', () => {
  assert.deepEqual(resolveResilience(searchConfig()), SEARCH_RETRY_DEFAULTS)

  process.env.SV_SEARCH_RETRY_ATTEMPTS = '5'
  process.env.SV_SEARCH_API_TIMEOUT_MS = '999'
  process.env.SV_SEARCH_RETRY_BUDGET_MS = '8888'
  assert.deepEqual(resolveResilience(searchConfig()), { attempts: 5, timeoutMs: 999, budgetMs: 8888 })

  assert.deepEqual(
    resolveResilience(searchConfig({ retryAttempts: 1, timeoutMs: 100, budgetMs: 200 })),
    { attempts: 1, timeoutMs: 100, budgetMs: 200 },
  )
})

test('resolveResilience 忽略非法环境变量', () => {
  process.env.SV_SEARCH_RETRY_ATTEMPTS = 'abc'
  process.env.SV_SEARCH_API_TIMEOUT_MS = '0'
  process.env.SV_SEARCH_RETRY_BUDGET_MS = '-3'
  const resolved = resolveResilience(searchConfig())
  assert.equal(resolved.attempts, SEARCH_RETRY_DEFAULTS.attempts)
  assert.equal(resolved.timeoutMs, SEARCH_RETRY_DEFAULTS.timeoutMs)
  assert.equal(resolved.budgetMs, SEARCH_RETRY_DEFAULTS.budgetMs)
})

test('withSearchRetry：首次成功直接返回', async () => {
  let calls = 0
  const value = await withSearchRetry(async () => {
    calls += 1
    return 'ok'
  }, { attempts: 2, timeoutMs: 1000, budgetMs: 5000 })
  assert.equal(value, 'ok')
  assert.equal(calls, 1)
})

test('withSearchRetry：失败后重试并成功', async () => {
  let calls = 0
  const value = await withSearchRetry(async () => {
    calls += 1
    if (calls === 1) throw new Error('boom')
    return 'recovered'
  }, { attempts: 2, timeoutMs: 1000, budgetMs: 5000 })
  assert.equal(value, 'recovered')
  assert.equal(calls, 2)
})

test('withSearchRetry：重试耗尽后 fail loud', async () => {
  let calls = 0
  await assert.rejects(
    () => withSearchRetry(async () => {
      calls += 1
      throw new Error('always')
    }, { attempts: 2, timeoutMs: 1000, budgetMs: 5000 }),
    (error: Error) => {
      assert.match(error.message, /已重试 2 次/)
      return true
    },
  )
  assert.equal(calls, 3) // 首次 + 2 次重试
})

test('withSearchRetry：预算耗尽后不再重试', async () => {
  let calls = 0
  await assert.rejects(
    () => withSearchRetry(async () => {
      calls += 1
      throw new Error('x')
    }, { attempts: 10, timeoutMs: 1000, budgetMs: 0 }),
  )
  assert.equal(calls, 1) // deadline 立即到期，不做重试
})

test('withSearchRetry：单次超时由 signal 传导', async () => {
  // AbortSignal.timeout 的定时器是 unref 的；测试中没有真实网络请求维持事件循环，
  // 需要一个 ref 的 keep-alive 定时器保证 abort 能触发。
  const slow = (signal: AbortSignal): Promise<never> =>
    new Promise((_, reject) => {
      const keepAlive = setTimeout(() => {}, 5_000)
      signal.addEventListener('abort', () => {
        clearTimeout(keepAlive)
        reject(signal.reason)
      }, { once: true })
    })
  await assert.rejects(
    () => withSearchRetry(slow, { attempts: 1, timeoutMs: 20, budgetMs: 10_000 }),
    /已重试 1 次/,
  )
})

test('withSearchRetry：外部取消立即抛出且不再调用 fn', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  await assert.rejects(
    () => withSearchRetry(async () => {
      calls += 1
      return 'x'
    }, { attempts: 3, timeoutMs: 1000, budgetMs: 5000 }, controller.signal),
  )
  assert.equal(calls, 0)
})

test('SvSearchProvider：密钥缺失直接抛错且不重试', async () => {
  const provider = new SvSearchProvider(() => searchConfig())
  assert.equal(provider.available(), false)
  let calls = 0
  await assert.rejects(
    () => provider.search({ query: 'q' } as Parameters<typeof provider.search>[0], undefined),
    (error: Error) => {
      assert.match(error.message, /尚未配置 Web 搜索 API key/)
      return true
    },
  )
  assert.equal(calls, 0)
})

test('SvSearchProvider：deepseek 复用模型 Key 并解析官方结果', async () => {
  const original = globalThis.fetch
  const calls: Array<{ url: string; auth: string; body: unknown }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      auth: String((init?.headers as Record<string, string> | undefined)?.authorization ?? ''),
      body: JSON.parse(String(init?.body ?? '{}')),
    })
    return new Response(JSON.stringify({
      results: [
        { title: 'T1', url: 'https://a.example/1', summary: 'S1', snippet: 'X1', date: '2026-06-01T00:00:00+00:00' },
        { title: 'T2', url: 'https://b.example/2', snippet: 'S2', date: null },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  try {
    const provider = new SvSearchProvider(
      () => searchConfig({ provider: 'deepseek', baseURL: 'https://api.deepseek.com', apiKey: '' }),
      () => 'sk-llm',
    )
    assert.equal(provider.available(), true)

    const result = await provider.search({ query: 'q', maxResults: 5 } as Parameters<typeof provider.search>[0])
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.url, 'https://api.deepseek.com/v1/tools/search')
    assert.equal(calls[0]!.auth, 'Bearer sk-llm')
    assert.deepEqual(calls[0]!.body, { query: 'q', count: 5 })
    assert.deepEqual(result.sources, [
      { url: 'https://a.example/1', title: 'T1', snippet: 'S1', publishedAt: '2026-06-01T00:00:00+00:00' },
      { url: 'https://b.example/2', title: 'T2', snippet: 'S2' },
    ])
    assert.equal(result.truncated, false)
  } finally {
    globalThis.fetch = original
  }
})

test('SvSearchProvider：deepseek 独立搜索密钥优先于模型 Key', async () => {
  const provider = new SvSearchProvider(
    () => searchConfig({ provider: 'deepseek', baseURL: 'https://api.deepseek.com', apiKey: 'sk-search' }),
    () => 'sk-llm',
  )
  assert.equal(provider.available(), true)

  let auth = ''
  const original = globalThis.fetch
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    auth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '')
    return new Response(JSON.stringify({ results: [] }), { status: 200 })
  }) as typeof fetch
  try {
    await provider.search({ query: 'q' } as Parameters<typeof provider.search>[0])
    assert.equal(auth, 'Bearer sk-search')
  } finally {
    globalThis.fetch = original
  }
})
