/** 光标是否已按本插件的偏好初始化（显示 + 不自动隐藏）。 */
let cursorReady = false

/**
 * 确保虚拟光标"看得见"：开启 overlay，并关闭空闲自动隐藏。
 * cua-driver 默认 idle_hide_ms=15000，多步操作间隙里光标会消失，
 * 用户会以为它没出现在外接显示器上；这里改为常显。
 */
export async function ensureCursor() {
  if (cursorReady) return
  await cuaCall('set_agent_cursor_enabled', { session: CUA_SESSION, enabled: true }).catch(() => undefined)
  await cuaCall('set_agent_cursor_motion', { session: CUA_SESSION, idle_hide_ms: 0 }).catch(() => undefined)
  cursorReady = true
}

/**
 * 窗口截图坐标 → 整个桌面的屏幕点（左上原点）。
 *
 * get_window_state 的截图可能被压缩（max_image_dimension 默认 1366），
 * 因此用 bounds / 截图宽高得到比例；虚拟光标 overlay 的 move_cursor
 * 不带 target 时接受的就是屏幕点，可直接落到外接显示器上。
 */
export function windowPxToScreen(px, py, snap = getSnapshot()) {
  if (!snap || !snap.bounds || !snap.screenshotWidth || !snap.screenshotHeight) return null
  const x = snap.bounds.x + Number(px) * (snap.bounds.width / snap.screenshotWidth)
  const y = snap.bounds.y + Number(py) * (snap.bounds.height / snap.screenshotHeight)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

/**
 * 把目标窗口前置并激活，让键盘事件落到它而不是应用的其它窗口。
 *
 * 背景投递的键盘事件发给应用当前的 key window；目标窗口如果在另一个
 * Space（常见于外接屏）或不是 key window，cmd+a / cmd+v 就会静默发到
 * 别的窗口。bring_to_front 带 window_id 时会由驱动独立验证是否成功。
 * @returns {Promise<{ok:boolean, detail:string}>}
 */
export async function focusWindow(snap = getSnapshot()) {
  if (!snap || !snap.pid || !snap.windowId) return { ok: false, detail: '没有可用的观察快照' }
  let value
  try {
    value = await cuaCall('bring_to_front', { pid: snap.pid, window_id: snap.windowId })
  } catch (err) {
    // 驱动在"已拿到键盘焦点、但进程内还有更靠前的辅助窗口"时也会以 exit 1 返回，
    // 结果 JSON 在错误信息里；解析出来按 focused 判定，避免误拒绝。
    const match = /(\{[\s\S]*\})\s*$/.exec(err.message || '')
    if (match) {
      try {
        value = JSON.parse(match[1])
      } catch {
        value = null
      }
    }
    if (!value) return { ok: false, detail: err.message }
  }
  const focused = value?.exact_window_effect?.focused === true
    || Number(value?.observed?.focused_window_id) === Number(snap.windowId)
  const ok = value?.activated === true || focused
  if (ok) snap.onCurrentSpace = true
  const detail = typeof value === 'string' ? value : JSON.stringify(value)
  return { ok, detail }
}
