  ctx.tools.register(defineTool({
    name: 'computer_aim',
    description:
      '把虚拟光标对准目标并返回目标附近的局部小截图（≤500px，解析快），用于点击前核对，不再靠整窗截图目测精确坐标。' +
      '传 element 编号最准；也可传窗口截图坐标 x/y；都不传则用当前光标位置。' +
      '支持多显示器：结果说明窗口在主屏还是外接屏、光标实际落在哪块屏。' +
      '核对后用 computer_click(from_zoom=true, x=图内x, y=图内y) 点击，或直接用 element 编号。',
    parameters: {
      window: { type: 'string', description: '可选：窗口标题/id/pid；缺省用当前 screen_observe 的快照窗口。' },
      element: { type: 'integer', description: '可选：screen_observe 输出的元素编号（优先）。' },
      x: { type: 'integer', description: '可选：窗口本地截图像素 x（与 element 二选一）。' },
      y: { type: 'integer', description: '可选：窗口本地截图像素 y。' },
      screen_x: { type: 'number', description: '可选：屏幕点 x（校准循环用）。与 screen_y 一起传时忽略 element/x/y。' },
      screen_y: { type: 'number', description: '可选：屏幕点 y。' },
      pad: { type: 'integer', description: '可选：局部截图半径（截图像素），默认 90，范围 20-400。' },
    },
    output: {
      ...OUT({
        ...IMAGE_FIELD,
        window: { type: 'object', additionalProperties: false, properties: {
          pid: { type: 'integer' }, windowId: { type: 'integer' }, title: { type: 'string' },
        } },
        display: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: {
          name: { type: 'string' }, primary: { type: 'boolean' }, x: { type: 'integer' }, y: { type: 'integer' },
          width: { type: 'integer' }, height: { type: 'integer' },
        } }] },
        cursor: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: {
          x: { type: 'integer' }, y: { type: 'integer' },
        } }] },
        target: { type: 'object', additionalProperties: false, properties: {
          x: { type: 'integer' }, y: { type: 'integer' },
        } },
        screen: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: {
          x: { type: 'integer' }, y: { type: 'integer' },
        } }] },
        cursorInImage: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: {
          x: { type: 'integer' }, y: { type: 'integer' },
        } }] },
        targetInImage: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: {
          x: { type: 'integer' }, y: { type: 'integer' },
        } }] },
        zoom: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: {
          width: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          height: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
        } }] },
      }),
      render: renderWithImage,
    },
    execute: wrap('computer_aim', (args, cfg2) => screenAim(ctx, args, cfg2)),
  }))
