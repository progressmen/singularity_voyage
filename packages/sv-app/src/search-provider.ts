/**
 * SV Web 搜索提供方：注册到 `ctx.web`（id: `sv-search`）。
 *
 * 支持两种协议（由 {@linkcode SvSearchConfig.provider} 决定）：
 *  - `tavily`：Tavily 兼容 API（POST {base}/search，api_key 走请求体）；
 *  - `bocha`：博查原生 Web Search API（POST {base}/v1/web-search，
 *    `Authorization: Bearer` 认证，支持 freshness 时效过滤）。
 *
 * 由 SV 组合包 patch 把 `web` 行的 `searchProvider` 指向本提供方，
 * 模型通过 `web_search` 工具触发；密钥与端点来自 {@linkcode ConfigStore}。
 */
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { SvSearchConfig } from './config-store.ts'

/** 注册到 ctx.web 的搜索提供方 id。 */
export const SV_SEARCH_PROVIDER_ID = 'sv-search'

/** 单次请求的结果数上限（seam 也会按 maxResults 强制截断）。 */
const MAX_RESULTS_HARD_CAP = 20

/** 博查 freshness 合法取值；非法值回退 noLimit。 */
const BOCHA_FRESHNESS = new Set(['oneDay', 'oneWeek', 'oneMonth', 'oneYear', 'noLimit'])

/** 韧性参数缺省值（env 优先于常量，页面配置优先于 env）。 */
export const SEARCH_RETRY_DEFAULTS = {
  attempts: 2,
  timeoutMs: 15_000,
  budgetMs: 30_000,
} as const

function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim().length === 0) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** 解析生效的韧性参数：页面配置 > 环境变量 > 缺省值。 */
export function resolveResilience(config: SvSearchConfig): { attempts: number; timeoutMs: number; budgetMs: number } {
  return {
    attempts: config.retryAttempts ?? envPositiveInt('SV_SEARCH_RETRY_ATTEMPTS') ?? SEARCH_RETRY_DEFAULTS.attempts,
    timeoutMs: config.timeoutMs ?? envPositiveInt('SV_SEARCH_API_TIMEOUT_MS') ?? SEARCH_RETRY_DEFAULTS.timeoutMs,
    budgetMs: config.budgetMs ?? envPositiveInt('SV_SEARCH_RETRY_BUDGET_MS') ?? SEARCH_RETRY_DEFAULTS.budgetMs,
  }
}

/**
 * 韧性包装：单次尝试叠加超时 signal，失败重试 attempts 次，重试阶段受
 * budgetMs 总预算约束。耗尽后 fail loud 抛出明确错误（SV 走 OpenAI 兼容
 * 适配器，没有“模型自带联网搜索”可降级——不做静默换通路）。
 */
export async function withSearchRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  resilience: { attempts: number; timeoutMs: number; budgetMs: number },
  outerSignal?: AbortSignal,
): Promise<T> {
  const { attempts, timeoutMs, budgetMs } = resilience
  let deadline = Number.POSITIVE_INFINITY
  let lastError: unknown
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    if (outerSignal?.aborted) {
      throw lastError ?? new Error('sv-app: 搜索请求已取消')
    }
    if (attempt > 0 && Date.now() >= deadline) break
    try {
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = outerSignal === undefined ? timeout : AbortSignal.any([outerSignal, timeout])
      return await fn(signal)
    } catch (error) {
      lastError = error
      if (outerSignal?.aborted) throw error
      if (attempt === 0) deadline = Date.now() + budgetMs
    }
  }
  throw new Error(`sv-app: 搜索请求失败（已重试 ${attempts} 次）: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

export class SvSearchProvider implements WebSearchProvider {
  readonly id = SV_SEARCH_PROVIDER_ID

  constructor(private readonly options: () => SvSearchConfig) {}

  /** 廉价本地检查：仅判断密钥是否已配置，禁止网络调用。 */
  available(): boolean {
    return this.options().apiKey.trim().length > 0
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const config = this.options()
    // 密钥缺失属配置错误，不做重试
    if (config.apiKey.trim().length === 0) {
      throw new Error(config.provider === 'bocha'
        ? 'sv-app: 尚未配置博查 API key；请在 SV 页面（/sv → 设置）填写，或设置环境变量 SV_SEARCH_BOCHA_API_KEY'
        : 'sv-app: 尚未配置 Web 搜索 API key；请在 SV 页面（/sv → 设置）填写，或设置环境变量 SV_SEARCH_API_KEY')
    }
    return withSearchRetry(inner => config.provider === 'bocha'
      ? this.searchBocha(config, request, inner)
      : this.searchTavily(config, request, inner), resolveResilience(config), signal)
  }

  /** Tavily 兼容 API：POST {base}/search，api_key 走请求体。 */
  private async searchTavily(config: SvSearchConfig, request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const apiKey = config.apiKey.trim()
    if (apiKey.length === 0) {
      throw new Error('sv-app: 尚未配置 Web 搜索 API key；请在 SV 页面（/sv → 设置）填写，或设置环境变量 SV_SEARCH_API_KEY')
    }
    const maxResults = clampResults(request.maxResults)
    const res = await postJson(`${config.baseURL.replace(/\/+$/, '')}/search`, {
      'content-type': 'application/json',
    }, JSON.stringify({
      api_key: apiKey,
      query: request.query,
      search_depth: 'basic',
      max_results: maxResults,
      include_answer: true,
    }), signal)
    if (!res.ok) throw await httpError('Web 搜索', res)
    const json = await res.json() as { results?: unknown; answer?: unknown }
    const entries = Array.isArray(json.results) ? json.results : []
    const sources: WebSearchSource[] = []
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue
      const url = (entry as { url?: unknown }).url
      if (typeof url !== 'string' || url.length === 0) continue
      const title = (entry as { title?: unknown }).title
      const content = (entry as { content?: unknown }).content
      sources.push({
        url,
        ...(typeof title === 'string' && title.length > 0 ? { title } : {}),
        ...(typeof content === 'string' && content.length > 0 ? { snippet: content } : {}),
      })
    }
    return cap(sources, maxResults, typeof json.answer === 'string' && json.answer.length > 0 ? json.answer : undefined)
  }

  /** 博查原生 API：POST {base}/v1/web-search，Bearer 认证，data.webPages.value 返回结果。 */
  private async searchBocha(config: SvSearchConfig, request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const apiKey = config.apiKey.trim()
    if (apiKey.length === 0) {
      throw new Error('sv-app: 尚未配置博查 API key；请在 SV 页面（/sv → 设置）填写，或设置环境变量 BOCHA_API_KEY')
    }
    const maxResults = clampResults(request.maxResults)
    const freshness = config.freshness !== undefined && BOCHA_FRESHNESS.has(config.freshness) ? config.freshness : 'noLimit'
    const res = await postJson(`${config.baseURL.replace(/\/+$/, '')}/v1/web-search`, {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`,
    }, JSON.stringify({
      query: request.query,
      freshness,
      summary: true,
      count: maxResults,
      page: 1,
    }), signal)
    if (!res.ok) throw await httpError('博查搜索', res)
    const json = await res.json() as { code?: unknown; data?: { webPages?: { value?: unknown } } }
    if (typeof json.code === 'number' && json.code !== 200 && json.code !== 0) {
      throw new Error(`sv-app: 博查搜索失败（code ${json.code}）`)
    }
    const pages = json.data?.webPages?.value
    const entries = Array.isArray(pages) ? pages : []
    const sources: WebSearchSource[] = []
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue
      const url = (entry as { url?: unknown }).url
      if (typeof url !== 'string' || url.length === 0) continue
      const name = (entry as { name?: unknown }).name
      const summary = (entry as { summary?: unknown }).summary
      const snippet = (entry as { snippet?: unknown }).snippet
      const text = typeof summary === 'string' && summary.length > 0 ? summary : typeof snippet === 'string' ? snippet : undefined
      sources.push({
        url,
        ...(typeof name === 'string' && name.length > 0 ? { title: name } : {}),
        ...(text !== undefined && text.length > 0 ? { snippet: text } : {}),
      })
    }
    return cap(sources, maxResults, undefined)
  }
}

function clampResults(maxResults: number | undefined): number {
  const requested = maxResults === undefined ? 8 : maxResults
  return Math.min(Math.max(requested, 1), MAX_RESULTS_HARD_CAP)
}

function cap(sources: WebSearchSource[], maxResults: number, content: string | undefined): WebSearchResult {
  const truncated = sources.length > maxResults
  return {
    sources: truncated ? sources.slice(0, maxResults) : sources,
    truncated,
    ...(content !== undefined ? { content } : {}),
  }
}

async function postJson(url: string, headers: Record<string, string>, body: string, signal?: AbortSignal): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      ...signal === undefined ? {} : { signal },
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new Error(`sv-app: 搜索请求失败: ${error instanceof Error ? error.message : String(error)}`)
  }
  return res
}

async function httpError(label: string, res: Response): Promise<Error> {
  let detail = ''
  try {
    detail = (await res.text()).slice(0, 300)
  } catch {
    // 保留空 detail
  }
  return new Error(`sv-app: ${label}失败 (HTTP ${res.status})${detail.length > 0 ? `: ${detail}` : ''}`)
}
