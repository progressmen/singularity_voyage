
/** 把屏幕区域裁到某块显示器内（保证光标尽量居中且区域有效）。 */
function clampRegion(point, display, wantedW, wantedH) {
  if (!display) {
    return {
      x: Math.round(point.x - wantedW / 2),
      y: Math.round(point.y - wantedH / 2),
      width: wantedW,
      height: wantedH,
    }
  }
  const width = Math.min(wantedW, display.width)
  const height = Math.min(wantedH, display.height)
  const x = Math.max(display.x, Math.min(point.x - width / 2, display.x + display.width - width))
  const y = Math.max(display.y, Math.min(point.y - height / 2, display.y + display.height - height))
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}

/**
 * computer_aim —— 把虚拟光标移到目标点，并返回包含光标的真实屏幕局部图。
 *
 * 目的：不靠整窗截图目测精确坐标，而是"先对准、再看小图核对、最后用
 * from_zoom 点击或元素编号点击"。局部图 ≤500px，解析快、token 少。
 * 光标本身不会被截图（驱动明确排除 overlay），所以到达与否以
 * get_agent_cursor_state 的屏幕坐标误差为准。
 *
 * @param {object} ctx - Cordis 上下文（attachments）
 * @param {object} args - { window?, element?, x?, y?, pad? }
 * @param {object} cfg - 插件配置（ttlMs）
 */
export async function screenAim(ctx, args, cfg) {
  const snap = getSnapshot()
  if (!snap || !isFresh(cfg.ttlMs)) {
    return { ok: false, result: '没有新鲜的观察快照：请先 screen_observe 目标窗口，再调用 computer_aim。' }
  }

  const want = args.window
  if (want !== undefined && want !== null && want !== '') {
    const w = String(want)
    const matches = w === String(snap.windowId) || w === String(snap.pid)
      || (snap.title || '').toLowerCase().includes(w.toLowerCase())
    if (!matches) {
      return { ok: false, result: `当前快照是「${snap.title}」(window_id=${snap.windowId})：请先 screen_observe 目标窗口「${w}」再 aim。` }
    }
  }

  if (!snap.bounds) {
    return { ok: false, result: '当前快照缺少窗口位置：请重新 screen_observe 目标窗口。' }
  }
  if (!snap.screenshotWidth || !snap.screenshotHeight) {
    // ax 模式可能没抓截图；补一次仅截图的读（include_accessibility_tree:false 不会让元素 token 失效）。
    const state = await cuaCall('get_window_state', {
      pid: snap.pid,
      window_id: snap.windowId,
      include_accessibility_tree: false,
    }).catch(() => null)
    if (!state?.screenshot_width) {
      return { ok: false, result: '当前快照没有窗口截图：请先用 screen_observe(mode="native") 取一张，再 computer_aim。' }
    }
    snap.screenshotWidth = state.screenshot_width
    snap.screenshotHeight = state.screenshot_height
    if (state.on_current_space === false) snap.onCurrentSpace = false
  }

  let px = null
  let py = null
  let label = ''
  let point = null

  if (args.screen_x !== undefined && args.screen_y !== undefined) {
    // 用屏幕点重新校准：局部图里看到偏移后，把新目标换回屏幕坐标再瞄一次。
    point = { x: Number(args.screen_x), y: Number(args.screen_y) }
    px = Math.round((point.x - snap.bounds.x) / (snap.bounds.width / snap.screenshotWidth))
    py = Math.round((point.y - snap.bounds.y) / (snap.bounds.height / snap.screenshotHeight))
  } else {
    if (args.element !== undefined && args.element !== null) {
      const entry = snap.entries?.get(Number(args.element))
      if (!entry || entry.x == null || entry.y == null) {
        return { ok: false, result: `编号 [${args.element}] 不在当前快照中或没有坐标：请重新 screen_observe。` }
      }
      px = entry.x
      py = entry.y
      label = entry.label || ''
    } else if (args.x !== undefined && args.y !== undefined) {
      px = Number(args.x)
      py = Number(args.y)
    } else {
      const state = await cuaCall('get_agent_cursor_state', { session: CUA_SESSION }).catch(() => null)
      const pos = state?.position
      if (!pos) return { ok: false, result: '取不到虚拟光标位置：请显式传 element、x/y 或 screen_x/screen_y。' }
      px = Math.round((Number(pos.x) - snap.bounds.x) / (snap.bounds.width / snap.screenshotWidth))
      py = Math.round((Number(pos.y) - snap.bounds.y) / (snap.bounds.height / snap.screenshotHeight))
    }
    px = Math.max(0, Math.min(Math.round(px), snap.screenshotWidth - 1))
    py = Math.max(0, Math.min(Math.round(py), snap.screenshotHeight - 1))
    point = windowPxToScreen(px, py, snap)
    if (!point) return { ok: false, result: '无法把截图坐标换算成屏幕坐标：请重新 screen_observe。' }
  }

  await ensureCursor()
  await cuaCall('move_cursor', { x: point.x, y: point.y }).catch(() => undefined)
  const cursorState = await cuaCall('get_agent_cursor_state', { session: CUA_SESSION }).catch(() => null)
  const pos = cursorState?.position

  const displays = await listDisplays()
  const primary = primaryDisplay(displays)
  const display = snap.display || displayOfRect(snap.bounds, displays)
  const pointDisplay = displayOfPoint(point.x, point.y, displays)

  const attachments = ctx?.get?.('attachments')
  if (!attachments) return { ok: false, result: '当前环境未挂载 attachments 服务，无法返回局部截图。' }

  // 1) 优先抓「合成后的真实屏幕」：cua-driver 的截图会排除 cursor overlay，
  //    系统 screencapture 不会，所以图里能直接看到光标是否对准目标。
  let region = null
  let shot = null
  try {
    region = clampRegion(point, pointDisplay, 360, 240)
    shot = await captureScreenRegion(region.x, region.y, region.width, region.height)
  } catch {
    shot = null
  }

  let image
  let cursorInImage = null
  let targetInImage = null
  if (shot) {
    const scaleX = shot.width / region.width
    const scaleY = shot.height / region.height
    const actual = pos ?? point
    cursorInImage = {
      x: Math.round((actual.x - region.x) * scaleX),
      y: Math.round((actual.y - region.y) * scaleY),
    }
    targetInImage = {
      x: Math.round((point.x - region.x) * scaleX),
      y: Math.round((point.y - region.y) * scaleY),
    }
    const ref = await attachments.saveImage({
      data: shot.buffer,
      mediaType: 'image/png',
      name: `aim-screen-${snap.windowId}.png`,
    })
    image = {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width ?? shot.width,
      height: ref.height ?? shot.height,
      name: ref.name,
    }
  } else {
    // 2) 系统截图不可用（未授权屏幕录制）→ 回退到窗口 zoom（不含光标）。
    const pad = Math.max(20, Math.min(Number(args.pad) || 90, 400))
    const x1 = Math.max(0, px - pad)
    const y1 = Math.max(0, py - pad)
    const x2 = Math.min(snap.screenshotWidth, px + pad)
    const y2 = Math.min(snap.screenshotHeight, py + pad)
    const zv = await cuaCall('zoom', { pid: snap.pid, window_id: snap.windowId, x1, y1, x2, y2 })
    const data = buf(zv?.screenshot_png_b64)
    if (data.byteLength === 0) return { ok: false, result: '局部截图失败：引擎返回空图片。' }
    const ref = await attachments.saveImage({ data, mediaType: 'image/jpeg', name: `aim-${snap.windowId}.jpg` })
    image = {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width ?? zv?.width,
      height: ref.height ?? zv?.height,
      name: ref.name,
    }
  }

  const arrival = pos
    ? `光标实际在屏幕 (${Math.round(pos.x)},${Math.round(pos.y)})，误差 ${Math.round(Math.abs(pos.x - point.x) * 10) / 10}×${Math.round(Math.abs(pos.y - point.y) * 10) / 10} pt`
    : '光标位置未返回（移动已下发）'

  const calibration = shot
    ? `校准：图片是合成后的真实屏幕。紫色光标实际在图内 (${cursorInImage.x},${cursorInImage.y})，目标点在图内 (${targetInImage.x},${targetInImage.y})。若目标点没落在控件中心，设控件中心在图内 (bx,by)，Δ=(bx-${targetInImage.x}, by-${targetInImage.y})，新屏幕点 = 当前屏幕点 + Δ/${(shot.width / region.width).toFixed(2)}，再用 computer_aim(screen_x=新x, screen_y=新y) 重新校准；若光标与目标点明显不重合，说明窗口/显示器不可达，先切到该桌面。对准后用 computer_click(screen_x=目标屏幕x, screen_y=目标屏幕y) 点击。`
    : '注意：系统截图不可用（未授权屏幕录制），本图不含光标；请用坐标误差判断是否到位。'

  const result = [
    ...snap.onCurrentSpace === false
      ? ['⚠ 该窗口不在当前 Space：图里若显示的是别的窗口/桌面，说明坐标点击会落到那里；请先切到窗口所在桌面。']
      : [],
    `目标：窗口「${snap.title || snap.windowId}」截图坐标 (${px},${py})${label ? `，元素「${label}」` : ''}`,
    `显示器：${describeDisplay(display, primary)}${pointDisplay && display && pointDisplay.name !== display.name ? `；光标落点实际在 ${pointDisplay.name}` : ''}`,
    `虚拟光标：已移到屏幕 (${Math.round(point.x)},${Math.round(point.y)})；${arrival}`,
    shot
      ? `局部截图：屏幕区域 (${region.x},${region.y}) ${region.width}×${region.height}pt，图片 ${image.width}×${image.height}px`
      : `局部截图：${image.width}×${image.height}px（窗口缩放图）`,
    calibration,
  ].join('\n')

  return {
    ok: true,
    result,
    image,
    window: { pid: snap.pid, windowId: snap.windowId, title: snap.title || '' },
    display: display
      ? { name: display.name, primary: display.primary, x: display.x, y: display.y, width: display.width, height: display.height }
      : null,
    cursor: pos ? { x: Math.round(pos.x), y: Math.round(pos.y) } : null,
    target: { x: px, y: py },
    screen: point ? { x: Math.round(point.x), y: Math.round(point.y) } : null,
    cursorInImage,
    targetInImage,
    zoom: shot ? null : { width: image.width ?? null, height: image.height ?? null },
  }
}
