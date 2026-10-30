/**
 * display.js —— 多显示器识别（macOS）。
 *
 * cua-driver 只暴露主屏尺寸（get_screen_size），窗口 bounds 却是整个桌面的
 * 屏幕坐标。用 JXA 读 NSScreen.screens 拿全部显示器几何，把 Apple 的左下
 * 原点换算成与 cua-driver 一致的主屏左上原点，用于判断窗口/光标在哪块屏上。
 * 结果缓存 60 秒（用户插拔显示器后最多滞后一分钟）。
 */
import { execFile } from 'node:child_process'

const CACHE_MS = 60_000

const JXA = 'ObjC.import("AppKit");'
  + 'var s=$.NSScreen.screens,m=$.NSScreen.mainScreen.frame,o=[];'
  + 'for(var i=0;i<s.count;i++){var sc=s.objectAtIndex(i),f=sc.frame;'
  + 'o.push({x:f.origin.x,y:f.origin.y,w:f.size.width,h:f.size.height,'
  + 'scale:sc.backingScaleFactor,name:ObjC.unwrap(sc.localizedName)||""});}'
  + 'JSON.stringify({main:{x:m.origin.x,y:m.origin.y,w:m.size.width,h:m.size.height},screens:o});'

let cache = { at: 0, displays: [], error: null }

/** 查询全部显示器；失败时返回上一次结果（可能为空数组）。 */
export async function listDisplays() {
  if (process.platform !== 'darwin') return []
  if (Date.now() - cache.at < CACHE_MS) return cache.displays

  const raw = await new Promise((resolve) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', JXA], { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(null)
      try {
        resolve(JSON.parse(stdout))
      } catch {
        resolve(null)
      }
    })
  })

  if (!raw || !raw.main || !Array.isArray(raw.screens) || raw.screens.length === 0) {
    cache = { at: Date.now(), displays: cache.displays, error: 'display_query_failed' }
    return cache.displays
  }

  const displays = raw.screens.map((s, i) => ({
    index: i,
    name: s.name || `显示器${i + 1}`,
    primary: s.x === raw.main.x && s.y === raw.main.y && s.w === raw.main.w && s.h === raw.main.h,
    x: Math.round(s.x),
    y: Math.round(raw.main.h - (s.y + s.h)),
    width: Math.round(s.w),
    height: Math.round(s.h),
    scale: s.scale,
  }))
  cache = { at: Date.now(), displays, error: null }
  return displays
}

/** 主屏（找不到标记时退回第一块）。 */
export function primaryDisplay(displays) {
  return (displays || []).find((d) => d.primary) || (displays || [])[0] || null
}

/** 矩形（屏幕点，左上原点）落在哪块显示器上；取交集面积最大者。 */
export function displayOfRect(rect, displays) {
  if (!rect || !Array.isArray(displays) || displays.length === 0) return null
  let best = null
  let bestArea = 0
  for (const d of displays) {
    const w = Math.min(rect.x + rect.width, d.x + d.width) - Math.max(rect.x, d.x)
    const h = Math.min(rect.y + rect.height, d.y + d.height) - Math.max(rect.y, d.y)
    const area = Math.max(0, w) * Math.max(0, h)
    if (area > bestArea) {
      bestArea = area
      best = d
    }
  }
  return best
}

/** 屏幕点落在哪块显示器上。 */
export function displayOfPoint(x, y, displays) {
  return (displays || []).find((d) => x >= d.x && x < d.x + d.width && y >= d.y && y < d.y + d.height)
    || null
}

/** 一句话描述显示器（主屏/外接 + 相对位置 + 分辨率 + 左上角）。 */
export function describeDisplay(d, primary) {
  if (!d) return '未知（取不到显示器信息）'
  const kind = d.primary ? '主屏' : '外接'
  const rel = d.primary ? '' : relativeTo(d, primary)
  return `${d.name}（${kind}${rel}）${d.width}×${d.height}@${d.scale}x，左上 (${d.x},${d.y})`
}

function relativeTo(d, primary) {
  if (!primary) return ''
  const cx = d.x + d.width / 2
  const cy = d.y + d.height / 2
  const px = primary.x + primary.width / 2
  const py = primary.y + primary.height / 2
  const h = cx < px - 1 ? '左' : cx > px + 1 ? '右' : ''
  const v = cy < py - 1 ? '上' : cy > py + 1 ? '下' : ''
  if (!h && !v) return '，与主屏重叠'
  return `，位于主屏${h}${v}方`
}

/** 缓存状态（调试用）。 */
export function displayCacheState() {
  return { ...cache }
}
