/**
 * 桌面操作护栏：只拦截「用终端启动应用 / 模拟输入」，普通 shell 不受影响。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { desktopViaTerminalReason } from '../src/tools.ts'

/** 命中即应被拒绝的命令。 */
const BLOCKED = [
  'open -a Safari',
  'open -n -a "Google Chrome"',
  'open /Applications/Notes.app',
  'osascript -e \'tell application "Finder" to activate\'',
  'cliclick c:100,200',
  'echo hi && xdotool key Return',
]

/** 与桌面无关、必须放行的命令。 */
const ALLOWED = [
  'pnpm test',
  'git status',
  'open .',
  'cat package.json',
  'grep -r "open" src',
  'npm run build',
]

for (const command of BLOCKED) {
  test(`拒绝：${command}`, () => {
    assert.match(desktopViaTerminalReason(command) ?? '', /app_launch/)
  })
}

for (const command of ALLOWED) {
  test(`放行：${command}`, () => {
    assert.equal(desktopViaTerminalReason(command), undefined)
  })
}
