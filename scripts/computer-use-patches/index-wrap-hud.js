  /** 统一包装：先过安全护栏，再执行实现；同时把动作同步到屏幕 HUD。 */
  const wrap = (toolName, impl) => async (args, exec) => {
    const startedAt = Date.now()
    hudStart(toolName, args)
    try {
      const g = await guard(ctx, cfg, toolName, args, exec)
      if (!g.ok) {
        hudEnd(toolName, args, false, g.reason, Date.now() - startedAt)
        return { ok: false, result: `✗ ${g.reason}` }
      }
      const value = await impl(args, cfg, exec)
      hudEnd(toolName, args, value?.ok !== false, value?.result, Date.now() - startedAt, value)
      return value
    } catch (err) {
      hudEnd(toolName, args, false, err.message, Date.now() - startedAt)
      return { ok: false, result: `✗ ${err.message}` }
    }
  }
