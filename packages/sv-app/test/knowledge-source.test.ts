/**
 * 知识来源单测：HTML → 文本、标题提取与网页抓取包装。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractPageTitle, fetchUrlPage, htmlTitle, htmlToText } from '../src/knowledge-source.ts'

test('htmlToText：去脚本/样式，保留段落与列表，解码常见实体', () => {
  const html = [
    '<html><head><style>body{color:red}</style><script>alert(1)</script></head>',
    '<body><h1>退休规划</h1><p>目标 &amp; 现金流</p><ul><li>指数基金</li><li>债券</li></ul></body></html>',
  ].join('')
  const text = htmlToText(html)
  assert.doesNotMatch(text, /alert|color:red/)
  assert.match(text, /退休规划/)
  assert.match(text, /目标 & 现金流/)
  assert.match(text, /- 指数基金/)
  assert.match(text, /- 债券/)
})

test('htmlTitle 与 extractPageTitle：title 优先，其次 h1，最后主机名', () => {
  assert.equal(htmlTitle('<title> 我的 &amp; 笔记 </title>'), '我的 & 笔记')
  assert.equal(extractPageTitle('<html><body><h2>正文标题</h2></body></html>', 'https://example.com/a'), '正文标题')
  assert.equal(extractPageTitle('<html></html>', 'https://example.com/a'), 'example.com')
})

test('fetchUrlPage：使用 ctx.web.fetch，返回标题与纯文本；非 2xx 抛错', async () => {
  const html = '<html><head><title>示例文章</title></head><body><p>正文内容</p></body></html>'
  const ctx = {
    web: {
      fetch: async () => ({
        url: 'https://example.com/article',
        statusCode: 200,
        body: { kind: 'html', content: html },
        truncated: false,
      }),
    },
  }
  const page = await fetchUrlPage(ctx as never, 'https://example.com/article')
  assert.equal(page.title, '示例文章')
  assert.equal(page.url, 'https://example.com/article')
  assert.match(page.text, /正文内容/)

  const badCtx = {
    web: {
      fetch: async () => ({
        url: 'https://example.com/missing',
        statusCode: 404,
        body: { kind: 'text', content: 'not found' },
        truncated: false,
      }),
    },
  }
  await assert.rejects(() => fetchUrlPage(badCtx as never, 'https://example.com/missing'), /HTTP 404/)
})
