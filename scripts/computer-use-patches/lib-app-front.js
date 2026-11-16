/**
 * app-front.js —— app_launch 之后的可靠前置。
 *
 * launch_app 只保证进程起来，窗口可能仍在后台、其他 Space 或被最小化。
 * 这里按「当前桌面可见 > 有标题 > 尺寸大」的顺序逐个尝试窗口，
 * 最后再按 pid 让系统激活应用主窗口；只有驱动明确确认焦点才算成功。
 */
import { cuaCall } from './cua.js'

const MAX_WINDOWS = 4
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 列出属于该 pid 的窗口，按「当前桌面可见 > 有标题 > 尺寸大」排序。 */
async function appWindows(pid) {
  const listed = await cuaCall('list_windows', { on_screen_only: false }).catch(() => null)
  const windows = Array.isArray(listed) ? listed : (listed?.windows || [])
  const areaOf = (w) => (w.bounds?.width ?? 0) * (w.bounds?.height ?? 0)
  return windows
    .filter((w) => Number(w.pid) === Number(pid))
    .sort((a, b) => (Number(b.on_current_space !== false) - Number(a.on_current_space !== false))
      || (Number(b.is_on_screen !== false) - Number(a.is_on_screen !== false))
      || (areaOf(b) - areaOf(a)))
}

/** 驱动是否明确确认了前置成功。 */
function verified(value, windowId) {
  if (!value || typeof value !== 'object') return false
  if (value.activated === true) return true
  if (value.exact_window_effect?.focused === true) return true
  if (windowId !== undefined && Number(value.observed?.focused_window_id) === Number(windowId)) return true
  return false
}

/** 调用一次 bring_to_front；驱动可能以 exit 1 + JSON 返回未确认结果。 */
async function frontOnce(args) {
  try {
    return { value: await cuaCall('bring_to_front', args), error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const match = /(\{[\s\S]*\})\s*$/.exec(message)
    if (match) {
      try {
        return { value: JSON.parse(match[1]), error: null }
      } catch {
        // JSON 解析失败时保留原始错误
      }
    }
    return { value: null, error: message }
  }
}

/**
 * 把指定 pid 的应用窗口前置到前台。
 * @param {number} pid - launch_app 返回的进程号
 * @returns {Promise<string>} 可直接拼进结果的前置说明
 */
export async function frontAppWindows(pid) {
  let mine = await appWindows(pid)
  // 刚启动的应用窗口可能还没被 WindowServer 注册，稍等再列一次。
  if (mine.length === 0) {
    await sleep(500)
    mine = await appWindows(pid)
  }

  for (const window of mine.slice(0, MAX_WINDOWS)) {
    const { value } = await frontOnce({ pid, window_id: window.window_id })
    if (verified(value, window.window_id)) return `已前置 window_id=${window.window_id}`
  }

  // 窗口还没创建、列不出来，或逐个窗口都未确认时，按 pid 激活应用主窗口。
  let result = await frontOnce({ pid })
  if (verified(result.value)) return '已前置'
  // 给应用一点时间完成窗口创建，再重试一次。
  await sleep(300)
  result = await frontOnce({ pid })
  if (verified(result.value)) return '已前置'
  if (result.error) return `前置失败：${result.error.slice(0, 160)}`
  return '已请求前置，但驱动未确认焦点；请 screen_observe 检查窗口是否在前台'
}
