/* Trace 面板纯函数测试（node --test，零依赖）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import './trace.js'
const { classify, summarize, distribution, groupTools, detailText } = globalThis.SvTrace

test('classify：MCP 工具识别 server 名', () => {
  assert.deepEqual(classify('mcp__sv-demo__now'), { kind: 'mcp', server: 'sv-demo' })
  assert.deepEqual(classify('mcp__supply-chain-graph__chain_locate'), { kind: 'mcp', server: 'supply-chain-graph' })
})

test('classify：内置工具类型', () => {
  assert.equal(classify('web_search').kind, 'web')
  assert.equal(classify('web_fetch').kind, 'web')
  assert.equal(classify('skill').kind, 'skill')
  assert.equal(classify('bash').kind, 'terminal')
  assert.equal(classify('str_replace_editor').kind, 'file')
  assert.equal(classify('totally_unknown').kind, 'tool')
})

test('summarize：人话摘要而非原始工具名', () => {
  assert.equal(summarize('web_search', JSON.stringify({ queries: ['乙烯 产能'] })), '搜索「乙烯 产能」')
  assert.match(summarize('web_fetch', JSON.stringify({ url: 'https://example.com/a/b?x=1' })), /^抓取 example\.com/)
  assert.equal(summarize('mcp__sv-demo__now', '{}'), 'sv-demo · now')
  const fallback = summarize('custom_tool', JSON.stringify({ target: '某目标' }))
  assert.ok(fallback.includes('custom_tool') && fallback.includes('某目标'))
})

test('summarize：参数为空时兜底', () => {
  assert.equal(summarize('web_search', undefined), '联网搜索')
  assert.equal(summarize('mcp__sv-demo__echo', 'not-json'), 'sv-demo · echo')
})

test('distribution：按类型计数且只显示出现过的', () => {
  const tools = [
    { name: 'skill' },
    { name: 'web_search' },
    { name: 'web_search' },
    { name: 'mcp__sv-demo__now' },
  ]
  assert.equal(distribution(tools), '📘1 🔎1 🌐2')
  assert.equal(distribution([]), '')
})

test('groupTools：连续 ≥3 次同类型折叠', () => {
  const tools = [
    { name: 'mcp__a__x' }, { name: 'mcp__a__y' }, { name: 'mcp__a__z' },
    { name: 'web_search' },
  ]
  const runs = groupTools(tools)
  assert.equal(runs.length, 2)
  assert.equal(runs[0].collapsed, true)
  assert.equal(runs[0].items.length, 3)
  assert.equal(runs[1].collapsed, false)
})

test('groupTools：失败强制展开', () => {
  const tools = [
    { name: 'web_search', isError: false },
    { name: 'web_search', isError: false },
    { name: 'web_search', isError: true },
  ]
  const runs = groupTools(tools)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].failed, true)
  assert.equal(runs[0].collapsed, false)
})

test('groupTools：两个以下不折叠', () => {
  const runs = groupTools([{ name: 'bash' }, { name: 'bash' }])
  assert.equal(runs[0].collapsed, false)
})

test('detailText：参数与结果 pretty JSON、超长截断', () => {
  const text = detailText({
    args: '{"query":"abc"}',
    result: '{"ok":true}',
  })
  assert.match(text, /参数 \{/)
  assert.match(text, /"query": "abc"/)
  assert.match(text, /结果 \{/)
  const long = detailText({ args: 'x'.repeat(3000) })
  assert.ok(long.length < 3000)
  assert.ok(long.endsWith('…'))
})
