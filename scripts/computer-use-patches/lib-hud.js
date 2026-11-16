/**
 * sv-hud.js —— Computer Use 屏幕 HUD 状态桥。
 *
 * 每次工具动作开始时把「正在做什么」写入状态文件，并确保一个轻量 AppKit
 * 面板在屏幕右上角显示；动作结束时追加一条简单日志。HUD 只读取状态文件，
 * 不参与工具执行，任何异常都必须被吞掉。
 *
 * 开关：SV_COMPUTER_HUD=0 关闭；仅 macOS 启用。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cuaCall, CUA_SESSION } from './cua.js'

const ENABLED = process.platform === 'darwin' && process.env.SV_COMPUTER_HUD !== '0'
const CURSOR_ENABLED = ENABLED && process.env.SV_CUSTOM_CURSOR !== '0'
const MAX_ENTRIES = 6

/**
 * 定位数据目录：优先使用已有 HUD 二进制的目录，避免宿主没透传 DSH_HOME
 * 时又去用户目录重新编译一份。
 */
function resolveDataRoot() {
  const candidates = []
  if (process.env.SV_HOME && process.env.SV_HOME.length > 0) candidates.push(process.env.SV_HOME)
  if (process.env.DSH_HOME && process.env.DSH_HOME.length > 0) candidates.push(join(process.env.DSH_HOME, 'sv'))
  candidates.push(join(process.cwd(), '.dsh', 'sv'))
  candidates.push(join(homedir(), '.sv'))
  for (const dir of candidates) {
    if (existsSync(join(dir, 'computer-use', 'sv-computer-hud'))) return dir
  }
  return candidates[0] ?? join(homedir(), '.sv')
}

const dataRoot = resolveDataRoot()
const hudDir = join(dataRoot, 'computer-use')
const statePath = join(hudDir, 'hud-state.json')
const cursorPath = join(hudDir, 'cursor-state.json')
const pidPath = join(hudDir, 'hud.pid')
const sourcePath = fileURLToPath(new URL('./sv-hud.swift', import.meta.url))
const binPath = join(hudDir, 'sv-computer-hud')

const state = {
  status: 'idle',
  current: '',
  detail: '',
  startedAt: 0,
  updatedAt: 0,
  entries: [],
}

/** 最近一次观察到的窗口标题，用于后续动作的上下文。 */
let currentTarget = ''
let hudPid = 0
let building = false
let driverCursorHidden = false

function safe(fn) {
  try {
    return fn()
  } catch {
    // HUD 属于旁路展示，绝不影响真实操作
    return undefined
  }
}

function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function describe(tool, args = {}) {
  const a = args ?? {}
  const withTarget = (detail) => currentTarget ? `${detail} · ${currentTarget}` : detail
  switch (tool) {
    case 'screen_observe': {
      const name = a.window || currentTarget
      return { title: name ? `观察窗口「${clip(name, 24)}」` : '观察当前窗口', detail: `模式 ${a.mode || 'ax'}` }
    }
    case 'screen_zoom':
      return { title: '放大局部区域', detail: a.window_id ? `window_id=${a.window_id}` : '' }
    case 'computer_click':
      return { title: '点击', detail: withTarget(targetDetail(a)) }
    case 'computer_double_click':
      return { title: '双击', detail: withTarget(targetDetail(a)) }
    case 'computer_right_click':
      return { title: '右键点击', detail: withTarget(targetDetail(a)) }
    case 'computer_type':
      return {
        title: `输入「${clip(a.text, 30)}」`,
        detail: withTarget(a.element !== undefined ? `element ${a.element}` : '当前焦点'),
      }
    case 'computer_key':
      return { title: `按键 ${clip(a.key, 24)}`, detail: currentTarget }
    case 'computer_scroll':
      return {
        title: `滚动 ${a.direction || 'down'} ${a.amount ?? 3} 格`,
        detail: withTarget(a.element !== undefined ? `element ${a.element}` : ''),
      }
    case 'computer_drag':
      return { title: '拖拽', detail: withTarget(`(${a.from_x},${a.from_y}) → (${a.to_x},${a.to_y})`) }
    case 'computer_wait':
      return { title: `等待 ${Math.round(Number(a.ms || 0) / 100) / 10}s`, detail: '' }
    case 'computer_aim':
      return { title: '校准坐标', detail: withTarget(targetDetail(a)) }
    case 'app_list':
      return { title: '列出正在运行的应用', detail: '' }
    case 'app_launch':
      return {
        title: `启动「${clip(a.name || a.bundle_id || '应用', 24)}」`,
        detail: a.bring_to_front ? '前置窗口' : '后台启动',
      }
    default:
      return { title: tool, detail: clip(JSON.stringify(a), 60) }
  }
}

function targetDetail(args) {
  if (args.element !== undefined) return `element ${args.element}`
  if (args.x !== undefined && args.y !== undefined) return `(${args.x}, ${args.y})`
  if (args.screen_x !== undefined && args.screen_y !== undefined) {
    return `屏幕 (${args.screen_x}, ${args.screen_y})`
  }
  return '当前光标位置'
}

function ensureDir() {
  mkdirSync(hudDir, { recursive: true })
}

function writeState() {
  ensureDir()
  state.updatedAt = Date.now()
  const tmp = `${statePath}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
  renameSync(tmp, statePath)
}

/** 写高亮光标状态：坐标是 cua-driver 的屏幕点（左上原点）。 */
function writeCursor(cursor) {
  ensureDir()
  const tmp = `${cursorPath}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(cursor), { mode: 0o600 })
  renameSync(tmp, cursorPath)
}

/** 用自建高层光标代替驱动自带的低层光标（仅当 HUD 二进制存在）。 */
function hideDriverCursor() {
  if (driverCursorHidden || !existsSync(binPath)) return
  driverCursorHidden = true
  void cuaCall('set_agent_cursor_enabled', { session: CUA_SESSION, enabled: false })
    .catch(() => { driverCursorHidden = false })
}

/** 更新自建光标位置；每次滑行分段都会调用。 */
export function cursorMove(x, y, extra = {}) {
  if (!CURSOR_ENABLED) return
  const px = Number(x)
  const py = Number(y)
  if (!Number.isFinite(px) || !Number.isFinite(py)) return
  safe(() => {
    writeCursor({ x: px, y: py, visible: true, click: 0, updatedAt: Date.now(), ...extra })
    spawnHud()
    hideDriverCursor()
  })
}

/** 点击位置：同一坐标 + click 时间戳，触发高层光标上的点击波纹。 */
export function cursorClick(x, y, extra = {}) {
  if (!CURSOR_ENABLED) return
  const px = Number(x)
  const py = Number(y)
  if (!Number.isFinite(px) || !Number.isFinite(py)) return
  safe(() => {
    writeCursor({ x: px, y: py, visible: true, click: Date.now(), updatedAt: Date.now(), ...extra })
    spawnHud()
    hideDriverCursor()
  })
}

/** 隐藏自建光标（目前未主动使用，保留给后续动作）。 */
export function cursorHide() {
  if (!CURSOR_ENABLED) return
  safe(() => {
    writeCursor({ x: 0, y: 0, visible: false, click: 0, updatedAt: Date.now() })
  })
}

function readPid() {
  return safe(() => Number(readFileSync(pidPath, 'utf8').trim()) || 0) ?? 0
}

function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function spawnHud() {
  if (hudPid !== 0 && isAlive(hudPid)) return
  const saved = readPid()
  if (saved !== 0 && isAlive(saved)) {
    hudPid = saved
    return
  }
  if (!existsSync(binPath)) {
    buildHud()
    return
  }
  safe(() => {
    const child = spawn(binPath, [statePath], { detached: true, stdio: 'ignore' })
    child.unref()
    hudPid = child.pid ?? 0
    if (hudPid !== 0) {
      ensureDir()
      writeFileSync(pidPath, String(hudPid), { mode: 0o600 })
    }
  })
}

/** 运行期兜底编译；正常路径由 setup-profile 预编译。 */
function buildHud() {
  if (building || !existsSync(sourcePath)) return
  building = true
  safe(() => {
    ensureDir()
    const child = spawn('swiftc', ['-O', '-o', binPath, sourcePath], { detached: true, stdio: 'ignore' })
    child.unref()
    child.on('exit', () => {
      building = false
      if (existsSync(binPath)) spawnHud()
    })
    child.on('error', () => {
      building = false
    })
  })
}

/** 动作开始：显示“正在做什么”。 */
export function hudStart(tool, args) {
  if (!ENABLED) return
  safe(() => {
    const { title, detail } = describe(tool, args)
    state.status = 'running'
    state.current = title
    state.detail = detail
    state.startedAt = Date.now()
    writeState()
    spawnHud()
  })
}

/** 动作结束：当前状态收敛，并追加一条简单日志。 */
export function hudEnd(tool, args, ok, result, durationMs, value) {
  if (!ENABLED) return
  safe(() => {
    if (value && typeof value === 'object' && value.cursor !== undefined) {
      const cursor = value.cursor
      if (cursor && typeof cursor.x === 'number' && typeof cursor.y === 'number') {
        cursorMove(cursor.x, cursor.y)
      }
    }
    if (tool === 'screen_observe' && value?.window !== undefined) {
      const name = value.window.title || value.window.app || ''
      if (name) currentTarget = clip(name, 28)
    }
    const { title, detail } = describe(tool, args)
    const resolvedTitle = tool === 'screen_observe' && currentTarget
      ? `观察窗口「${currentTarget}」`
      : title
    const entryTitle = tool === 'screen_observe' || !detail
      ? resolvedTitle
      : `${resolvedTitle} · ${clip(detail, 36)}`
    const status = ok ? 'success' : 'error'
    state.entries.push({
      status,
      title: entryTitle,
      detail: ok ? clip(detail, 70) : clip(result, 110),
      ms: Number(durationMs) || 0,
      at: Date.now(),
    })
    if (state.entries.length > MAX_ENTRIES) {
      state.entries.splice(0, state.entries.length - MAX_ENTRIES)
    }
    state.status = status
    state.current = ok ? resolvedTitle : `${resolvedTitle} · 失败`
    state.detail = ok ? clip(detail, 70) : clip(result, 110)
    writeState()
  })
}
