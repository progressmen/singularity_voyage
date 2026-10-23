/*
 * SV Trace 面板：工具调用步骤的可视化（零依赖，双端可跑）。
 *
 * - 浏览器：classic script 引入，挂 window.SvTrace，app.js 调用 render()；
 * - node：import 副作用挂 globalThis.SvTrace，trace.test.mjs 测纯函数。
 *
 * 参考实现：invest-agent-dsh frontend/trace.js —— 类型分布行直接回答
 * "这轮到底用没用查数工具"；连续 ≥3 次同一类型自动折叠；失败步骤强制展开。
 */
'use strict'

const MCP_PREFIX = 'mcp__'

/** 工具类型 → 展示徽章。顺序即分布行显示顺序。 */
const KIND_BADGES = [
  ['skill', '📘'],
  ['mcp', '🔎'],
  ['web', '🌐'],
  ['file', '📄'],
  ['terminal', '⌨'],
  ['tool', '🔧'],
]

const FILE_TOOL_RE = /^(str_replace_editor|str_replace_based_edit_tool|view|read|write|edit|glob|grep|list|search|find)(_|$)/i
const TERMINAL_TOOL_RE = /^(bash|sh|shell|terminal|command|exec|process)(_|$)/i

/** 按工具名分类；MCP 工具（mcp__<server>__<tool>）额外给出 server 名。 */
function classify(name) {
  const n = String(name ?? '')
  if (n.startsWith(MCP_PREFIX)) {
    const rest = n.slice(MCP_PREFIX.length)
    const sep = rest.indexOf('__')
    const server = sep >= 0 ? rest.slice(0, sep) : rest
    return { kind: 'mcp', server }
  }
  if (n === 'skill' || n.startsWith('skill_') || n.startsWith('skill-')) return { kind: 'skill' }
  if (n === 'web_search' || n === 'web_fetch' || n.startsWith('web_')) return { kind: 'web' }
  if (TERMINAL_TOOL_RE.test(n)) return { kind: 'terminal' }
  if (FILE_TOOL_RE.test(n)) return { kind: 'file' }
  return { kind: 'tool' }
}

function badgeOf(kind) {
  const hit = KIND_BADGES.find(([k]) => k === kind)
  return hit ? hit[1] : '🔧'
}

function clipText(text, max) {
  const s = String(text ?? '')
  return s.length <= max ? s : `${s.slice(0, max)}…`
}

function parseArgs(args) {
  if (args === undefined || args === null || args === '') return {}
  if (typeof args === 'object') return args
  try {
    const parsed = JSON.parse(args)
    return typeof parsed === 'object' && parsed !== null ? parsed : { value: parsed }
  } catch {
    return {}
  }
}

function firstString(obj) {
  for (const value of Object.values(obj ?? {})) {
    if (typeof value === 'string' && value.trim().length > 0) return value
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') return value.join(' ')
  }
  return undefined
}

function hostOf(url) {
  try {
    const parsed = new URL(String(url))
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return clipText(url, 40)
  }
}

/** 人话摘要：标题不是原始工具名，而是这一步在做什么。 */
function summarize(name, args) {
  const n = String(name ?? '')
  const a = parseArgs(args)
  const info = classify(n)
  if (info.kind === 'mcp') {
    const tool = n.startsWith(MCP_PREFIX) ? n.slice(MCP_PREFIX.length).split('__').slice(1).join('__') : n
    return clipText(`${info.server ?? 'mcp'} · ${tool || '工具'}`, 48)
  }
  if (n === 'web_search') {
    const query = (Array.isArray(a.queries) ? a.queries.join(' ') : undefined) ?? firstString(a)
    return query ? `搜索「${clipText(query, 40)}」` : '联网搜索'
  }
  if (n === 'web_fetch') return a.url ? `抓取 ${clipText(hostOf(a.url), 48)}` : '抓取网页'
  if (info.kind === 'skill') return `技能 ${clipText(a.name ?? a.skill ?? n, 40)}`
  if (info.kind === 'terminal') return a.command ? `终端 ${clipText(String(a.command).split('\n')[0], 40)}` : '终端命令'
  if (info.kind === 'file') return `${clipText(a.path ?? a.file ?? firstString(a) ?? n, 48)}`
  const text = firstString(a)
  return text ? `${clipText(n, 24)} ${clipText(text, 36)}` : clipText(n, 48)
}

/** 类型分布行：`📘2 🌐4 🔎1`（只统计出现过的类型）。 */
function distribution(tools) {
  const counts = new Map()
  for (const tool of tools ?? []) {
    const { kind } = classify(tool?.name)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return KIND_BADGES
    .filter(([kind]) => counts.has(kind))
    .map(([kind, badge]) => `${badge}${counts.get(kind)}`)
    .join(' ')
}

/**
 * 连续同类型分组：连续 ≥3 次同一 kind 折叠为一组；
 * 组内任一失败则该组强制展开（失败不能被折叠藏起来）。
 * 纯函数，便于测试。
 */
function groupTools(tools) {
  const runs = []
  for (const tool of tools ?? []) {
    const { kind } = classify(tool?.name)
    const last = runs[runs.length - 1]
    if (last && last.kind === kind) {
      last.items.push(tool)
    } else {
      runs.push({ kind, items: [tool] })
    }
  }
  for (const run of runs) {
    run.failed = run.items.some(item => item?.isError === true)
    run.collapsed = run.items.length >= 3 && !run.failed
  }
  return runs
}

/** 展开体文本：参数 + 结果（pretty JSON，超长截断）。 */
function detailText(tool) {
  const parts = []
  const pretty = (raw) => {
    if (raw === undefined || raw === null || raw === '') return undefined
    if (typeof raw === 'string') {
      try {
        return JSON.stringify(JSON.parse(raw), null, 2)
      } catch {
        return raw
      }
    }
    try {
      return JSON.stringify(raw, null, 2)
    } catch {
      return String(raw)
    }
  }
  const args = pretty(tool?.args)
  if (args !== undefined) parts.push(`参数 ${clipText(args, 2000)}`)
  const result = pretty(tool?.result)
  if (result !== undefined) parts.push(`结果 ${clipText(result, 2000)}`)
  return parts.join('\n\n')
}

function durationText(tool) {
  const ms = tool?.durationMs
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

function buildRow(tool) {
  const info = classify(tool?.name)
  const kind = info.kind
  const row = document.createElement('details')
  row.className = `trace-row kind-${kind}${tool?.isError ? ' failed' : ''}${tool?.phase === 'start' ? ' running' : ''}`
  const summary = document.createElement('summary')
  const badge = document.createElement('span')
  badge.className = 'trace-badge'
  badge.textContent = badgeOf(kind)
  const title = document.createElement('span')
  title.className = 'trace-title'
  title.textContent = summarize(tool?.name, tool?.args)
  summary.appendChild(badge)
  summary.appendChild(title)
  const meta = document.createElement('span')
  meta.className = 'trace-meta'
  const duration = durationText(tool)
  meta.textContent = tool?.isError ? `✕ ${duration}`.trim() : (tool?.phase === 'start' ? '…' : duration)
  summary.appendChild(meta)
  row.appendChild(summary)
  const body = detailText(tool)
  if (body.length > 0) {
    const pre = document.createElement('pre')
    pre.className = 'trace-detail'
    pre.textContent = body
    row.appendChild(pre)
  }
  if (info.server !== undefined && info.kind === 'mcp') row.dataset.server = info.server
  return row
}

function buildGroup(run) {
  if (!run.collapsed) {
    const frag = document.createDocumentFragment()
    for (const item of run.items) frag.appendChild(buildRow(item))
    return frag
  }
  const group = document.createElement('details')
  group.className = `trace-group kind-${run.kind}`
  const summary = document.createElement('summary')
  const badge = document.createElement('span')
  badge.className = 'trace-badge'
  badge.textContent = badgeOf(run.kind)
  const title = document.createElement('span')
  title.className = 'trace-title'
  const first = summarize(run.items[0]?.name, run.items[0]?.args)
  const same = run.items.every(item => summarize(item?.name, item?.args) === first)
  title.textContent = same ? `${run.items.length} 次 · ${first}` : `${run.items.length} 次 · ${first} 等`
  summary.appendChild(badge)
  summary.appendChild(title)
  const meta = document.createElement('span')
  meta.className = 'trace-meta'
  meta.textContent = '展开'
  summary.appendChild(meta)
  group.appendChild(summary)
  for (const item of run.items) group.appendChild(buildRow(item))
  return group
}

/** 渲染一条 assistant 消息的 trace 面板（container 内容整体替换）。 */
function render(container, tools) {
  container.innerHTML = ''
  const list = tools ?? []
  if (list.length === 0) {
    container.hidden = true
    return
  }
  container.hidden = false
  const dist = distribution(list)
  if (dist.length > 0) {
    const distRow = document.createElement('div')
    distRow.className = 'trace-dist'
    distRow.textContent = dist
    distRow.title = '本轮工具调用的类型分布'
    container.appendChild(distRow)
  }
  for (const run of groupTools(list)) container.appendChild(buildGroup(run))
}

const SvTrace = { classify, summarize, distribution, groupTools, detailText, badgeOf, render }
globalThis.SvTrace = SvTrace
