  // 默认前置；只有显式 bring_to_front: false 才只启动、不抢焦点
  let pid = launched?.pid ?? null
  let frontNote = ''
  if (args.bring_to_front !== false && pid) {
    frontNote = ` ${await frontAppWindows(pid)}`
  }
