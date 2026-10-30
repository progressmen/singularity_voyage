#!/usr/bin/env node
/**
 * 初始化 Singularity Voyage 的 dsh profile（默认 <repo>/.dsh/profiles/sv）。
 *
 * 做三件事：
 *  1. 写入 profile 清单（package.json，声明 dsh.profile 组合包与对本仓库 sv-app 的 link 依赖）；
 *  2. 在 profile 目录执行 pnpm install（把 sv-app 以 link: 方式挂进 profile node_modules）；
 *  3. 打印启动命令。
 *
 * DSH_HOME 默认指向仓库内 `.dsh/`，可用同名环境变量覆盖（便于与其它 dsh 实例隔离）。
 * 重复运行是安全的：manifest 会被重写为确定内容。
 */
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshHome = process.env.DSH_HOME ?? join(repoRoot, '.dsh')
const profileDir = join(dshHome, 'profiles', 'sv')
// 只对指定目录打 dsh-computer-use 补丁（不写 manifest、不跑 pnpm install）。
// 用于验证补丁链：把上游包解压到临时目录后执行本脚本。
const patchOnlyRoot = process.env.SV_PATCH_ONLY_ROOT
const svAppDir = join(repoRoot, 'packages', 'sv-app')

// dsh-computer-use 放在 sv-app 之前：bundle 按顺序叠层，sv-app 的 patch
// 需要能覆盖它的观察快照 TTL 等配置（patch 替换整段 config，不做深合并）。
const manifest = {
  name: 'sv-profile',
  private: true,
  type: 'module',
  dsh: {
    profile: {
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        'dsh-computer-use',
        '@singularity-voyage/sv-app',
      ],
    },
  },
  dependencies: {
    '@singularity-voyage/sv-app': `link:${svAppDir}`,
    // 桌面操作能力（cua-driver）：观察窗口 → 点击/输入/快捷键 → 再观察验证。
    // 固定版本：工具 schema 与安全护栏随版本变化，升级需重新验证。
    'dsh-computer-use': '0.3.1',
  },
}

if (!patchOnlyRoot) {
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(`[sv] profile 目录: ${profileDir}`)
  console.log('[sv] 安装 profile 依赖 (pnpm install)…')
  // profile 目录嵌在仓库内，pnpm 默认会向上找到仓库 workspace 而跳过这里的依赖；
  // --ignore-workspace 让 profile 作为独立项目安装，--no-frozen-lockfile 允许
  // manifest 变更（如新增插件）后重写 profile 自己的锁文件。
  const install = spawnSync('pnpm', ['install', '--ignore-workspace', '--no-frozen-lockfile', '--prefer-offline'], {
    cwd: profileDir,
    stdio: 'inherit',
  })
  if (install.status !== 0) {
    console.error('[sv] pnpm install 失败；请确认 pnpm 已安装且网络可用。')
    process.exit(install.status ?? 1)
  }
}

/**
 * dsh-computer-use@0.3.1 的本地补丁（幂等，每次 setup 都会校准）。
 *
 * 上游四个问题直接影响桌面操作可用性：
 *  1. `get_window_state` 的调用没带 `session`，而 cua-driver 的截图上下文按会话
 *     归属 → `screen_zoom` 与坐标点击报 `screenshot_context_missing: window_never_read`；
 *  2. 窗口列表只查 `on_screen_only: true`，其它 Space 与最小化的窗口完全不可见，
 *     点击后弹出的新窗口一旦不在当前桌面就“消失”；
 *  3. 观察到的目标窗口不可见时不会前置，`get_window_state` 只能截到空帧；
 *  4. 动作结果只回一句“完成”，模型不知道界面可能已经换了窗口。
 *
 * 每个补丁都用「替换前后文本」描述：`after` 已存在即视为已修补，`before` 找不到
 * 则告警跳过（升级插件后需要重新确认）。字符串按行拼接，保留上游格式。
 */
const COMPUTER_USE_PATCHES = [
  {
    label: '会话标签',
    file: 'lib/cua.js',
    before: ['JSON.stringify(args)], {'],
    after: ['JSON.stringify({ session: CUA_SESSION, ...args })], {'],
  },
  {
    label: '会话过期自愈',
    file: 'lib/cua.js',
    before: ["if (tool !== 'start_session' && /session '.*' has ended|revive it/.test(err.message)) {"],
    after: ["if (tool !== 'start_session' && /has ended|revive it|use a new session label/.test(err.message)) {"],
  },
  {
    label: '输入类错误补人话',
    file: 'lib/cua.js',
    before: ['        reject(new Error(`cua-driver ${tool} 失败 (exit ${code}): ${msg.slice(0, 800)}`))'],
    after: [
      '        const reachHint = /screenshot_context_missing|window_never_read/.test(msg)',
      "          ? '（该窗口不在当前桌面或已被遮挡，鼠标/键盘无法送达：请让用户把窗口切到当前桌面，或重新 screen_observe 指定可见窗口；不要重复重试同一操作）'",
      "          : ''",
      '        reject(new Error(`cua-driver ${tool} 失败 (exit ${code}): ${msg.slice(0, 800)}${reachHint}`))',
    ],
  },
  {
    label: '列出所有桌面的窗口',
    file: 'lib/observe.js',
    before: ["cuaCall('list_windows', { on_screen_only: true })"],
    after: ["cuaCall('list_windows', { on_screen_only: false })"],
  },
  {
    label: 'window 参数支持 window_id',
    file: 'lib/observe.js',
    marker: 'let matchNote',
    before: ['    target = windows.find((w) => String(w.pid) === wantStr)'],
    after: [
      '    target = windows.find((w) => String(w.window_id) === wantStr)',
      '      || windows.find((w) => String(w.pid) === wantStr)',
    ],
  },
  {
    label: '窗口候选列表带 window_id',
    file: 'lib/observe.js',
    before: ["      .map((w) => `${w.app_name || ''} · ${w.title || ''} · pid=${w.pid}`)"],
    after: ["      .map((w) => `${w.app_name || ''} · ${w.title || '(无标题)'} · pid=${w.pid} · window_id=${w.window_id}`)"],
  },
  {
    label: '缺省窗口优先当前桌面',
    file: 'lib/observe.js',
    marker: 'pickWindow(visible.length > 0 ? visible : windows)',
    before: ['    const sorted = [...windows].sort((a, b) => (b.z_index || 0) - (a.z_index || 0))'],
    after: [
      '    const shown = (w) => w.is_on_screen === true && w.on_current_space !== false',
      '    const sorted = [...windows].sort((a, b) => (Number(shown(b)) - Number(shown(a))) || (b.z_index || 0) - (a.z_index || 0))',
    ],
  },
  {
    label: '引入会话常量',
    file: 'lib/observe.js',
    before: ["import { withSession } from './cua.js'"],
    after: ["import { CUA_SESSION, withSession } from './cua.js'"],
  },
  {
    label: '不可见窗口自动前置',
    file: 'lib/observe.js',
    before: ['  // 3. AX 树（vision / native 模式同时抓截图）'],
    after: [
      '  // 目标窗口不在当前桌面或已最小化时先前置，否则截不到画面（模型会以为窗口没出现）',
      "  let frontNote = ''",
      '  if (target.is_on_screen === false || target.on_current_space === false) {',
      "    const focus = (args) => cuaCall('bring_to_front', withSession(args))",
      '    const attempt = async (args) => {',
      '      let r = await focus(args).catch((err) => err)',
      '      if (r instanceof Error && /has ended|revive it/.test(r.message)) {',
      '        // 会话空闲后会过期；先重建会话再重试一次',
      "        await cuaCall('start_session', { session: CUA_SESSION }).catch(() => undefined)",
      '        r = await focus(args).catch((err) => err)',
      '      }',
      '      return r',
      '    }',
      '    // 只有明确 verified 才算前置成功；partial / unverified 说明目标仍不可见',
      '    const verified = (r) => !(r instanceof Error) && Boolean(r) && r.activated === true && r.code !== "bring_to_front_exact_window_unverified"',
      '    let moved = await attempt({ pid: target.pid, window_id: target.window_id })',
      '    let adopted = null',
      '    if (!verified(moved)) {',
      '      // 同应用其它窗口按面积从大到小试一次：主窗口通常能前置，弹出小窗不行',
      '      const area = (w) => (w.bounds?.width ?? 0) * (w.bounds?.height ?? 0)',
      '      const siblings = windows',
      '        .filter((w) => w.pid === target.pid && w.window_id !== target.window_id)',
      '        .sort((a, b) => area(b) - area(a))',
      '      for (const w of siblings) {',
      '        const r = await attempt({ pid: w.pid, window_id: w.window_id })',
      '        if (verified(r)) { adopted = w; moved = r; break }',
      '      }',
      '    }',
      '    if (!verified(moved)) moved = await attempt({ pid: target.pid })',
      '    if (verified(moved)) {',
      '      if (adopted) {',
      '        target = adopted',
      '        frontNote = `\\n（原目标窗口不可见，已改为前置同应用窗口 window_id=${adopted.window_id}「${safeStr(adopted.title)}」，本次观察针对该窗口）`',
      '      } else {',
      '        frontNote = "\\n（目标窗口原本不在当前桌面或已最小化，已前置到前台）"',
      '      }',
      '    } else {',
      '      frontNote = "\\n注意：目标窗口不在当前桌面，自动前置失败；鼠标/键盘无法送达该窗口。请让用户把该应用切到当前桌面，或指定其它可见窗口；不要反复重试同一坐标点击。"',
      '    }',
      '  }',
      '',
      '  // 3. AX 树（vision / native 模式同时抓截图）',
    ],
  },
  {
    label: '观察结果带截图尺寸',
    file: 'lib/observe.js',
    before: ['    `pid=${target.pid} window_id=${target.window_id} ${modeNote} 坐标=窗口本地截图像素`,'],
    after: ['    `pid=${target.pid} window_id=${target.window_id} ${modeNote} 坐标=窗口本地截图像素` + (state.screenshot_width ? `\\n截图像素 ${state.screenshot_width}×${state.screenshot_height}（点击坐标按这张图的像素估，Retina 截图通常是逻辑尺寸的 2 倍）` : \'\'),'],
  },
  {
    // 模型看到的是图片像素，动作要的是原截图像素。compact 降采样或附件缩放后
    // 两者不同，模型按图内坐标点击就会整体偏移——这里直接给出换算系数。
    label: '缩放图给出坐标换算',
    file: 'lib/observe.js',
    before: ['    `pid=${target.pid} window_id=${target.window_id} ${modeNote} 坐标=窗口本地截图像素` + (state.screenshot_width ? `\\n截图像素 ${state.screenshot_width}×${state.screenshot_height}（点击坐标按这张图的像素估，Retina 截图通常是逻辑尺寸的 2 倍）` : \'\'),'],
    after: [
      '    `pid=${target.pid} window_id=${target.window_id} ${modeNote} 坐标=窗口本地截图像素` + (state.screenshot_width ? `\\n截图像素 ${state.screenshot_width}×${state.screenshot_height}（点击坐标按这张图的像素估，Retina 截图通常是逻辑尺寸的 2 倍）` : \'\'),',
      '    ...(image && image.width && state.screenshot_width',
      '      ? [image.width === state.screenshot_width',
      '        ? `\\n你看到的图片 ${image.width}×${image.height}，与截图像素一致，可直接按图估坐标。`',
      '        : `\\n⚠ 你看到的图片 ${image.width}×${image.height}，已被缩放：点击前必须换算回原截图坐标，x = 图内 x × ${(state.screenshot_width / image.width).toFixed(2)}，y = 图内 y × ${((state.screenshot_height || image.height) / (image.height || 1)).toFixed(2)}`]',
      '      : []),',
    ],
  },
  {
    // zoom 返回的裁剪图同样可能被缩到 ≤500px；旧文案说"直接传截图坐标"会点偏。
    label: 'zoom 结果给出坐标换算',
    file: 'lib/observe.js',
    before: ['    result: `区域截图完成（${image.width}×${image.height}px JPEG）：坐标为窗口本地截图像素，点击时直接传截图坐标。`,'],
    after: ['    result: `区域截图完成（${image.width}×${image.height}px JPEG，覆盖原截图 x ${x1}~${x2} / y ${y1}~${y2}）：点击坐标 = x ${x1} + 图内 x × ${((Number(x2) - Number(x1)) / (image.width || 1)).toFixed(3)}，y ${y1} + 图内 y × ${((Number(y2) - Number(y1)) / (image.height || 1)).toFixed(3)}（比例为 1 时直接相加）。也可以直接 computer_click(from_zoom=true, x=图内 x, y=图内 y)，驱动会自动换算。`,'],
  },
  {
    label: '点击工具描述强调坐标换算',
    file: 'index.js',
    before: ["    description: '点击：传入 screen_observe 输出的元素编号（element），或窗口截图像素坐标（x,y）。点击的是 cua-driver 的虚拟光标，不抢真实鼠标。',"],
    after: ["    description: '点击：优先传 screen_observe 输出的元素编号（element，精确）。仅在 AX 无元素时用 x/y —— 必须是窗口本地截图像素；若观察到的图片被缩放，先按提示换算回原截图坐标。点击的是 cua-driver 的虚拟光标，不抢真实鼠标。',"],
  },
  {
    label: '观察结果带前置说明',
    file: 'lib/observe.js',
    marker: '${frontNote}${matchNote}',
    before: ['    result: `${header}\\n${body}${visionBlock}\\n\\n提示: 用 computer_click(element=[编号]) 或 computer_click(x=, y=) 操作（坐标为截图像素）。`,'],
    after: ['    result: `${header}${frontNote}\\n${body}${visionBlock}\\n\\n提示: 用 computer_click(element=[编号]) 或 computer_click(x=, y=) 操作（坐标为截图像素）。`,'],
  },
  {
    label: '动作后列出应用窗口',
    file: 'lib/actions.js',
    before: [
      '  const value = await humanClick({ ...target, ...extra })',
      '  const refusal = engineRefusal(value)',
      '  if (refusal) return { ok: false, result: `${label} 被引擎拒绝：${refusal}` }',
      '  const detail = typeof value === \'string\' ? value : JSON.stringify(value)',
      '  return { ok: true, result: `${label} 完成（虚拟光标滑行+点击）：${detail}` }',
    ],
    after: [
      '  const value = await humanClick({ ...target, ...extra })',
      '  const refusal = engineRefusal(value)',
      '  if (refusal) return { ok: false, result: `${label} 被引擎拒绝：${refusal}` }',
      '  const detail = typeof value === \'string\' ? value : JSON.stringify(value)',
      '  // 点击常会弹出新窗口/对话框：顺带列出该应用窗口，模型才不会继续用旧快照',
      "  let windowsNote = ''",
      '  try {',
      "    const list = await cuaCall('list_windows', { on_screen_only: false })",
      '    const mine = (list.windows || []).filter((w) => w.pid === target.pid && (w.title || w.app_name))',
      '    if (mine.length > 0) {',
      '      const lines = mine.slice(0, 8).map((w) => {',
      "        const hidden = w.is_on_screen === false || w.on_current_space === false ? '（不在当前桌面，观察时会自动前置）' : ''",
      "        return `  - ${w.app_name} · ${w.title || '(无标题)'} window_id=${w.window_id}${hidden}`",
      '      })',
      "      windowsNote = `\\n该应用窗口（${mine.length}）：\\n${lines.join('\\n')}`",
      '    }',
      '  } catch { /* 列窗口失败不影响点击结果 */ }',
      '  return {',
      '    ok: true,',
      '    result: `${label} 完成（虚拟光标滑行+点击）：${detail}${windowsNote}\\n提示：界面可能已变化，下一步请重新 screen_observe（可传 window=标题 定位新窗口），不要复用旧元素编号。`,',
      '  }',
    ],
  },
  {
    label: '启动结果带观察提示',
    file: 'lib/actions.js',
    before: [
      '    result: `应用已启动${frontNote}：${detail}`,',
    ],
    after: [
      '    result: `应用已启动${frontNote}：${detail}\\n提示：下一步请 screen_observe 观察窗口（可传 window=应用名）；窗口不在当前桌面时会自动前置。`,',
    ],
  },
  {
    label: 'app_launch 工具描述',
    file: 'index.js',
    before: ["    description: '启动一个应用（后台启动，不抢焦点；可选 bring_to_front 前置到前台）。用于\"打开应用\"这一步。',"],
    after: ["    description: '启动或前置应用（默认后台启动、不抢焦点；需要立刻看到窗口时传 bring_to_front: true）。打开应用的唯一正确方式——不要用终端 open / osascript / cliclick。',"],
  },
  // ── 多显示器 / 虚拟光标常显 / 局部截图核对 ─────────────────────────────
  {
    label: '多显示器模块',
    file: 'lib/display.js',
    contentFile: 'lib-display.js',
  },
  {
    label: '系统截图模块（包含虚拟光标）',
    file: 'lib/screen-capture.js',
    contentFile: 'lib-screen-capture.js',
  },
  {
    label: '虚拟光标常显与坐标换算',
    file: 'lib/human.js',
    appendFile: 'human-helpers.js',
    marker: 'export function windowPxToScreen',
  },
  {
    label: 'computer_aim 实现',
    file: 'lib/observe.js',
    appendFile: 'screen-aim.js',
    marker: 'export async function screenAim',
  },
  {
    label: '观察引入显示器与坐标工具',
    file: 'lib/observe.js',
    before: ["import { setSnapshot } from './snapshot.js'"],
    after: [
      "import { setSnapshot, getSnapshot, isFresh } from './snapshot.js'",
      "import { ensureCursor, windowPxToScreen } from './human.js'",
      'import {',
      '  listDisplays, primaryDisplay, displayOfRect, displayOfPoint, describeDisplay,',
      "} from './display.js'",
    ],
  },
  {
    label: '观察引入系统截图',
    file: 'lib/observe.js',
    before: [
      'import {',
      '  listDisplays, primaryDisplay, displayOfRect, displayOfPoint, describeDisplay,',
      "} from './display.js'",
    ],
    after: [
      'import {',
      '  listDisplays, primaryDisplay, displayOfRect, displayOfPoint, describeDisplay,',
      "} from './display.js'",
      "import { captureScreenRegion } from './screen-capture.js'",
    ],
  },
  {
    label: '窗口优先级选择器',
    file: 'lib/observe.js',
    marker: 'function pickWindow',
    before: ['/** 清洗为安全字符串：保证可无损 JSON 序列化（去孤立代理项）+ 截断。 */'],
    after: [
      '/** 窗口优先级：当前桌面可见 > 有标题 > 尺寸正常 > z 序靠前。 */',
      'function pickWindow(list) {',
      "  const area = (w) => (w.bounds?.width ?? 0) * (w.bounds?.height ?? 0)",
      "  const visible = (w) => w.is_on_screen !== false && w.on_current_space !== false",
      '  return [...list].sort((a, b) =>',
      '    (Number(visible(b)) - Number(visible(a)))',
      '    || (Number(Boolean(b.title)) - Number(Boolean(a.title)))',
      '    || (Number(area(b) >= 40000) - Number(area(a) >= 40000))',
      '    || ((b.z_index || 0) - (a.z_index || 0)))[0]',
      '}',
      '',
      '/** 清洗为安全字符串：保证可无损 JSON 序列化（去孤立代理项）+ 截断。 */',
    ],
  },
  {
    label: '观察计算窗口所在显示器',
    file: 'lib/observe.js',
    before: ['  // 3. AX 树（vision / native 模式同时抓截图）'],
    after: [
      '  // 3. AX 树（vision / native 模式同时抓截图）',
      '  // 多显示器：窗口 bounds 与光标位置都是整个桌面的屏幕坐标，先取显示器几何，',
      '  // 后面既用于标注"窗口在哪块屏"，也让动作层按绝对屏幕点移动虚拟光标。',
      '  const displays = await listDisplays()',
      '  const primary = primaryDisplay(displays)',
      '  const targetDisplay = displayOfRect(target.bounds, displays)',
      '  let cursorPos = null',
      '  let cursorDisplay = null',
      '  try {',
      "    const cs = await cuaCall('get_agent_cursor_state', { session: CUA_SESSION })",
      '    cursorPos = cs?.position ?? null',
      '    if (cursorPos) cursorDisplay = displayOfPoint(cursorPos.x, cursorPos.y, displays)',
      '  } catch { /* 光标状态只用于展示，失败不影响观察 */ }',
    ],
  },
  {
    label: '快照记录窗口位置与显示器',
    file: 'lib/observe.js',
    before: [
      "    screenshotWidth: state.screenshot_width || null,",
      "    screenshotHeight: state.screenshot_height || null,",
      '  })',
    ],
    after: [
      "    screenshotWidth: state.screenshot_width || null,",
      "    screenshotHeight: state.screenshot_height || null,",
      "    title: target.title || '',",
      '    bounds: target.bounds || null,',
      '    display: targetDisplay || null,',
      '    onCurrentSpace: state.on_current_space !== false,',
      '  })',
    ],
  },
  {
    label: '观察结果带显示器与光标位置',
    file: 'lib/observe.js',
    before: [
      '    `窗口: ${safeStr(target.app_name)} · ${safeStr(target.title)}`,',
      "    `pid=${target.pid} window_id=${target.window_id} ${modeNote} 坐标=窗口本地截图像素` + (state.screenshot_width ? `\\n截图像素 ${state.screenshot_width}×${state.screenshot_height}（点击坐标按这张图的像素估，Retina 截图通常是逻辑尺寸的 2 倍）` : ''),",
    ],
    after: [
      '    `窗口: ${safeStr(target.app_name)} · ${safeStr(target.title)}`,',
      "    `显示器: ${describeDisplay(targetDisplay, primary)}` + (targetDisplay && !targetDisplay.primary ? '\\n⚠ 该窗口在外接屏：窗口截图与点击坐标不受影响；桌面截图只覆盖主屏，窗口若不在当前 Space 需先切到该桌面。' : ''),",
      "    ...cursorPos ? [`虚拟光标: 屏幕 (${Math.round(cursorPos.x)},${Math.round(cursorPos.y)})${cursorDisplay ? `，在 ${cursorDisplay.name}` : ''}`] : [],",
      "    `pid=${target.pid} window_id=${target.window_id} ${modeNote} 坐标=窗口本地截图像素` + (state.screenshot_width ? `\\n截图像素 ${state.screenshot_width}×${state.screenshot_height}（点击坐标按这张图的像素估，Retina 截图通常是逻辑尺寸的 2 倍）` : ''),",
    ],
  },
  {
    label: '点击解构补 from_zoom',
    file: 'lib/human.js',
    before: ["  const { pid, windowId, x, y, sx, sy, token, count = 1, button = 'left' } = opts"],
    after: ["  const { pid, windowId, x, y, sx, sy, token, count = 1, button = 'left', fromZoom = false, snap = getSnapshot() } = opts"],
  },
  {
    label: '光标按屏幕点移动',
    file: 'lib/human.js',
    before: [
      '  // 1. 光标滑行到目标（最佳努力，看得见过程）',
      '  if (sx != null && sy != null) {',
      "    await glideCursor(sx, sy, { target: { kind: 'window', pid, window_id: windowId } })",
      '  }',
    ],
    after: [
      '  await ensureCursor()',
      '',
      '  // 1. 光标滑行到目标（最佳努力，看得见过程）。',
      '  //    move_cursor 不带 target 时接受屏幕点：窗口在外接屏时也能落对位置，',
      '  //    不再依赖驱动把窗口本地坐标映射到正确显示器。',
      '  //    from_zoom 的坐标属于局部放大图，无法反算屏幕点，直接跳过滑行。',
      '  if (!fromZoom && sx != null && sy != null) {',
      '    const pt = windowPxToScreen(sx, sy, snap)',
      '    if (pt) await glideCursor(pt.x, pt.y, {})',
      "    else await glideCursor(sx, sy, { target: { kind: 'window', pid, window_id: windowId } })",
      '  }',
    ],
  },
  {
    label: '坐标点击支持 from_zoom',
    file: 'lib/human.js',
    before: [
      '    payload.count = count',
      '    payload.button = button',
      '  }',
      "  const value = await cuaCall('click', payload)",
    ],
    after: [
      '    payload.count = count',
      '    payload.button = button',
      '    if (fromZoom) payload.from_zoom = true',
      '  }',
      "  const value = await cuaCall('click', payload)",
    ],
  },
  {
    label: '点击透传 from_zoom',
    file: 'lib/actions.js',
    before: [
      '  const extra = {}',
      '  if (args.count) extra.count = Number(args.count)',
    ],
    after: [
      '  const extra = {}',
      '  if (args.count) extra.count = Number(args.count)',
      '  if (args.from_zoom) extra.fromZoom = true',
    ],
  },
  {
    label: '引入 computer_aim',
    file: 'index.js',
    before: ["import { screenObserve, screenZoom } from './lib/observe.js'"],
    after: ["import { screenObserve, screenZoom, screenAim } from './lib/observe.js'"],
  },
  {
    label: '点击参数补 from_zoom',
    file: 'index.js',
    marker: "screen_x: { type: 'number'",
    before: ["    parameters: { ...TARGET_PARAMS, count: { type: 'integer', description: '可选：点击次数，默认 1。' } },"],
    after: ["    parameters: { ...TARGET_PARAMS, count: { type: 'integer', description: '可选：点击次数，默认 1。' }, from_zoom: { type: 'boolean', description: '可选：x/y 来自最近一次 screen_zoom / computer_aim 的局部图时传 true，驱动自动换算回窗口坐标。' } },"],
  },
  {
    label: '点击参数补屏幕坐标',
    file: 'index.js',
    before: ["    parameters: { ...TARGET_PARAMS, count: { type: 'integer', description: '可选：点击次数，默认 1。' }, from_zoom: { type: 'boolean', description: '可选：x/y 来自最近一次 screen_zoom / computer_aim 的局部图时传 true，驱动自动换算回窗口坐标。' } },"],
    after: ["    parameters: { ...TARGET_PARAMS, count: { type: 'integer', description: '可选：点击次数，默认 1。' }, from_zoom: { type: 'boolean', description: '可选：x/y 来自最近一次 screen_zoom / computer_aim 的局部图时传 true，驱动自动换算回窗口坐标。' }, screen_x: { type: 'number', description: '可选：屏幕点 x（computer_aim 校准后的 screen 坐标）。与 screen_y 一起用，优先于 element/x/y。' }, screen_y: { type: 'number', description: '可选：屏幕点 y。' } },"],
  },
  {
    label: '注册 computer_aim',
    file: 'index.js',
    insertFile: 'index-aim-tool.js',
    marker: "name: 'computer_aim'",
    before: ["  ctx.logger?.info('dsh-computer-use: 12 个工具已注册（screen_observe / screen_zoom / computer_click / double / right / type / key / scroll / drag / wait / app_list / app_launch）')"],
  },
  {
    label: '观察工具描述补显示器与 aim',
    file: 'index.js',
    before: [
      "      '观察屏幕：对目标窗口生成\"编号 + 控件 + 坐标\"的界面树（AX 语义，零视觉 token 成本）。' +",
      "      '操作电脑前必须先调用本工具取得快照；之后用 computer_click(element=[编号]) 或 computer_click(x=,y=) 操作（坐标为窗口本地截图像素）。' +",
    ],
    after: [
      "      '观察屏幕：对目标窗口生成\"编号 + 控件 + 坐标\"的界面树（AX 语义，零视觉 token 成本）。' +",
      "      '操作电脑前必须先调用本工具取得快照；之后用 computer_click(element=[编号]) 或 computer_click(x=,y=) 操作（坐标为窗口本地截图像素）。' +",
      "      '结果里会标注「显示器:」主屏/外接屏与「虚拟光标:」当前屏幕坐标；窗口在外接屏且不在当前 Space 时，需先让用户切到该桌面。' +",
      "      '全局画面用 mode=\"native\" 看整窗；要核对某个控件时改用 computer_aim 拿局部小图（更快更省 token）。' +",
    ],
  },
  {
    label: '工具注册日志补 computer_aim',
    file: 'index.js',
    before: ["  ctx.logger?.info('dsh-computer-use: 12 个工具已注册（screen_observe / screen_zoom / computer_click / double / right / type / key / scroll / drag / wait / app_list / app_launch）')"],
    after: ["  ctx.logger?.info('dsh-computer-use: 13 个工具已注册（screen_observe / screen_zoom / computer_aim / computer_click / double / right / type / key / scroll / drag / wait / app_list / app_launch）')"],
  },
  // ── 同名窗口选择 / 键盘投递到正确窗口 ───────────────────────────────────
  {
    label: '窗口选择优先当前桌面',
    file: 'lib/observe.js',
    replaceFile: 'observe-select-window.js',
    marker: 'let matchNote',
    before: [
      '  // 2. 选目标窗口：参数 window（pid / 标题子串）→ 否则 z 序最前',
      '  let target = null',
      '  const want = args.window',
      "  if (want !== undefined && want !== null && want !== '') {",
      '    const wantStr = String(want)',
      '    target = windows.find((w) => String(w.window_id) === wantStr)',
      '      || windows.find((w) => String(w.pid) === wantStr)',
      "      || windows.find((w) => (w.title || '').toLowerCase().includes(wantStr.toLowerCase()))",
      "      || windows.find((w) => (w.app_name || '').toLowerCase().includes(wantStr.toLowerCase()))",
      '  }',
    ],
  },
  {
    label: '缺省窗口优先有标题的可见窗口',
    file: 'lib/observe.js',
    marker: 'pickWindow(visible.length > 0 ? visible : windows)',
    before: [
      '  if (!target) {',
      "    const shown = (w) => w.is_on_screen === true && w.on_current_space !== false",
      '    const sorted = [...windows].sort((a, b) => (Number(shown(b)) - Number(shown(a))) || (b.z_index || 0) - (a.z_index || 0))',
      '    target = sorted[0]',
      '  }',
    ],
    after: [
      '  if (!target) {',
      "    const shown = (w) => w.is_on_screen !== false && w.on_current_space !== false",
      '    const visible = windows.filter(shown)',
      '    target = pickWindow(visible.length > 0 ? visible : windows)',
      '  }',
    ],
  },
  {
    label: '观察结果带窗口匹配说明',
    file: 'lib/observe.js',
    before: ['    result: `${header}${frontNote}\\n${body}${visionBlock}\\n\\n提示: 用 computer_click(element=[编号]) 或 computer_click(x=, y=) 操作（坐标为截图像素）。`,'],
    after: ['    result: `${header}${frontNote}${matchNote}\\n${body}${visionBlock}\\n\\n提示: 用 computer_click(element=[编号]) 或 computer_click(x=, y=) 操作（坐标为截图像素）。`,'],
  },
  {
    label: '动作层引入前置窗口',
    file: 'lib/actions.js',
    before: ["import { humanClick, resolveClickTarget, screenPointOf, windowLocalOf } from './human.js'"],
    after: ["import { focusWindow, humanClick, resolveClickTarget, screenPointOf, windowLocalOf } from './human.js'"],
  },
  {
    label: '屏幕点点击分支',
    file: 'lib/actions.js',
    replaceFile: 'actions-screen-click.js',
    marker: 'args.screen_x !== undefined',
    before: ['  } else if (args.x !== undefined && args.y !== undefined) {'],
  },
  {
    label: '坐标点击前前置窗口',
    file: 'lib/actions.js',
    replaceFile: 'actions-click-focus.js',
    marker: '坐标点击会落到其它窗口',
    before: [
      '  } else if (args.x !== undefined && args.y !== undefined) {',
      '    const { pid, windowId } = resolveWindow(cfg.ttlMs)',
      '    const sx = Number(args.x)',
      '    const sy = Number(args.y)',
      '    const local = windowLocalOf(sx, sy, snap)',
      '    target = {',
      '      pid,',
      '      windowId,',
      '      x: local.x,',
      '      y: local.y,',
      '      sx,',
      '      sy,',
      '    }',
      '  } else {',
    ],
  },
  {
    label: '输入前前置窗口',
    file: 'lib/actions.js',
    before: [
      'export async function typeText(args, cfg, { call = cuaCall, resolve = resolveWindow } = {}) {',
      "  if (!args.text) throw new Error('computer_type: 缺少 text 参数。')",
      '  const payload = withSession({ text: String(args.text) })',
    ],
    after: [
      'export async function typeText(args, cfg, { call = cuaCall, resolve = resolveWindow } = {}) {',
      "  if (!args.text) throw new Error('computer_type: 缺少 text 参数。')",
      '  // 键盘事件只发给应用的 key window。目标窗口在别的 Space 时，',
      '  // 不前置就直接输入会静默写进另一个窗口。',
      '  const focus = await focusWindow(getSnapshot())',
      '  if (!focus.ok) {',
      '    return {',
      '      ok: false,',
      '      result: `输入被拒绝：目标窗口不在当前桌面或无法前置，键盘事件会发到别的窗口。请先切到该窗口所在桌面，或换一个当前桌面的同名窗口。详情：${focus.detail.slice(0, 240)}`,',
      '    }',
      '  }',
      '  const payload = withSession({ text: String(args.text) })',
    ],
  },
  {
    label: '按键前前置窗口',
    file: 'lib/actions.js',
    before: [
      '/** computer_key —— 按键 / 快捷键（如 return、cmd+c） */',
      'export async function key(args, cfg) {',
      '  return dispatchKey(args, cfg)',
      '}',
    ],
    after: [
      '/** computer_key —— 按键 / 快捷键（如 return、cmd+c） */',
      'export async function key(args, cfg) {',
      '  // 与 typeText 同理：先把目标窗口置为 key window，否则快捷键会发给别的窗口。',
      '  const focus = await focusWindow(getSnapshot())',
      '  if (!focus.ok) {',
      '    return {',
      '      ok: false,',
      '      result: `按键被拒绝：目标窗口不在当前桌面或无法前置，快捷键会发到别的窗口。请先切到该窗口所在桌面，或换一个当前桌面的同名窗口。详情：${focus.detail.slice(0, 240)}`,',
      '    }',
      '  }',
      '  return dispatchKey(args, cfg)',
      '}',
    ],
  },
]

async function patchComputerUse(targetRoot = join(profileDir, 'node_modules', 'dsh-computer-use')) {
  const root = targetRoot
  const patchDir = join(repoRoot, 'scripts', 'computer-use-patches')
  const readSnippet = (name) => readFile(join(patchDir, name), 'utf8')

  for (const patch of COMPUTER_USE_PATCHES) {
    const file = join(root, patch.file)

    // 整文件写入：新增模块（display.js）用，内容放在 scripts/computer-use-patches/。
    if (patch.contentFile !== undefined) {
      let current = ''
      try {
        current = await readFile(file, 'utf8')
      } catch {
        // 新文件，正常路径
      }
      const next = await readSnippet(patch.contentFile)
      if (current === next) {
        console.log(`[sv] dsh-computer-use: 「${patch.label}」已修补`)
        continue
      }
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, next)
      console.log(`[sv] dsh-computer-use: 已写入「${patch.label}」`)
      continue
    }

    // 追加片段：新增导出函数（ensureCursor / screenAim）用，marker 存在即视为已修补。
    if (patch.appendFile !== undefined) {
      let source
      try {
        source = await readFile(file, 'utf8')
      } catch {
        console.warn(`[sv] dsh-computer-use: 读不到 ${patch.file}，跳过「${patch.label}」`)
        continue
      }
      if (source.includes(patch.marker)) {
        console.log(`[sv] dsh-computer-use: 「${patch.label}」已修补`)
        continue
      }
      const code = (await readSnippet(patch.appendFile)).trimEnd()
      await writeFile(file, `${source.trimEnd()}\n\n${code}\n`)
      console.log(`[sv] dsh-computer-use: 已追加「${patch.label}」`)
      continue
    }

    // 在指定锚点前插入片段（工具注册块）：anchor 存在且片段 marker 不存在时写入。
    if (patch.insertFile !== undefined) {
      let source
      try {
        source = await readFile(file, 'utf8')
      } catch {
        console.warn(`[sv] dsh-computer-use: 读不到 ${patch.file}，跳过「${patch.label}」`)
        continue
      }
      if (source.includes(patch.marker)) {
        console.log(`[sv] dsh-computer-use: 「${patch.label}」已修补`)
        continue
      }
      const anchor = patch.before.join('\n')
      if (!source.includes(anchor)) {
        console.warn(`[sv] dsh-computer-use: 未找到「${patch.label}」的插入点，跳过（升级插件后需重新确认）`)
        continue
      }
      const code = (await readSnippet(patch.insertFile)).trimEnd()
      await writeFile(file, source.replace(anchor, `${code}\n\n${anchor}`))
      console.log(`[sv] dsh-computer-use: 已插入「${patch.label}」`)
      continue
    }

    // 用片段文件替换一个代码块（大段逻辑，避免在 JS 字符串里转义引号）。
    if (patch.replaceFile !== undefined) {
      let source
      try {
        source = await readFile(file, 'utf8')
      } catch {
        console.warn(`[sv] dsh-computer-use: 读不到 ${patch.file}，跳过「${patch.label}」`)
        continue
      }
      if (source.includes(patch.marker)) {
        console.log(`[sv] dsh-computer-use: 「${patch.label}」已修补`)
        continue
      }
      const before = patch.before.join('\n')
      if (!source.includes(before)) {
        console.warn(`[sv] dsh-computer-use: 未找到「${patch.label}」的替换点，跳过（升级插件后需重新确认）`)
        continue
      }
      const code = (await readSnippet(patch.replaceFile)).trimEnd()
      await writeFile(file, source.replace(before, code))
      console.log(`[sv] dsh-computer-use: 已替换「${patch.label}」`)
      continue
    }

    let source
    try {
      source = await readFile(file, 'utf8')
    } catch {
      console.warn(`[sv] dsh-computer-use: 读不到 ${patch.file}，跳过「${patch.label}」`)
      continue
    }
    const before = patch.before.join('\n')
    const after = patch.after.join('\n')
    if (patch.marker && source.includes(patch.marker)) {
      console.log(`[sv] dsh-computer-use: 「${patch.label}」已修补`)
      continue
    }
    if (source.includes(after)) {
      console.log(`[sv] dsh-computer-use: 「${patch.label}」已修补`)
      continue
    }
    if (!source.includes(before)) {
      console.warn(`[sv] dsh-computer-use: 未找到「${patch.label}」的调用点，跳过（升级插件后需重新确认）`)
      continue
    }
    await writeFile(file, source.split(before).join(after))
    console.log(`[sv] dsh-computer-use: 已修补「${patch.label}」`)
  }
}

await patchComputerUse(patchOnlyRoot || undefined)
if (patchOnlyRoot) process.exit(0)

const dshSrc = process.env.DSH_SRC ?? join(repoRoot, '..', 'deepseek-harness-dsh-v0.2.1-rc.2')
console.log('')
console.log('[sv] 就绪。启动（或直接 pnpm dev）：')
console.log(`      node "${join(dshSrc, 'apps', 'cli', 'lib', 'bin.js')}" --profile sv --port 7000 --no-open`)
console.log('')
console.log('[sv] Singularity Voyage 页面: http://127.0.0.1:7000/（自建前端，重定向到 /sv/）')
console.log('[sv] dsh 官方 Web UI 已禁用（web-runtime disabled），仅通过 /sv/api 桥接')
