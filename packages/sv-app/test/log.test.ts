/**
 * 日志格式单测：前缀、字段顺序、引号规则、err 行尾、异常提取。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { appendSvLogLine, installSvLogSink, svError, svLog, svLogFileName } from '../src/log.ts'

test('svLog：模块前缀 + 事件名', () => {
  assert.equal(svLog('index', 'surface_ready'), '[sv-app][index] surface_ready')
})

test('svLog：数字/布尔裸写，含空格的值加引号', () => {
  assert.equal(
    svLog('memory', 'memory_extracted', { sessionId: 'a1', count: 2, ok: true }),
    '[sv-app][memory] memory_extracted sessionId=a1 count=2 ok=true',
  )
  assert.equal(
    svLog('chat', 'session_resume_failed', { sessionId: 'a b' }),
    '[sv-app][chat] session_resume_failed sessionId="a b"',
  )
})

test('svLog：err 永远在行尾，即使传入顺序在前', () => {
  assert.equal(
    svLog('http', 'request_failed', { err: 'boom', method: 'POST', path: '/sv/api/chat' }),
    '[sv-app][http] request_failed method=POST path=/sv/api/chat err=boom',
  )
})

test('svLog：undefined 与 null 字段省略；空 err 不输出', () => {
  assert.equal(
    svLog('tasks', 'tasks_load_failed', { sessionId: undefined, count: null, err: '' }),
    '[sv-app][tasks] tasks_load_failed',
  )
})

test('svError：Error 取 message，其他值转字符串', () => {
  assert.equal(svError(new Error('disk full')), 'disk full')
  assert.equal(svError('plain'), 'plain')
  assert.equal(svError(42), '42')
})

test('installSvLogSink：只输出 sv-app 的 info/warn/error，跳过 debug 与其他插件', () => {
  const lines: string[] = []
  let handler: ((message: { name: string; type: string; args: unknown[] }) => void) | undefined
  installSvLogSink({
    exporter(options) {
      handler = options.export
      return () => {}
    },
  }, line => lines.push(line))
  assert.ok(handler !== undefined)

  handler({ name: '@singularity-voyage/sv-app', type: 'info', args: ['[sv-app][index] surface_ready path=/sv/'] })
  handler({ name: '@singularity-voyage/sv-app', type: 'warn', args: ['[sv-app][http] request_failed'] })
  handler({ name: '@singularity-voyage/sv-app', type: 'debug', args: ['[sv-app][http] trace'] })
  handler({ name: '@deepseek-ai/dsh-base', type: 'error', args: ['kernel boom'] })

  assert.deepEqual(lines, ['[sv-app][index] surface_ready path=/sv/', '[sv-app][http] request_failed'])
})

test('appendSvLogLine：按本地日期追加到 sv-YYYY-MM-DD.log，跨天分文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sv-log-'))
  const previous = process.env.SV_LOG_DIR
  process.env.SV_LOG_DIR = dir
  try {
    const day1 = new Date(2026, 9, 25, 23, 59)
    const day2 = new Date(2026, 9, 26, 0, 1)
    assert.equal(svLogFileName(day1), 'sv-2026-10-25.log')
    assert.equal(svLogFileName(day2), 'sv-2026-10-26.log')

    await appendSvLogLine('line-1', day1)
    await appendSvLogLine('line-2', day1)
    await appendSvLogLine('line-3', day2)

    assert.equal(await readFile(join(dir, 'sv-2026-10-25.log'), 'utf8'), 'line-1\nline-2\n')
    assert.equal(await readFile(join(dir, 'sv-2026-10-26.log'), 'utf8'), 'line-3\n')
  } finally {
    if (previous === undefined) delete process.env.SV_LOG_DIR
    else process.env.SV_LOG_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})
