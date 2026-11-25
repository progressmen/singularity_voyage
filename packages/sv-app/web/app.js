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

/** 图片消息限制（与后端 /sv/api/chat 的校验保持一致）。 */
const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
/** 待发送图片：{ id, name, mediaType, data(base64), preview(objectURL) }。 */
let pendingImages = []
/** 宿主是否挂载了附件服务；未挂载时禁用图片入口。 */
let attachmentsSupported = false

/* ── 视图切换（对话 / 收件箱 / 知识 / 待办 / 定时任务 / 自动化 / 记忆 / 数据 / 日志） ───── */
const VIEW_KEY = 'sv.view.v1'
let currentView = localStorage.getItem(VIEW_KEY) ?? 'chat'
if (!['chat', 'superagent', 'inbox', 'approvals', 'knowledge', 'tasks', 'schedules', 'automations', 'connectors', 'memory', 'data', 'logs'].includes(currentView)) currentView = 'chat'

/** 「更多」分组：不常用入口折叠，活跃项在组内时自动展开。 */
const NAV_MORE_KEY = 'sv.nav.more'
const MORE_VIEWS = new Set(['superagent', 'schedules', 'automations', 'connectors', 'memory', 'data', 'logs'])
let navMoreExpanded = localStorage.getItem(NAV_MORE_KEY) === '1'

/** 非对话视图的顶栏标题。 */
const VIEW_TITLES = { superagent: 'Super Agent', inbox: '收件箱', approvals: '审批中心', knowledge: '个人知识', tasks: '待办与提醒', schedules: '定时任务', automations: '自动化', connectors: '连接器', memory: '长期记忆', data: '数据与备份', logs: '运行日志' }

/** 待办、定时任务与记忆数据缓存。 */
let tasksCache = []
let schedulesCache = []
let memoriesCache = []
let memoryKindFilter = ''
let overdueCount = 0
/** 收件箱缓存与过滤条件。 */
let inboxCache = []
let inboxKindFilter = ''
let inboxUnreadOnly = false
let inboxUnread = 0
/** 知识库缓存：文档列表、检索结果与当前打开的文档详情。 */
let knowledgeDocs = []
let knowledgeHits = []
let knowledgeQuery = ''
let knowledgeDetail = null
/** 自动化缓存与正在手动运行的 id。 */
let automationsCache = []
let automationRuns = []
let automationRunningId = null
/** 自动化全局设置（暂停 / 静默 / 重试）。 */
let automationConfig = { paused: false, quietStart: '', quietEnd: '', retryAttempts: 1 }
/** 会话全文检索的输入防抖与结果。 */
let convSearchTimer = null
/** 审批缓存：待处理与历史、未处理数量。 */
let approvalsPending = []
let approvalsHistory = []
let approvalPendingCount = 0
/** 连接器缓存与事件流。 */
let connectorsCache = []
let connectorEvents = []
let connectorEventsQuery = ''
let connectorRunningId = null

/** 展开/收起「更多」分组；persist=false 用于启动时恢复状态。 */
function setNavMore(expanded, persist = true) {
  navMoreExpanded = expanded
  const box = $('nav-more')
  const toggle = $('toggle-more-nav')
  if (box) box.hidden = !expanded
  if (toggle) {
    toggle.classList.toggle('expanded', expanded)
    toggle.setAttribute('aria-expanded', String(expanded))
  }
  if (persist) localStorage.setItem(NAV_MORE_KEY, expanded ? '1' : '0')
}

function applyView(view) {
  // Super-agent 未启用时导航项是隐藏的，避免停在不可用视图。
  if (view === 'superagent' && $('tab-superagent').hidden) view = 'chat'
  // 目标页在「更多」里时自动展开，避免用户切过去却看不到当前项。
  if (MORE_VIEWS.has(view)) setNavMore(true)
  hideSlashMenu()
  currentView = view
  localStorage.setItem(VIEW_KEY, view)
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.view === view)
  })
  $('messages').hidden = view !== 'chat'
  $('composer').hidden = view !== 'chat'
  $('panel-superagent').hidden = view !== 'superagent'
  $('panel-inbox').hidden = view !== 'inbox'
  $('panel-approvals').hidden = view !== 'approvals'
  $('panel-knowledge').hidden = view !== 'knowledge'
  $('panel-tasks').hidden = view !== 'tasks'
  $('panel-schedules').hidden = view !== 'schedules'
  $('panel-automations').hidden = view !== 'automations'
  $('panel-connectors').hidden = view !== 'connectors'
  $('panel-memory').hidden = view !== 'memory'
  $('panel-data').hidden = view !== 'data'
  $('panel-logs').hidden = view !== 'logs'
  $('topbar-title').textContent = VIEW_TITLES[view] ?? (activeConversation()?.title ?? '新对话')
  renderUsage(activeConversation()?.usage)
  renderFileRail()
  if (view === 'superagent') void loadSuperAgent()
  if (view === 'inbox') void loadInbox()
  if (view === 'approvals') void loadApprovals()
  if (view === 'knowledge') void loadKnowledge()
  if (view === 'tasks') void loadTasks()
  if (view === 'schedules') void loadSchedules()
  if (view === 'automations') void loadAutomations()
  if (view === 'connectors') void loadConnectors()
  if (view === 'memory') void loadMemories()
  if (view === 'data') void loadDataStatus()
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
  // 回到有排队消息的会话且当前空闲时，自动续发。
  if (!streaming && conv !== null) drainNextSend(conv)
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
    // 历史回填后重新扫描正文里的文件路径（空会话时可能已标记过）
    conv.filesScanned = false
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

/* ── 会话全文检索 ─────────────────────────────────────── */

/** 渲染检索结果下拉框。 */
function renderConvSearchResults(hits, query) {
  const box = $('conv-search-results')
  box.innerHTML = ''
  if (query.length === 0) {
    box.hidden = true
    return
  }
  if (hits.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'panel-empty'
    empty.textContent = '没有匹配的会话'
    box.appendChild(empty)
  } else {
    for (const hit of hits) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'side-search-hit'
      const title = document.createElement('div')
      title.className = 'side-search-hit-title'
      title.textContent = hit.title || '未命名会话'
      const snippet = document.createElement('div')
      snippet.className = 'side-search-hit-snippet'
      snippet.textContent = hit.snippet ?? ''
      row.append(title, snippet)
      row.addEventListener('click', () => openSearchHit(hit))
      box.appendChild(row)
    }
  }
  box.hidden = false
}

/** 打开一条检索命中：本地没有该会话时先建占位，再由 hydrate 补历史。 */
function openSearchHit(hit) {
  $('conv-search').value = ''
  $('conv-search-clear').hidden = true
  renderConvSearchResults([], '')
  let conv = conversations.find(c => c.id === hit.sessionId)
  if (conv === undefined) {
    conv = { id: hit.sessionId, title: hit.title || '会话', messages: [], updatedAt: hit.ts || Date.now() }
    conversations.unshift(conv)
    saveConversations()
  }
  selectConversation(hit.sessionId)
}

/** 输入防抖后请求 /sv/api/search。 */
function onConvSearchInput(event) {
  const query = event.target.value.trim()
  $('conv-search-clear').hidden = query.length === 0
  clearTimeout(convSearchTimer)
  if (query.length === 0) {
    renderConvSearchResults([], '')
    return
  }
  convSearchTimer = setTimeout(async () => {
    try {
      const data = await api(`/sv/api/search?q=${encodeURIComponent(query)}&limit=20`)
      renderConvSearchResults(Array.isArray(data.hits) ? data.hits : [], query)
    } catch {
      renderConvSearchResults([], query)
    }
  }, 220)
}

/** token 数缩写：1234 → 1.2K，1234567 → 1.2M。 */function formatTokens(value) {
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
  // 会话被删除时一并清掉它的排队消息，避免留下永远发不出去的条目。
  for (let i = queuedMessages.length - 1; i >= 0; i--) {
    if (queuedMessages[i].conv !== conv) continue
    for (const image of queuedMessages[i].images ?? []) {
      if (typeof image.preview === 'string') URL.revokeObjectURL(image.preview)
    }
    queuedMessages.splice(i, 1)
  }
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
  // 知识库引用：[标题](sv-knowledge:<docId>) → 可点击，打开知识原文。
  s = s.replace(/\[([^\]]+)\]\(sv-knowledge:([A-Za-z0-9-]+)\)/g,
    (_m, label, docId) => `<a href="#" class="knowledge-cite" data-doc-id="${docId}" title="打开知识原文">${label}</a>`)

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
  if (message.steer) {
    const tag = document.createElement('span')
    tag.className = 'msg-tag'
    tag.textContent = '插话'
    who.appendChild(tag)
  }
  bubble.appendChild(who)

  const content = document.createElement('div')
  content.className = 'content'

  if (message.stopped) {
    const note = document.createElement('div')
    note.className = 'stop-note'
    note.textContent = '已停止生成'
    content.appendChild(note)
  }

  if (message.error) {
    const note = document.createElement('div')
    note.className = 'error-note'
    note.textContent = message.error
    content.appendChild(note)
  }

  if (Array.isArray(message.images) && message.images.length > 0) {
    const grid = document.createElement('div')
    grid.className = 'msg-images'
    for (const image of message.images) {
      const src = image.preview ?? attachmentSrc(image)
      if (!src) continue
      const img = document.createElement('img')
      img.src = src
      img.alt = typeof image.name === 'string' && image.name.length > 0 ? image.name : '图片'
      img.loading = 'lazy'
      img.addEventListener('error', () => {
        const note = document.createElement('span')
        note.className = 'image-missing'
        note.textContent = '图片不可用'
        img.replaceWith(note)
      })
      grid.appendChild(img)
    }
    if (grid.children.length > 0) content.appendChild(grid)
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

  if (message.role === 'assistant' && !message.streaming && (message.text ?? '').trim().length > 0) {
    content.appendChild(answerActions(message.text))
  }
  if (message.role === 'user' && !message.streaming && message.stopped !== true) {
    content.appendChild(userActions())
  }

  bubble.appendChild(content)
  wrap.appendChild(bubble)
  return wrap
}

const ICON_COPY = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5.6" y="5.6" width="7.8" height="7.8" rx="1.6"/><path d="M10.4 5.6V3.9a1.4 1.4 0 0 0-1.4-1.4H3.9a1.4 1.4 0 0 0-1.4 1.4v5.1a1.4 1.4 0 0 0 1.4 1.4h1.7"/></svg>'
const ICON_CHECK = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.4l3 3 6-6.8"/></svg>'
const ICON_REGEN = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.8v2.7h-2.7"/></svg>'
const ICON_EDIT = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10.4 2.6l3 3L5.8 13.2l-3.6.6.6-3.6z"/></svg>'

/** 用户消息底部操作条：编辑并重发（会创建分支会话）。 */
function userActions() {
  const bar = document.createElement('div')
  bar.className = 'msg-actions'
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'icon-btn msg-edit'
  button.title = '编辑并重发'
  button.setAttribute('aria-label', '编辑并重发')
  button.innerHTML = ICON_EDIT
  bar.appendChild(button)
  return bar
}

/** 答案底部操作条：复制整段回答（Markdown 原文，不含思考过程与工具轨迹）。 */
function answerActions(text) {
  const bar = document.createElement('div')
  bar.className = 'msg-actions'

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'icon-btn'
  button.title = '复制'
  button.setAttribute('aria-label', '复制回答')
  button.innerHTML = ICON_COPY

  let timer
  const flash = (className, title, icon) => {
    button.classList.add(className)
    button.title = title
    button.innerHTML = icon
    clearTimeout(timer)
    timer = setTimeout(() => {
      button.classList.remove(className)
      button.title = '复制'
      button.innerHTML = ICON_COPY
    }, 1600)
  }

  button.addEventListener('click', async () => {
    try {
      await writeClipboard(text)
      flash('copied', '已复制', ICON_CHECK)
    } catch {
      flash('copy-failed', '复制失败', ICON_COPY)
    }
  })

  bar.appendChild(button)

  const regen = document.createElement('button')
  regen.type = 'button'
  regen.className = 'icon-btn msg-regen'
  regen.title = '重新生成'
  regen.setAttribute('aria-label', '重新生成回答')
  regen.innerHTML = ICON_REGEN
  bar.appendChild(regen)
  return bar
}

/**
 * 写入剪贴板。navigator.clipboard 只在安全上下文可用，
 * 通过局域网 http 打开 /sv 时回退到 execCommand。
 */
async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {}
  }
  const area = document.createElement('textarea')
  area.value = text
  area.readOnly = true
  area.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0'
  document.body.appendChild(area)
  area.select()
  const ok = document.execCommand('copy')
  area.remove()
  if (!ok) throw new Error('copy failed')
}

/** 收集容器内处于展开状态的 details（按文档顺序编号）。 */
function openDetails(root) {
  const open = new Set()
  root.querySelectorAll('details').forEach((el, index) => {
    if (el.open) open.add(index)
  })
  return open
}

/**
 * 重绘后按同序恢复展开状态。
 * 流式过程中每个 token / 工具事件都会重绘最后一条消息，若不恢复，
 * 用户点开的「展开」「思考过程」会在下一次增量到达时被吞掉。
 */
function applyOpenDetails(root, open) {
  if (open.size === 0) return
  root.querySelectorAll('details').forEach((el, index) => {
    if (open.has(index)) el.open = true
  })
}

/** 内容是否已接近底部（用于决定重绘后是否跟随滚动）。 */
function nearBottom(el, threshold = 120) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold
}

function renderMessages() {
  cancelScheduledRefresh()
  renderFileRail()
  renderQueueStrip()
  const container = $('messages')
  const open = openDetails(container)
  const stick = nearBottom(container) || container.scrollTop === 0
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
  applyOpenDetails(inner, open)
  if (stick) container.scrollTop = container.scrollHeight
}

/* ── 生成文件列表 ─────────────────────────────────────── */

/** 右侧文件列表可预览的文本文件扩展名。 */
const PREVIEWABLE_RE = /\.(md|markdown|txt|json|csv|tsv|html?|xml|ya?ml|toml|ini|log|py|js|mjs|cjs|ts|tsx|jsx|css|scss|sh|sql)$/i

/** 从助手正文中提取文件路径（Markdown 链接与裸绝对路径）。 */
function extractFilePaths(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const found = new Set()
  const push = (raw) => {
    let value = String(raw).trim()
    if (value.startsWith('file://')) {
      try {
        value = decodeURIComponent(value.slice('file://'.length))
      } catch {
        value = value.slice('file://'.length)
      }
    }
    if (!value.startsWith('/') || value.startsWith('//') || value.includes('://')) return
    if (value.includes('\n') || !PREVIEWABLE_RE.test(value)) return
    found.add(value)
  }
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) push(match[1])
  for (const match of text.matchAll(/\/[^\s()<>"'`，。；：、（）]+/g)) push(match[0])
  return [...found]
}

/** 取得会话的产出文件；首次访问时从历史消息里补齐。 */
function conversationFiles(conv = activeConversation()) {
  if (conv === null || conv === undefined) return []
  if (!Array.isArray(conv.files)) conv.files = []
  if (conv.filesScanned !== true) {
    conv.filesScanned = true
    let added = false
    for (const message of conv.messages ?? []) {
      if (message.role !== 'assistant') continue
      for (const path of extractFilePaths(message.text ?? '')) {
        if (addConversationFile(conv, path, false)) added = true
      }
    }
    if (added) saveConversations()
  }
  return conv.files
}

/** 记录一个产出文件；返回是否新增。 */
function addConversationFile(conv, path, persist = true) {
  if (conv === null || conv === undefined || typeof path !== 'string' || !path.startsWith('/')) return false
  if (!Array.isArray(conv.files)) conv.files = []
  if (conv.files.some(file => file.path === path)) return false
  conv.files.push({ path, name: path.split('/').pop() || path, addedAt: Date.now() })
  if (persist) saveConversations()
  return true
}

/** 渲染页面右侧的生成文件列表（只在对话视图且有文件时出现）。 */
function renderFileRail() {
  const rail = $('file-rail')
  const files = conversationFiles()
  const show = currentView === 'chat' && files.length > 0
  rail.hidden = !show
  if (!show) return
  $('file-count').textContent = String(files.length)
  const list = $('file-list')
  list.innerHTML = ''
  for (const file of [...files].reverse()) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'file-item'
    button.title = file.path
    const ext = (file.name.includes('.') ? file.name.split('.').pop() : 'file').toUpperCase().slice(0, 4)
    const dir = file.path.split('/').slice(-2, -1)[0] ?? ''
    button.innerHTML = `
      <span class="file-ext" aria-hidden="true"></span>
      <span class="file-meta">
        <span class="file-name"></span>
        <span class="file-sub"></span>
      </span>`
    button.querySelector('.file-ext').textContent = ext
    button.querySelector('.file-name').textContent = file.name
    button.querySelector('.file-sub').textContent = dir
    button.addEventListener('click', () => void openFilePreview(file.path))
    list.appendChild(button)
  }
}

/** 打开文件预览弹层。 */
async function openFilePreview(path) {
  const dialog = $('file-preview')
  const body = $('file-preview-body')
  $('file-preview-title').textContent = path.split('/').pop() || path
  $('file-preview-path').textContent = path
  body.innerHTML = '<div class="file-preview-status">加载中…</div>'
  if (!dialog.open) dialog.showModal()
  try {
    const data = await api(`/sv/api/file?path=${encodeURIComponent(path)}`)
    $('file-preview-title').textContent = data.name ?? path.split('/').pop() ?? path
    if (data.binary) {
      body.innerHTML = '<div class="file-preview-status">二进制文件，暂不支持预览。</div>'
      return
    }
    const text = typeof data.text === 'string' ? data.text : ''
    if (/\.(md|markdown)$/i.test(data.name ?? path)) {
      const html = globalThis.SvMarkdown?.render(text) ?? `<pre>${escapeHtml(text)}</pre>`
      body.innerHTML = `<div class="content file-preview-md">${html}</div>`
    } else {
      body.innerHTML = `<pre class="file-preview-text">${escapeHtml(text)}</pre>`
    }
    if (data.truncated) body.insertAdjacentHTML('beforeend', '<div class="file-preview-status">文件较大，仅显示前 512 KB。</div>')
  } catch (error) {
    body.innerHTML = `<div class="file-preview-status error">预览失败：${escapeHtml(error.message ?? String(error))}</div>`
  }
}

/** 流式重绘合并窗口：每个 token 都重建整条消息会退化成 O(n²)。 */
const REFRESH_INTERVAL_MS = 100
let refreshTimer = 0

/** 合并同一窗口内的增量事件，最多每 100ms 重绘一次。 */
function scheduleRefreshActiveMessage() {
  if (refreshTimer !== 0) return
  refreshTimer = window.setTimeout(() => {
    refreshTimer = 0
    refreshActiveMessage()
  }, REFRESH_INTERVAL_MS)
}

/** 丢弃尚未执行的合并重绘（整表重绘前调用，避免重复渲染旧消息）。 */
function cancelScheduledRefresh() {
  if (refreshTimer === 0) return
  window.clearTimeout(refreshTimer)
  refreshTimer = 0
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
  const stick = nearBottom(container)
  if (inner.children[count - 1] && inner.children[count - 1].className.includes(last.role)) {
    // 保留用户在当前消息里展开的区块，否则每次增量都会把它们重新折叠
    const prev = inner.children[count - 1]
    const open = openDetails(prev)
    const node = messageNode(last)
    applyOpenDetails(node, open)
    inner.replaceChild(node, prev)
  } else {
    inner.appendChild(messageNode(last))
  }
  if (stick) container.scrollTop = container.scrollHeight
}

/* ── Super Agent ─────────────────────────────────────── */

const SA_RUN_LABELS = {
  running: '运行中',
  succeeded: '完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消',
}
const SA_WORKER_LABELS = {
  pending: '等待',
  running: '执行中',
  succeeded: '完成',
  failed: '失败',
  timeout: '超时',
  cancelled: '已取消',
}

/** 当前展示的运行（服务端事件回流后的本地副本）。 */
let saRun = null
/** 历史运行列表（服务端持久化后返回）。 */
let saRuns = []
let saStreaming = false
let saRetrying = false
let saRenderScheduled = false
let saController = null

/** 合并同一帧内的多次增量渲染。 */
function scheduleSaRender() {
  if (saRenderScheduled) return
  saRenderScheduled = true
  requestAnimationFrame(() => {
    saRenderScheduled = false
    renderSuperAgent()
  })
}

function saWorker(index) {
  return saRun?.workers?.find(worker => worker.index === index) ?? null
}

/** 渲染历史下拉框；当前运行变化时同步选中项。 */
function renderSaHistory() {
  const row = $('sa-history-row')
  const select = $('sa-history')
  select.innerHTML = ''
  row.hidden = saRuns.length === 0
  if (saRuns.length === 0) return
  for (const run of saRuns) {
    const option = document.createElement('option')
    option.value = run.id
    const date = run.startedAt ? fmtDue(run.startedAt) : ''
    option.textContent = `${run.goal.slice(0, 36)} · ${SA_RUN_LABELS[run.status] ?? run.status}${date ? ` · ${date}` : ''}`
    option.title = run.goal
    select.appendChild(option)
  }
  select.value = saRun?.id ?? saRuns[0]?.id ?? ''
}

/** 把当前运行写回历史列表（同一运行更新，新运行插到最前）。 */
function syncSaHistory() {
  if (!saRun?.id) return
  const index = saRuns.findIndex(run => run.id === saRun.id)
  if (index >= 0) saRuns[index] = saRun
  else saRuns.unshift(saRun)
  saRuns.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  if (saRuns.length > 20) saRuns.splice(20)
  renderSaHistory()
}

/** 读取 Super-agent 的 SSE 流并逐条应用事件。 */
async function consumeSaStream(res) {
  if (!res.body) throw new Error('响应没有 body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let carry = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    carry += decoder.decode(value, { stream: true })
    let boundary
    while ((boundary = carry.indexOf('\n\n')) >= 0) {
      const frame = carry.slice(0, boundary)
      carry = carry.slice(boundary + 2)
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue
        try {
          applySaEvent(JSON.parse(line.slice(5).trim()))
        } catch {
          // 跳过无法解析的行
        }
      }
    }
  }
}

/** 处理一条 SSE 事件。 */
function applySaEvent(event) {
  if (event.type === 'run-start') {
    saRun = { id: event.runId, goal: event.goal, status: 'running', startedAt: event.at, workers: [] }
    syncSaHistory()
  } else if (event.type === 'retry-start') {
    if (saRun) {
      const worker = saWorker(event.index)
      if (worker) {
        worker.status = 'running'
        worker.output = ''
        worker.error = undefined
        worker.durationMs = undefined
      }
      saRun.status = 'running'
      saRun.error = undefined
    }
  } else if (event.type === 'plan') {
    if (saRun) {
      saRun.workers = event.subtasks.map(item => ({
        index: item.index,
        title: item.title,
        status: 'pending',
        attempts: 0,
      }))
    }
  } else if (event.type === 'worker-start') {
    const worker = saWorker(event.index)
    if (worker) {
      worker.status = 'running'
      worker.attempts = event.attempt
    }
  } else if (event.type === 'worker-session') {
    const worker = saWorker(event.index)
    if (worker) worker.sessionId = event.sessionId
  } else if (event.type === 'worker-delta') {
    const worker = saWorker(event.index)
    if (worker) worker.output = `${worker.output ?? ''}${event.text}`
  } else if (event.type === 'worker-retry') {
    const worker = saWorker(event.index)
    if (worker) {
      worker.status = 'pending'
      worker.error = event.error
    }
  } else if (event.type === 'worker-end') {
    const worker = saWorker(event.index)
    if (worker) {
      worker.status = event.status
      worker.attempts = event.attempts
      worker.durationMs = event.durationMs
      if (event.output !== undefined) worker.output = event.output
      if (event.error !== undefined) worker.error = event.error
      if (event.sessionId !== undefined) worker.sessionId = event.sessionId
    }
  } else if (event.type === 'summary') {
    if (saRun) saRun.summary = event.text
  } else if (event.type === 'run-end') {
    if (saRun) {
      saRun.status = event.status
      saRun.durationMs = event.durationMs
      saRun.workers = event.workers
      syncSaHistory()
    }
  } else if (event.type === 'error') {
    if (saRun) saRun.error = saRun.error ? `${saRun.error}\n${event.message}` : event.message
  } else if (event.type === 'done') {
    saStreaming = false
    saRetrying = false
    $('sa-stop').hidden = true
    $('sa-submit').disabled = false
  }
  scheduleSaRender()
}

async function submitSuperAgent(event) {
  event.preventDefault()
  if (saStreaming) return
  const goal = $('sa-goal').value.trim()
  if (goal.length === 0) return
  const subtasks = $('sa-subtasks').value
    .split('\n')
    .map(text => text.trim())
    .filter(text => text.length > 0)

  saStreaming = true
  saRetrying = false
  saController = new AbortController()
  saRun = { id: '', goal, status: 'running', startedAt: Date.now(), workers: [] }
  $('sa-submit').disabled = true
  $('sa-stop').hidden = false
  scheduleSaRender()

  try {
    const res = await fetch('/sv/api/superagent/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(subtasks.length === 0 ? { goal } : { goal, subtasks }),
      signal: saController.signal,
    })
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error ?? `HTTP ${res.status}`)
    }
    await consumeSaStream(res)
  } catch (error) {
    if (error?.name !== 'AbortError') {
      if (saRun) saRun.error = error?.message ?? String(error)
      if (saRun && saRun.status === 'running') saRun.status = 'failed'
      scheduleSaRender()
    }
  } finally {
    saStreaming = false
    saController = null
    $('sa-submit').disabled = false
    $('sa-stop').hidden = true
    if (saRun && saRun.status === 'running') {
      saRun.status = 'failed'
    }
    scheduleSaRender()
  }
}

async function stopSuperAgent() {
  if (!saStreaming) return
  $('sa-stop').disabled = true
  try {
    const result = saRun?.id
      ? await api('/sv/api/superagent/stop', { method: 'POST', body: { runId: saRun.id } })
      : { stopped: false }
    // 服务端中止后会补发 run-end/done；只有它没接住时才直接断开客户端。
    if (!result.stopped) saController?.abort()
  } catch (error) {
    if (saRun) saRun.error = error?.message ?? String(error)
    scheduleSaRender()
  } finally {
    $('sa-stop').disabled = false
  }
}

/** 手动重试单个失败 / 超时 / 取消的 Worker。 */
async function retrySuperAgentWorker(worker) {
  if (saStreaming || !saRun?.id) return
  if (!['failed', 'timeout', 'cancelled'].includes(worker.status)) return
  saStreaming = true
  saRetrying = true
  saController = new AbortController()
  $('sa-submit').disabled = true
  $('sa-stop').hidden = false
  scheduleSaRender()

  try {
    const res = await fetch('/sv/api/superagent/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: saRun.id, index: worker.index }),
      signal: saController.signal,
    })
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error ?? `HTTP ${res.status}`)
    }
    await consumeSaStream(res)
  } catch (error) {
    if (error?.name !== 'AbortError') {
      if (saRun) {
        saRun.error = error?.message ?? String(error)
        scheduleSaRender()
      }
    }
  } finally {
    saStreaming = false
    saRetrying = false
    saController = null
    $('sa-submit').disabled = false
    $('sa-stop').hidden = true
    if (saRun && saRun.status === 'running') {
      saRun.status = 'partial'
    }
    scheduleSaRender()
  }
}

/** 进入视图时拉取最近一次运行（刷新页面后仍能看到结果）。 */
async function loadSuperAgent() {
  if (saStreaming) return
  try {
    const state = await api('/sv/api/superagent/state')
    if (state.enabled !== true) return
    saRuns = Array.isArray(state.runs) ? state.runs : []
    if (!saRun || !saRuns.some(run => run.id === saRun.id)) {
      saRun = saRuns[0] ?? null
    }
    renderSaHistory()
    scheduleSaRender()
  } catch {
    // 状态接口失败时保留本地视图
  }
}

function renderSuperAgent() {
  const host = $('sa-runs')
  const status = $('sa-status')
  host.innerHTML = ''
  if (saRun === null) {
    status.textContent = '就绪'
    status.className = 'sa-status'
    $('sa-stop').hidden = true
    const empty = document.createElement('div')
    empty.className = 'panel-empty'
    empty.textContent = '还没有运行。输入目标后点击「开始」，Router 会拆解并分派 Worker。'
    host.appendChild(empty)
    return
  }

  status.textContent = SA_RUN_LABELS[saRun.status] ?? saRun.status
  status.className = `sa-status ${saRun.status ?? ''}`

  const card = document.createElement('div')
  card.className = 'sa-run'

  const goal = document.createElement('div')
  goal.className = 'sa-goal'
  goal.textContent = saRun.goal
  card.appendChild(goal)

  const metaBits = []
  if (saRun.id) metaBits.push(`run ${saRun.id.slice(0, 8)}`)
  if (saRun.startedAt) metaBits.push(fmtDue(saRun.startedAt))
  if (saRun.durationMs !== undefined) metaBits.push(`耗时 ${(saRun.durationMs / 1000).toFixed(1)}s`)
  metaBits.push(`${saRun.workers?.length ?? 0} 个 Worker`)
  const meta = document.createElement('div')
  meta.className = 'sa-meta'
  meta.textContent = metaBits.join(' · ')
  card.appendChild(meta)

  if (saRun.error) {
    const error = document.createElement('div')
    error.className = 'sa-error'
    error.textContent = saRun.error
    card.appendChild(error)
  }

  const list = document.createElement('div')
  list.className = 'sa-workers'
  for (const worker of saRun.workers ?? []) {
    list.appendChild(saWorkerNode(worker))
  }
  card.appendChild(list)

  if (saRun.summary) {
    const box = document.createElement('div')
    box.className = 'sa-summary'
    const title = document.createElement('div')
    title.className = 'sa-summary-title'
    title.textContent = 'Router 汇总'
    const text = document.createElement('div')
    text.className = 'sa-summary-text'
    const renderMarkdown = globalThis.SvMarkdown?.render
    if (typeof renderMarkdown === 'function') text.innerHTML = renderMarkdown(saRun.summary)
    else text.textContent = saRun.summary
    box.append(title, text)
    card.appendChild(box)
  }

  host.appendChild(card)
}

function saWorkerNode(worker) {
  const el = document.createElement('div')
  el.className = `sa-worker ${worker.status ?? 'pending'}`

  const head = document.createElement('div')
  head.className = 'sa-worker-head'
  const title = document.createElement('div')
  title.className = 'sa-worker-title'
  title.textContent = `${worker.index + 1}. ${worker.title}`
  const chip = document.createElement('span')
  chip.className = `sa-chip ${worker.status ?? 'pending'}`
  chip.textContent = SA_WORKER_LABELS[worker.status] ?? worker.status
  const actions = document.createElement('div')
  actions.className = 'sa-worker-actions'
  actions.appendChild(chip)
  const canRetry = saRun?.status !== 'running'
    && ['failed', 'timeout', 'cancelled'].includes(worker.status)
  if (canRetry) {
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'btn btn-ghost sa-retry'
    retry.textContent = '重试'
    retry.disabled = saStreaming
    retry.addEventListener('click', () => void retrySuperAgentWorker(worker))
    actions.appendChild(retry)
  }
  head.append(title, actions)
  el.appendChild(head)

  const bits = []
  if (worker.attempts > 0) bits.push(`尝试 ${worker.attempts} 次`)
  if (worker.durationMs !== undefined) bits.push(`${(worker.durationMs / 1000).toFixed(1)}s`)
  if (worker.sessionId) bits.push(`会话 ${worker.sessionId.slice(0, 8)}`)
  if (worker.error) bits.push(worker.error)
  if (bits.length > 0) {
    const meta = document.createElement('div')
    meta.className = 'sa-worker-meta'
    meta.textContent = bits.join(' · ')
    el.appendChild(meta)
  }

  if (worker.output) {
    const details = document.createElement('details')
    details.className = 'sa-worker-output'
    const summary = document.createElement('summary')
    summary.textContent = worker.status === 'running' ? '实时输出' : '查看输出'
    const pre = document.createElement('pre')
    pre.textContent = worker.output
    details.append(summary, pre)
    el.appendChild(details)
  }
  return el
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
    setAttachmentsSupported(state.attachments === true)
    const modelChip = $('chip-model')
    modelChip.textContent = state.llm?.model ?? '…'
    modelChip.className = 'chip'
    renderModelSwitch(state)
    const searchChip = $('chip-search')
    searchChip.textContent = state.search?.hasApiKey ? `搜索 ${state.search?.provider ?? ''} ✓` : '搜索 ✕'
    searchChip.className = 'chip ' + (state.search?.hasApiKey ? 'on' : 'off')
    renderMailQuick(state.mail)
    // Super-agent 由服务端开关控制：关闭时隐藏导航项，保持原页面结构。
    const saEnabled = state.superAgent?.enabled === true
    $('tab-superagent').hidden = !saEnabled
    const storedView = localStorage.getItem(VIEW_KEY)
    // 首屏 applyView 早于本接口返回；若上次停留在 Super Agent，这里补一次恢复。
    if (saEnabled && storedView === 'superagent' && currentView !== 'superagent') applyView('superagent')
    else if (!saEnabled && currentView === 'superagent') applyView('chat')
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

/** 设置页的模型配置草稿：保存时整体提交，切换条目不会丢改动。 */
let llmDrafts = []
/** 当前正在编辑的条目（只影响表单，不改变运行时生效模型）。 */
let llmDraftEditId = ''
/** 当前运行时生效的条目；保存时原样提交。 */
let llmDraftActiveId = ''

/** 顶栏快速切换的并发保护。 */
let modelSwitching = false

function newDraftId() {
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** 重绘设置页的模型配置下拉。 */
function renderLlmProfileSelect() {
  const select = $('cfg-llm-profile')
  select.innerHTML = ''
  for (const draft of llmDrafts) {
    const option = document.createElement('option')
    option.value = draft.id
    const label = draft.name?.trim() || draft.model || '未命名模型'
    option.textContent = draft.id === llmDraftActiveId ? `${label}（当前）` : label
    select.appendChild(option)
  }
  select.value = llmDraftEditId
  $('cfg-llm-remove').disabled = llmDrafts.length <= 1
}

/** 把当前表单写回选中的草稿（切换条目前调用）。 */
function commitLlmDraft() {
  const draft = llmDrafts.find(item => item.id === llmDraftEditId)
  if (draft === undefined) return
  draft.name = $('cfg-llm-name').value.trim()
  draft.provider = $('cfg-llm-provider').value
  draft.baseURL = $('cfg-llm-base').value.trim()
  draft.model = $('cfg-llm-model').value.trim()
  const ctx = $('cfg-llm-ctx').value.trim()
  const max = $('cfg-llm-max').value.trim()
  draft.contextWindow = ctx.length > 0 ? Number(ctx) : undefined
  draft.maxTokens = max.length > 0 ? Number(max) : undefined
  const key = $('cfg-llm-key').value.trim()
  if (key.length > 0) {
    draft.apiKey = key
    draft.hasApiKey = true
    $('cfg-llm-key').value = ''
  }
}

/** 把选中的草稿填进表单。 */
function loadLlmDraft() {
  const draft = llmDrafts.find(item => item.id === llmDraftEditId)
  if (draft === undefined) return
  $('cfg-llm-name').value = draft.name ?? ''
  $('cfg-llm-provider').value = draft.provider ?? 'custom'
  $('cfg-llm-base').value = draft.baseURL ?? ''
  $('cfg-llm-model').value = draft.model ?? ''
  $('cfg-llm-ctx').value = draft.contextWindow ?? ''
  $('cfg-llm-max').value = draft.maxTokens ?? ''
  $('cfg-llm-key').value = ''
  $('cfg-llm-key').placeholder = draft.hasApiKey ? '已配置（留空表示不修改）' : '未配置'
}

/** 顶栏模型快速切换下拉。 */
function renderModelSwitch(state) {
  const select = $('model-switch')
  const models = Array.isArray(state?.llmModels) ? state.llmModels : []
  select.innerHTML = ''
  for (const model of models) {
    const option = document.createElement('option')
    option.value = model.id
    option.textContent = model.name || model.model
    option.title = `${model.model} · ${model.baseURL}`
    select.appendChild(option)
  }
  if (typeof state?.activeModelId === 'string') select.value = state.activeModelId
  select.dataset.activeId = state?.activeModelId ?? ''
  select.hidden = models.length === 0
}

/** 切换生效模型（立即持久化，下一条消息生效）。 */
async function switchModel() {
  const select = $('model-switch')
  const id = select.value
  if (modelSwitching || id.length === 0) return
  const previous = select.dataset.activeId ?? ''
  modelSwitching = true
  select.disabled = true
  const status = $('topbar-status')
  try {
    const state = await api('/sv/api/config', { method: 'POST', body: { activeModelId: id } })
    renderModelSwitch(state)
    $('chip-model').textContent = state.llm?.model ?? '…'
    $('chip-model').className = 'chip'
    status.textContent = `已切换到 ${state.llm?.model ?? id}`
    status.className = 'topbar-status'
    window.setTimeout(() => {
      if (!streaming && status.textContent.startsWith('已切换到')) status.textContent = ''
    }, 2200)
  } catch (error) {
    select.value = previous
    status.textContent = `切换失败：${error.message ?? String(error)}`
  } finally {
    modelSwitching = false
    select.disabled = false
  }
}

function fillSettingsForm(state) {
  $('cfg-theme').value = preferredTheme()
  llmDrafts = (Array.isArray(state.llmModels) ? state.llmModels : []).map(profile => ({
    id: profile.id,
    name: profile.name ?? '',
    provider: profile.provider ?? 'custom',
    baseURL: profile.baseURL ?? '',
    model: profile.model ?? '',
    contextWindow: profile.contextWindow,
    maxTokens: profile.maxTokens,
    apiKey: '',
    hasApiKey: profile.hasApiKey === true,
  }))
  if (llmDrafts.length === 0) {
    llmDrafts = [{
      id: newDraftId(),
      name: state.llm?.model ?? '',
      provider: state.llm?.provider ?? 'custom',
      baseURL: state.llm?.baseURL ?? '',
      model: state.llm?.model ?? '',
      contextWindow: state.llm?.contextWindow,
      maxTokens: state.llm?.maxTokens,
      apiKey: '',
      hasApiKey: state.llm?.hasApiKey === true,
    }]
  }
  llmDraftActiveId = llmDrafts.some(draft => draft.id === state.activeModelId)
    ? state.activeModelId
    : llmDrafts[0].id
  llmDraftEditId = llmDraftActiveId
  renderLlmProfileSelect()
  loadLlmDraft()
  const sa = state.superAgent ?? {}
  const saLimits = sa.limits ?? sa
  $('cfg-sa-enabled').checked = sa.enabled === true
  $('cfg-sa-concurrency').value = saLimits.maxConcurrency ?? ''
  $('cfg-sa-subtasks').value = saLimits.maxSubtasks ?? ''
  $('cfg-sa-retry').value = saLimits.retryAttempts ?? ''
  $('cfg-sa-timeout').value = saLimits.workerTimeoutMs ?? ''
  $('cfg-sa-watchdog').value = saLimits.watchdogIntervalMs ?? ''
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
  const briefing = state.briefing ?? {}
  $('cfg-brief-enabled').checked = briefing.enabled === true
  $('cfg-brief-time').value = typeof briefing.time === 'string' && briefing.time.length > 0 ? briefing.time : '08:30'
  $('cfg-brief-time').disabled = briefing.enabled !== true
  $('cfg-brief-email').checked = briefing.email === true
  $('brief-run-result').textContent = ''
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
  commitLlmDraft()
  const body = {
    llmModels: {
      models: llmDrafts.map(draft => ({
        id: draft.id,
        name: draft.name,
        provider: draft.provider,
        baseURL: draft.baseURL,
        model: draft.model,
        contextWindow: draft.contextWindow ?? null,
        maxTokens: draft.maxTokens ?? null,
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      })),
      activeModelId: llmDraftActiveId,
    },
    superAgent: {
      enabled: $('cfg-sa-enabled').checked,
      maxConcurrency: Number($('cfg-sa-concurrency').value),
      maxSubtasks: Number($('cfg-sa-subtasks').value),
      retryAttempts: Number($('cfg-sa-retry').value),
      workerTimeoutMs: Number($('cfg-sa-timeout').value),
      watchdogIntervalMs: Number($('cfg-sa-watchdog').value),
    },
    search: {
      provider: $('cfg-search-provider').value,
      baseURL: $('cfg-search-base').value.trim(),
    },
  }
  body.search.freshness = $('cfg-search-provider').value === 'bocha' ? $('cfg-search-freshness').value : null
  if ($('cfg-search-key').value.trim().length > 0) body.search.apiKey = $('cfg-search-key').value.trim()
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
  body.briefing = {
    enabled: $('cfg-brief-enabled').checked,
    time: $('cfg-brief-time').value.trim() || '08:30',
    email: $('cfg-brief-email').checked,
  }

  try {
    await api('/sv/api/config', { method: 'POST', body })
    $('settings').close()
    await loadState()
  } catch (error) {
    $('settings-error').textContent = error.message ?? String(error)
  }
}

/** 当前编辑表单对应的模型配置（测试与拉取模型用，不触发保存）。 */
function currentLlmForm() {
  const apiKey = $('cfg-llm-key').value.trim()
  return {
    id: llmDraftEditId,
    baseURL: $('cfg-llm-base').value.trim(),
    model: $('cfg-llm-model').value.trim(),
    ...(apiKey.length > 0 ? { apiKey } : {}),
  }
}

async function runTest(target) {
  const result = $({ llm: 'test-llm-result', search: 'test-search-result', mail: 'test-mail-result' }[target])
  result.textContent = '测试中…'
  result.className = 'test-result'
  try {
    const body = target === 'llm' ? { target, llm: currentLlmForm() } : { target }
    const res = await api('/sv/api/test', { method: 'POST', body })
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

/* ── 编辑重发 / 重新生成（创建分支会话） ───────────────── */

/** 把前序消息压成一段上下文，供分支会话的首轮使用。 */
function buildBranchContext(messages) {
  const lines = []
  for (const message of messages) {
    const text = (message.text ?? '').trim()
    if (text.length === 0) continue
    lines.push(`${message.role === 'user' ? '用户' : '助手'}：${text}`)
  }
  const MAX = 12000
  let joined = lines.join('\n\n')
  if (joined.length > MAX) joined = `…（较早内容省略）\n\n${joined.slice(joined.length - MAX)}`
  return joined
}

/** 以现有消息为前缀创建一个新分支会话。 */
function branchConversation(prior) {
  const conv = {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: '新对话',
    messages: prior.map(message => ({ ...message })),
    updatedAt: Date.now(),
  }
  conversations.unshift(conv)
  activeId = conv.id
  localStorage.setItem(ACTIVE_KEY, conv.id)
  saveConversations()
  renderSidebar()
  renderMessages()
  return conv
}

/** 把某条用户消息变为可编辑区域，发送后在新分支里重跑。 */
function beginEditMessage(index) {
  const conv = activeConversation()
  if (conv === null) return
  const message = conv.messages[index]
  if (message === undefined || message.role !== 'user') return
  const wrap = [...$('messages').querySelectorAll('.messages-inner > .msg')][index]
  if (wrap === undefined) return
  const content = wrap.querySelector('.content')
  if (content === null) return
  const original = message.text ?? ''
  content.innerHTML = ''

  const area = document.createElement('textarea')
  area.className = 'msg-edit-area'
  area.value = original
  area.rows = Math.min(12, Math.max(2, original.split('\n').length + 1))

  const actions = document.createElement('div')
  actions.className = 'section-actions'
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'btn btn-primary'
  save.textContent = '发送'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'btn btn-ghost'
  cancel.textContent = '取消'
  actions.append(save, cancel)
  content.append(area, actions)
  area.focus()
  area.setSelectionRange(original.length, original.length)

  cancel.addEventListener('click', () => renderMessages())
  save.addEventListener('click', () => {
    const text = area.value.trim()
    if (text.length === 0) {
      area.focus()
      return
    }
    const prior = conv.messages.slice(0, index)
    const context = buildBranchContext(prior)
    const branch = branchConversation(prior)
    branch.title = text.slice(0, 24)
    saveConversations()
    renderSidebar()
    void runTurn(branch, text, [], context)
  })
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      save.click()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      renderMessages()
    }
  })
}

/** 重新生成某条回答：从它前面最近的一条用户消息重新提问。 */
function regenerateMessage(index) {
  const conv = activeConversation()
  if (conv === null) return
  const message = conv.messages[index]
  if (message === undefined || message.role !== 'assistant') return
  let userIndex = index - 1
  while (userIndex >= 0 && conv.messages[userIndex].role !== 'user') userIndex -= 1
  if (userIndex < 0) return
  const userText = (conv.messages[userIndex].text ?? '').trim()
  if (userText.length === 0) return
  const prior = conv.messages.slice(0, userIndex)
  const context = buildBranchContext(prior)
  const branch = branchConversation(prior)
  branch.title = conv.title === '新对话' ? '新对话' : `${conv.title} · 重新生成`
  saveConversations()
  renderSidebar()
  void runTurn(branch, userText, [], context)
}

/** 消息区点击：知识引用 / 编辑 / 重新生成。 */
function onMessageAreaClick(event) {
  const cite = event.target.closest?.('a.knowledge-cite')
  if (cite) {
    event.preventDefault()
    const docId = cite.dataset.docId
    if (typeof docId === 'string' && docId.length > 0) {
      applyView('knowledge')
      void openKnowledgeDoc(docId)
    }
    return
  }
  if (streaming) return
  const action = event.target.closest?.('.msg-edit, .msg-regen')
  if (!action) return
  const wrap = action.closest('.msg')
  if (wrap === null) return
  const nodes = [...$('messages').querySelectorAll('.messages-inner > .msg')]
  const index = nodes.indexOf(wrap)
  if (index < 0) return
  if (action.classList.contains('msg-edit')) beginEditMessage(index)
  else regenerateMessage(index)
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
  // 生成中仍保留发送按钮：点击后选择排队、插话或打断。
  $('send').hidden = false
  $('send').title = value ? '继续提问' : '发送'
  $('stop').hidden = !value
  $('input').placeholder = value
    ? '可继续输入；Enter 选择排队、插话或打断'
    : '输入消息，Enter 发送，Shift+Enter 换行；输入 / 选择技能或工具'
  $('topbar-status').textContent = value ? '● 生成中' : ''
  $('topbar-status').className = 'topbar-status' + (value ? ' running' : '')
  if (!value) closeSendModeMenu()
}

/** 附件引用 → 图片读取地址；刷新页面后历史消息也走这里。 */
function attachmentSrc(ref) {
  if (!ref || typeof ref.attachmentId !== 'string') return ''
  try {
    return `/sv/api/attachments?ref=${encodeURIComponent(JSON.stringify(ref))}`
  } catch {
    return ''
  }
}

/** 输入区上方的即时提示（图片校验失败等），数秒后自动消失。 */
let composerErrorTimer = null
function showComposerError(text) {
  const note = $('composer-error')
  note.textContent = text
  note.hidden = false
  if (composerErrorTimer !== null) clearTimeout(composerErrorTimer)
  composerErrorTimer = setTimeout(() => { note.hidden = true }, 5000)
}

/** 宿主未挂载附件服务时禁用图片入口，文本问答不受影响。 */
function setAttachmentsSupported(supported) {
  attachmentsSupported = supported
  const button = $('attach')
  button.hidden = !supported
  button.disabled = !supported
  if (!supported) {
    $('image-input').value = ''
    pendingImages = []
    renderImageStrip()
  }
}

function renderImageStrip() {
  const strip = $('image-strip')
  strip.innerHTML = ''
  for (const image of pendingImages) {
    const chip = document.createElement('div')
    chip.className = 'image-chip'
    const img = document.createElement('img')
    img.src = image.preview
    img.alt = image.name || '图片'
    chip.appendChild(img)
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.title = '移除图片'
    remove.textContent = '×'
    remove.addEventListener('click', () => {
      URL.revokeObjectURL(image.preview)
      pendingImages = pendingImages.filter(item => item !== image)
      renderImageStrip()
    })
    chip.appendChild(remove)
    strip.appendChild(chip)
  }
  strip.hidden = pendingImages.length === 0
}

/** 读取图片为 base64（去掉 data URL 前缀）。 */
function readImageBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      if (comma < 0) {
        reject(new Error('读取图片失败'))
        return
      }
      resolve(result.slice(comma + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

/** 选择/粘贴图片后加入待发送列表，并做数量、类型与体积校验。 */
async function addImageFiles(files) {
  const candidates = [...files]
  if (candidates.length === 0) return
  if (!attachmentsSupported) {
    showComposerError('当前环境未挂载附件服务，暂不支持图片消息')
    return
  }
  for (const file of candidates) {
    if (pendingImages.length >= MAX_IMAGES) {
      showComposerError(`单次最多 ${MAX_IMAGES} 张图片`)
      break
    }
    if (!IMAGE_TYPES.has(file.type)) {
      showComposerError('仅支持 PNG / JPEG / WebP / GIF 图片')
      continue
    }
    if (file.size > MAX_IMAGE_BYTES) {
      showComposerError('单张图片不能超过 10MB')
      continue
    }
    try {
      const data = await readImageBase64(file)
      pendingImages.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: file.name || 'image',
        mediaType: file.type,
        data,
        preview: URL.createObjectURL(file),
      })
    } catch {
      showComposerError('读取图片失败，请重试')
    }
  }
  renderImageStrip()
}

/* ── 生成中继续提问 ───────────────────────────────────── */

/** 排队等待当前回答结束后发送的消息。 */
const queuedMessages = []
/** 当前正在流式接收的回答；无生成时为 null。 */
let activeStream = null
/** 打断当前生成后要立即发送的消息。 */
let pendingInterrupt = null
/** 发送方式菜单（排队 / 插话 / 打断）。 */
let sendModeMenu = null
let sendModeAnchor = null

function clearComposer() {
  const input = $('input')
  input.value = ''
  autosize()
  pendingImages = []
  renderImageStrip()
}

function renderQueueStrip() {
  const strip = $('queue-strip')
  strip.innerHTML = ''
  const conv = activeConversation()
  const items = queuedMessages.filter(item => item.conv === conv)
  strip.hidden = items.length === 0
  for (const item of items) {
    const chip = document.createElement('div')
    chip.className = 'queue-chip'
    const label = document.createElement('span')
    label.className = 'queue-chip-text'
    const imageNote = item.images?.length > 0 ? ` [${item.images.length} 图]` : ''
    label.textContent = `${item.text || '图片消息'}${imageNote}`
    label.title = item.text
    const meta = document.createElement('span')
    meta.className = 'queue-chip-meta'
    meta.textContent = '待发送'
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.title = '取消排队'
    remove.textContent = '×'
    remove.addEventListener('click', () => {
      const index = queuedMessages.indexOf(item)
      if (index >= 0) queuedMessages.splice(index, 1)
      for (const image of item.images ?? []) {
        if (typeof image.preview === 'string') URL.revokeObjectURL(image.preview)
      }
      renderQueueStrip()
    })
    chip.append(label, meta, remove)
    strip.appendChild(chip)
  }
}

function enqueueMessage(conv, text, images) {
  queuedMessages.push({ conv, text, images })
  renderQueueStrip()
}

/** 取当前会话的下一条待发送消息：打断优先于排队。 */
function takeNextSend(conv) {
  if (pendingInterrupt !== null && pendingInterrupt.conv === conv) {
    const next = pendingInterrupt
    pendingInterrupt = null
    return next
  }
  const index = queuedMessages.findIndex(item => item.conv === conv)
  if (index < 0) return null
  const next = queuedMessages.splice(index, 1)[0]
  renderQueueStrip()
  return next
}

/** 当前生成结束后自动续发；用户切走后不抢跑，等回到该会话再发。 */
function drainNextSend(conv) {
  if (activeConversation() !== conv) {
    renderQueueStrip()
    return
  }
  const next = takeNextSend(conv)
  if (next !== null) void runTurn(conv, next.text, next.images)
}

function closeSendModeMenu() {
  if (sendModeMenu === null) return
  sendModeMenu.remove()
  sendModeMenu = null
  sendModeAnchor = null
}

function openSendModeMenu() {
  const reopen = sendModeAnchor !== $('send')
  closeSendModeMenu()
  if (!reopen) return

  // 插话与打断只作用于当前正在生成的那个会话；切到别的会话时只能排队。
  const sameConv = activeStream !== null && activeStream.conv === activeConversation()
  const menu = document.createElement('div')
  menu.className = 'conv-menu send-menu'
  menu.setAttribute('role', 'menu')
  const options = [
    ['queue', '排队发送', '当前回答结束后自动发送', false],
    [
      'steer',
      '中途插话',
      !sameConv ? '另一会话正在生成' : pendingImages.length > 0 ? '插话暂不支持图片' : '立即加入当前任务，下一步生效',
      !sameConv || pendingImages.length > 0,
    ],
    ['interrupt', '打断重答', sameConv ? '停止当前生成，立即回答本条' : '另一会话正在生成', !sameConv],
  ]
  for (const [mode, label, desc, disabled] of options) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'conv-menu-item send-menu-item'
    button.disabled = disabled === true
    const title = document.createElement('span')
    title.className = 'send-menu-label'
    title.textContent = label
    const hint = document.createElement('span')
    hint.className = 'send-menu-desc'
    hint.textContent = desc
    button.append(title, hint)
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      chooseSendMode(mode)
    })
    menu.appendChild(button)
  }
  document.body.appendChild(menu)

  const rect = $('send').getBoundingClientRect()
  const top = Math.max(8, rect.top - menu.offsetHeight - 8)
  const left = Math.max(8, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))
  menu.style.top = `${top}px`
  menu.style.left = `${left}px`
  sendModeMenu = menu
  sendModeAnchor = $('send')
}

document.addEventListener('click', (event) => {
  if (sendModeMenu === null) return
  if (sendModeMenu.contains(event.target) || sendModeAnchor?.contains(event.target)) return
  closeSendModeMenu()
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeSendModeMenu()
})
window.addEventListener('resize', closeSendModeMenu)
$('messages').addEventListener('scroll', closeSendModeMenu, { passive: true })

function chooseSendMode(mode) {
  const input = $('input')
  const text = input.value.trim()
  const images = pendingImages.slice()
  if (!text && images.length === 0) return
  if (mode === 'steer' && images.length > 0) {
    showComposerError('中途插话暂不支持图片')
    return
  }
  closeSendModeMenu()
  if (mode === 'steer') {
    void steerMessage(text)
    return
  }
  clearComposer()
  const conv = ensureConversation()
  if (mode === 'queue') {
    enqueueMessage(conv, text, images)
    return
  }
  void interruptAndSend(conv, text, images)
}

/** 取累计文本里新一段的内容；跨段拼接符（空行）去掉。 */
function suffixOf(full, prefix) {
  const rest = full.slice(prefix.length)
  return prefix.length > 0 ? rest.replace(/^\n+/, '') : rest
}

/** 把当前回答定稿，在它和后续输出之间插入用户消息并开启新回答。 */
function splitAssistant(stream, conv, text) {
  stream.current.streaming = false
  conv.messages.push({ role: 'user', text, steer: true })
  const next = { role: 'assistant', text: '', reasoning: '', tools: [], streaming: true }
  conv.messages.push(next)
  stream.baseText = stream.cumulativeText
  stream.baseReasoning = stream.cumulativeReasoning
  stream.segments.push(next)
  stream.current = next
  renderMessages()
}

async function steerMessage(text) {
  const conv = activeConversation()
  const stream = activeStream
  if (conv === null || stream === null || stream.conv !== conv) {
    showComposerError('当前没有正在生成的回答')
    return
  }
  const sessionId = stream.sessionId ?? conv.id
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    showComposerError('会话尚未就绪，请稍后再试')
    return
  }
  try {
    await api('/sv/api/chat/steer', { method: 'POST', body: { sessionId, text } })
    clearComposer()
    splitAssistant(stream, conv, text)
    conv.updatedAt = Date.now()
    saveConversations()
  } catch (error) {
    showComposerError(`插话失败：${error.message ?? String(error)}`)
  }
}

async function interruptAndSend(conv, text, images) {
  const stream = activeStream
  if (stream === null || stream.conv !== conv) {
    enqueueMessage(conv, text, images)
    return
  }
  stream.current.stopped = true
  pendingInterrupt = { conv, text, images }
  refreshActiveMessage()
  const sessionId = stream.sessionId ?? conv.id
  try {
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      await api('/sv/api/stop', { method: 'POST', body: { sessionId } })
    }
  } catch {
    // 停止失败时让当前轮次自然结束，finally 仍会续发
  }
  // 流可能在设置 pendingInterrupt 之前就已结束，这里补一次。
  if (!streaming) {
    const next = takeNextSend(conv)
    if (next !== null) void runTurn(conv, next.text, next.images)
  }
}

async function sendMessage() {
  hideSlashMenu()
  const input = $('input')
  const text = input.value.trim()
  const images = pendingImages.slice()
  if (!text && images.length === 0) return
  if (streaming) {
    openSendModeMenu()
    return
  }
  clearComposer()
  await runTurn(ensureConversation(), text, images)
}

async function runTurn(conv, text, images, context) {
  const userMessage = {
    role: 'user',
    text,
    ...images.length === 0
      ? {}
      : {
          images: images.map(image => ({
            preview: image.preview,
            name: image.name,
            mediaType: image.mediaType,
          })),
        },
  }
  conv.messages.push(userMessage)
  if (conv.title === '新对话') conv.title = text ? text.slice(0, 24) : '图片消息'
  conv.updatedAt = Date.now()
  renderMessages()
  saveConversations()
  renderSidebar()

  const assistant = { role: 'assistant', text: '', reasoning: '', tools: [], streaming: true }
  conv.messages.push(assistant)
  const stream = {
    conv,
    sessionId: typeof conv.id === 'string' && conv.id.length > 0 ? conv.id : null,
    current: assistant,
    baseText: '',
    baseReasoning: '',
    cumulativeText: '',
    cumulativeReasoning: '',
    segments: [assistant],
  }
  activeStream = stream
  refreshActiveMessage()
  setStreaming(true)

  let sessionId = conv.id
  try {
    const res = await fetch('/sv/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...sessionId ? { sessionId } : {},
        text,
        ...typeof context === 'string' && context.trim().length > 0 ? { context: context.trim() } : {},
        ...images.length === 0
          ? {}
          : {
              images: images.map(({ mediaType, name, data }) => ({ mediaType, name, data })),
            },
      }),
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
          handleEvent(conv, stream, event, userMessage)
          if (event.type === 'done') done = true
        }
      }
    }
  } catch (error) {
    stream.current.error = stream.current.error ?? `连接失败：${error.message ?? String(error)}`
  } finally {
    for (const segment of stream.segments) segment.streaming = false
    if (activeStream === stream) activeStream = null
    // 兜底：正文里以链接/绝对路径提到的产出文件也补进右侧列表
    for (const segment of stream.segments) {
      for (const path of extractFilePaths(segment.text ?? '')) addConversationFile(conv, path, false)
    }
    conv.updatedAt = Date.now()
    conversations.sort((a, b) => b.updatedAt - a.updatedAt)
    saveConversations()
    renderSidebar()
    renderMessages()
    setStreaming(false)
    drainNextSend(conv)
    // 当前流属于别的会话时，用户正停留的会话如果有排队消息，也在这里续发。
    const active = activeConversation()
    if (activeStream === null && active !== null && active !== conv) drainNextSend(active)
    $('input').focus()
  }
}

function handleEvent(conv, stream, event, userMessage) {
  const assistant = stream.current
  switch (event.type) {
    case 'session':
      stream.sessionId = event.sessionId
      if (conv.id !== event.sessionId) {
        conv.id = event.sessionId
        activeId = event.sessionId
        localStorage.setItem(ACTIVE_KEY, event.sessionId)
        saveConversations()
      }
      // 服务端把上传图片转成了可持久化的附件引用：替换本地预览地址。
      if (userMessage !== undefined && Array.isArray(event.images) && event.images.length > 0) {
        for (const image of userMessage.images ?? []) {
          if (typeof image.preview === 'string') URL.revokeObjectURL(image.preview)
        }
        userMessage.images = event.images
        saveConversations()
        renderMessages()
      }
      break
    case 'text-delta':
      stream.cumulativeText += event.text
      assistant.text += event.text
      scheduleRefreshActiveMessage()
      break
    case 'reasoning-delta':
      stream.cumulativeReasoning += event.text
      assistant.reasoning += event.text
      scheduleRefreshActiveMessage()
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
      scheduleRefreshActiveMessage()
      break
    }
    case 'message': {
      // 服务端给的是整轮累计文本；插话分段后用前缀差量还原当前段。
      const text = typeof event.text === 'string' ? event.text : ''
      stream.cumulativeText = text
      assistant.text = text.startsWith(stream.baseText)
        ? suffixOf(text, stream.baseText)
        : text
      const reasoning = typeof event.reasoning === 'string' ? event.reasoning : ''
      stream.cumulativeReasoning = reasoning
      assistant.reasoning = reasoning.startsWith(stream.baseReasoning)
        ? suffixOf(reasoning, stream.baseReasoning)
        : reasoning
      scheduleRefreshActiveMessage()
      break
    }
    case 'file':
      if (addConversationFile(conv, event.path)) renderFileRail()
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
      scheduleRefreshActiveMessage()
      break
    case 'done':
      assistant.streaming = false
      break
  }
}

async function stopStreaming() {
  const conv = activeConversation()
  if (!conv || !conv.id) return
  if (activeStream !== null && activeStream.conv === conv) {
    activeStream.current.stopped = true
    refreshActiveMessage()
  }
  try {
    await api('/sv/api/stop', { method: 'POST', body: { sessionId: conv.id } })
  } catch {
    // 忽略：会话可能尚未建立
  }
}

/* ── / 斜杠技能与工具 ─────────────────────────────────── */

let slashData = null
let slashMenuOpen = false
let slashItems = []
let slashIndex = 0
let slashQuery = ''

/** 懒加载技能与工具列表；各自失败时退化为空数组。 */
async function loadSlashData() {
  if (slashData !== null) return slashData
  const [skillState, toolState] = await Promise.all([
    api('/sv/api/skills').catch(() => ({ skills: [] })),
    api('/sv/api/tools').catch(() => ({ tools: [] })),
  ])
  slashData = {
    skills: Array.isArray(skillState.skills) ? skillState.skills : [],
    tools: Array.isArray(toolState.tools) ? toolState.tools : [],
  }
  return slashData
}

/** 按当前输入过滤技能与工具。 */
function slashCandidates(query) {
  const q = query.toLowerCase()
  const skills = (slashData?.skills ?? [])
    .filter(skill => q.length === 0
      || skill.name.toLowerCase().includes(q)
      || String(skill.description ?? '').toLowerCase().includes(q)
      || String(skill.path ?? '').toLowerCase().includes(q))
    .map(skill => ({
      kind: 'skill',
      label: `/${skill.name}`,
      description: skill.description || '用户可调用技能',
      path: skill.path || '',
      name: skill.name,
    }))
  const tools = (slashData?.tools ?? [])
    .filter(tool => q.length === 0
      || tool.name.toLowerCase().includes(q)
      || String(tool.description ?? '').toLowerCase().includes(q))
    .map(tool => ({
      kind: 'tool',
      label: tool.name,
      description: tool.description || '工具',
      path: '',
      name: tool.name,
    }))
  return [...skills, ...tools].slice(0, 120)
}

function hideSlashMenu() {
  slashMenuOpen = false
  slashItems = []
  $('slash-menu').hidden = true
}

function renderSlashMenu() {
  const menu = $('slash-menu')
  slashItems = slashCandidates(slashQuery)
  if (slashItems.length === 0) {
    hideSlashMenu()
    return
  }
  menu.innerHTML = ''
  slashIndex = Math.min(Math.max(slashIndex, 0), slashItems.length - 1)
  slashItems.forEach((item, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `slash-item${index === slashIndex ? ' active' : ''}`
    button.dataset.index = String(index)
    const kind = document.createElement('span')
    kind.className = 'slash-kind'
    kind.textContent = item.kind === 'skill' ? '技能' : '工具'
    const main = document.createElement('span')
    main.className = 'slash-main'
    const label = document.createElement('span')
    label.className = 'slash-label'
    label.textContent = item.label
    const desc = document.createElement('span')
    desc.className = 'slash-desc'
    desc.textContent = item.description
    main.append(label, desc)
    if (item.path) {
      const path = document.createElement('span')
      path.className = 'slash-path'
      path.textContent = item.path
      path.title = item.path
      main.appendChild(path)
    }
    button.append(kind, main)
    menu.appendChild(button)
  })
  menu.hidden = false
  slashMenuOpen = true
  menu.querySelector('.slash-item.active')?.scrollIntoView({ block: 'nearest' })
}

/** 输入形如 `/query` 时打开菜单；出现空格后关闭。 */
function updateSlashMenu() {
  if (currentView !== 'chat') {
    hideSlashMenu()
    return
  }
  const match = /^\/([^\s]*)$/.exec($('input').value)
  if (match === null) {
    hideSlashMenu()
    return
  }
  slashQuery = match[1]
  slashIndex = 0
  renderSlashMenu()
  if (slashData === null) {
    void loadSlashData().then(() => {
      if (slashMenuOpen) renderSlashMenu()
    })
  }
}

function moveSlashSelection(delta) {
  if (!slashMenuOpen || slashItems.length === 0) return
  slashIndex = (slashIndex + delta + slashItems.length) % slashItems.length
  const buttons = $('slash-menu').querySelectorAll('.slash-item')
  buttons.forEach((button, index) => {
    button.classList.toggle('active', index === slashIndex)
  })
  buttons[slashIndex]?.scrollIntoView({ block: 'nearest' })
}

function selectSlashItem(item) {
  const input = $('input')
  input.value = item.kind === 'skill'
    ? `${item.label} `
    : `请使用工具 ${item.name} 完成：`
  hideSlashMenu()
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
  autosize()
}

/* ── 个人知识 ─────────────────────────────────────────── */

const KNOWLEDGE_SOURCE_LABELS = { text: '手动', file: '文件', url: '网页' }

function knowledgeMeta(parts) {
  const meta = document.createElement('div')
  meta.className = 'task-meta'
  for (const part of parts) {
    if (typeof part !== 'string' || part.length === 0) continue
    const span = document.createElement('span')
    span.textContent = part
    meta.appendChild(span)
  }
  return meta
}

async function loadKnowledge() {
  try {
    const data = await api('/sv/api/knowledge')
    knowledgeDocs = Array.isArray(data.docs) ? data.docs : []
    if (knowledgeQuery.length > 0) {
      const res = await api(`/sv/api/knowledge/search?q=${encodeURIComponent(knowledgeQuery)}&limit=20`)
      knowledgeHits = Array.isArray(res.hits) ? res.hits : []
    } else {
      knowledgeHits = []
    }
    renderKnowledge()
  } catch (error) {
    const list = $('knowledge-list')
    list.innerHTML = ''
    const empty = document.createElement('div')
    empty.className = 'panel-empty'
    empty.textContent = `加载失败：${error?.message ?? String(error)}`
    list.appendChild(empty)
  }
}

function renderKnowledge() {
  $('knowledge-count').textContent = knowledgeDocs.length > 0 ? `共 ${knowledgeDocs.length} 篇` : ''
  $('knowledge-search-clear').hidden = knowledgeQuery.length === 0
  const list = $('knowledge-list')
  list.innerHTML = ''
  if (knowledgeQuery.length > 0) {
    const head = document.createElement('div')
    head.className = 'knowledge-section-head'
    head.textContent = `搜索结果 · ${knowledgeHits.length} 条`
    list.appendChild(head)
    if (knowledgeHits.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'panel-empty'
      empty.textContent = `没有找到与「${knowledgeQuery}」相关的片段。`
      list.appendChild(empty)
      return
    }
    for (const hit of knowledgeHits) list.appendChild(knowledgeHitNode(hit))
    return
  }
  if (knowledgeDocs.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'panel-empty'
    empty.textContent = '知识库是空的。导入笔记、工作区文件或网页后，对话会自动召回相关内容。'
    list.appendChild(empty)
    return
  }
  for (const doc of knowledgeDocs) list.appendChild(knowledgeDocNode(doc))
}

function knowledgeDocNode(doc) {
  const el = document.createElement('div')
  el.className = 'task-item knowledge-item'
  const main = document.createElement('div')
  main.className = 'task-main'
  const title = document.createElement('div')
  title.className = 'task-title'
  title.textContent = doc.title
  main.appendChild(title)
  main.appendChild(knowledgeMeta([
    `${KNOWLEDGE_SOURCE_LABELS[doc.sourceKind] ?? '来源'} · ${doc.source}`,
    `${doc.chars} 字`,
    `${doc.chunks} 块`,
    `更新 ${fmtDue(doc.updatedAt)}`,
  ]))
  el.appendChild(main)

  const actions = document.createElement('div')
  actions.className = 'task-actions'
  const view = document.createElement('button')
  view.type = 'button'
  view.className = 'panel-act'
  view.title = '查看全文'
  view.textContent = '查看'
  view.addEventListener('click', () => void openKnowledgeDoc(doc.id))
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'panel-act danger'
  remove.title = '删除文档'
  remove.textContent = '✕'
  remove.addEventListener('click', () => void deleteKnowledgeDoc(doc))
  actions.append(view, remove)
  el.appendChild(actions)
  return el
}

function knowledgeHitNode(hit) {
  const el = document.createElement('div')
  el.className = 'task-item knowledge-item'
  const main = document.createElement('div')
  main.className = 'task-main'
  const head = document.createElement('div')
  head.className = 'inbox-head'
  const kind = document.createElement('span')
  kind.className = 'inbox-kind inbox-kind-briefing'
  kind.textContent = '匹配'
  const title = document.createElement('div')
  title.className = 'task-title'
  title.textContent = hit.heading === undefined ? hit.title : `${hit.title} · ${hit.heading}`
  const time = document.createElement('span')
  time.className = 'inbox-time'
  time.textContent = hit.score.toFixed(1)
  head.append(kind, title, time)
  main.appendChild(head)
  main.appendChild(knowledgeMeta([
    `${KNOWLEDGE_SOURCE_LABELS[hit.sourceKind] ?? '来源'} · ${hit.source}`,
    `块 #${hit.chunkIndex + 1}`,
  ]))
  const snippet = document.createElement('div')
  snippet.className = 'knowledge-snippet'
  snippet.textContent = hit.snippet
  main.appendChild(snippet)
  el.appendChild(main)

  const actions = document.createElement('div')
  actions.className = 'task-actions'
  const view = document.createElement('button')
  view.type = 'button'
  view.className = 'panel-act'
  view.textContent = '全文'
  view.title = '查看全文'
  view.addEventListener('click', () => void openKnowledgeDoc(hit.docId))
  actions.appendChild(view)
  el.appendChild(actions)
  return el
}

async function openKnowledgeDoc(id) {
  try {
    const data = await api(`/sv/api/knowledge/${encodeURIComponent(id)}`)
    knowledgeDetail = data.doc ?? null
    renderKnowledgeDetail()
  } catch (error) {
    alert(`加载失败：${error?.message ?? error}`)
  }
}

function renderKnowledgeDetail() {
  const box = $('knowledge-detail')
  if (knowledgeDetail === null) {
    box.hidden = true
    return
  }
  box.hidden = false
  $('knowledge-detail-title').textContent = knowledgeDetail.title
  const meta = $('knowledge-detail-meta')
  meta.innerHTML = ''
  const parts = [
    `${KNOWLEDGE_SOURCE_LABELS[knowledgeDetail.sourceKind] ?? '来源'} · ${knowledgeDetail.source}`,
    `${knowledgeDetail.chars} 字`,
    `${knowledgeDetail.chunks.length} 块`,
    `更新 ${fmtDue(knowledgeDetail.updatedAt)}`,
  ]
  for (const part of parts) {
    const span = document.createElement('span')
    span.textContent = part
    meta.appendChild(span)
  }
  const chunks = $('knowledge-detail-chunks')
  chunks.innerHTML = ''
  for (const chunk of knowledgeDetail.chunks) {
    const el = document.createElement('div')
    el.className = 'knowledge-chunk'
    const head = document.createElement('div')
    head.className = 'task-meta'
    head.textContent = `#${chunk.index + 1}${chunk.heading ? ` · ${chunk.heading}` : ''}`
    const body = document.createElement('div')
    body.className = 'inbox-body'
    body.innerHTML = renderMarkdown(chunk.text)
    el.append(head, body)
    chunks.appendChild(el)
  }
  box.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function closeKnowledgeDetail() {
  knowledgeDetail = null
  renderKnowledgeDetail()
}

function setKnowledgeResult(text, ok) {
  const result = $('knowledge-import-result')
  result.textContent = text
  result.className = 'test-result' + (ok === undefined ? '' : ok ? ' ok' : ' err')
}

async function importKnowledge(body) {
  setKnowledgeResult('导入中…')
  try {
    const data = await api('/sv/api/knowledge', { method: 'POST', body })
    const doc = data.doc ?? {}
    setKnowledgeResult(`${data.duplicate ? '已更新' : '已导入'}：${doc.title ?? '文档'}（${doc.chunks ?? 0} 块）`, true)
    await loadKnowledge()
    return true
  } catch (error) {
    setKnowledgeResult(`导入失败：${error?.message ?? error}`, false)
    return false
  }
}

async function submitKnowledge(event) {
  event.preventDefault()
  const text = $('knowledge-text').value
  if (text.trim().length === 0) return
  const title = $('knowledge-title').value.trim()
  const source = $('knowledge-source').value.trim()
  const body = { text, ...(title.length > 0 ? { title } : {}), ...(source.length > 0 ? { source } : {}) }
  if (await importKnowledge(body)) {
    $('knowledge-text').value = ''
    $('knowledge-title').value = ''
    $('knowledge-source').value = ''
  }
}

async function submitKnowledgeFile(event) {
  event.preventDefault()
  const path = $('knowledge-path').value.trim()
  if (path.length === 0) return
  if (await importKnowledge({ path })) $('knowledge-path').value = ''
}

async function submitKnowledgeUrl(event) {
  event.preventDefault()
  const url = $('knowledge-url').value.trim()
  if (url.length === 0) return
  if (await importKnowledge({ url })) $('knowledge-url').value = ''
}

async function runKnowledgeSearch() {
  const query = $('knowledge-search').value.trim()
  knowledgeQuery = query
  if (query.length === 0) {
    knowledgeHits = []
    renderKnowledge()
    return
  }
  try {
    const data = await api(`/sv/api/knowledge/search?q=${encodeURIComponent(query)}&limit=20`)
    knowledgeHits = Array.isArray(data.hits) ? data.hits : []
    renderKnowledge()
  } catch (error) {
    alert(`搜索失败：${error?.message ?? error}`)
  }
}

function clearKnowledgeSearch() {
  $('knowledge-search').value = ''
  knowledgeQuery = ''
  knowledgeHits = []
  renderKnowledge()
}

async function deleteKnowledgeDoc(doc) {
  if (!confirm(`从知识库删除《${doc.title}》？删除后下一轮不再召回。`)) return
  try {
    await api(`/sv/api/knowledge/${encodeURIComponent(doc.id)}`, { method: 'DELETE' })
  } catch (error) {
    alert(`删除失败：${error?.message ?? error}`)
    return
  }
  if (knowledgeDetail !== null && knowledgeDetail.id === doc.id) closeKnowledgeDetail()
  await loadKnowledge()
}

/* ── 数据与备份 ───────────────────────────────────────── */

function formatUptime(ms) {
  const minutes = Math.floor(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes % 60} 分`
  return `${minutes} 分钟`
}

function setDataResult(text, ok) {
  const result = $('data-result')
  result.textContent = text
  result.className = 'test-result' + (ok === undefined ? '' : ok ? ' ok' : ' err')
}

function dataStat(label, value, hint) {
  const card = document.createElement('div')
  card.className = 'data-stat'
  const labelNode = document.createElement('div')
  labelNode.className = 'data-stat-label'
  labelNode.textContent = label
  const valueNode = document.createElement('div')
  valueNode.className = 'data-stat-value'
  valueNode.textContent = value
  card.appendChild(labelNode)
  card.appendChild(valueNode)
  if (typeof hint === 'string' && hint.length > 0) {
    const hintNode = document.createElement('div')
    hintNode.className = 'data-stat-hint'
    hintNode.textContent = hint
    card.appendChild(hintNode)
  }
  return card
}

async function loadDataStatus() {
  try {
    const data = await api('/sv/api/data')
    renderDataStatus(data.status)
  } catch (error) {
    const stats = $('data-stats')
    stats.innerHTML = ''
    const empty = document.createElement('div')
    empty.className = 'panel-empty'
    empty.textContent = `加载失败：${error?.message ?? String(error)}`
    stats.appendChild(empty)
  }
}

function renderDataStatus(status) {
  const stats = $('data-stats')
  stats.innerHTML = ''
  if (status === undefined) return
  const counts = status.counts ?? {}
  const usage = status.usage ?? {}
  stats.append(
    dataStat('会话', String(counts.sessions ?? 0)),
    dataStat('累计 tokens', formatTokens(usage.totalTokens ?? 0), `输入 ${formatTokens(usage.inputTokens ?? 0)} / 输出 ${formatTokens(usage.outputTokens ?? 0)}`),
    dataStat('长期记忆', String(counts.memories ?? 0)),
    dataStat('待办', `${counts.tasksPending ?? 0} 未完成`, `共 ${counts.tasksTotal ?? 0} 项`),
    dataStat('收件箱', `${counts.inboxUnread ?? 0} 未读`, `共 ${counts.inboxTotal ?? 0} 条`),
    dataStat('个人知识', `${counts.knowledgeDocs ?? 0} 篇`, `${counts.knowledgeChunks ?? 0} 个分块`),
    dataStat('自动化', `${counts.automations ?? 0} 个`, `${counts.automationRuns ?? 0} 次运行`),
    dataStat('可备份数据', formatBytes(status.backupBytes ?? 0), status.backend === 'postgres' ? '会话后端：Postgres' : '会话后端：本地文件'),
    dataStat('运行时长', formatUptime(status.uptimeMs ?? 0)),
  )

  const dir = document.createElement('div')
  dir.className = 'data-dir'
  dir.textContent = `数据目录：${status.dataDir ?? ''}`
  stats.appendChild(dir)

  const files = $('data-files')
  files.innerHTML = ''
  for (const file of status.files ?? []) {
    const row = document.createElement('div')
    row.className = 'task-item data-file-row'
    const main = document.createElement('div')
    main.className = 'task-main'
    const name = document.createElement('div')
    name.className = 'task-title'
    name.textContent = file.name
    const meta = document.createElement('div')
    meta.className = 'task-meta'
    meta.textContent = formatBytes(file.bytes ?? 0)
    main.append(name, meta)
    row.appendChild(main)
    if (file.backup !== true) {
      const badge = document.createElement('span')
      badge.className = 'inbox-kind inbox-kind-reminder'
      badge.textContent = '不备份'
      row.appendChild(badge)
    }
    files.appendChild(row)
  }
  const transcripts = document.createElement('div')
  transcripts.className = 'task-item data-file-row'
  const main = document.createElement('div')
  main.className = 'task-main'
  const name = document.createElement('div')
  name.className = 'task-title'
  name.textContent = `transcripts（${status.transcripts?.count ?? 0} 个文件）`
  const meta = document.createElement('div')
  meta.className = 'task-meta'
  meta.textContent = formatBytes(status.transcripts?.bytes ?? 0)
  main.append(name, meta)
  transcripts.appendChild(main)
  files.appendChild(transcripts)
  renderUsageCost(stats, files, status.usageCost)
}

/** 数据页的用量与费用区块（按天柱状 + 分模型汇总）。 */
function renderUsageCost(stats, files, snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return
  const totals = snapshot.totals ?? {}
  const cost = snapshot.cost ?? {}
  const budget = snapshot.budget ?? {}
  stats.append(
    dataStat('累计请求', String(totals.requests ?? 0), `输入 ${formatTokens(totals.inputTokens ?? 0)} / 输出 ${formatTokens(totals.outputTokens ?? 0)}`),
    dataStat('费用估算', String(cost.total ?? 0), `输入 ${cost.inputPerMillion ?? 0}/M · 输出 ${cost.outputPerMillion ?? 0}/M（按设置单价）`),
    dataStat('本月 tokens', formatTokens(budget.monthTokens ?? 0), Number(budget.monthlyTokenBudget) > 0
      ? `预算 ${formatTokens(budget.monthlyTokenBudget)}（${Math.round(budget.percent ?? 0)}%）`
      : '未设置月度预算'),
  )
  const days = Array.isArray(snapshot.days) ? snapshot.days : []
  if (days.length > 0) {
    const head = document.createElement('div')
    head.className = 'knowledge-section-head'
    head.textContent = '每日用量（最近 14 天）'
    files.appendChild(head)
    const max = Math.max(1, ...days.map(day => (day.totals?.inputTokens ?? 0) + (day.totals?.outputTokens ?? 0)))
    const bars = document.createElement('div')
    bars.className = 'usage-bars'
    for (const day of days) {
      const total = (day.totals?.inputTokens ?? 0) + (day.totals?.outputTokens ?? 0)
      const bar = document.createElement('div')
      bar.className = 'usage-bar'
      bar.title = `${day.day}：${formatTokens(total)} tokens`
      const fill = document.createElement('div')
      fill.className = 'usage-bar-fill'
      fill.style.height = `${Math.max(4, Math.round((total / max) * 100))}%`
      const label = document.createElement('div')
      label.className = 'usage-bar-label'
      label.textContent = day.day.slice(5)
      bar.append(fill, label)
      bars.appendChild(bar)
    }
    files.appendChild(bars)
  }
  const models = Object.entries(snapshot.byModel ?? {})
  if (models.length > 0) {
    const head = document.createElement('div')
    head.className = 'knowledge-section-head'
    head.textContent = '分模型用量'
    files.appendChild(head)
    const sorted = models.sort((a, b) => (b[1].inputTokens + b[1].outputTokens) - (a[1].inputTokens + a[1].outputTokens))
    for (const [model, item] of sorted) {
      const row = document.createElement('div')
      row.className = 'task-item data-file-row'
      const main = document.createElement('div')
      main.className = 'task-main'
      const name = document.createElement('div')
      name.className = 'task-title'
      name.textContent = model
      const meta = document.createElement('div')
      meta.className = 'task-meta'
      meta.textContent = `输入 ${formatTokens(item.inputTokens)} · 输出 ${formatTokens(item.outputTokens)} · ${item.requests} 次`
      main.append(name, meta)
      row.appendChild(main)
      files.appendChild(row)
    }
  }
}

async function exportBackup() {
  const domain = $('data-export-domain')?.value ?? 'all'
  setDataResult('正在打包…')
  try {
    const res = await fetch(`/sv/api/backup?domain=${encodeURIComponent(domain)}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const now = new Date()
    const pad = value => String(value).padStart(2, '0')
    const suffix = domain === 'all' ? 'backup' : `backup-${domain}`
    const filename = `sv-${suffix}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setDataResult(`备份已开始下载：${filename}`, true)
  } catch (error) {
    setDataResult(`导出失败：${error?.message ?? error}`, false)
  }
}

async function restoreBackupFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  setDataResult('读取备份中…')
  try {
    const text = await file.text()
    const bundle = JSON.parse(text)
    if (!bundle || bundle.version !== 1 || typeof bundle.files !== 'object') {
      throw new Error('不是有效的 SV 备份文件')
    }
    if (!confirm(`恢复 ${file.name} 会覆盖当前个人数据，且不可撤销。继续？`)) {
      setDataResult('已取消')
      return
    }
    setDataResult('恢复中…')
    const data = await api('/sv/api/data/restore', { method: 'POST', body: bundle })
    setDataResult(`已恢复 ${data.restored ?? 0} 个文件，正在刷新…`, true)
    localStorage.removeItem(STORE_KEY)
    localStorage.removeItem(ACTIVE_KEY)
    setTimeout(() => location.reload(), 600)
  } catch (error) {
    setDataResult(`恢复失败：${error?.message ?? error}`, false)
  }
}

async function clearPersonalData() {
  const domain = $('data-clear-domain').value
  const label = $('data-clear-domain').selectedOptions[0]?.textContent ?? domain
  const message = domain === 'all'
    ? '将清空全部个人数据（记忆、待办、收件箱、知识、自动化、会话投影），且不可撤销。继续？'
    : `将清空「${label}」，且不可撤销。继续？`
  if (!confirm(message)) return
  setDataResult('清空中…')
  try {
    await api('/sv/api/data/clear', { method: 'POST', body: { domain } })
    setDataResult(`已清空：${label}，正在刷新…`, true)
    if (domain === 'sessions' || domain === 'all') {
      localStorage.removeItem(STORE_KEY)
      localStorage.removeItem(ACTIVE_KEY)
    }
    setTimeout(() => location.reload(), 600)
  } catch (error) {
    setDataResult(`清空失败：${error?.message ?? error}`, false)
  }
}

/* ── 自动化 ───────────────────────────────────────────── */

const AUTOMATION_KIND_LABELS = { web: '网页变化', keyword: '关键词', prompt: '定时任务', rss: 'RSS' }
const AUTOMATION_RUN_LABELS = { ok: '成功', unchanged: '未变化', changed: '发现变化', matched: '命中', failed: '失败' }
const AUTOMATION_WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function automationScheduleLabel(entry) {
  const schedule = entry.schedule
  if (schedule.kind === 'interval') return `每 ${schedule.everyMinutes} 分钟`
  if (schedule.kind === 'daily') return `每天 ${schedule.at}`
  return `每${AUTOMATION_WEEKDAYS[schedule.weekday] ?? '周'} ${schedule.at}`
}

function setAutomationResult(text, ok) {
  const result = $('automation-result')
  result.textContent = text
  result.className = 'test-result' + (ok === undefined ? '' : ok ? ' ok' : ' err')
}

/** 把全局设置回填到表单。 */
function renderAutomationConfig() {
  $('automation-paused').checked = automationConfig.paused === true
  $('automation-quiet-start').value = automationConfig.quietStart ?? ''
  $('automation-quiet-end').value = automationConfig.quietEnd ?? ''
  $('automation-retry').value = String(automationConfig.retryAttempts ?? 0)
}

/** 保存全局设置（暂停 / 静默时段 / 重试）。 */
async function saveAutomationConfig(event) {
  event.preventDefault()
  const result = $('automation-global-result')
  result.textContent = '保存中…'
  result.className = 'test-result'
  try {
    const data = await api('/sv/api/automations/config', {
      method: 'POST',
      body: {
        paused: $('automation-paused').checked,
        quietStart: $('automation-quiet-start').value,
        quietEnd: $('automation-quiet-end').value,
        retryAttempts: Number($('automation-retry').value),
      },
    })
    if (data.config && typeof data.config === 'object') automationConfig = data.config
    renderAutomationConfig()
    result.textContent = '已保存'
    result.className = 'test-result ok'
  } catch (error) {
    result.textContent = `保存失败：${error?.message ?? error}`
    result.className = 'test-result err'
  }
}

async function loadAutomations() {
  try {
    const data = await api('/sv/api/automations')
    automationsCache = Array.isArray(data.automations) ? data.automations : []
    automationRuns = Array.isArray(data.runs) ? data.runs : []
    if (data.config && typeof data.config === 'object') automationConfig = data.config
    renderAutomationConfig()
    renderAutomations()
  } catch (error) {
    automationsCache = []
    automationRuns = []
    const list = $('automation-list')
    list.innerHTML = ''
    const empty = document.createElement('div')
    empty.className = 'panel-empty'
    empty.textContent = `加载失败：${error?.message ?? String(error)}`
    list.appendChild(empty)
    $('automation-runs').innerHTML = ''
  }
}

function renderAutomations() {
  $('automation-count').textContent = automationsCache.length > 0 ? `共 ${automationsCache.length} 个` : ''
  const list = $('automation-list')
  list.innerHTML = ''
  if (automationsCache.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'panel-empty'
    empty.textContent = '还没有自动化。可以监控网页变化、盯关键词，或每天定时执行一段任务。'
    list.appendChild(empty)
  } else {
    for (const entry of automationsCache) list.appendChild(automationNode(entry))
  }
  const runs = $('automation-runs')
  runs.innerHTML = ''
  if (automationRuns.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'panel-empty'
    empty.textContent = '还没有运行记录。'
    runs.appendChild(empty)
    return
  }
  for (const run of automationRuns.slice(0, 20)) runs.appendChild(automationRunNode(run))
}

function automationNode(entry) {
  const el = document.createElement('div')
  el.className = 'task-item automation-item'
  const main = document.createElement('div')
  main.className = 'task-main'
  const head = document.createElement('div')
  head.className = 'inbox-head'
  const kind = document.createElement('span')
  kind.className = 'inbox-kind inbox-kind-automation'
  kind.textContent = AUTOMATION_KIND_LABELS[entry.kind] ?? entry.kind
  const title = document.createElement('div')
  title.className = 'task-title'
  title.textContent = entry.title
  const state = document.createElement('span')
  state.className = 'inbox-time'
  state.textContent = entry.enabled ? '启用' : '已暂停'
  head.append(kind, title, state)
  main.appendChild(head)
  const meta = knowledgeMeta([
    automationScheduleLabel(entry),
    entry.enabled ? `下次 ${fmtDue(entry.nextRunAt)}` : '暂停中',
    entry.lastRunAt === undefined ? '从未运行' : `上次 ${fmtDue(entry.lastRunAt)}`,
  ])
  main.appendChild(meta)
  if (entry.lastSummary) {
    const summary = document.createElement('div')
    summary.className = 'knowledge-snippet'
    summary.textContent = entry.lastSummary
    main.appendChild(summary)
  }
  if (typeof entry.url === 'string' && entry.url.length > 0) {
    const url = document.createElement('div')
    url.className = 'task-meta automation-source'
    url.textContent = entry.url
    main.appendChild(url)
  }
  if (Array.isArray(entry.keywords) && entry.keywords.length > 0) {
    const keywords = document.createElement('div')
    keywords.className = 'task-meta'
    keywords.textContent = `关键词：${entry.keywords.join('、')}`
    main.appendChild(keywords)
  }
  if (entry.kind === 'prompt' && typeof entry.prompt === 'string' && entry.prompt.length > 0) {
    const prompt = document.createElement('div')
    prompt.className = 'knowledge-snippet'
    prompt.textContent = entry.prompt
    main.appendChild(prompt)
  }
  el.appendChild(main)

  const actions = document.createElement('div')
  actions.className = 'task-actions'
  const run = document.createElement('button')
  run.type = 'button'
  run.className = 'panel-act'
  run.title = '立即运行一次'
  run.textContent = automationRunningId === entry.id ? '运行中…' : '运行'
  run.disabled = automationRunningId !== null
  run.addEventListener('click', () => void runAutomation(entry))
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'panel-act'
  toggle.title = entry.enabled ? '暂停' : '恢复'
  toggle.textContent = entry.enabled ? '暂停' : '恢复'
  toggle.addEventListener('click', () => void toggleAutomation(entry))
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'panel-act danger'
  remove.title = '删除'
  remove.textContent = '✕'
  remove.addEventListener('click', () => void deleteAutomation(entry))
  actions.append(run, toggle, remove)
  el.appendChild(actions)
  return el
}

function automationRunNode(run) {
  const el = document.createElement('div')
  el.className = 'task-item automation-run-item'
  const main = document.createElement('div')
  main.className = 'task-main'
  const head = document.createElement('div')
  head.className = 'inbox-head'
  const status = document.createElement('span')
  status.className = `inbox-kind automation-run-${run.status}`
  status.textContent = AUTOMATION_RUN_LABELS[run.status] ?? run.status
  const title = document.createElement('div')
  title.className = 'task-title'
  title.textContent = run.title
  const time = document.createElement('span')
  time.className = 'inbox-time'
  time.textContent = fmtDue(run.finishedAt)
  head.append(status, title, time)
  main.appendChild(head)
  const duration = Math.max(0, (run.finishedAt - run.startedAt) / 1000)
  main.appendChild(knowledgeMeta([`耗时 ${duration.toFixed(1)} 秒`]))
  const summary = document.createElement('div')
  summary.className = 'knowledge-snippet'
  summary.textContent = run.error === undefined ? run.summary : `${run.summary}：${run.error}`
  main.appendChild(summary)
  el.appendChild(main)
  return el
}

async function runAutomation(entry) {
  if (automationRunningId !== null) return
  automationRunningId = entry.id
  setAutomationResult(`正在运行「${entry.title}」…`)
  renderAutomations()
  try {
    const data = await api(`/sv/api/automations/${encodeURIComponent(entry.id)}/run`, { method: 'POST' })
    const run = data.run ?? {}
    const label = AUTOMATION_RUN_LABELS[run.status] ?? run.status ?? '完成'
    setAutomationResult(`${label}：${run.summary ?? ''}`, run.status !== 'failed')
  } catch (error) {
    setAutomationResult(`运行失败：${error?.message ?? error}`, false)
  } finally {
    automationRunningId = null
    await loadAutomations()
  }
}

async function toggleAutomation(entry) {
  try {
    await api(`/sv/api/automations/${encodeURIComponent(entry.id)}`, {
      method: 'PATCH',
      body: { enabled: !entry.enabled },
    })
  } catch (error) {
    alert(`操作失败：${error?.message ?? error}`)
  }
  await loadAutomations()
}

async function deleteAutomation(entry) {
  if (!confirm(`删除自动化「${entry.title}」及其运行历史？`)) return
  try {
    await api(`/sv/api/automations/${encodeURIComponent(entry.id)}`, { method: 'DELETE' })
  } catch (error) {
    alert(`删除失败：${error?.message ?? error}`)
    return
  }
  await loadAutomations()
}

function syncAutomationForm() {
  const kind = $('automation-kind').value
  const scheduleKind = $('automation-schedule-kind').value
  $('automation-url-field').hidden = kind === 'prompt'
  $('automation-keywords-field').hidden = kind !== 'keyword'
  $('automation-prompt-field').hidden = kind !== 'prompt'
  $('automation-url').required = kind !== 'prompt'
  $('automation-keywords').required = kind === 'keyword'
  $('automation-prompt').required = kind === 'prompt'
  $('automation-interval-field').hidden = scheduleKind !== 'interval'
  $('automation-at-field').hidden = scheduleKind === 'interval'
  $('automation-weekday-field').hidden = scheduleKind !== 'weekly'
}

async function submitAutomation(event) {
  event.preventDefault()
  const kind = $('automation-kind').value
  const title = $('automation-title').value.trim()
  if (title.length === 0) return
  const scheduleKind = $('automation-schedule-kind').value
  const body = { kind, title, scheduleKind, email: $('automation-email').checked }
  if (kind !== 'prompt') body.url = $('automation-url').value.trim()
  if (kind === 'keyword') {
    body.keywords = $('automation-keywords').value
      .split(/[,，\n]/)
      .map(keyword => keyword.trim())
      .filter(keyword => keyword.length > 0)
  }
  if (kind === 'prompt') body.prompt = $('automation-prompt').value.trim()
  if (scheduleKind === 'interval') {
    body.everyMinutes = Number($('automation-interval').value)
  } else {
    body.at = $('automation-at').value || '08:30'
    if (scheduleKind === 'weekly') body.weekday = Number($('automation-weekday').value)
  }
  try {
    const data = await api('/sv/api/automations', { method: 'POST', body })
    setAutomationResult(`已创建：${data.automation?.title ?? title}`, true)
    $('automation-title').value = ''
    $('automation-url').value = ''
    $('automation-keywords').value = ''
    $('automation-prompt').value = ''
    await loadAutomations()
  } catch (error) {
    setAutomationResult(`创建失败：${error?.message ?? error}`, false)
  }
}

/* ── 审批中心 ─────────────────────────────────────────── */

const APPROVAL_OUTCOME_LABELS = {
  'allowed-once': '已批准',
  rejected: '已拒绝',
  cancelled: '已取消',
  unavailable: '自动拒绝',
}
const APPROVAL_DECIDED_LABELS = {
  user: '用户',
  timeout: '超时',
  aborted: '请求取消',
  'viewer-left': '页面关闭',
  restart: '进程重启',
  'no-answerer': '无页面在线',
}

async function loadApprovals() {
  try {
    const data = await api('/sv/api/approvals?status=all&limit=200')
    const all = Array.isArray(data.approvals) ? data.approvals : []
    approvalsPending = all.filter(item => item.outcome === undefined)
    approvalsHistory = all.filter(item => item.outcome !== undefined)
    approvalPendingCount = Number(data.pending) || approvalsPending.length
    renderApprovals()
    updateApprovalBadge(approvalPendingCount)
  } catch (error) {
    approvalsPending = []
    approvalsHistory = []
    const list = $('approval-pending')
    list.innerHTML = ''
    const empty = document.createElement('div')
    empty.className = 'panel-empty'
    empty.textContent = `加载失败：${error?.message ?? String(error)}`
    list.appendChild(empty)
    $('approval-history').innerHTML = ''
  }
}

function renderApprovals() {
  $('approval-count').textContent = approvalPendingCount > 0 ? `待处理 ${approvalPendingCount}` : ''
  const pending = $('approval-pending')
  pending.innerHTML = ''
  if (approvalsPending.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'panel-empty'
    empty.textContent = '没有待处理的审批。需要确认的工具操作会在这里出现。'
    pending.appendChild(empty)
  } else {
    for (const item of approvalsPending) pending.appendChild(approvalNode(item, true))
  }
  const history = $('approval-history')
  history.innerHTML = ''
  if (approvalsHistory.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'panel-empty'
    empty.textContent = '还没有审批历史。'
    history.appendChild(empty)
  } else {
    for (const item of approvalsHistory.slice(0, 100)) history.appendChild(approvalNode(item, false))
  }
}

function approvalNode(item, pending) {
  const el = document.createElement('div')
  el.className = 'task-item approval-item' + (pending ? ' unread' : '')
  const main = document.createElement('div')
  main.className = 'task-main'
  const head = document.createElement('div')
  head.className = 'inbox-head'
  const kind = document.createElement('span')
  kind.className = 'inbox-kind inbox-kind-reminder'
  kind.textContent = pending ? '待审批' : (APPROVAL_OUTCOME_LABELS[item.outcome] ?? item.outcome)
  const title = document.createElement('div')
  title.className = 'task-title'
  title.textContent = item.toolName
  const time = document.createElement('span')
  time.className = 'inbox-time'
  time.textContent = fmtDue(item.requestedAt)
  head.append(kind, title, time)
  main.appendChild(head)
  const meta = knowledgeMeta([
    item.sessionId === undefined ? '未知会话' : `会话 ${String(item.sessionId).slice(0, 8)}`,
    ...pending ? [] : [`${APPROVAL_DECIDED_LABELS[item.decidedBy] ?? item.decidedBy} · ${fmtDue(item.decidedAt)}`],
  ])
  main.appendChild(meta)
  if (typeof item.reason === 'string' && item.reason.length > 0) {
    const reason = document.createElement('div')
    reason.className = 'knowledge-snippet'
    reason.textContent = item.reason
    main.appendChild(reason)
  }
  el.appendChild(main)
  if (pending) {
    const actions = document.createElement('div')
    actions.className = 'task-actions'
    const allow = document.createElement('button')
    allow.type = 'button'
    allow.className = 'panel-act'
    allow.textContent = '批准'
    allow.addEventListener('click', () => void answerApproval(item.id, 'allowed-once'))
    const deny = document.createElement('button')
    deny.type = 'button'
    deny.className = 'panel-act danger'
    deny.textContent = '拒绝'
    deny.addEventListener('click', () => void answerApproval(item.id, 'rejected'))
    actions.append(allow, deny)
    el.appendChild(actions)
  }
  return el
}

async function answerApproval(id, outcome) {
  try {
    await api(`/sv/api/approvals/${encodeURIComponent(id)}/answer`, {
      method: 'POST',
      body: { outcome },
    })
  } catch (error) {
    alert(`审批失败：${error?.message ?? error}`)
  }
  document.querySelectorAll(`.approval-toast[data-id="${id}"]`).forEach(node => node.remove())
  await loadApprovals()
}

/** 侧栏红点：待处理审批数量。 */
function updateApprovalBadge(count) {
  approvalPendingCount = Math.max(0, Number(count) || 0)
  const tab = $('tab-approvals')
  tab.querySelector('.dot')?.remove()
  if (approvalPendingCount > 0) {
    const dot = document.createElement('span')
    dot.className = 'dot'
    tab.appendChild(dot)
  }
  $('approval-count').textContent = approvalPendingCount > 0 ? `待处理 ${approvalPendingCount}` : ''
}

/** 审批卡片：常驻，直到用户批准/拒绝或关闭。 */
function showApprovalToast(item) {
  document.querySelectorAll(`.approval-toast[data-id="${item.id}"]`).forEach(node => node.remove())
  const toast = document.createElement('div')
  toast.className = 'reminder-toast approval-toast'
  toast.dataset.id = item.id
  const title = document.createElement('div')
  title.className = 'rt-title'
  title.textContent = `🔐 需要审批：${item.toolName}`
  toast.appendChild(title)
  if (typeof item.reason === 'string' && item.reason.length > 0) {
    const reason = document.createElement('div')
    reason.className = 'approval-reason'
    reason.textContent = item.reason
    toast.appendChild(reason)
  }
  const actions = document.createElement('div')
  actions.className = 'rt-actions'
  const allow = document.createElement('button')
  allow.type = 'button'
  allow.className = 'btn btn-primary'
  allow.textContent = '批准'
  allow.addEventListener('click', () => void answerApproval(item.id, 'allowed-once'))
  const deny = document.createElement('button')
  deny.type = 'button'
  deny.className = 'btn btn-ghost'
  deny.textContent = '拒绝'
  deny.addEventListener('click', () => void answerApproval(item.id, 'rejected'))
  const view = document.createElement('button')
  view.type = 'button'
  view.className = 'btn btn-ghost'
  view.textContent = '审批中心'
  view.addEventListener('click', () => {
    toast.remove()
    applyView('approvals')
  })
  actions.append(allow, deny, view)
  toast.appendChild(actions)
  document.body.appendChild(toast)
}

function handleApprovalEvent(payload) {
  updateApprovalBadge(Number(payload.pending) || 0)
  if (currentView === 'approvals') void loadApprovals()
  if (payload.action === 'asked' && payload.item && currentView !== 'approvals') {
    showApprovalToast(payload.item)
  }
}

/* ── 连接器（只读） ───────────────────────────────────── */

const CONNECTOR_SPECS = {
  ics: {
    label: '日历订阅 (ICS)',
    fields: [
      { key: 'url', label: 'ICS 地址', type: 'url', required: true, placeholder: 'https://calendar.google.com/calendar/ical/.../basic.ics' },
    ],
  },
  rss: {
    label: 'RSS / Atom',
    fields: [
      { key: 'url', label: 'Feed 地址', type: 'url', required: true, placeholder: 'https://example.com/feed.xml' },
    ],
  },
  slack: {
    label: 'Slack',
    fields: [
      { key: 'token', label: 'User / Bot Token', type: 'password', required: true, placeholder: 'xoxp-…' },
      { key: 'channels', label: '频道 ID 或名称（逗号分隔，留空取前 10 个）', type: 'text' },
    ],
  },
  notion: {
    label: 'Notion',
    fields: [
      { key: 'token', label: 'Integration Token', type: 'password', required: true },
      { key: 'databaseId', label: '数据库 ID（可选）', type: 'text' },
      { key: 'query', label: '搜索词（可选）', type: 'text' },
    ],
  },
  gmail: {
    label: 'Gmail',
    fields: [
      { key: 'clientId', label: 'OAuth Client ID', type: 'text', required: true },
      { key: 'clientSecret', label: 'OAuth Client Secret', type: 'password', required: true },
      { key: 'refreshToken', label: 'Refresh Token', type: 'password', required: true },
      { key: 'query', label: 'Gmail 搜索条件（可选，如 from:acme）', type: 'text' },
    ],
  },
  gcal: {
    label: 'Google Calendar',
    fields: [
      { key: 'clientId', label: 'OAuth Client ID', type: 'text', required: true },
      { key: 'clientSecret', label: 'OAuth Client Secret', type: 'password', required: true },
      { key: 'refreshToken', label: 'Refresh Token', type: 'password', required: true },
      { key: 'calendarId', label: 'Calendar ID（默认 primary）', type: 'text' },
    ],
  },
  outlook: {
    label: 'Outlook (Graph)',
    fields: [
      { key: 'tenantId', label: 'Tenant ID（默认 common）', type: 'text' },
      { key: 'clientId', label: 'OAuth Client ID', type: 'text', required: true },
      { key: 'clientSecret', label: 'OAuth Client Secret', type: 'password', required: true },
      { key: 'refreshToken', label: 'Refresh Token', type: 'password', required: true },
      {
        key: 'resource',
        label: '资源',
        type: 'select',
        default: 'mail',
        options: [{ value: 'mail', label: '邮件' }, { value: 'calendar', label: '日历' }],
      },
    ],
  },
}

const CONNECTOR_KIND_LABELS = Object.fromEntries(Object.entries(CONNECTOR_SPECS).map(([kind, spec]) => [kind, spec.label]))

function renderConnectorFields() {
  const kind = $('connector-kind').value
  const spec = CONNECTOR_SPECS[kind]
  const box = $('connector-fields')
  box.innerHTML = ''
  if (spec === undefined) return
  for (const field of spec.fields) {
    const label = document.createElement('label')
    label.className = 'field'
    const span = document.createElement('span')
    span.textContent = field.label
    label.appendChild(span)
    let input
    if (field.type === 'select') {
      input = document.createElement('select')
      for (const option of field.options ?? []) {
        const node = document.createElement('option')
        node.value = option.value
        node.textContent = option.label
        input.appendChild(node)
      }
      if (field.default !== undefined) input.value = field.default
    } else {
      input = document.createElement('input')
      input.type = field.type ?? 'text'
      if (field.placeholder !== undefined) input.placeholder = field.placeholder
      input.required = field.required === true
      input.autocomplete = 'off'
      if (field.default !== undefined) input.value = field.default
    }
    input.dataset.key = field.key
    label.appendChild(input)
    box.appendChild(label)
  }
}

function connectorSettingsFromForm() {
  const kind = $('connector-kind').value
  const spec = CONNECTOR_SPECS[kind]
  const settings = {}
  for (const field of spec?.fields ?? []) {
    const input = $('connector-fields').querySelector(`[data-key="${field.key}"]`)
    if (!input) continue
    const value = String(input.value ?? '').trim()
    if (value.length > 0) settings[field.key] = value
  }
  return settings
}

async function loadConnectors() {
  try {
    const params = new URLSearchParams()
    params.set('limit', '100')
    if (connectorEventsQuery.length > 0) params.set('q', connectorEventsQuery)
    const [list, events] = await Promise.all([
      api('/sv/api/connectors'),
      api(`/sv/api/connectors/events?${params.toString()}`),
    ])
    connectorsCache = Array.isArray(list.connectors) ? list.connectors : []
    connectorEvents = Array.isArray(events.events) ? events.events : []
    renderConnectors()
    renderConnectorEvents()
  } catch (error) {
    connectorsCache = []
    connectorEvents = []
    const list = $('connector-list')
    list.innerHTML = ''
    const empty = document.createElement('div')
    empty.className = 'panel-empty'
    empty.textContent = `加载失败：${error?.message ?? String(error)}`
    list.appendChild(empty)
    $('connector-events').innerHTML = ''
  }
}

function renderConnectors() {
  $('connector-count').textContent = connectorsCache.length > 0 ? `共 ${connectorsCache.length} 个` : ''
  const list = $('connector-list')
  list.innerHTML = ''
  if (connectorsCache.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'panel-empty'
    empty.textContent = '还没有连接器。可以先接入一个 ICS 日历或 RSS，不需要 OAuth。'
    list.appendChild(empty)
    return
  }
  for (const connector of connectorsCache) list.appendChild(connectorNode(connector))
}

function connectorNode(connector) {
  const el = document.createElement('div')
  el.className = 'task-item connector-item'
  const main = document.createElement('div')
  main.className = 'task-main'
  const head = document.createElement('div')
  head.className = 'inbox-head'
  const kind = document.createElement('span')
  kind.className = 'inbox-kind inbox-kind-briefing'
  kind.textContent = CONNECTOR_SPECS[connector.kind]?.label ?? connector.kind
  const title = document.createElement('div')
  title.className = 'task-title'
  title.textContent = connector.name
  const state = document.createElement('span')
  state.className = 'inbox-time'
  state.textContent = connector.enabled ? '启用' : '已暂停'
  head.append(kind, title, state)
  main.appendChild(head)
  const meta = knowledgeMeta([
    `每 ${connector.everyMinutes} 分钟`,
    `首次 ${connector.initialDays} 天`,
    connector.lastSyncAt === undefined ? '尚未同步' : `上次 ${fmtDue(connector.lastSyncAt)}`,
    ...connector.lastAdded === undefined ? [] : [`上次新增 ${connector.lastAdded}`],
  ])
  main.appendChild(meta)
  if (connector.configuredSecrets.length > 0) {
    const secrets = document.createElement('div')
    secrets.className = 'task-meta'
    secrets.textContent = `密钥已配置：${connector.configuredSecrets.join('、')}`
    main.appendChild(secrets)
  }
  if (connector.lastError) {
    const error = document.createElement('div')
    error.className = 'knowledge-snippet connector-error'
    error.textContent = `最近错误：${connector.lastError}`
    main.appendChild(error)
  }
  el.appendChild(main)

  const actions = document.createElement('div')
  actions.className = 'task-actions'
  const run = document.createElement('button')
  run.type = 'button'
  run.className = 'panel-act'
  run.textContent = connectorRunningId === connector.id ? '同步中…' : '同步'
  run.disabled = connectorRunningId !== null
  run.addEventListener('click', () => void runConnector(connector))
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'panel-act'
  toggle.textContent = connector.enabled ? '暂停' : '恢复'
  toggle.addEventListener('click', () => void toggleConnector(connector))
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'panel-act danger'
  remove.textContent = '✕'
  remove.title = '删除连接器'
  remove.addEventListener('click', () => void deleteConnector(connector))
  actions.append(run, toggle, remove)
  el.appendChild(actions)
  return el
}

function renderConnectorEvents() {
  const list = $('connector-events')
  list.innerHTML = ''
  if (connectorEvents.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'panel-empty'
    empty.textContent = connectorEventsQuery.length > 0 ? '没有匹配的事件。' : '还没有事件。连接器同步成功后，最近的邮件/日程/消息会出现在这里。'
    list.appendChild(empty)
    return
  }
  for (const event of connectorEvents) list.appendChild(connectorEventNode(event))
}

function connectorEventNode(event) {
  const el = document.createElement('div')
  el.className = 'task-item connector-event' + (event.readAt === undefined ? ' unread' : '')
  const main = document.createElement('div')
  main.className = 'task-main'
  const head = document.createElement('div')
  head.className = 'inbox-head'
  const source = document.createElement('span')
  source.className = 'inbox-kind inbox-kind-automation'
  source.textContent = CONNECTOR_KIND_LABELS[event.source] ?? event.source
  const title = document.createElement('div')
  title.className = 'task-title'
  title.textContent = event.title
  const time = document.createElement('span')
  time.className = 'inbox-time'
  time.textContent = fmtDue(event.occurredAt)
  head.append(source, title, time)
  main.appendChild(head)
  main.appendChild(knowledgeMeta([
    event.connectorName,
    ...(event.author === undefined ? [] : [event.author]),
  ]))
  if (event.body.length > 0) {
    const body = document.createElement('div')
    body.className = 'connector-event-body'
    body.textContent = event.body.length > 280 ? `${event.body.slice(0, 280)}…` : event.body
    main.appendChild(body)
  }
  el.appendChild(main)

  const actions = document.createElement('div')
  actions.className = 'task-actions'
  if (event.url !== undefined) {
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'panel-act'
    open.textContent = '打开'
    open.addEventListener('click', () => window.open(event.url, '_blank', 'noopener'))
    actions.appendChild(open)
  }
  if (event.readAt === undefined) {
    const read = document.createElement('button')
    read.type = 'button'
    read.className = 'panel-act'
    read.textContent = '已读'
    read.addEventListener('click', () => void markConnectorEventRead(event.id))
    actions.appendChild(read)
  }
  if (actions.children.length > 0) el.appendChild(actions)
  return el
}

async function submitConnector(event) {
  event.preventDefault()
  const kind = $('connector-kind').value
  const name = $('connector-name').value.trim()
  const result = $('connector-result')
  result.textContent = '添加中…'
  result.className = 'test-result'
  try {
    const data = await api('/sv/api/connectors', {
      method: 'POST',
      body: {
        kind,
        name,
        settings: connectorSettingsFromForm(),
        everyMinutes: Number($('connector-interval').value),
        initialDays: Number($('connector-days').value),
      },
    })
    result.textContent = `已添加：${data.connector?.name ?? name}（稍后自动开始首次同步）`
    result.className = 'test-result ok'
    $('connector-name').value = ''
    await loadConnectors()
  } catch (error) {
    result.textContent = `添加失败：${error?.message ?? error}`
    result.className = 'test-result err'
  }
}

async function testConnector() {
  const result = $('connector-result')
  result.textContent = '测试中…'
  result.className = 'test-result'
  try {
    const data = await api('/sv/api/connectors/test', {
      method: 'POST',
      body: { kind: $('connector-kind').value, settings: connectorSettingsFromForm() },
    })
    if (data.ok !== true) throw new Error(data.error ?? '测试失败')
    result.textContent = `测试通过：拉取 ${data.count} 条${data.title === undefined ? '' : ` · ${data.title}`}`
    result.className = 'test-result ok'
  } catch (error) {
    result.textContent = `测试失败：${error?.message ?? error}`
    result.className = 'test-result err'
  }
}

async function runConnector(connector) {
  if (connectorRunningId !== null) return
  connectorRunningId = connector.id
  const result = $('connector-result')
  result.textContent = `正在同步「${connector.name}」…`
  result.className = 'test-result'
  renderConnectors()
  try {
    const data = await api(`/sv/api/connectors/${encodeURIComponent(connector.id)}/run`, { method: 'POST' })
    result.textContent = `同步完成：新增 ${data.added ?? 0} 条${data.note === undefined ? '' : `（${data.note}）`}`
    result.className = 'test-result ok'
  } catch (error) {
    result.textContent = `同步失败：${error?.message ?? error}`
    result.className = 'test-result err'
  } finally {
    connectorRunningId = null
    await loadConnectors()
  }
}

async function toggleConnector(connector) {
  try {
    await api(`/sv/api/connectors/${encodeURIComponent(connector.id)}`, {
      method: 'PATCH',
      body: { enabled: !connector.enabled },
    })
  } catch (error) {
    alert(`操作失败：${error?.message ?? error}`)
  }
  await loadConnectors()
}

async function deleteConnector(connector) {
  if (!confirm(`删除连接器「${connector.name}」及其事件？`)) return
  try {
    await api(`/sv/api/connectors/${encodeURIComponent(connector.id)}`, { method: 'DELETE' })
  } catch (error) {
    alert(`删除失败：${error?.message ?? error}`)
    return
  }
  await loadConnectors()
}

async function markConnectorEventRead(id) {
  try {
    await api(`/sv/api/connectors/events/${encodeURIComponent(id)}/read`, { method: 'POST' })
  } catch (error) {
    alert(`标记失败：${error?.message ?? error}`)
  }
  await loadConnectors()
}

async function markAllConnectorEventsRead() {
  try {
    await api('/sv/api/connectors/events/read-all', { method: 'POST', body: {} })
  } catch (error) {
    alert(`操作失败：${error?.message ?? error}`)
  }
  await loadConnectors()
}

async function clearConnectorEvents() {
  if (!confirm('清空全部连接器事件？连接器本身会保留，下次同步会重新拉取最近数据。')) return
  try {
    await api('/sv/api/connectors/events', { method: 'DELETE' })
  } catch (error) {
    alert(`清空失败：${error?.message ?? error}`)
  }
  await loadConnectors()
}

function handleConnectorEvent(payload) {
  if (currentView === 'connectors') void loadConnectors()
  if (payload.action === 'synced' && Number(payload.added) > 0) {
    showConnectorToast(payload)
  }
}

function showConnectorToast(payload) {
  for (const node of document.querySelectorAll('.connector-toast')) node.remove()
  const toast = document.createElement('div')
  toast.className = 'reminder-toast connector-toast'
  const title = document.createElement('div')
  title.className = 'rt-title'
  title.textContent = `🔌 ${payload.name ?? '连接器'} 新增 ${payload.added} 条`
  toast.appendChild(title)
  const actions = document.createElement('div')
  actions.className = 'rt-actions'
  const view = document.createElement('button')
  view.type = 'button'
  view.className = 'btn btn-primary'
  view.textContent = '查看'
  view.addEventListener('click', () => {
    toast.remove()
    applyView('connectors')
  })
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'btn btn-ghost'
  close.textContent = '知道了'
  close.addEventListener('click', () => toast.remove())
  actions.append(view, close)
  toast.appendChild(actions)
  document.body.appendChild(toast)
  setTimeout(() => toast.remove(), 60_000)
}

/* ── 收件箱 ───────────────────────────────────────────── */

const INBOX_KIND_LABELS = { briefing: '简报', reminder: '提醒', agent: '助手', automation: '自动化', system: '系统' }

async function loadInbox() {
  const params = new URLSearchParams()
  if (inboxKindFilter) params.set('kind', inboxKindFilter)
  if (inboxUnreadOnly) params.set('unread', '1')
  params.set('limit', '100')
  try {
    const data = await api(`/sv/api/inbox?${params.toString()}`)
    inboxCache = Array.isArray(data.items) ? data.items : []
    updateInboxBadge(Number(data.unread) || 0)
    renderInbox()
  } catch (error) {
    const list = $('inbox-list')
    list.innerHTML = ''
    const empty = document.createElement('div')
    empty.className = 'panel-empty'
    empty.textContent = `加载失败：${error?.message ?? String(error)}`
    list.appendChild(empty)
  }
}

/** 侧栏红点与面板头部的未读计数。 */
function updateInboxBadge(count) {
  inboxUnread = count
  const tab = $('tab-inbox')
  tab.querySelector('.dot')?.remove()
  if (count > 0) {
    const dot = document.createElement('span')
    dot.className = 'dot'
    tab.appendChild(dot)
  }
  $('inbox-count').textContent = count > 0 ? `未读 ${count}` : ''
}

function renderInbox() {
  const list = $('inbox-list')
  list.innerHTML = ''
  if (inboxCache.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'panel-empty'
    empty.textContent = '收件箱是空的。每日简报到点会自动生成；后台完成的任务也会出现在这里。'
    list.appendChild(empty)
    return
  }
  for (const item of inboxCache) list.appendChild(inboxNode(item))
}

function inboxNode(item) {
  const el = document.createElement('div')
  el.className = 'task-item inbox-item' + (item.read ? '' : ' unread')

  const main = document.createElement('div')
  main.className = 'task-main'
  const head = document.createElement('div')
  head.className = 'inbox-head'
  const kind = document.createElement('span')
  kind.className = `inbox-kind inbox-kind-${item.kind}`
  kind.textContent = INBOX_KIND_LABELS[item.kind] ?? item.kind
  const title = document.createElement('div')
  title.className = 'task-title'
  title.textContent = item.title
  const time = document.createElement('span')
  time.className = 'inbox-time'
  time.textContent = fmtDue(item.createdAt)
  head.append(kind, title, time)
  main.appendChild(head)

  const body = document.createElement('div')
  body.className = 'inbox-body'
  body.hidden = true
  body.innerHTML = renderMarkdown(item.body && item.body.length > 0 ? item.body : '（无正文）')
  main.appendChild(body)

  const meta = document.createElement('div')
  meta.className = 'task-meta'
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'panel-act inbox-toggle'
  toggle.textContent = '展开'
  toggle.addEventListener('click', (event) => {
    event.stopPropagation()
    body.hidden = !body.hidden
    toggle.textContent = body.hidden ? '展开' : '收起'
    if (!body.hidden && !item.read) {
      el.classList.remove('unread')
      void setInboxRead(item, true, false)
    }
  })
  meta.appendChild(toggle)
  if (typeof item.sessionId === 'string' && item.sessionId.length > 0) {
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'panel-act'
    open.textContent = '打开会话'
    open.addEventListener('click', (event) => {
      event.stopPropagation()
      openInboxSession(item)
    })
    meta.appendChild(open)
  }
  main.appendChild(meta)
  el.appendChild(main)

  const actions = document.createElement('div')
  actions.className = 'task-actions'
  const read = document.createElement('button')
  read.type = 'button'
  read.className = 'panel-act'
  read.title = item.read ? '标记未读' : '标记已读'
  read.textContent = item.read ? '↺' : '✓'
  read.addEventListener('click', () => void setInboxRead(item, !item.read, true))
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'panel-act danger'
  remove.title = '删除'
  remove.textContent = '✕'
  remove.addEventListener('click', () => void deleteInbox(item))
  actions.append(read, remove)
  el.appendChild(actions)
  return el
}

async function setInboxRead(item, read, rerender) {
  try {
    const data = await api(`/sv/api/inbox/${encodeURIComponent(item.id)}/read`, {
      method: 'POST',
      body: { read },
    })
    if (data.item) {
      item.read = data.item.read === true
      item.readAt = data.item.readAt
    }
    updateInboxBadge(Number(data.unread) || 0)
  } catch (error) {
    alert(`操作失败：${error?.message ?? error}`)
  }
  if (rerender) renderInbox()
}

async function deleteInbox(item) {
  if (!confirm(`删除「${item.title}」？`)) return
  try {
    const data = await api(`/sv/api/inbox/${encodeURIComponent(item.id)}`, { method: 'DELETE' })
    updateInboxBadge(Number(data.unread) || 0)
  } catch (error) {
    alert(`删除失败：${error?.message ?? error}`)
  }
  await loadInbox()
}

async function markAllInboxRead() {
  try {
    const data = await api('/sv/api/inbox/read-all', { method: 'POST' })
    updateInboxBadge(Number(data.unread) || 0)
  } catch (error) {
    alert(`操作失败：${error?.message ?? error}`)
  }
  await loadInbox()
}

/** 从收件箱跳到关联会话；本地没有索引时先放占位，由 hydrateConversation 补齐。 */
function openInboxSession(item) {
  if (typeof item.sessionId !== 'string' || item.sessionId.length === 0) return
  if (!conversations.some(conv => conv.id === item.sessionId)) {
    conversations.unshift({
      id: item.sessionId,
      title: '收件箱关联会话',
      messages: [],
      updatedAt: item.createdAt ?? Date.now(),
    })
    saveConversations()
  }
  selectConversation(item.sessionId)
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
        else if (payload?.type === 'inbox') handleInboxEvent(payload)
        else if (payload?.type === 'approval') handleApprovalEvent(payload)
        else if (payload?.type === 'connector') handleConnectorEvent(payload)
      } catch { /* 忽略坏帧 */ }
    }
    es.onerror = () => {
      // 浏览器 EventSource 会自动重连；这里只需避免未处理告警
    }
  } catch {
    // 不支持 EventSource 时静默跳过（仍可在待办页看到逾期）
  }
}

/** 收件箱 SSE：更新红点，并在页面内提示新简报/后台结果。 */
function handleInboxEvent(payload) {
  updateInboxBadge(Number(payload.unread) || 0)
  // 静默时段产生的条目只进列表，不弹提示。
  if (payload.action === 'add' && payload.item && payload.item.kind !== 'reminder' && payload.item.silent !== true) {
    showInboxToast(payload.item)
  }
  if (currentView === 'inbox') void loadInbox()
}

function showInboxToast(item) {
  for (const node of document.querySelectorAll('.inbox-toast')) node.remove()
  if (currentView === 'inbox') return
  const toast = document.createElement('div')
  toast.className = 'reminder-toast inbox-toast'
  const title = document.createElement('div')
  title.className = 'rt-title'
  const label = INBOX_KIND_LABELS[item.kind] ?? '消息'
  const text = String(item.title ?? '')
  title.textContent = `📥 新${label}：${text.length <= 40 ? text : `${text.slice(0, 40)}…`}`
  toast.appendChild(title)
  const actions = document.createElement('div')
  actions.className = 'rt-actions'
  const view = document.createElement('button')
  view.type = 'button'
  view.className = 'btn btn-primary'
  view.textContent = '查看'
  view.addEventListener('click', () => {
    toast.remove()
    applyView('inbox')
    void loadInbox()
  })
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'btn btn-ghost'
  close.textContent = '知道了'
  close.addEventListener('click', () => toast.remove())
  actions.append(view, close)
  toast.appendChild(actions)
  document.body.appendChild(toast)
  setTimeout(() => toast.remove(), 10 * 60 * 1000)
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
$('attach').addEventListener('click', () => $('image-input').click())
$('image-input').addEventListener('change', (event) => {
  void addImageFiles(event.target.files ?? [])
  event.target.value = ''
})
$('input').addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files ?? [])].filter(file => file.type.startsWith('image/'))
  if (files.length === 0) return
  event.preventDefault()
  void addImageFiles(files)
})
$('input').addEventListener('input', autosize)
$('input').addEventListener('input', updateSlashMenu)
$('input').addEventListener('blur', () => setTimeout(hideSlashMenu, 120))
$('slash-menu').addEventListener('mousedown', (event) => {
  const button = event.target.closest('.slash-item')
  if (!button) return
  event.preventDefault()
  const item = slashItems[Number(button.dataset.index)]
  if (item) selectSlashItem(item)
})
$('input').addEventListener('keydown', (e) => {
  if (slashMenuOpen) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveSlashSelection(1)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveSlashSelection(-1)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      hideSlashMenu()
      return
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      const item = slashItems[slashIndex]
      if (item) selectSlashItem(item)
      return
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    sendMessage()
  }
})
/** 窄屏抽屉：打开时显示遮罩，关闭时一并收起。 */
const narrowMedia = window.matchMedia('(max-width: 900px)')
function isNarrow() {
  return narrowMedia.matches
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
// 窗口缩到窄屏时自动收起抽屉；重新变宽时清理 open 状态，避免下次缩小时又自动弹出。
narrowMedia.addEventListener('change', () => setSidebarOpen(false))
if (isNarrow()) setSidebarOpen(false)
/** 窄屏下选中视图后收起抽屉，避免继续遮挡主区。 */
function closeSidebarDrawer() {
  if (isNarrow()) setSidebarOpen(false)
}
document.querySelectorAll('.nav-item').forEach(item => {
  if (item.id === 'new-chat') return
  item.addEventListener('click', () => applyView(item.dataset.view ?? 'chat'))
})
$('toggle-more-nav').addEventListener('click', () => setNavMore(!navMoreExpanded))
$('sa-form').addEventListener('submit', submitSuperAgent)
$('sa-stop').addEventListener('click', () => void stopSuperAgent())
$('sa-history').addEventListener('change', event => {
  const run = saRuns.find(candidate => candidate.id === event.target.value)
  if (run) {
    saRun = run
    scheduleSaRender()
  }
})
$('task-form').addEventListener('submit', submitTask)
$('tasks-show-done').addEventListener('change', () => void loadTasks())
$('inbox-refresh').addEventListener('click', () => void loadInbox())
$('inbox-read-all').addEventListener('click', () => void markAllInboxRead())
$('inbox-kind-filter').addEventListener('click', (event) => {
  const chip = event.target.closest('.kchip')
  if (!chip) return
  inboxKindFilter = chip.dataset.kind ?? ''
  $('inbox-kind-filter').querySelectorAll('.kchip').forEach(node => {
    node.classList.toggle('active', node === chip)
  })
  void loadInbox()
})
$('inbox-unread-only').addEventListener('change', () => {
  inboxUnreadOnly = $('inbox-unread-only').checked
  void loadInbox()
})
$('knowledge-refresh').addEventListener('click', () => void loadKnowledge())
$('knowledge-form').addEventListener('submit', submitKnowledge)
$('knowledge-file-form').addEventListener('submit', submitKnowledgeFile)
$('knowledge-url-form').addEventListener('submit', submitKnowledgeUrl)
$('knowledge-search-btn').addEventListener('click', () => void runKnowledgeSearch())
$('knowledge-search').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault()
    void runKnowledgeSearch()
  }
})
$('knowledge-search-clear').addEventListener('click', clearKnowledgeSearch)
$('knowledge-detail-close').addEventListener('click', closeKnowledgeDetail)
$('schedule-refresh').addEventListener('click', () => void loadSchedules())
$('automation-refresh').addEventListener('click', () => void loadAutomations())
$('automation-form').addEventListener('submit', submitAutomation)
$('automation-kind').addEventListener('change', syncAutomationForm)
$('automation-schedule-kind').addEventListener('change', syncAutomationForm)
$('automation-global-form').addEventListener('submit', saveAutomationConfig)
syncAutomationForm()
$('approval-refresh').addEventListener('click', () => void loadApprovals())
$('approval-clear').addEventListener('click', async () => {
  if (!confirm('清空审批历史？正在等待的审批不会受影响。')) return
  try {
    await api('/sv/api/approvals/clear', { method: 'POST', body: {} })
  } catch (error) {
    alert(`清空失败：${error?.message ?? error}`)
  }
  await loadApprovals()
})
$('connector-refresh').addEventListener('click', () => void loadConnectors())
$('connector-kind').addEventListener('change', renderConnectorFields)
$('connector-form').addEventListener('submit', submitConnector)
$('connector-test').addEventListener('click', () => void testConnector())
$('connector-read-all').addEventListener('click', () => void markAllConnectorEventsRead())
$('connector-event-clear').addEventListener('click', () => void clearConnectorEvents())
$('connector-event-search').addEventListener('input', (event) => {
  connectorEventsQuery = event.target.value.trim()
  void loadConnectors()
})
renderConnectorFields()
$('conv-search').addEventListener('input', onConvSearchInput)
$('conv-search-clear').addEventListener('click', () => {
  $('conv-search').value = ''
  $('conv-search-clear').hidden = true
  renderConvSearchResults([], '')
})
$('messages').addEventListener('click', onMessageAreaClick)
$('data-refresh').addEventListener('click', () => void loadDataStatus())
$('data-export').addEventListener('click', () => void exportBackup())
$('data-restore').addEventListener('click', () => $('data-restore-input').click())
$('data-restore-input').addEventListener('change', event => void restoreBackupFile(event))
$('data-clear').addEventListener('click', () => void clearPersonalData())
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
$('file-preview-close').addEventListener('click', () => $('file-preview').close())
$('file-preview').addEventListener('click', (event) => {
  if (event.target === $('file-preview')) $('file-preview').close()
})
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
$('cfg-brief-enabled').addEventListener('change', () => {
  $('cfg-brief-time').disabled = !$('cfg-brief-enabled').checked
})
$('brief-run').addEventListener('click', async () => {
  const result = $('brief-run-result')
  result.textContent = '生成中…'
  result.className = 'test-result'
  try {
    const data = await api('/sv/api/briefing/run', { method: 'POST' })
    result.className = 'test-result ok'
    result.textContent = '已生成，可在收件箱查看'
    updateInboxBadge(Number(data.unread) || 0)
    if (currentView === 'inbox') await loadInbox()
  } catch (error) {
    result.className = 'test-result err'
    result.textContent = error.message ?? String(error)
  }
})
$('settings-cancel').addEventListener('click', () => $('settings').close())
// 点击弹窗外（backdrop 或 dialog 空白区域）关闭设置
$('settings').addEventListener('click', (event) => {
  if (event.target === $('settings')) $('settings').close()
})
$('cfg-search-provider').addEventListener('change', syncSearchProviderUI)
$('cfg-llm-provider').addEventListener('change', syncLlmProviderUI)
$('model-switch').addEventListener('change', () => void switchModel())
$('cfg-llm-profile').addEventListener('change', () => {
  commitLlmDraft()
  llmDraftEditId = $('cfg-llm-profile').value
  renderLlmProfileSelect()
  loadLlmDraft()
})
$('cfg-llm-add').addEventListener('click', () => {
  commitLlmDraft()
  const preset = LLM_PRESETS.deepseek
  const draft = {
    id: newDraftId(),
    name: '',
    provider: 'deepseek',
    baseURL: preset.baseURL,
    model: preset.model,
    apiKey: '',
    hasApiKey: false,
  }
  llmDrafts.push(draft)
  llmDraftEditId = draft.id
  renderLlmProfileSelect()
  loadLlmDraft()
  $('cfg-llm-name').focus()
})
$('cfg-llm-remove').addEventListener('click', () => {
  if (llmDrafts.length <= 1) return
  commitLlmDraft()
  const index = llmDrafts.findIndex(draft => draft.id === llmDraftEditId)
  llmDrafts.splice(index >= 0 ? index : 0, 1)
  // 删掉当前生效条目时，生效模型回落到第一个
  if (!llmDrafts.some(draft => draft.id === llmDraftActiveId)) llmDraftActiveId = llmDrafts[0].id
  llmDraftEditId = llmDrafts[0].id
  renderLlmProfileSelect()
  loadLlmDraft()
})
$('cfg-theme').addEventListener('change', () => applyTheme($('cfg-theme').value))
$('settings-save').addEventListener('click', saveSettings)
$('test-llm').addEventListener('click', () => runTest('llm'))
$('test-search').addEventListener('click', () => runTest('search'))
$('test-mail').addEventListener('click', () => runTest('mail'))
$('fetch-models').addEventListener('click', async () => {
  const result = $('test-llm-result')
  result.textContent = '拉取中…'
  result.className = 'test-result'
  try {
    // 用当前表单的端点/密钥拉取，不依赖已保存的生效配置
    const res = await api('/sv/api/test', { method: 'POST', body: { target: 'llm', llm: currentLlmForm() } })
    if (!res.ok) {
      result.className = 'test-result err'
      result.textContent = res.error ?? '失败'
      return
    }
    const list = $('model-list')
    list.innerHTML = ''
    for (const id of res.models ?? []) {
      const option = document.createElement('option')
      option.value = id
      list.appendChild(option)
    }
    result.className = 'test-result ok'
    result.textContent = `已拉取 ${res.models?.length ?? 0} 个模型`
  } catch (error) {
    result.className = 'test-result err'
    result.textContent = error.message ?? String(error)
  }
})

// 每次打开 /sv/ 都从空白新对话开始，并把光标放进输入框。
currentView = 'chat'
localStorage.setItem(VIEW_KEY, 'chat')
activeId = null
localStorage.removeItem(ACTIVE_KEY)
const bootBlank = conversations.find(c => c.id === null && c.messages.length === 0)
conversations = bootBlank === undefined
  ? [{ id: null, title: '新对话', messages: [], updatedAt: Date.now() }, ...conversations]
  : [bootBlank, ...conversations.filter(c => c !== bootBlank && !(c.id === null && c.messages.length === 0))]
saveConversations()
renderSidebar()
renderMessages()
setNavMore(navMoreExpanded, false)
applyView('chat')
$('input').focus()
// 从服务端索引补齐侧边栏（清缓存/换浏览器后仍能看到历史会话列表）
void syncConversations().then(() => {
  const conv = activeConversation()
  if (conv !== null && conv.id !== null && conv.messages.length === 0) void hydrateConversation(conv.id)
})
loadState()
connectReminders()
// 审批角标在任意视图下都可见
void loadApprovals()
// 进入待办视图前先拉一次，保证红点在任意视图下都可用
void loadTasks().then(() => {
  if (currentView !== 'tasks') applyView(currentView)
})
// 收件箱角标同样在任意视图下可见
void loadInbox()
setStreaming(false)
autosize()
applyTheme()
