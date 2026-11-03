/* Markdown 渲染器纯函数测试（node --test，零依赖）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import './markdown.js'
const { render } = globalThis.SvMarkdown

test('标题、粗体、行内代码与链接', () => {
  const html = render('# 标题\n\n这是 **粗体**、*斜体*、`code`，见 [示例](https://example.com)。')
  assert.match(html, /<h1>标题<\/h1>/)
  assert.match(html, /<strong>粗体<\/strong>/)
  assert.match(html, /<em>斜体<\/em>/)
  assert.match(html, /<code>code<\/code>/)
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">示例<\/a>/)
})

test('无序、有序与嵌套列表', () => {
  const html = render('- A\n- B\n  - B1\n  - B2\n\n1. C\n2. D')
  assert.match(html, /<ul><li>A<\/li><li>B<ul><li>B1<\/li><li>B2<\/li><\/ul><\/li><\/ul>/)
  assert.match(html, /<ol><li>C<\/li><li>D<\/li><\/ol>/)
})

test('同缩进切换列表类型不会吞掉后续项', () => {
  const html = render('- A\n1. B\n2. C')
  assert.match(html, /<ul><li>A<\/li><\/ul>/)
  assert.match(html, /<ol><li>B<\/li><li>C<\/li><\/ol>/)
})

test('表格与对齐', () => {
  const html = render('| 名称 | 数值 |\n| --- | ---: |\n| A | 1 |')
  assert.match(html, /<table>/)
  assert.match(html, /<th>名称<\/th>/)
  assert.match(html, /<th style="text-align:right">数值<\/th>/)
  assert.match(html, /<td style="text-align:right">1<\/td>/)
})

test('代码块内容不参与行内格式化', () => {
  const html = render('```js\nconst x = "**not bold**"\n```')
  assert.match(html, /<pre><code class="language-js">const x = &quot;\*\*not bold\*\*&quot;<\/code><\/pre>/)
  assert.ok(!html.includes('<strong>'))
})

test('引用与分隔线', () => {
  const html = render('> 第一行\n> 第二行\n\n---')
  assert.match(html, /<blockquote>第一行<br>第二行<\/blockquote>/)
  assert.match(html, /<hr>/)
})

test('转义原始 HTML，拒绝 javascript 链接', () => {
  const html = render('<script>alert(1)</script>\n\n[bad](javascript:alert(1))')
  assert.ok(!html.includes('<script>'))
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(!html.includes('href="javascript:'))
  assert.match(html, /\[bad\]\(javascript:alert\(1\)\)/)
})

test('snake_case 不会被斜体化', () => {
  const html = render('变量 snake_case_name 保持不变')
  assert.ok(!html.includes('<em>'))
  assert.ok(html.includes('snake_case_name'))
})
