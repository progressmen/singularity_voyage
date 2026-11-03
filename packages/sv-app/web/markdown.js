/*
 * SV Markdown 渲染器：零依赖、双端可跑。
 *
 * - 浏览器：classic script 引入，挂 globalThis.SvMarkdown，app.js 用 render() 渲染 Router 汇总；
 * - node：import 副作用挂 globalThis.SvMarkdown，markdown.test.mjs 测纯函数。
 *
 * 安全约束：所有原文先 HTML 转义，再只生成白名单标签；不渲染原始 HTML，
 * 链接仅允许 http(s) / mailto，避免模型输出注入脚本。
 */
'use strict'

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** HTML 转义。 */
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, char => ESCAPES[char])
}

/** 行内格式：代码 > 链接 > 粗体 > 斜体 > 删除线。 */
function renderInline(raw) {
  const codes = []
  // 先摘出行内代码，避免其中的 ** / _ / 链接被继续解析。
  let text = String(raw).replace(/`([^`]+)`/g, (_, code) => {
    const token = `\u0000CODE${codes.length}\u0000`
    codes.push(`<code>${escapeHtml(code)}</code>`)
    return token
  })

  text = escapeHtml(text)

  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
    (_, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`,
  )
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  // 单下划线只在词边界生效，避免把 snake_case_name 斜体化。
  text = text.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,;:!?])/g, '$1<em>$2</em>')

  for (let index = 0; index < codes.length; index += 1) {
    text = text.replace(`\u0000CODE${index}\u0000`, codes[index])
  }
  return text
}

/** 拆表格行：去掉首尾竖线后按 | 切分。 */
function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim())
}

/** 是否为 Markdown 表格分隔行。 */
function isTableSeparator(line) {
  if (!line.includes('-')) return false
  const cells = splitRow(line)
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell))
}

/** 表格列对齐方式。 */
function tableAlign(cell) {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return ''
}

/** 解析连续的列表项（支持一层或多层缩进嵌套）。 */
function parseList(lines, start) {
  const items = []
  let index = start

  while (index < lines.length) {
    const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index])
    if (match === null) break
    const item = {
      indent: match[1].length,
      ordered: /^\d/.test(match[2]),
      text: match[3],
      line: index,
    }
    index += 1
    // 缩进续行并入当前项，保留换行。
    while (index < lines.length
      && /^\s+\S/.test(lines[index])
      && /^(\s*)([-*+]|\d+[.)])\s+/.test(lines[index]) === false) {
      item.text += `\n${lines[index].trim()}`
      index += 1
    }
    items.push(item)
  }

  let cursor = 0
  const build = (indent) => {
    const tag = items[cursor].ordered ? 'ol' : 'ul'
    let html = `<${tag}>`
    while (cursor < items.length && items[cursor].indent >= indent) {
      const item = items[cursor]
      const itemTag = item.ordered ? 'ol' : 'ul'
      if (item.indent === indent && itemTag !== tag) break
      if (item.indent > indent) {
        const nested = build(item.indent)
        html += nested.html
        cursor = nested.next
        continue
      }
      cursor += 1
      let content = renderInline(item.text).replace(/\n/g, '<br>')
      if (cursor < items.length && items[cursor].indent > indent) {
        const nested = build(items[cursor].indent)
        content += nested.html
        cursor = nested.next
      }
      html += `<li>${content}</li>`
    }
    html += `</${tag}>`
    return { html, next: cursor }
  }

  const result = build(items[0]?.indent ?? 0)
  // 同一缩进切换有序/无序列表时，build 会提前停下；回到该行的位置重新解析。
  return { html: result.html, next: items[result.next]?.line ?? index }
}

/** 渲染 Markdown 为安全 HTML。 */
function render(markdown) {
  const source = String(markdown ?? '').replace(/\r\n?/g, '\n')
  const lines = source.split('\n')
  const output = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    if (line.trim().length === 0) {
      index += 1
      continue
    }

    // 围栏代码块
    const fence = /^```\s*([\w-]*)\s*$/.exec(line)
    if (fence !== null) {
      const language = fence[1]
      const code = []
      index += 1
      while (index < lines.length && /^```\s*$/.test(lines[index]) === false) {
        code.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      output.push(
        `<pre><code${language.length > 0 ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>`,
      )
      continue
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      const level = Math.min(heading[1].length, 4)
      output.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`)
      index += 1
      continue
    }

    // 分隔线
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      output.push('<hr>')
      index += 1
      continue
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const quote = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''))
        index += 1
      }
      output.push(`<blockquote>${quote.map(item => renderInline(item)).join('<br>')}</blockquote>`)
      continue
    }

    // 表格
    if (line.includes('|')
      && index + 1 < lines.length
      && isTableSeparator(lines[index + 1])) {
      const header = splitRow(line)
      const separator = splitRow(lines[index + 1])
      const aligns = header.map((_, cellIndex) => tableAlign(separator[cellIndex] ?? ''))
      index += 2
      const rows = []
      while (index < lines.length && lines[index].includes('|') && lines[index].trim().length > 0) {
        rows.push(splitRow(lines[index]))
        index += 1
      }
      const headHtml = header
        .map((cell, cellIndex) => `<th${aligns[cellIndex] ? ` style="text-align:${aligns[cellIndex]}"` : ''}>${renderInline(cell)}</th>`)
        .join('')
      const bodyHtml = rows
        .map(row => `<tr>${header.map((_, cellIndex) => {
          const align = aligns[cellIndex]
          return `<td${align ? ` style="text-align:${align}"` : ''}>${renderInline(row[cellIndex] ?? '')}</td>`
        }).join('')}</tr>`)
        .join('')
      output.push(`<div class="md-table-wrap"><table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`)
      continue
    }

    // 列表
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const list = parseList(lines, index)
      output.push(list.html)
      index = list.next
      continue
    }

    // 段落：吃到空行或下一个块级语法
    const paragraph = []
    while (index < lines.length && lines[index].trim().length > 0) {
      const current = lines[index]
      if (/^```/.test(current)
        || /^(#{1,6})\s+/.test(current)
        || /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(current)
        || /^\s*>\s?/.test(current)
        || /^\s*([-*+]|\d+[.)])\s+/.test(current)
        || (current.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1]))) {
        break
      }
      paragraph.push(current.trim())
      index += 1
    }
    if (paragraph.length > 0) {
      output.push(`<p>${paragraph.map(item => renderInline(item)).join('<br>')}</p>`)
    }
  }

  return output.join('\n')
}

globalThis.SvMarkdown = { render }
