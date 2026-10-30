  } else if (args.screen_x !== undefined && args.screen_y !== undefined) {
    // 用屏幕点点击（computer_aim 校准后直接点，无需再猜窗口截图坐标）。
    if (!snap?.bounds || !snap.screenshotWidth || !snap.screenshotHeight) {
      return { ok: false, result: `${label}被拒绝：快照缺少窗口位置或截图尺寸，无法换算屏幕点。请重新 screen_observe。` }
    }
    const focus = await focusWindow(snap)
    if (!focus.ok) {
      return {
        ok: false,
        result: `${label}被拒绝：目标窗口不在当前桌面或无法前置，屏幕点会点到别的窗口。请先切到该窗口所在桌面。详情：${focus.detail.slice(0, 240)}`,
      }
    }
    const sx = Number(args.screen_x)
    const sy = Number(args.screen_y)
    const px = Math.round((sx - snap.bounds.x) / (snap.bounds.width / snap.screenshotWidth))
    const py = Math.round((sy - snap.bounds.y) / (snap.bounds.height / snap.screenshotHeight))
    target = {
      pid: snap.pid,
      windowId: snap.windowId,
      x: px,
      y: py,
      // humanClick 会把 sx/sy 当作窗口截图坐标再换算成屏幕点；这里回传 px/py，
      // 换算结果正好是原来的屏幕点，避免光标滑行到错误位置。
      sx: px,
      sy: py,
    }
  } else if (args.x !== undefined && args.y !== undefined) {
