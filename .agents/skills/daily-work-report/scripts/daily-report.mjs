#!/usr/bin/env node
// 日报辅助脚本：采集指定日期、指定提交人的 Git 提交，或校验日报条目格式。
//
// 用法：
//   node daily-report.mjs commits --author <提交人> [--date YYYY-MM-DD] [--files] [--hunks] <repo>...
//   node daily-report.mjs check [--min 6] [--max-chars 30] <file|->

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

function usage() {
  console.log(`用法：
  node daily-report.mjs commits --author <提交人> [--date YYYY-MM-DD] [--files] [--hunks] <repo>...
  node daily-report.mjs check [--min 6] [--max-chars 30] <file|->

commits：按提交人 + 本地日期汇总多个仓库的提交（排除 merge）。
        --files 附带改动文件；--hunks 附带 hunk 头（函数级改动点，用于拆分条目）。
check：校验日报「序号. 内容」格式、编号连续性、条数下限与单条字数上限。`)
}

function die(message) {
  console.error(`✗ ${message}`)
  process.exit(2)
}

function todayLocal() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function runGit(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function commits(argv) {
  let author = ''
  let date = todayLocal()
  let withFiles = false
  let withHunks = false
  const repos = []

  while (argv.length > 0) {
    const arg = argv.shift()
    if (arg === '--author') author = argv.shift() ?? ''
    else if (arg === '--date') date = argv.shift() ?? ''
    else if (arg === '--files') withFiles = true
    else if (arg === '--hunks') withHunks = true
    else if (arg === '-h' || arg === '--help') return usage()
    else if (arg.startsWith('-')) die(`未知参数：${arg}`)
    else repos.push(arg.replace(/^['"]|['"]$/g, ''))
  }

  if (!author) die('缺少 --author')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) die('--date 需为 YYYY-MM-DD')
  if (repos.length === 0) die('至少提供一个仓库路径')

  const range = [`--since=${date} 00:00:00`, `--until=${date} 23:59:59`]
  let total = 0

  for (const repo of repos) {
    console.log(`## ${repo}`)

    if (!existsSync(repo)) {
      console.log(`（路径不存在，已跳过：${repo}）\n`)
      continue
    }

    let logs
    try {
      logs = runGit(repo, [
        'log', '--all', '--no-merges', `--author=${author}`, ...range,
        '--pretty=format:%h|%ad|%s', '--date=format:%H:%M',
      ])
    } catch {
      console.log('（不是 Git 仓库，已跳过）\n')
      continue
    }

    if (!logs.trim()) {
      console.log(`（${date} 无 ${author} 的提交）\n`)
      continue
    }

    console.log(logs.trim())
    const count = logs.trim().split('\n').length
    total += count

    if (withFiles) {
      console.log('\n改动文件：')
      const detail = runGit(repo, [
        'log', '--all', '--no-merges', `--author=${author}`, ...range,
        '--name-only', '--pretty=format:@@%h %s',
      ])
      let shown = 0
      for (const line of detail.split('\n')) {
        if (line.startsWith('@@')) {
          shown = 0
          console.log(`\n${line}`)
        } else if (line.trim()) {
          if (shown < 8) {
            console.log(`  ${line.trim()}`)
            shown += 1
          } else if (shown === 8) {
            console.log('  …')
            shown += 1
          }
        }
      }
    }

    if (withHunks) {
      console.log('\n改动点（hunk 头）：')
      const hunks = runGit(repo, [
        'log', '--all', '--no-merges', `--author=${author}`, ...range,
        '-p', '--unified=0', '--pretty=format:@@@%h %s',
      ])
      let file = ''
      for (const line of hunks.split('\n')) {
        if (line.startsWith('@@@')) {
          console.log(`\n${line.slice(3)}`)
          file = ''
        } else if (line.startsWith('diff --git')) {
          file = line.replace(/^diff --git a\//, '').split(' b/')[0]
        } else if (line.startsWith('@@')) {
          const context = line.replace(/^@@[^@]*@@\s*/, '').trim()
          console.log(`  ${file}${context ? `: ${context}` : ''}`)
        }
      }
    }

    console.log()
  }

  console.log(`== 合计 ${total} 条提交（不含 merge）==`)
}

function check(argv) {
  let min = 6
  let maxChars = 30
  let file = ''

  while (argv.length > 0) {
    const arg = argv.shift()
    if (arg === '--min') min = Number(argv.shift())
    else if (arg === '--max-chars') maxChars = Number(argv.shift())
    else if (arg === '-h' || arg === '--help') return usage()
    else if (arg.startsWith('-') && arg !== '-') die(`未知参数：${arg}`)
    else file = arg
  }

  if (!file) die('需要日报文件路径（或 - 读 stdin）')
  if (!Number.isInteger(min) || min < 1) die('--min 需为正整数')
  if (!Number.isInteger(maxChars) || maxChars < 1) die('--max-chars 需为正整数')

  let content
  if (file === '-') content = readFileSync(0, 'utf8')
  else {
    if (!existsSync(file)) die(`文件不存在：${file}`)
    content = readFileSync(file, 'utf8')
  }

  let count = 0
  let over = 0
  let bad = 0
  let expected = 1

  for (const raw of content.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim()) continue

    const match = /^\s*(\d+)[.、]\s*(.+)$/.exec(line)
    if (!match) {
      console.log(`✗ 不是「序号. 内容」格式：${line}`)
      bad += 1
      continue
    }

    const index = Number(match[1])
    const text = match[2].trim()
    count += 1

    if (index !== expected) {
      console.log(`✗ 编号不连续：期望 ${expected}，实际 ${index}（${text}）`)
      bad += 1
    }
    expected += 1

    const length = Array.from(text).length
    if (length > maxChars) {
      console.log(`✗ ${length} 字（上限 ${maxChars}）：${text}`)
      over += 1
    }
  }

  console.log(`条目数 ${count}（要求 ≥${min}），超字数 ${over}，格式异常 ${bad}`)

  const failed = count < min || over > 0 || bad > 0
  console.log(failed ? '✗ 校验未通过' : '✓ 校验通过')
  process.exit(failed ? 1 : 0)
}

const command = process.argv[2]
const rest = process.argv.slice(3)

switch (command) {
  case 'commits':
    commits(rest)
    break
  case 'check':
    check(rest)
    break
  case '-h':
  case '--help':
  case undefined:
    usage()
    break
  default:
    die(`未知子命令：${command}（可用 commits / check）`)
}
