/**
 * screen-capture.js —— 用系统 screencapture 抓屏幕区域（包含虚拟光标）。
 *
 * cua-driver 的 get_window_state / zoom 会显式排除自己的 cursor overlay，
 * 所以"鼠标有没有对准目标"从窗口截图里看不出来。系统 screencapture 抓的是
 * 合成后的屏幕，能看到虚拟光标本身，正好用于点击前的闭环校准。
 *
 * 需要给运行 dsh 的宿主应用授予「屏幕录制」权限；失败时调用方回退到 zoom。
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 读 PNG IHDR 的宽高（screencapture 默认输出 PNG）。 */
function pngSize(buf) {
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/**
 * 抓屏幕一块区域（屏幕点坐标，可为负，支持外接屏）。
 * @returns {Promise<{buffer:Buffer, width:number, height:number}>}
 */
export async function captureScreenRegion(x, y, width, height) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cua-'))
  const file = join(dir, 'shot.png')
  try {
    await new Promise((resolve, reject) => {
      execFile(
        'screencapture',
        ['-x', `-R${Math.round(x)},${Math.round(y)},${Math.round(width)},${Math.round(height)}`, file],
        { timeout: 6000 },
        (err) => (err ? reject(err) : resolve()),
      )
    })
    const buffer = await readFile(file)
    const size = pngSize(buffer)
    if (!size) throw new Error('screencapture 返回的不是 PNG')
    return { buffer, width: size.width, height: size.height }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
