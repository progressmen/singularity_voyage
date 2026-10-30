  // 2. 选目标窗口：参数 window（pid / window_id / 标题子串）→ 否则 z 序最前
  let target = null
  let matchNote = ''
  const want = args.window
  if (want !== undefined && want !== null && want !== '') {
    const wantStr = String(want)
    const exact = windows.filter((w) => String(w.window_id) === wantStr || String(w.pid) === wantStr)
    if (exact.length > 0) {
      target = exact.length > 1 ? pickWindow(exact) : exact[0]
    } else {
      const matches = windows.filter((w) => (w.title || '').toLowerCase().includes(wantStr.toLowerCase())
        || (w.app_name || '').toLowerCase().includes(wantStr.toLowerCase()))
      if (matches.length > 0) {
        // 同名窗口可能有多份（例如工作台在内外两块屏各开了一个）。优先当前桌面上可见、
        // 有标题且尺寸正常的窗口，避免选中 Chromium 的辅助小窗。
        const visible = matches.filter((w) => w.is_on_screen !== false && w.on_current_space !== false)
        const pool = visible.length > 0 ? visible : matches
        target = pickWindow(pool)
        if (matches.length > 1) {
          const fmt = (w) => `window_id=${w.window_id}「${safeStr(w.title || '(无标题)', 40)}」${w.is_on_screen === false || w.on_current_space === false ? '（不在当前桌面）' : '（当前桌面）'}`
          matchNote = `\n窗口匹配 ${matches.length} 个，已选${visible.length > 0 ? '当前桌面的' : '离屏的'} ${fmt(target)}；候选：${matches.slice(0, 6).map(fmt).join('；')}。要精确指定请传 window_id。`
        }
      }
    }
  }
