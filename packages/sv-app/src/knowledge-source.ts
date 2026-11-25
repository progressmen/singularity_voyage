/**
 * 知识来源：网页抓取与 HTML → 纯文本。
 *
 * 抓取走宿主 `ctx.web.fetch`（与 web_fetch 工具同一个 fetch 提供方），
 * 不在知识库模块里另起一套 HTTP 栈；HTML 只做粗粒度转文本，保留段落与标题。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-web'

/** 抓取后的网页内容。 */
export interface FetchedPage {
  /** 重定向后的最终 URL。 */
  url: string
  title: string
  text: string
}

const HTML_TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i
const HTML_HEADING_RE = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (match, hex: string) => {
      try {
        return String.fromCodePoint(Number.parseInt(hex, 16))
      } catch {
        return match
      }
    })
    .replace(/&#(\d+);/g, (match, dec: string) => {
      try {
        return String.fromCodePoint(Number.parseInt(dec, 10))
      } catch {
        return match
      }
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
}

/** 从 HTML 里提取 `<title>`；找不到时返回 undefined。 */
export function htmlTitle(html: string): string | undefined {
  const match = HTML_TITLE_RE.exec(html)
  if (match === null) return undefined
  const title = decodeEntities(match[1] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  return title.length > 0 ? title : undefined
}

/** 把 HTML 粗略转成纯文本：去脚本/样式，块级标签转换行，列表加前缀。 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<\/li>/gi, '\n')
      .replace(/<\/?(p|div|section|article|header|footer|main|tr|h[1-6]|blockquote|pre|table|ul|ol)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 从 HTML 里提取一个可读标题：`<title>` → 第一个 h1-h3 → 主机名。 */
export function extractPageTitle(html: string, url: string): string {
  const title = htmlTitle(html)
  if (title !== undefined) return title
  let heading: string | undefined
  for (const match of html.matchAll(HTML_HEADING_RE)) {
    const value = decodeEntities(match[2] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    if (value.length > 0) {
      heading = value
      break
    }
  }
  if (heading !== undefined) return heading
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/**
 * 抓取一个网页并转成可入库的文本。
 * @param ctx - 插件上下文（使用 `ctx.web.fetch`）。
 * @param url - http(s) 地址。
 * @param signal - 可选取消信号。
 */
export async function fetchUrlPage(ctx: Context, url: string, signal?: AbortSignal): Promise<FetchedPage> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('网页地址非法')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('只支持 http(s) 网页地址')
  const result = await ctx.web.fetch({ url: parsed.toString() }, signal)
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(`网页抓取失败：HTTP ${result.statusCode}`)
  }
  const html = result.body.kind === 'html' ? result.body.content : undefined
  const text = html === undefined ? result.body.content : htmlToText(html)
  if (text.trim().length === 0) throw new Error('网页没有可提取的文本内容')
  return {
    url: result.url,
    title: html === undefined ? extractPageTitle('', result.url) : extractPageTitle(html, result.url),
    text,
  }
}
