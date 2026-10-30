  } else if (args.x !== undefined && args.y !== undefined) {
    const { pid, windowId } = resolveWindow(cfg.ttlMs)
    // 坐标点击依赖窗口真的可点（前台/当前桌面）。窗口在别的 Space 时，
    // CGEvent 会落到那个屏幕位置上的其它窗口——先前置并让驱动验证。
    const focus = await focusWindow(snap)
    if (!focus.ok) {
      return {
        ok: false,
        result: `${label}被拒绝：目标窗口不在当前桌面或无法前置，坐标点击会落到其它窗口。请先切到该窗口所在桌面，或改用 element 编号点击（后台可达）。详情：${focus.detail.slice(0, 240)}`,
      }
    }
    const sx = Number(args.x)
    const sy = Number(args.y)
    const local = windowLocalOf(sx, sy, snap)
    target = {
      pid,
      windowId,
      x: local.x,
      y: local.y,
      sx,
      sy,
    }
  } else {
