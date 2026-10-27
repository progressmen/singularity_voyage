/* Singularity Voyage 前端：无依赖单页应用。 */
'use strict'

const $ = (id) => document.getElementById(id)

const STORE_KEY = 'sv.conversations.v1'
const ACTIVE_KEY = 'sv.active.v1'
const THEME_KEY = 'sv.theme'

/** 系统浅色偏好；跟随系统模式据此解析。 */
const themeMedia = window.matchMedia('(prefers-color-scheme: light)')

/** 主题偏好：system | dark | light（持久化在 localStorage）。 */
function preferredTheme() {
  const value = localStorage.getItem(THEME_KEY)
  return value === 'light' || value === 'dark' ? value : 'system'
}

/** 应用主题：system 解析为当前系统偏好后写入 data-theme。 */
function applyTheme(theme = preferredTheme()) {
  if (theme === 'system' || theme === 'dark' || theme === 'light') localStorage.setItem(THEME_KEY, theme)
  const resolved = theme === 'system' ? (themeMedia.matches ? 'light' : 'dark') : theme
  document.documentElement.dataset.theme = resolved
  document.documentElement.style.colorScheme = resolved
}

themeMedia.addEventListener('change', () => {
  if (preferredTheme() === 'system') applyTheme('system')
})

/** LLM 供应商预设（与后端 SV_LLM_PRESETS 一致；切换预设时回填端点与模型，仍可手改）。 */
const LLM_PRESETS = {
  deepseek: { baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' },
  qwen: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-max' },
  ark: { baseURL: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-1-6-250615' },
  openai: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
}

/** 本地会话记录（消息副本仅用于页面回显；事实源在服务端会话日志）。 */
let conversations = loadConversations()
let activeId = localStorage.getItem(ACTIVE_KEY) ?? null
let streaming = false

/* ── 视图切换（对话 / 待办 / 定时任务 / 记忆 / 日志） ───── */
const VIEW_KEY = 'sv.view.v1'
let currentView = localStorage.getItem(VIEW_KEY) ?? 'chat'
if (!['chat', 'tasks', 'schedules', 'memory', 'logs'].includes(currentView)) currentView = 'chat'

/** 非对话视图的顶栏标题。 */
const VIEW_TITLES = { tasks: '待办与提醒', schedules: '定时任务', memory: '长期记忆', logs: '运行日志' }

/** 待办、定时任务与记忆数据缓存。 */
let tasksCache = []
let schedulesCache = []
let memoriesCache = []
let memoryKindFilter = ''
let overdueCount = 0

function applyView(view) {
  currentView = view
  localStorage.setItem(VIEW_KEY, view)
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.view === view)
  })
  $('messages').hidden = view !== 'chat'
  $('composer').hidden = view !== 'chat'
  $('panel-tasks').hidden = view !== 'tasks'
  $('panel-schedules').hidden = view !== 'schedules'
  $('panel-memory').hidden = view !== 'memory'
  $('panel-logs').hidden = view !== 'logs'
  $('topbar-title').textContent = VIEW_TITLES[view] ?? (activeConversation()?.title ?? '新对话')
  renderUsage(activeConversation()?.usage)
  if (view === 'tasks') void loadTasks()
  if (view === 'schedules') void loadSchedules()
  if (view === 'memory') void loadMemories()
  if (view === 'logs') {
    void loadLogs()
    startLogAutoRefresh()
  } else {
    stopLogAutoRefresh()
  }
  closeSidebarDrawer()
}

function loadConversations() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    // 旧版本可能把同一轮的多条 assistant 消息分别存下，载入时一并合并
    return parsed
      .filter(c => c && typeof c.id === 'string' && Array.isArray(c.messages))
      .map(c => ({ ...c, messages: mergeAssistantBatches(c.messages) }))
  } catch {
    return []
  }
}

function saveConversations() {
  localStorage.setItem(STORE_KEY, JSON.stringify(conversations.slice(0, 100)))
}

function activeConversation() {
  return conversations.find(c => c.id === activeId) ?? null
}

function newConversation() {
  const conv = { id: null, title: '新对话', messages: [], updatedAt: Date.now() }
  conversations.unshift(conv)
  activeId = null
  localStorage.removeItem(ACTIVE_KEY)
  saveConversations()
  renderSidebar()
  renderMessages()
  $('input').focus()
}

function selectConversation(id) {
  activeId = id
  localStorage.setItem(ACTIVE_KEY, id)
  renderSidebar()
  renderMessages()
  applyView('chat')
  // 服务端索引里的会话在换浏览器/清缓存后本地没有消息副本，点开时按需补齐。
  const conv = activeConversation()
  if (conv !== null && conv.messages.length === 0) void hydrateConversation(id)
}

/**
 * 合并同一轮内的连续 assistant 条目。
 * 工具调用前后会产生多条 assistant 消息（各自带一段思考过程），
 * 历史回显应合并成一条：思考与正文按空行拼接，工具记录按顺序累积。
 */
function mergeAssistantBatches(messages) {
  const out = []
  for (const message of messages) {
    const prev = out[out.length - 1]
    if (message.role === 'assistant' && prev?.role === 'assistant') {
      if (message.text) prev.text = prev.text ? `${prev.text}\n\n${message.text}` : message.text
      if (message.reasoning) {
        prev.reasoning = prev.reasoning ? `${prev.reasoning}\n\n${message.reasoning}` : message.reasoning
      }
      if (Array.isArray(message.tools) && message.tools.length > 0) {
        prev.tools = [...(Array.isArray(prev.tools) ? prev.tools : []), ...message.tools]
      }
      continue
    }
    out.push({ ...message })
  }
  return out
}

/** 启动时按 id 从服务端恢复历史（本地缺失或为空时），支持清缓存后找回会话。 */
async function hydrateConversation(id) {
  try {
    const { messages } = await api(`/sv/api/sessions/${encodeURIComponent(id)}/messages`)
    if (!Array.isArray(messages) || messages.length === 0) return
    let conv = conversations.find(c => c.id === id)
    if (conv && conv.messages.length > 0) return
    // 等待期间用户已切到别的会话：放弃本次回填，避免抢走选中态
    if (activeId !== id) return
    if (!conv) {
      const blank = conversations.find(c => c.id === null && c.messages.length === 0)
      if (blank) {
        conv = blank
        conv.id = id
      } else {
        conv = { id, title: '新对话', messages: [], updatedAt: Date.now() }
        conversations.unshift(conv)
      }
    }
    conv.messages = mergeAssistantBatches(messages.map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      text: m.text ?? '',
      ...(m.reasoning ? { reasoning: m.reasoning } : {}),
      ...(Array.isArray(m.tools) && m.tools.length > 0 ? { tools: m.tools } : {}),
    })))
    const firstUser = messages.find(m => m.role === 'user')
    if (conv.title === '新对话' && firstUser?.text) conv.title = firstUser.text.slice(0, 24)
    conv.updatedAt = messages[messages.length - 1]?.ts ?? Date.now()
    conversations.sort((a, b) => b.updatedAt - a.updatedAt)
    activeId = id
    localStorage.setItem(ACTIVE_KEY, id)
    saveConversations()
    renderSidebar()
    renderMessages()
  } catch {
    // 服务端不可用或无历史：静默忽略，本地照常使用
  }
}

/** 从服务端拉取会话索引并合并进侧边栏（换浏览器/清缓存后仍能看到历史会话列表）。 */
async function syncConversations() {
  let remote
  try {
    const data = await api('/sv/api/sessions')
    remote = Array.isArray(data.sessions) ? data.sessions : []
  } catch {
    return
  }
  const merged = []
  const remoteIds = new Set()
  for (const entry of remote) {
    if (typeof entry?.id !== 'string' || entry.id.length === 0) continue
    remoteIds.add(entry.id)
    const local = conversations.find(c => c.id === entry.id)
    if (local !== undefined) {
      // 标题以服务端为准（可能在其他浏览器重命名过），时间取较新值
      if (typeof entry.title === 'string' && entry.title.length > 0) local.title = entry.title
      local.updatedAt = Math.max(local.updatedAt ?? 0, Number(entry.updatedAt) || 0)
      // token 统计由服务端持久化，换浏览器/重启后仍可展示
      if (entry.usage !== undefined) local.usage = entry.usage
      merged.push(local)
      continue
    }
    // 本地没有消息副本，只放索引占位，点开时由 hydrateConversation 补齐
    merged.push({
      id: entry.id,
      title: typeof entry.title === 'string' && entry.title.length > 0 ? entry.title : '新对话',
      messages: [],
      updatedAt: Number(entry.updatedAt) || 0,
      ...(entry.usage === undefined ? {} : { usage: entry.usage }),
    })
  }
  for (const conv of conversations) {
    // 本地未落到服务端索引的会话（新建中、服务端旧数据）继续保留
    if (conv.id === null || !remoteIds.has(conv.id)) merged.push(conv)
  }
  merged.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  conversations = merged
  saveConversations()
  renderSidebar()
}

/* ── 渲染 ─────────────────────────────────────────────── */

/** 侧边栏两个会话分组的折叠状态（持久化在 localStorage）。 */
const SIDEBAR_COLLAPSE_KEY = 'sv.sidebar.collapsed.v1'

function loadCollapsed() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SIDEBAR_COLLAPSE_KEY) ?? '{}')
    return { starred: parsed?.starred === true, history: parsed?.history === true }
  } catch {
    return { starred: false, history: false }
  }
}

let collapsedSections = loadCollapsed()

function applyCollapsed() {
  for (const [key, sectionId, toggleId] of [
    ['starred', 'section-starred', 'toggle-starred'],
    ['history', 'section-history', 'toggle-history'],
  ]) {
    $(sectionId).classList.toggle('collapsed', collapsedSections[key])
    $(toggleId).setAttribute('aria-expanded', String(!collapsedSections[key]))
  }
}

function toggleSection(key) {
  collapsedSections[key] = !collapsedSections[key]
  localStorage.setItem(SIDEBAR_COLLAPSE_KEY, JSON.stringify(collapsedSections))
  applyCollapsed()
}

$('toggle-starred').addEventListener('click', () => toggleSection('starred'))
$('toggle-history').addEventListener('click', () => toggleSection('history'))
applyCollapsed()

/** 星标切换：标记在会话数据上，随 saveConversations() 持久化。 */
function toggleStar(conv) {
  conv.starred = conv.starred !== true
  saveConversations()
  renderSidebar()
}

/** 渲染单条会话；星标列表与历史列表共用同一套结构与行为。 */
function createConversationRow(conv) {
  const active = activeId === null ? conv === conversations[0] : conv.id === activeId
  const el = document.createElement('div')
  el.className = 'conversation' + (active ? ' active' : '')

  const title = document.createElement('span')
  title.className = 'conv-title'
  title.textContent = conv.title || '新对话'
  el.appendChild(title)

  const actions = document.createElement('span')
  actions.className = 'conv-actions'

  const moreBtn = document.createElement('button')
  moreBtn.type = 'button'
  moreBtn.className = 'conv-more'
  moreBtn.title = '更多操作'
  moreBtn.setAttribute('aria-label', '更多操作')
  moreBtn.textContent = '⋯'
  moreBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    openConvMenu(conv, moreBtn, title)
  })
  actions.appendChild(moreBtn)
  el.appendChild(actions)

  el.addEventListener('click', () => {
    if (streaming) return
    selectConversation(conv.id)
  })
  return el
}

function renderSidebar() {
  closeConvMenu()
  const starredList = $('starred-conversations')
  const historyList = $('conversations')
  starredList.innerHTML = ''
  historyList.innerHTML = ''
  const starred = conversations.filter(c => c.starred === true)
  const history = conversations.filter(c => c.starred !== true)
  for (const conv of starred) starredList.appendChild(createConversationRow(conv))
  for (const conv of history) historyList.appendChild(createConversationRow(conv))
  // 没有星标会话时整块隐藏，避免留出空白区域
  $('section-starred').hidden = starred.length === 0
  $('starred-count').textContent = starred.length > 0 ? ` (${starred.length})` : ''
  $('conv-count').textContent = history.length > 0 ? ` (${history.length})` : ''
  const conv = activeConversation() ?? conversations[0]
  $('topbar-title').textContent = VIEW_TITLES[currentView] ?? (conv ? conv.title : '新对话')
  renderUsage(conv?.usage)
}

/** token 数缩写：1234 → 1.2K，1234567 → 1.2M。 */
function formatTokens(value) {
  const n = Math.max(0, Math.round(Number(value) || 0))
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** 顶栏的上下文占用与累计 token；非对话视图或没有统计时隐藏。 */
function renderUsage(usage) {
  const box = $('topbar-usage')
  if (!box) return
  const hasUsage = usage !== undefined && usage !== null
  if (currentView !== 'chat' || !hasUsage) {
    box.hidden = true
    return
  }
  const context = Number(usage.contextTokens) || 0
  const window = Number(usage.contextWindow) || 0
  const percent = window > 0 ? Math.min(100, (context / window) * 100) : null
  $('usage-context').textContent = percent === null
    ? `上下文 ${formatTokens(context)}`
    : `上下文 ${formatTokens(context)} / ${formatTokens(window)}`
  $('usage-percent').textContent = percent === null ? '' : `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`
  const meter = $('usage-meter')
  meter.hidden = percent === null
  meter.className = 'usage-meter' + (percent !== null && percent >= 90 ? ' danger' : percent !== null && percent >= 70 ? ' warn' : '')
  $('usage-meter-fill').style.width = percent === null ? '0%' : `${percent.toFixed(1)}%`
  const input = (Number(usage.inputTokens) || 0) + (Number(usage.cacheReadTokens) || 0)
  $('usage-tokens').textContent = `↑${formatTokens(input)} ↓${formatTokens(usage.outputTokens)}`
  box.title = [
    `累计输入 ${formatTokens(input)}（缓存命中 ${formatTokens(usage.cacheReadTokens)}）`,
    `累计输出 ${formatTokens(usage.outputTokens)}`,
    `累计总量 ${formatTokens(usage.totalTokens)}`,
    window > 0 ? `上下文窗口 ${formatTokens(window)}（可在设置中覆盖）` : '未配置上下文窗口',
  ].join(' · ')
  box.hidden = false
}

/* ── 会话操作菜单（星标 / 重命名 / 删除） ───────────────── */
let convMenu = null
let convMenuAnchor = null

function closeConvMenu() {
  if (convMenu) {
    convMenu.remove()
    convMenu = null
  }
  if (convMenuAnchor) {
    convMenuAnchor.closest('.conversation')?.classList.remove('menu-open')
    convMenuAnchor = null
  }
}

function openConvMenu(conv, anchor, titleEl) {
  const reopen = convMenuAnchor !== anchor
  closeConvMenu()
  if (!reopen) return

  const menu = document.createElement('div')
  menu.className = 'conv-menu'
  menu.setAttribute('role', 'menu')

  const star = document.createElement('button')
  star.type = 'button'
  star.className = 'conv-menu-item'
  star.textContent = conv.starred === true ? '取消星标' : '添加星标'
  star.addEventListener('click', (event) => {
    event.stopPropagation()
    closeConvMenu()
    toggleStar(conv)
  })

  const rename = document.createElement('button')
  rename.type = 'button'
  rename.className = 'conv-menu-item'
  rename.textContent = '重命名'
  rename.addEventListener('click', (event) => {
    event.stopPropagation()
    closeConvMenu()
    startRename(conv, titleEl)
  })

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'conv-menu-item danger'
  remove.textContent = '删除会话'
  remove.addEventListener('click', (event) => {
    event.stopPropagation()
    closeConvMenu()
    void deleteConversation(conv)
  })

  menu.append(star, rename, remove)
  document.body.appendChild(menu)

  const rect = anchor.getBoundingClientRect()
  const top = Math.min(rect.bottom + 6, window.innerHeight - menu.offsetHeight - 8)
  const left = Math.max(8, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))
  menu.style.top = `${Math.max(8, top)}px`
  menu.style.left = `${left}px`

  convMenu = menu
  convMenuAnchor = anchor
  anchor.closest('.conversation')?.classList.add('menu-open')
}

document.addEventListener('click', (event) => {
  if (!convMenu) return
  if (convMenu.contains(event.target) || convMenuAnchor?.contains(event.target)) return
  closeConvMenu()
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeConvMenu()
})
window.addEventListener('resize', closeConvMenu)
$('conversations').addEventListener('scroll', closeConvMenu, { passive: true })
$('starred-conversations').addEventListener('scroll', closeConvMenu, { passive: true })

/** 行内重命名：Enter 保存，Esc 取消，失焦保存。 */
function startRename(conv, titleEl) {
  if (streaming) return
  const input = document.createElement('input')
  input.className = 'conv-rename'
  input.maxLength = 60
  input.placeholder = '会话名称'
  input.value = conv.title === '新对话' ? '' : conv.title
  titleEl.replaceWith(input)
  input.focus()
  input.select()

  let settled = false
  const finish = async (save) => {
    if (settled) return
    settled = true
    const next = input.value.trim()
    if (!save || next.length === 0 || next === conv.title) {
      renderSidebar()
      return
    }
    try {
      if (conv.id !== null) {
        await api(`/sv/api/sessions/${encodeURIComponent(conv.id)}`, { method: 'PATCH', body: { title: next } })
      }
      conv.title = next
      saveConversations()
    } catch (error) {
      alert(`重命名失败：${error?.message ?? error}`)
    }
    renderSidebar()
  }

  input.addEventListener('click', event => event.stopPropagation())
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void finish(true)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      void finish(false)
    }
  })
  input.addEventListener('blur', () => void finish(true))
}

/** 通用确认弹窗：点击确定返回 true；取消、Esc、点击遮罩返回 false。 */
function askConfirm({ title, text, okText = '确定', cancelText = '取消' }) {
  const dialog = $('confirm-dialog')
  $('confirm-title').textContent = title
  $('confirm-text').textContent = text
  $('confirm-ok').textContent = okText
  $('confirm-cancel').textContent = cancelText
  return new Promise((resolve) => {
    let confirmed = false
    dialog.addEventListener('close', () => resolve(confirmed), { once: true })
    $('confirm-ok').onclick = () => {
      confirmed = true
      dialog.close()
    }
    $('confirm-cancel').onclick = () => dialog.close()
    // 点击弹窗外区域视为取消
    dialog.onclick = (event) => {
      if (event.target === dialog) dialog.close()
    }
    dialog.showModal()
    // 危险操作默认聚焦“取消”，避免误触
    $('confirm-cancel').focus()
  })
}

/** 删除会话（本地 + 服务端索引/记录）。 */
async function deleteConversation(conv) {
  if (streaming) return
  const label = conv.title || '新对话'
  const confirmed = await askConfirm({
    title: '删除会话',
    text: `「${label}」将从此设备与服务端记录中移除，此操作不可恢复。`,
    okText: '删除',
  })
  if (!confirmed) return
  if (conv.id !== null) {
    try {
      await api(`/sv/api/sessions/${encodeURIComponent(conv.id)}`, { method: 'DELETE' })
    } catch (error) {
      alert(`删除失败：${error?.message ?? error}`)
      return
    }
  }
  const index = conversations.indexOf(conv)
  if (index >= 0) conversations.splice(index, 1)
  if (conv.id !== null && activeId === conv.id) {
    const next = conversations[0]
    activeId = next?.id ?? null
    if (activeId === null) localStorage.removeItem(ACTIVE_KEY)
    else localStorage.setItem(ACTIVE_KEY, activeId)
  }
  saveConversations()
  renderSidebar()
  renderMessages()
}

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** 极简 Markdown 渲染：围栏代码、行内代码、粗体、链接、标题、表格、引用、列表、段落。 */
function renderMarkdown(text) {
  const fences = []
  let s = escapeHtml(text ?? '')
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const index = fences.length
    fences.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`)
    return `\u0000fence${index}\u0000`
  })
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')

  const lines = s.split('\n')
  const out = []
  const isFence = line => /^\u0000fence\d+\u0000$/.test(line.trim())
  const isTableSeparator = line => line.includes('|') && line.includes('-') && /^[\s|:-]+$/.test(line)
  const splitRow = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      i++
      continue
    }
    if (isFence(trimmed)) {
      out.push(trimmed)
      i++
      continue
    }
    // 表格：当前行 + 分隔行
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitRow(line)
      i += 2
      const rows = []
      while (i < lines.length && lines[i].trim().length > 0 && lines[i].includes('|')) {
        rows.push(splitRow(lines[i]))
        i++
      }
      const head = `<tr>${header.map(cell => `<th>${cell}</th>`).join('')}</tr>`
      const body = rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')
      out.push(`<table><thead>${head}</thead><tbody>${body}</tbody></table>`)
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed)
    if (heading !== null) {
      const level = heading[1].length
      out.push(`<h${level}>${heading[2].trim()}</h${level}>`)
      i++
      continue
    }
    if (/^&gt;\s?/.test(trimmed)) {
      const quoted = []
      while (i < lines.length && /^&gt;\s?/.test(lines[i].trim())) {
        quoted.push(lines[i].trim().replace(/^&gt;\s?/, ''))
        i++
      }
      out.push(`<blockquote><p>${quoted.join('<br>')}</p></blockquote>`)
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(`<li>${lines[i].replace(/^\s*[-*]\s+/, '')}</li>`)
        i++
      }
      out.push(`<ul>${items.join('')}</ul>`)
      continue
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(`<li>${lines[i].replace(/^\s*\d+[.)]\s+/, '')}</li>`)
        i++
      }
      out.push(`<ol>${items.join('')}</ol>`)
      continue
    }
    const paragraph = []
    while (i < lines.length && lines[i].trim().length > 0
      && !isFence(lines[i].trim())
      && !/^(#{1,6})\s+/.test(lines[i].trim())
      && !/^&gt;\s?/.test(lines[i].trim())
      && !/^\s*[-*]\s+/.test(lines[i])
      && !/^\s*\d+[.)]\s+/.test(lines[i])
      && !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))) {
      paragraph.push(lines[i].trim())
      i++
    }
    if (paragraph.length === 0) {
      i++
      continue
    }
    out.push(`<p>${paragraph.join('<br>')}</p>`)
  }

  let html = out.join('')
  html = html.replace(/\u0000fence(\d+)\u0000/g, (_m, index) => fences[Number(index)] ?? '')
  return html
}

function messageNode(message) {
  const wrap = document.createElement('div')
  wrap.className = `msg ${message.role}`

  const avatar = document.createElement('span')
  avatar.className = 'avatar'
  avatar.textContent = message.role === 'user' ? '你' : 'SV'
  wrap.appendChild(avatar)

  const bubble = document.createElement('div')
  bubble.className = 'bubble'

  const who = document.createElement('div')
  who.className = 'who'
  who.textContent = message.role === 'user' ? '你' : 'Singularity Voyage'
  bubble.appendChild(who)

  const content = document.createElement('div')
  content.className = 'content'

  if (message.error) {
    const note = document.createElement('div')
    note.className = 'error-note'
    note.textContent = message.error
    content.appendChild(note)
  }

  if (message.tools && message.tools.length > 0) {
    const panel = document.createElement('div')
    panel.className = 'trace-panel'
    SvTrace.render(panel, message.tools)
    content.appendChild(panel)
  }

  if (message.reasoning && message.reasoning.trim().length > 0) {
    const details = document.createElement('details')
    details.className = 'reasoning'
    const summary = document.createElement('summary')
    summary.textContent = '思考过程'
    const body = document.createElement('div')
    body.textContent = message.reasoning
    details.appendChild(summary)
    details.appendChild(body)
    content.appendChild(details)
  }

  const body = document.createElement('div')
  body.className = 'text-body'
  body.innerHTML = renderMarkdown(message.text ?? '')
  if (message.streaming && !(message.text ?? '').length) {
    body.innerHTML = '<span class="caret"></span>'
  } else if (message.streaming) {
    body.insertAdjacentHTML('beforeend', '<span class="caret"></span>')
  }
  content.appendChild(body)

  bubble.appendChild(content)
  wrap.appendChild(bubble)
  return wrap
}

function renderMessages() {
  const container = $('messages')
  container.innerHTML = ''
  const conv = activeConversation() ?? conversations[0]
  if (!conv || conv.messages.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.innerHTML = `
      <h1>Singularity Voyage</h1>
      <div>全能 Agent 工作台 · 自定义模型与搜索 · 联网对话</div>
      <div class="hint-cards">
        <div class="hint-card" data-fill="帮我搜索一下本周 AI 领域的重要新闻，并给出摘要与来源">🔍 联网调研</div>
        <div class="hint-card" data-fill="用通俗的语言解释一下什么是 KV Cache">📖 概念讲解</div>
        <div class="hint-card" data-fill="写一个 Python 脚本：批量重命名当前目录下的图片文件">⚙️ 写个小工具</div>
      </div>`
    empty.querySelectorAll('.hint-card').forEach(card => {
      card.addEventListener('click', () => {
        $('input').value = card.dataset.fill ?? ''
        $('input').focus()
      })
    })
    container.appendChild(empty)
    return
  }
  const inner = document.createElement('div')
  inner.className = 'messages-inner'
  for (const message of conv.messages) inner.appendChild(messageNode(message))
  container.appendChild(inner)
  container.scrollTop = container.scrollHeight
}

function refreshActiveMessage() {
  const conv = activeConversation() ?? conversations[0]
  if (!conv) return
  const container = $('messages')
  const inner = container.querySelector('.messages-inner')
  if (!inner) { renderMessages(); return }
  const count = inner.children.length
  if (count === 0 || conv.messages.length === 0) { renderMessages(); return }
  // 只重绘最后一条（流式中的 assistant 消息）
  const last = conv.messages[conv.messages.length - 1]
  if (inner.children[count - 1] && inner.children[count - 1].className.includes(last.role)) {
    inner.replaceChild(messageNode(last), inner.children[count - 1])
  } else {
    inner.appendChild(messageNode(last))
  }
  container.scrollTop = container.scrollHeight
}

/* ── 状态与设置 ───────────────────────────────────────── */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
  return json
}

async function loadState() {
  try {
    const state = await api('/sv/api/state')
    const modelChip = $('chip-model')
    modelChip.textContent = state.llm?.model ?? '…'
    modelChip.className = 'chip'
    const searchChip = $('chip-search')
    searchChip.textContent = state.search?.hasApiKey ? `搜索 ${state.search?.provider ?? ''} ✓` : '搜索 ✕'
    searchChip.className = 'chip ' + (state.search?.hasApiKey ? 'on' : 'off')
    renderMailQuick(state.mail)
    return state
  } catch (error) {
    $('chip-model').textContent = '离线'
    $('chip-model').className = 'chip off'
    renderMailQuick(null)
    return null
  }
}

/** 最近一次读取到的邮件配置（待办页快捷开关用）。 */
let mailState = null

/** 待办页顶部的邮件提醒摘要 + 开关状态。 */
function renderMailQuick(mail) {
  mailState = mail ?? null
  const toggle = $('mail-quick-toggle')
  const status = $('mail-quick-status')
  if (mail === null || mail === undefined) {
    toggle.checked = false
    status.textContent = '未连接'
    status.className = 'mail-quick-status'
    return
  }
  const configured = Boolean(mail.host && mail.hasPassword)
  toggle.checked = configured && mail.enabled === true
  if (!configured) {
    status.textContent = '未配置 SMTP，点「详细设置」填写'
    status.className = 'mail-quick-status warn'
    return
  }
  const parts = [`发给 ${mail.to || mail.user}`]
  if (mail.enabled !== true) parts.unshift('已关闭')
  parts.push(mail.notifyOnReminder === false ? '到期不发' : '到期即发')
  parts.push(mail.digestAt ? `摘要 ${mail.digestAt}（含逾期）` : '无摘要')
  status.textContent = parts.join(' · ')
  status.className = 'mail-quick-status' + (mail.enabled === true ? ' on' : '')
}

/** 各搜索提供方的默认根地址（切换提供方时回填，仍可手改）。 */
const SEARCH_PRESETS = {
  deepseek: 'https://api.deepseek.com',
  tavily: 'https://api.tavily.com',
  bocha: 'https://api.bochaai.com',
}

/** 最近一次读取到的搜索密钥配置状态（设置表单占位提示用）。 */
let searchHasApiKey = false

function fillSettingsForm(state) {
  $('cfg-theme').value = preferredTheme()
  $('cfg-llm-provider').value = state.llm?.provider ?? 'custom'
  $('cfg-llm-base').value = state.llm?.baseURL ?? ''
  $('cfg-llm-model').value = state.llm?.model ?? ''
  $('cfg-llm-ctx').value = state.llm?.contextWindow ?? ''
  $('cfg-llm-max').value = state.llm?.maxTokens ?? ''
  $('cfg-llm-key').value = ''
  $('cfg-llm-key').placeholder = state.llm?.hasApiKey ? '已配置（留空表示不修改）' : '未配置'
  $('cfg-search-provider').value = state.search?.provider ?? 'deepseek'
  $('cfg-search-base').value = state.search?.baseURL ?? ''
  $('cfg-search-key').value = ''
  searchHasApiKey = state.search?.hasApiKey === true
  applySearchKeyPlaceholder()
  $('cfg-search-freshness').value = state.search?.freshness ?? 'noLimit'
  $('cfg-search-retry').value = state.search?.retryAttempts ?? ''
  $('cfg-search-timeout').value = state.search?.timeoutMs ?? ''
  $('cfg-search-budget').value = state.search?.budgetMs ?? ''
  $('cfg-mail-enabled').checked = state.mail?.enabled === true
  $('cfg-mail-host').value = state.mail?.host ?? ''
  $('cfg-mail-port').value = state.mail?.port ?? 465
  $('cfg-mail-secure').value = state.mail?.secure === false ? 'starttls' : 'ssl'
  $('cfg-mail-user').value = state.mail?.user ?? ''
  $('cfg-mail-pass').value = ''
  $('cfg-mail-pass').placeholder = state.mail?.hasPassword ? '已配置（留空表示不修改）' : '未配置'
  $('cfg-mail-from').value = state.mail?.from ?? ''
  $('cfg-mail-to').value = state.mail?.to ?? ''
  $('cfg-mail-reminder').checked = state.mail?.notifyOnReminder !== false
  const digestAt = state.mail?.digestAt ?? ''
  $('cfg-mail-digest-enabled').checked = digestAt.length > 0
  $('cfg-mail-digest').value = digestAt.length > 0 ? digestAt : '08:30'
  $('cfg-mail-digest').disabled = digestAt.length === 0
  $('test-mail-result').textContent = ''
  syncSearchProviderUI()
  const list = $('model-list')
  list.innerHTML = ''
  for (const id of state.models ?? []) {
    const option = document.createElement('option')
    option.value = id
    list.appendChild(option)
  }
  if (state.modelsError) {
    $('test-llm-result').textContent = state.modelsError
    $('test-llm-result').className = 'test-result err'
  } else {
    $('test-llm-result').textContent = ''
  }
  $('test-search-result').textContent = ''
  $('settings-error').textContent = ''
}

/** 搜索密钥输入框占位：DeepSeek 官方搜索默认复用模型 Key。 */
function applySearchKeyPlaceholder() {
  const provider = $('cfg-search-provider').value
  $('cfg-search-key').placeholder = provider === 'deepseek'
    ? '留空即复用上方模型 API Key'
    : searchHasApiKey
      ? '已配置（留空表示不修改）'
      : (provider === 'bocha' ? '未配置（env: BOCHA_API_KEY）' : '未配置（env: SV_SEARCH_API_KEY）')
}

/** 按提供方切换搜索设置：回填默认根地址，博查显示时效过滤。 */
function syncSearchProviderUI() {
  const provider = $('cfg-search-provider').value
  const base = $('cfg-search-base')
  const current = base.value.trim().replace(/\/+$/, '')
  // 只在空或仍是某个提供方预设默认值时回填，保留用户手填的地址
  if (current.length === 0 || Object.values(SEARCH_PRESETS).includes(current)) {
    base.value = SEARCH_PRESETS[provider] ?? ''
  }
  $('cfg-search-freshness-field').hidden = provider !== 'bocha'
  applySearchKeyPlaceholder()
}

/** 切换 LLM 预设：非 custom 时回填该供应商默认端点与模型（仍可手改）。 */
function syncLlmProviderUI() {
  const preset = LLM_PRESETS[$('cfg-llm-provider').value]
  if (preset) {
    $('cfg-llm-base').value = preset.baseURL
    $('cfg-llm-model').value = preset.model
  }
}

async function saveSettings() {
  const body = {
    llm: {
      provider: $('cfg-llm-provider').value,
      baseURL: $('cfg-llm-base').value.trim(),
      model: $('cfg-llm-model').value.trim(),
    },
    search: {
      provider: $('cfg-search-provider').value,
      baseURL: $('cfg-search-base').value.trim(),
    },
  }
  body.search.freshness = $('cfg-search-provider').value === 'bocha' ? $('cfg-search-freshness').value : null
  if ($('cfg-llm-key').value.trim().length > 0) body.llm.apiKey = $('cfg-llm-key').value.trim()
  if ($('cfg-search-key').value.trim().length > 0) body.search.apiKey = $('cfg-search-key').value.trim()
  const ctx = $('cfg-llm-ctx').value.trim()
  const max = $('cfg-llm-max').value.trim()
  if (ctx.length > 0) body.llm.contextWindow = Number(ctx)
  if (ctx.length === 0) body.llm.contextWindow = null
  if (max.length > 0) body.llm.maxTokens = Number(max)
  if (max.length === 0) body.llm.maxTokens = null
  for (const [key, id] of [['retryAttempts', 'cfg-search-retry'], ['timeoutMs', 'cfg-search-timeout'], ['budgetMs', 'cfg-search-budget']]) {
    const raw = $(id).value.trim()
    body.search[key] = raw.length > 0 ? Number(raw) : null
  }
  const mailSecure = $('cfg-mail-secure').value === 'ssl'
  body.mail = {
    enabled: $('cfg-mail-enabled').checked,
    host: $('cfg-mail-host').value.trim(),
    port: Number($('cfg-mail-port').value.trim() || (mailSecure ? 465 : 587)),
    secure: mailSecure,
    user: $('cfg-mail-user').value.trim(),
    from: $('cfg-mail-from').value.trim(),
    to: $('cfg-mail-to').value.trim(),
    notifyOnReminder: $('cfg-mail-reminder').checked,
    digestAt: $('cfg-mail-digest-enabled').checked
      ? ($('cfg-mail-digest').value.trim() || '08:30')
      : '',
  }
  if ($('cfg-mail-pass').value.trim().length > 0) body.mail.password = $('cfg-mail-pass').value.trim()

  try {
    await api('/sv/api/config', { method: 'POST', body })
    $('settings').close()
    await loadState()
  } catch (error) {
    $('settings-error').textContent = error.message ?? String(error)
  }
}

async function runTest(target) {
  const result = $({ llm: 'test-llm-result', search: 'test-search-result', mail: 'test-mail-result' }[target])
  result.textContent = '测试中…'
  result.className = 'test-result'
  try {
    const res = await api('/sv/api/test', { method: 'POST', body: { target } })
    if (res.ok) {
      result.className = 'test-result ok'
      result.textContent = target === 'llm'
        ? `连通成功，${res.models.length} 个模型`
        : target === 'mail' ? '测试邮件已发送，请查收' : '连通成功'
    } else {
      result.className = 'test-result err'
      result.textContent = res.error ?? '失败'
    }
  } catch (error) {
    result.className = 'test-result err'
    result.textContent = error.message ?? String(error)
  }
}

/* ── 对话发送（SSE） ─────────────────────────────────── */

function ensureConversation() {
  let conv = activeConversation()
  if (!conv) {
    if (conversations.length > 0 && conversations[0].id === null) conv = conversations[0]
    else {
      conv = { id: null, title: '新对话', messages: [], updatedAt: Date.now() }
      conversations.unshift(conv)
    }
  }
  return conv
}

function setStreaming(value) {
  streaming = value
  $('send').hidden = value
  $('stop').hidden = !value
  $('topbar-status').textContent = value ? '● 生成中' : ''
  $('topbar-status').className = 'topbar-status' + (value ? ' running' : '')
}

async function sendMessage() {
  const input = $('input')
  const text = input.value.trim()
  if (!text || streaming) return

  const conv = ensureConversation()
  conv.messages.push({ role: 'user', text })
  if (conv.title === '新对话') conv.title = text.slice(0, 24)
  conv.updatedAt = Date.now()
  input.value = ''
  autosize()
  renderMessages()
  saveConversations()
  renderSidebar()

  const assistant = { role: 'assistant', text: '', reasoning: '', tools: [], streaming: true }
  conv.messages.push(assistant)
  refreshActiveMessage()
  setStreaming(true)

  let sessionId = conv.id
  try {
    const res = await fetch('/sv/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sessionId ? { sessionId, text } : { text }),
    })
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error ?? `HTTP ${res.status}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let carry = ''
    let done = false

    while (!done) {
      const { value, done: readerDone } = await reader.read()
      if (readerDone) break
      carry += decoder.decode(value, { stream: true })
      let boundary
      while ((boundary = carry.indexOf('\n\n')) >= 0) {
        const frame = carry.slice(0, boundary)
        carry = carry.slice(boundary + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          let event
          try {
            event = JSON.parse(line.slice(5).trim())
          } catch {
            continue
          }
          handleEvent(conv, assistant, event)
          if (event.type === 'done') done = true
        }
      }
    }
  } catch (error) {
    assistant.error = assistant.error ?? `连接失败：${error.message ?? String(error)}`
  } finally {
    assistant.streaming = false
    conv.updatedAt = Date.now()
    conversations.sort((a, b) => b.updatedAt - a.updatedAt)
    saveConversations()
    renderSidebar()
    renderMessages()
    setStreaming(false)
    input.focus()
  }
}

function handleEvent(conv, assistant, event) {
  switch (event.type) {
    case 'session':
      if (conv.id !== event.sessionId) {
        conv.id = event.sessionId
        activeId = event.sessionId
        localStorage.setItem(ACTIVE_KEY, event.sessionId)
        saveConversations()
      }
      break
    case 'text-delta':
      assistant.text += event.text
      refreshActiveMessage()
      break
    case 'reasoning-delta':
      assistant.reasoning += event.text
      refreshActiveMessage()
      break
    case 'tool': {
      if (event.phase === 'start') {
        assistant.tools.push({ callId: event.callId, name: event.name, phase: 'start', args: event.args })
      } else {
        const pending = event.callId !== undefined
          ? assistant.tools.find(t => t.callId === event.callId && t.phase !== 'end')
          : undefined
        if (pending) {
          pending.phase = 'end'
          pending.isError = event.isError
          pending.result = event.result
          pending.durationMs = event.durationMs
        } else {
          assistant.tools.push({
            callId: event.callId, name: event.name, phase: 'end',
            isError: event.isError, result: event.result, durationMs: event.durationMs,
          })
        }
      }
      refreshActiveMessage()
      break
    }
    case 'message':
      assistant.text = event.text
      assistant.reasoning = event.reasoning || assistant.reasoning
      refreshActiveMessage()
      break
    case 'usage':
      conv.usage = event.usage
      saveConversations()
      if (conv === activeConversation()) renderUsage(event.usage)
      break
    case 'status':
      $('topbar-status').textContent = event.status === 'running' ? '● 生成中' : ''
      break
    case 'error':
      assistant.error = event.message
      refreshActiveMessage()
      break
    case 'done':
      assistant.streaming = false
      break
  }
}

async function stopStreaming() {
  const conv = activeConversation()
  if (!conv || !conv.id) return
  try {
    await api('/sv/api/stop', { method: 'POST', body: { sessionId: conv.id } })
  } catch {
    // 忽略：会话可能尚未建立
  }
}

/* ── 待办与提醒 ───────────────────────────────────────── */

const MEMORY_KIND_LABELS = { fact: '事实', preference: '偏好', person: '人物', project: '项目', decision: '决定' }

function fmtDue(ts) {
  return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

/** datetime-local 值 → epoch ms（本地时区）。 */
function localInputToMs(value) {
  if (!value) return undefined
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : undefined
}

async function loadTasks() {
  try {
    const { tasks } = await api(`/sv/api/tasks${$('tasks-show-done').checked ? '?done=1' : ''}`)
    tasksCache = Array.isArray(tasks) ? tasks : []
    renderTasks()
  } catch (error) {
    renderTasksError(error?.message ?? String(error))
  }
}

function renderTasksError(message) {
  const list = $('tasks-list')
  list.innerHTML = ''
  const empty = document.createElement('div')
  empty.className = 'panel-empty'
  empty.textContent = `加载失败：${message}`
  list.appendChild(empty)
}

function renderTasks() {
  const list = $('tasks-list')
  list.innerHTML = ''
  if (tasksCache.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'panel-empty'
    empty.textContent = '没有待办。对我说「提醒我明天 10 点交材料」即可创建。'
    list.appendChild(empty)
    updateOverdueBadge(0)
    return
  }
  const now = Date.now()
  let overdue = 0
  for (const task of tasksCache) {
    if (task.status === 'pending' && task.dueAt !== undefined && task.dueAt <= now) overdue += 1
    list.appendChild(taskNode(task))
  }
  updateOverdueBadge(overdue)
}

function updateOverdueBadge(count) {
  overdueCount = count
  const tab = $('tab-tasks')
  tab.querySelector('.dot')?.remove()
  if (count > 0) {
    const dot = document.createElement('span')
    dot.className = 'dot'
    tab.appendChild(dot)
  }
}

function taskNode(task) {
  const el = document.createElement('div')
  el.className = 'task-item'
  const done = task.status !== 'pending'
  if (done) el.classList.add('done')
  const overdue = task.status === 'pending' && task.dueAt !== undefined && task.dueAt <= Date.now()
  if (overdue) el.classList.add('overdue')

  const check = document.createElement('input')
  check.type = 'checkbox'
  check.className = 'task-check'
  check.checked = done
  check.addEventListener('change', () => {
    void patchTask(task.id, done ? { status: 'pending' } : { status: 'done' })
  })

  const main = document.createElement('div')
  main.className = 'task-main'
  const title = document.createElement('div')
  title.className = 'task-title'
  title.textContent = task.title
  main.appendChild(title)

  const meta = document.createElement('div')
  meta.className = 'task-meta'
  const bits = []
  if (task.dueAt !== undefined) bits.push(`<span class="due">${overdue ? '已逾期 · ' : ''}${fmtDue(task.dueAt)}</span>`)
  if (task.recurrence === 'daily') bits.push('<span>每天</span>')
  if (task.recurrence === 'weekly') bits.push('<span>每周</span>')
  if (done && task.completedAt !== undefined) bits.push(`<span>完成于 ${fmtDue(task.completedAt)}</span>`)
  meta.innerHTML = bits.join('')
  if (meta.childNodes.length > 0) main.appendChild(meta)
  if (task.notes) {
    const notes = document.createElement('div')
    notes.className = 'task-meta'
    notes.textContent = task.notes
    main.appendChild(notes)
  }
  el.append(check, main)

  const actions = document.createElement('div')
  actions.className = 'task-actions'
  if (!done) {
    const snooze = document.createElement('button')
    snooze.type = 'button'
    snooze.className = 'panel-act'
    snooze.title = '推迟 10 分钟'
    snooze.textContent = '⏱'
    snooze.addEventListener('click', () => void patchTask(task.id, { snoozeMinutes: 10 }))
    actions.appendChild(snooze)
  }
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'panel-act danger'
  remove.title = '删除'
  remove.textContent = '✕'
  remove.addEventListener('click', () => void deleteTask(task.id))
  actions.appendChild(remove)
  el.appendChild(actions)
  return el
}

async function patchTask(id, patch) {
  try {
    await api(`/sv/api/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch })
  } catch (error) {
    alert(`操作失败：${error?.message ?? error}`)
  }
  await loadTasks()
}

async function deleteTask(id) {
  if (!confirm('删除这条待办？')) return
  try {
    await api(`/sv/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' })
  } catch (error) {
    alert(`删除失败：${error?.message ?? error}`)
  }
  await loadTasks()
}

async function submitTask(event) {
  event.preventDefault()
  const title = $('task-title').value.trim()
  if (!title) return
  const dueMs = localInputToMs($('task-due').value)
  const body = { title }
  if (dueMs !== undefined) body.dueAt = dueMs
  if ($('task-recurrence').value !== 'none') body.recurrence = $('task-recurrence').value
  try {
    await api('/sv/api/tasks', { method: 'POST', body })
    $('task-title').value = ''
    $('task-due').value = ''
    $('task-recurrence').value = 'none'
  } catch (error) {
    alert(`添加失败：${error?.message ?? error}`)
  }
  await loadTasks()
}

/* ── 定时任务（harness schedule） ───────────────────────── */

/** 规则种类 → 中文标签。 */
const SCHEDULE_KINDS = { after: '一次性', at: '一次性', every: '固定间隔', daily: '每天', weekly: '每周', cron: 'cron' }

async function loadSchedules() {
  try {
    const { schedules } = await api('/sv/api/schedules')
    schedulesCache = Array.isArray(schedules) ? schedules : []
    renderSchedules()
  } catch (error) {
    const list = $('schedules-list')
    list.innerHTML = ''
    const empty = document.createElement('div')
    empty.className = 'panel-empty'
    empty.textContent = `加载失败：${error?.message ?? String(error)}`
    list.appendChild(empty)
  }
}

function renderSchedules() {
  const list = $('schedules-list')
  list.innerHTML = ''
  if (schedulesCache.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'panel-empty'
    empty.textContent = '没有定时任务。对我说「10 秒后提醒我喝水」即可创建。'
    list.appendChild(empty)
    return
  }
  for (const entry of schedulesCache) list.appendChild(scheduleNode(entry))
}

function scheduleNode(entry) {
  const el = document.createElement('div')
  el.className = 'task-item'
  if (entry.status !== 'active') el.classList.add('done')

  const main = document.createElement('div')
  main.className = 'task-main'
  const title = document.createElement('div')
  title.className = 'task-title'
  title.textContent = entry.title ?? entry.id
  main.appendChild(title)

  const meta = document.createElement('div')
  meta.className = 'task-meta'
  const at = Date.parse(entry.scheduledAt)
  const bits = []
  const when = Number.isFinite(at) ? fmtDue(at) : entry.scheduledAt
  if (entry.status !== 'active') bits.push(`<span>已结束 · ${when}</span>`)
  else if (entry.state === 'overdue') bits.push(`<span class="due">已逾期 · ${when}</span>`)
  else bits.push(`<span>${when}</span>`)
  bits.push(`<span>${SCHEDULE_KINDS[entry.kind] ?? entry.kind}</span>`)
  if (entry.lastDelivery?.deliveredAt) {
    const delivered = Date.parse(entry.lastDelivery.deliveredAt)
    bits.push(`<span>投递于 ${Number.isFinite(delivered) ? fmtDue(delivered) : entry.lastDelivery.deliveredAt}</span>`)
  }
  meta.innerHTML = bits.join('')
  main.appendChild(meta)

  if (entry.prompt) {
    const prompt = document.createElement('div')
    prompt.className = 'task-meta'
    prompt.textContent = entry.prompt
    main.appendChild(prompt)
  }
  el.appendChild(main)

  const actions = document.createElement('div')
  actions.className = 'task-actions'
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'panel-act danger'
  remove.title = '删除（取消后续投递）'
  remove.textContent = '✕'
  remove.addEventListener('click', () => void deleteSchedule(entry.id))
  actions.appendChild(remove)
  el.appendChild(actions)
  return el
}

async function deleteSchedule(id) {
  if (!confirm('删除这条定时任务？删除后不会再投递，已进入会话的消息不受影响。')) return
  try {
    await api(`/sv/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' })
  } catch (error) {
    alert(`删除失败：${error?.message ?? error}`)
  }
  await loadSchedules()
}

/* ── 记忆 ─────────────────────────────────────────────── */

async function loadMemories() {
  try {
    const { memories } = await api('/sv/api/memories')
    memoriesCache = Array.isArray(memories) ? memories : []
    renderMemories()
  } catch (error) {
    const list = $('memory-list')
    list.innerHTML = ''
    const empty = document.createElement('div')
    empty.className = 'panel-empty'
    empty.textContent = `加载失败：${error?.message ?? error}`
    list.appendChild(empty)
  }
}

function renderMemories() {
  const list = $('memory-list')
  list.innerHTML = ''
  const keyword = $('memory-search').value.trim().toLowerCase()
  const visible = memoriesCache.filter(m => {
    if (memoryKindFilter && m.kind !== memoryKindFilter) return false
    if (keyword && !(`${m.text} ${(m.tags ?? []).join(' ')}`.toLowerCase().includes(keyword))) return false
    return true
  })
  if (visible.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'panel-empty'
    empty.textContent = memoriesCache.length === 0
      ? '还没有记忆。对话中提到的偏好与事实会自动记住，也可以在上方手动添加。'
      : '没有匹配的记忆。'
    list.appendChild(empty)
    return
  }
  for (const memory of visible) list.appendChild(memoryNode(memory))
}

function memoryNode(memory) {
  const el = document.createElement('div')
  el.className = 'memory-item'
  el.dataset.id = memory.id

  const kind = document.createElement('span')
  kind.className = 'memory-kind-tag'
  kind.textContent = MEMORY_KIND_LABELS[memory.kind] ?? memory.kind
  el.appendChild(kind)

  const main = document.createElement('div')
  main.className = 'memory-main'
  const text = document.createElement('div')
  text.className = 'memory-text'
  text.textContent = memory.text
  main.appendChild(text)

  const meta = document.createElement('div')
  meta.className = 'memory-meta'
  const bits = [`更新于 ${new Date(memory.updatedAt).toLocaleDateString('zh-CN')}`, `置信度 ${(memory.confidence * 100).toFixed(0)}%`]
  meta.innerHTML = bits.map(bit => `<span>${escapeHtml(bit)}</span>`).join('')
  if (Array.isArray(memory.tags) && memory.tags.length > 0) {
    const tags = document.createElement('span')
    tags.className = 'memory-tags'
    for (const tag of memory.tags.slice(0, 5)) {
      const chip = document.createElement('span')
      chip.className = 'memory-tag'
      chip.textContent = tag
      tags.appendChild(chip)
    }
    meta.appendChild(tags)
  }
  main.appendChild(meta)
  el.appendChild(main)

  const actions = document.createElement('div')
  actions.className = 'memory-actions'
  const edit = document.createElement('button')
  edit.type = 'button'
  edit.className = 'panel-act'
  edit.title = '编辑'
  edit.textContent = '✎'
  edit.addEventListener('click', () => startMemoryEdit(el, memory))
  const forget = document.createElement('button')
  forget.type = 'button'
  forget.className = 'panel-act danger'
  forget.title = '忘记'
  forget.textContent = '✕'
  forget.addEventListener('click', () => void forgetMemory(memory.id))
  actions.append(edit, forget)
  el.appendChild(actions)
  return el
}

/** 就地编辑记忆文本：Enter 保存，Esc 取消。 */
function startMemoryEdit(el, memory) {
  if (el.classList.contains('editing')) return
  el.classList.add('editing')
  const input = document.createElement('textarea')
  input.className = 'memory-edit'
  input.rows = 2
  input.value = memory.text
  const textEl = el.querySelector('.memory-text')
  textEl.after(input)
  input.focus()

  const finish = async (save) => {
    if (input.dataset.done) return
    input.dataset.done = '1'
    const next = input.value.trim()
    el.classList.remove('editing')
    input.remove()
    if (!save || next.length === 0 || next === memory.text) return
    try {
      await api(`/sv/api/memories/${encodeURIComponent(memory.id)}`, { method: 'PATCH', body: { text: next } })
    } catch (error) {
      alert(`保存失败：${error?.message ?? error}`)
    }
    await loadMemories()
  }
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void finish(true)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      void finish(false)
    }
  })
  input.addEventListener('blur', () => void finish(true))
}

async function forgetMemory(id) {
  if (!confirm('忘记这条记忆？删除后将不再影响回答。')) return
  try {
    await api(`/sv/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE' })
  } catch (error) {
    alert(`删除失败：${error?.message ?? error}`)
  }
  await loadMemories()
}

async function submitMemory(event) {
  event.preventDefault()
  const text = $('memory-text').value.trim()
  if (!text) return
  try {
    await api('/sv/api/memories', { method: 'POST', body: { kind: $('memory-kind').value, text } })
    $('memory-text').value = ''
  } catch (error) {
    alert(`添加失败：${error?.message ?? error}`)
  }
  await loadMemories()
}

/* ── 日志 ─────────────────────────────────────────────── */

let logLevelFilter = ''
let logTimer = null
let logFilesRendered = ''
let logPage = 1

const LOG_FOLLOW_MS = 2000
const LOG_PAGE_SIZE = 50
const LOG_LEVEL_LABELS = { error: '错误', warn: '警告', info: '信息' }
/** sv-app 日志行前缀：`YYYY-MM-DD HH:mm:ss 正文`。 */
const LOG_TIME_RE = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s?([\s\S]*)$/

async function loadLogs() {
  const params = new URLSearchParams({
    page: String(logPage),
    pageSize: String(LOG_PAGE_SIZE),
  })
  // 未选文件时不传 file，由服务端默认读取最新的日志文件
  const file = $('log-file').value
  if (file) params.set('file', file)
  if (logLevelFilter) params.set('level', logLevelFilter)
  const keyword = $('log-search').value.trim()
  if (keyword) params.set('q', keyword)
  try {
    const data = await api(`/sv/api/logs?${params.toString()}`)
    renderLogFiles(data.files ?? [], data.file)
    renderLogs(data)
  } catch (error) {
    const body = $('log-body')
    body.innerHTML = ''
    body.appendChild(logEmptyRow(`加载日志失败：${error?.message ?? error}`))
    $('log-meta').textContent = ''
    $('log-page-info').textContent = ''
  }
}

/** 文件下拉只在清单变化时重建，避免每次刷新丢失选择。 */
function renderLogFiles(files, current) {
  const key = files.length === 0 ? '-' : files.map(file => file.name).join('|')
  const select = $('log-file')
  if (key !== logFilesRendered) {
    logFilesRendered = key
    select.innerHTML = ''
    for (const file of files) {
      const option = document.createElement('option')
      option.value = file.name
      option.textContent = `${file.name}（${formatBytes(file.size)}）`
      select.appendChild(option)
    }
    if (files.length === 0) {
      const option = document.createElement('option')
      option.value = ''
      option.textContent = '暂无日志文件'
      select.appendChild(option)
    }
  }
  // 选中态以服务端实际读取的文件为准（未指定时即最新的那个）
  if (current && files.some(file => file.name === current)) select.value = current
}

function logEmptyRow(text) {
  const row = document.createElement('tr')
  const cell = document.createElement('td')
  cell.colSpan = 3
  cell.className = 'log-empty'
  cell.textContent = text
  row.appendChild(cell)
  return row
}

/** 一行日志 → 表格行：时间 + 级别徽章 + 正文。 */
function logRow(line) {
  const row = document.createElement('tr')
  row.className = `log-row log-${line.level}`
  const match = LOG_TIME_RE.exec(String(line.text ?? ''))
  const time = document.createElement('td')
  time.className = 'log-col-time'
  time.textContent = match ? match[1] : '—'
  const level = document.createElement('td')
  level.className = 'log-col-level'
  const badge = document.createElement('span')
  badge.className = `log-level log-level-${line.level}`
  badge.textContent = LOG_LEVEL_LABELS[line.level] ?? line.level
  level.appendChild(badge)
  const text = document.createElement('td')
  text.className = 'log-col-text'
  text.textContent = match ? match[2] : line.text
  row.append(time, level, text)
  return row
}

function renderLogs(data) {
  const body = $('log-body')
  const lines = Array.isArray(data.lines) ? data.lines : []
  body.innerHTML = ''
  if (data.exists === false) {
    body.appendChild(logEmptyRow('日志文件不存在（服务尚未写入日志？）'))
  } else if (lines.length === 0) {
    body.appendChild(logEmptyRow('没有匹配的日志行。'))
  } else {
    const frag = document.createDocumentFragment()
    for (const line of lines) frag.appendChild(logRow(line))
    body.appendChild(frag)
  }

  const page = data.page ?? 1
  const pageSize = data.pageSize ?? LOG_PAGE_SIZE
  const matched = data.matched ?? 0
  const pages = Math.max(1, Math.ceil(matched / pageSize))
  $('log-page-info').textContent = `第 ${page} / ${pages} 页 · 共 ${matched} 条`
  $('log-prev').disabled = page <= 1
  $('log-next').disabled = page >= pages
  // 筛选后页数变少时回到第一页
  if (page > pages) {
    logPage = 1
    void loadLogs()
    return
  }

  const bits = []
  if (typeof data.matched === 'number') bits.push(`${data.matched} 条匹配 / 文件共 ${data.total ?? 0} 行`)
  if (typeof data.size === 'number') bits.push(formatBytes(data.size))
  if (data.mtime) bits.push(`更新于 ${new Date(data.mtime).toLocaleTimeString('zh-CN')}`)
  if (data.truncated) bits.push('仅读取文件尾部 8 MB')
  $('log-meta').textContent = bits.join(' · ')
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function startLogAutoRefresh() {
  stopLogAutoRefresh()
  if (!$('log-follow').checked) return
  logTimer = setInterval(() => {
    if (currentView !== 'logs' || document.hidden) return
    void loadLogs()
  }, LOG_FOLLOW_MS)
}

function stopLogAutoRefresh() {
  if (logTimer !== null) {
    clearInterval(logTimer)
    logTimer = null
  }
}

/* ── 提醒通知（SSE + Toast） ──────────────────────────── */

function connectReminders() {
  try {
    const es = new EventSource('/sv/api/events')
    es.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data)
        if (payload?.type === 'reminder' && payload.task) showReminderToast(payload.task)
      } catch { /* 忽略坏帧 */ }
    }
    es.onerror = () => {
      // 浏览器 EventSource 会自动重连；这里只需避免未处理告警
    }
  } catch {
    // 不支持 EventSource 时静默跳过（仍可在待办页看到逾期）
  }
}

function showReminderToast(task) {
  for (const node of document.querySelectorAll('.reminder-toast')) node.remove()
  const toast = document.createElement('div')
  toast.className = 'reminder-toast'
  const title = document.createElement('div')
  title.className = 'rt-title'
  title.textContent = `⏰ ${task.title}`
  toast.appendChild(title)
  const actions = document.createElement('div')
  actions.className = 'rt-actions'

  const doneBtn = document.createElement('button')
  doneBtn.type = 'button'
  doneBtn.className = 'btn btn-primary'
  doneBtn.textContent = '完成'
  doneBtn.addEventListener('click', () => {
    toast.remove()
    void patchTask(task.id, { status: 'done' })
  })
  const snoozeBtn = document.createElement('button')
  snoozeBtn.type = 'button'
  snoozeBtn.className = 'btn btn-ghost'
  snoozeBtn.textContent = '10 分钟后'
  snoozeBtn.addEventListener('click', () => {
    toast.remove()
    void patchTask(task.id, { snoozeMinutes: 10 })
  })
  const laterBtn = document.createElement('button')
  laterBtn.type = 'button'
  laterBtn.className = 'btn btn-ghost'
  laterBtn.textContent = '知道了'
  laterBtn.addEventListener('click', () => toast.remove())
  actions.append(doneBtn, snoozeBtn, laterBtn)
  toast.appendChild(actions)
  document.body.appendChild(toast)
  setTimeout(() => toast.remove(), 10 * 60 * 1000)
}

/* ── 输入框 ───────────────────────────────────────────── */

function autosize() {
  const input = $('input')
  // 与 #input 的 CSS min-height 保持一致：内容再少也保持两行高度
  const minHeight = 60
  const maxHeight = 200
  input.style.height = 'auto'
  input.style.height = `${Math.min(Math.max(input.scrollHeight, minHeight), maxHeight)}px`
}

/* ── 初始化 ───────────────────────────────────────────── */

$('new-chat').addEventListener('click', () => {
  if (streaming) return
  const blank = conversations.find(c => c.id === null && c.messages.length === 0)
  if (blank) {
    activeId = null
    localStorage.removeItem(ACTIVE_KEY)
    renderSidebar()
    renderMessages()
    $('input').focus()
  } else {
    newConversation()
  }
  applyView('chat')
})
$('send').addEventListener('click', sendMessage)
$('stop').addEventListener('click', stopStreaming)
$('input').addEventListener('input', autosize)
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    sendMessage()
  }
})
/** 窄屏抽屉：打开时显示遮罩，关闭时一并收起。 */
function isNarrow() {
  return window.matchMedia('(max-width: 720px)').matches
}
function setSidebarOpen(open) {
  $('sidebar').classList.toggle('open', open)
  $('sidebar-backdrop').classList.toggle('show', open && isNarrow())
}
$('toggle-sidebar').addEventListener('click', () => {
  if (isNarrow()) setSidebarOpen(!$('sidebar').classList.contains('open'))
  else $('sidebar').classList.toggle('collapsed')
})
$('sidebar-backdrop').addEventListener('click', () => setSidebarOpen(false))
/** 窄屏下选中视图后收起抽屉，避免继续遮挡主区。 */
function closeSidebarDrawer() {
  if (isNarrow()) setSidebarOpen(false)
}
document.querySelectorAll('.nav-item').forEach(item => {
  if (item.id === 'new-chat') return
  item.addEventListener('click', () => applyView(item.dataset.view ?? 'chat'))
})
$('task-form').addEventListener('submit', submitTask)
$('tasks-show-done').addEventListener('change', () => void loadTasks())
$('schedule-refresh').addEventListener('click', () => void loadSchedules())
$('memory-form').addEventListener('submit', submitMemory)
$('memory-search').addEventListener('input', renderMemories)
$('memory-kind-filter').addEventListener('click', (event) => {
  const chip = event.target.closest('.kchip')
  if (!chip) return
  memoryKindFilter = chip.dataset.kind ?? ''
  $('memory-kind-filter').querySelectorAll('.kchip').forEach(node => {
    node.classList.toggle('active', node === chip)
  })
  renderMemories()
})
$('log-refresh').addEventListener('click', () => void loadLogs())
$('log-file').addEventListener('change', () => {
  logPage = 1
  void loadLogs()
})
$('log-follow').addEventListener('change', () => {
  if ($('log-follow').checked) startLogAutoRefresh()
  else stopLogAutoRefresh()
})
$('log-prev').addEventListener('click', () => {
  if (logPage <= 1) return
  logPage -= 1
  void loadLogs()
})
$('log-next').addEventListener('click', () => {
  if ($('log-next').disabled) return
  logPage += 1
  void loadLogs()
})
$('log-level-filter').addEventListener('click', (event) => {
  const chip = event.target.closest('.kchip')
  if (!chip) return
  logLevelFilter = chip.dataset.level ?? ''
  $('log-level-filter').querySelectorAll('.kchip').forEach(node => {
    node.classList.toggle('active', node === chip)
  })
  logPage = 1
  void loadLogs()
})
let logSearchTimer = null
$('log-search').addEventListener('input', () => {
  if (logSearchTimer !== null) clearTimeout(logSearchTimer)
  logSearchTimer = setTimeout(() => {
    logPage = 1
    void loadLogs()
  }, 300)
})
async function openSettings() {
  const state = await loadState()
  if (state) fillSettingsForm(state)
  $('settings').showModal()
}
$('open-settings').addEventListener('click', openSettings)
$('mail-quick-settings').addEventListener('click', () => void openSettings())
// 待办页快捷开关：只改总开关，其余策略在设置弹窗里；未配置 SMTP 时引导去配置
$('mail-quick-toggle').addEventListener('change', async event => {
  const enabled = event.target.checked
  const mail = mailState ?? {}
  if (enabled && !(mail.host && mail.hasPassword)) {
    event.target.checked = false
    await openSettings()
    $('settings-error').textContent = '请先填写 SMTP 主机、账号与应用密码，再开启邮件提醒。'
    return
  }
  event.target.disabled = true
  try {
    await api('/sv/api/config', { method: 'POST', body: { mail: { enabled } } })
    await loadState()
  } catch (error) {
    event.target.checked = !enabled
    $('mail-quick-status').textContent = error.message ?? String(error)
    $('mail-quick-status').className = 'mail-quick-status warn'
  } finally {
    event.target.disabled = false
  }
})
$('cfg-mail-digest-enabled').addEventListener('change', () => {
  $('cfg-mail-digest').disabled = !$('cfg-mail-digest-enabled').checked
})
$('settings-cancel').addEventListener('click', () => $('settings').close())
// 点击弹窗外（backdrop 或 dialog 空白区域）关闭设置
$('settings').addEventListener('click', (event) => {
  if (event.target === $('settings')) $('settings').close()
})
$('cfg-search-provider').addEventListener('change', syncSearchProviderUI)
$('cfg-llm-provider').addEventListener('change', syncLlmProviderUI)
$('cfg-theme').addEventListener('change', () => applyTheme($('cfg-theme').value))
$('settings-save').addEventListener('click', saveSettings)
$('test-llm').addEventListener('click', () => runTest('llm'))
$('test-search').addEventListener('click', () => runTest('search'))
$('test-mail').addEventListener('click', () => runTest('mail'))
$('fetch-models').addEventListener('click', async () => {
  const state = await loadState()
  if (state) {
    fillSettingsForm(state)
    const list = $('model-list')
    list.innerHTML = ''
    for (const id of state.models ?? []) {
      const option = document.createElement('option')
      option.value = id
      list.appendChild(option)
    }
  }
})

const bootActiveId = localStorage.getItem(ACTIVE_KEY)
if (conversations.length === 0) newConversation()
else {
  if (activeId === null || !conversations.some(c => c.id === activeId)) {
    activeId = conversations[0].id
  }
  renderSidebar()
  renderMessages()
}
applyView(currentView)
if (bootActiveId && (activeConversation()?.messages.length ?? 0) === 0) {
  void hydrateConversation(bootActiveId)
}
// 从服务端索引补齐侧边栏（清缓存/换浏览器后仍能看到历史会话），必要时回填当前会话
void syncConversations().then(() => {
  const conv = activeConversation()
  if (conv !== null && conv.messages.length === 0) void hydrateConversation(conv.id)
})
loadState()
connectReminders()
// 进入待办视图前先拉一次，保证红点在任意视图下都可用
void loadTasks().then(() => {
  if (currentView !== 'tasks') applyView(currentView)
})
setStreaming(false)
autosize()
applyTheme()
