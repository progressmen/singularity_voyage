/**
 * 网页配图检索：先用现有搜索拿到相关网页，再从页面提取封面图/正文图。
 *
 * 不引入额外的图片搜索服务：复用 `ctx.web.search` 与 `ctx.web.fetch`，
 * 因此不需要新密钥。图片地址只做「结构上可用」的校验（http(s)、常见格式、
 * 排除小图标与统计像素），是否真的能加载由浏览器决定，前端会隐藏破图。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-web'

/** 一条配图候选。 */
export interface ImageHit {
  /** 可直接写进 Markdown 的图片地址。 */
  url: string
  /** 图片所在网页。 */
  pageUrl: string
  /** 网页标题。 */
  title: string
}

/** 单页抓取超时：搜索结果再多也不拖住整轮回答。 */
const PAGE_TIMEOUT_MS = 6000

/** 明显不是正文配图的地址片段（图标、头像、统计像素等）。 */
const BLOCKED_URL_PARTS = [
  'sprite',
  'logo',
  'icon',
  'avatar',
  'emoji',
  'badge',
  'pixel',
  'tracking',
  'analytics',
  'placeholder',
  'blank.gif',
  '1x1',
  'spacer',
  'sharepic',
  'qrcode',
  'qr_code',
]

/** 常见位图格式；只接受能在浏览器里直接展示的类型。 */
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|avif)(?:[?#]|$)/i

/** 解析标签属性，返回小写键名到值的映射。 */
function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g)) {
    const key = match[1]
    const raw = match[2]
    if (key === undefined || raw === undefined) continue
    attrs[key.toLowerCase()] = raw.replace(/^["']|["']$/g, '')
  }
  return attrs
}

/** 把相对地址补全为绝对地址；非法地址返回 undefined。 */
export function resolveImageUrl(raw: string, pageUrl: string): string | undefined {
  const value = raw.trim().replace(/&amp;/g, '&')
  if (value.length === 0 || value.startsWith('data:')) return undefined
  try {
    const url = new URL(value, pageUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

/** 是否为可用的正文配图地址。 */
export function isUsableImageUrl(url: string): boolean {
  const lower = url.toLowerCase()
  if (lower.includes('/favicon') || lower.includes('favicon.')) return false
  if (!IMAGE_EXT_RE.test(lower) && !/[?&](?:image|img|pic|url)=/i.test(lower)) return false
  return !BLOCKED_URL_PARTS.some(part => lower.includes(part))
}

/**
 * 从 HTML 提取候选图片：og:image / twitter:image / 正文 img 依次兜底。
 * @param html - 网页 HTML。
 * @param pageUrl - 重定向后的最终地址，用于补全相对路径。
 * @returns 去重后的绝对图片地址（最多 4 个）。
 */
export function extractPageImages(html: string, pageUrl: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const push = (raw: string | undefined): boolean => {
    if (raw === undefined) return false
    const url = resolveImageUrl(raw, pageUrl)
    if (url === undefined || seen.has(url) || !isUsableImageUrl(url)) return false
    seen.add(url)
    found.push(url)
    return true
  }

  // 1) 社交卡片封面图：通常就是页面的主图
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = parseAttrs(tag)
    const key = (attrs.property ?? attrs.name ?? '').toLowerCase()
    if (key === 'og:image' || key === 'og:image:url' || key === 'og:image:secure_url'
      || key === 'twitter:image' || key === 'twitter:image:src') {
      push(attrs.content)
    }
    if (found.length >= 4) return found
  }

  // 2) <link rel="image_src">
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attrs = parseAttrs(tag)
    if ((attrs.rel ?? '').toLowerCase() === 'image_src') push(attrs.href)
    if (found.length >= 4) return found
  }

  // 3) 正文图片：优先 src，其次 srcset 的第一段
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const attrs = parseAttrs(tag)
    const width = Number(attrs.width ?? 0)
    const height = Number(attrs.height ?? 0)
    if (width > 0 && width < 120) continue
    if (height > 0 && height < 90) continue
    const src = attrs.src ?? attrs['data-src'] ?? attrs['data-original']
    const srcset = attrs.srcset ?? attrs['data-srcset']
    const candidate = src ?? srcset?.split(',')[0]?.trim().split(/\s+/)[0]
    if (push(candidate) && found.length >= 4) break
  }

  return found
}

/** 抓取单个网页并提取图片；失败按无图处理。 */
async function fetchPageImages(ctx: Context, pageUrl: string, signal?: AbortSignal): Promise<string[]> {
  const timeout = AbortSignal.timeout(PAGE_TIMEOUT_MS)
  const pageSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const result = await ctx.web.fetch({ url: pageUrl }, pageSignal)
  if (result.statusCode < 200 || result.statusCode >= 300) return []
  if (result.body.kind !== 'html') return []
  return extractPageImages(result.body.content, result.url)
}

/**
 * 搜索主题相关网页并提取可用配图。
 * @param ctx - 插件上下文（使用 `ctx.web.search` / `ctx.web.fetch`）。
 * @param query - 图片主题。
 * @param options - 抓取网页数与返回图片数上限。
 */
export async function searchImages(
  ctx: Context,
  query: string,
  options: { count?: number; pages?: number; signal?: AbortSignal } = {},
): Promise<ImageHit[]> {
  const count = Math.min(8, Math.max(1, Math.trunc(options.count ?? 4)))
  const pages = Math.min(4, Math.max(1, Math.trunc(options.pages ?? 3)))
  const result = await ctx.web.search({ query, maxResults: pages }, options.signal)
  const sources = result.sources.slice(0, pages)
  if (sources.length === 0) return []

  const settled = await Promise.allSettled(
    sources.map(source => fetchPageImages(ctx, source.url, options.signal)),
  )
  const hits: ImageHit[] = []
  const seen = new Set<string>()
  for (let index = 0; index < sources.length; index += 1) {
    if (hits.length >= count) break
    const outcome = settled[index]
    const source = sources[index]
    if (outcome === undefined || source === undefined) continue
    if (outcome.status !== 'fulfilled') continue
    for (const url of outcome.value) {
      if (seen.has(url)) continue
      seen.add(url)
      hits.push({
        url,
        pageUrl: source.url,
        title: source.title ?? '',
      })
      if (hits.length >= count) break
    }
  }
  return hits
}
