# invest-agent-dsh 参考移植计划

## Context

用户要求参考 [invest-agent-dsh](file:///Users/zhaoqi/project/company_project/invest-agent-dsh/README.md)（Python + dsh 的招商智能体，已验证的成熟实现），把其中四个经过实战验证的模式移植到当前项目 singularity_voyage（TS monorepo，dsh 之上的产品层，M0 已跑通）：

1. **SSE 桥接与会话管理**（参考 gateway/ + harness_service/）
2. **MCP 工具接入模式**（参考 supply-chain-graph-mcp 等 Python MCP server + fail-fast 配置）
3. **Trace 面板**（参考 frontend/trace.js：类型分区、人话摘要、自动折叠、类型分布行）
4. **多供应商 LLM / 搜索配置**（参考 harness_service/providers.py 注册表 + 搜索韧性参数）

Python 仅用于 **MCP 查数服务模板**（与参考项目同款定位）；桥接/编排层沿用 sv-app TS 插件——sv-app 本身就等价于参考项目的 gateway + harness_service，无需重复实现。

### 参考项目 → 本项目 的映射与取舍

| 参考项目做法 | 本项目落地方式 | 不照搬的原因 |
|---|---|---|
| gateway SQLite 会话落库 | `$DSH_HOME/sv/` 下轻量会话索引 + transcript 投影 | SV 原则「日志即事实、投影可重建」；dsh 已持久化会话 JSONL，SV 只存产品面需要的索引 |
| harness_service 事件翻译（tool_call/tool_result 分离） | chat.ts 工具事件升级：`callId` 关联 + `args`/`result` 载荷 | 已有 agent 事件订阅，补齐载荷即可 |
| MCP server `failOnStartupError: true` | cordis.patch.yml 接线 TS harness 自带的 `@deepseek-ai/dsh-mcp-client`（同样支持该字段） | 参考项目坑 #1：默认 false 会静默注册零工具，模型看不到查数工具却照常编数据 |
| 模式 A 回调（gateway/toolapi.py HMAC） | 不移植；副作用工具走 SV 原生 TS 工具（`ctx.tools`） | 参考项目该模式是为 Python 网关设计的；SV 的工具层原生支持审批/会话上下文 |
| 搜索失败降级到「模型自带联网搜索」 | 不移植，重试耗尽后 fail loud 返回明确错误 | SV 走 OpenAI 兼容适配器，没有模型原生搜索可降级；静默换通路违背 fail-fast 原则 |
| 搜索韧性参数（RETRY_ATTEMPTS / API_TIMEOUT_MS / RETRY_BUDGET_MS） | 移植到 search-provider.ts | 同样的网络环境问题 |
| LLM_PROVIDER 注册表（deepseek/qwen/ark） | 移植为 provider 预设表（预设 baseURL+默认模型，可覆盖） | SV 本就是通用 OpenAI 兼容适配器，预设即可，无需注册表路由机制 |

已核实的关键事实（影响设计）：
- dsh agent 事件：`agent/assistant-stream` 的 `block-end` chunk 携带 `{ type:'tool-call', id, name, arguments(JSON字符串) }`（packages/llm/llm/tests/properties.spec.ts:27）；`tools/result` 事件携带 `exec`（含 `callId`、`arguments` 已解析）与 `result`（`isError` / `value` 或 `error`）（packages/core/tools/src/index.ts:327,573,597）→ 可按 `callId` 关联 start/end。
- TS harness 自带 `@deepseek-ai/dsh-mcp-client`（packages/mcp/mcp-client/src/index.ts），支持 stdio/streamable-http、`failOnStartupError`，工具命名为 `mcp__<server>__<tool>`。
- 当前 `SvChatEvent.tool` 只有 `name/phase/isError`（chat.ts:27），前端只渲染简单工具条（app.js:459-461）。

---

## WS1 工具事件与会话管理增强（chat.ts / sessions-store.ts / http.ts）

### 1.1 工具事件升级（packages/sv-app/src/chat.ts）

- `SvChatEvent.tool` 扩展为：
  - start：`{ type:'tool', phase:'start', callId, name, args }`（args 来自 block-end 的 `arguments` JSON 解析，序列化后截断到 2KB）
  - end：`{ type:'tool', phase:'end', callId, name, isError, result?, durationMs? }`
    - result 来自 `tools/result` 的 `result.value`（成功）或 `result.error`（失败），JSON 序列化截断到 2KB；durationMs 按 callId 记录的起始时间差
- `wire()` 中：`agent/assistant-stream` 的 tool-call block-end 处记录 `callId → { name, args, startTs }` 并发出 start；`tools/result` 按 `exec.callId` 匹配发出 end（匹配不到也发，用 exec.arguments 兜底）。旧字段 `name/phase/isError` 保留，前端向后兼容。
- `LiveSession` 增加 `pendingTools: Map<callId, {name, startTs}>` 与本轮 `turnTools`（供 transcript 记录）。

### 1.2 会话索引与 transcript（新文件 packages/sv-app/src/sessions-store.ts）

新建 `SessionStore` 类，数据目录复用 `svDataDir()`（[config-store.ts:59](file:///Users/zhaoqi/project/singularity_voyage/packages/sv-app/src/config-store.ts#L59)）：

- `sessions.json`：`{ version:1, sessions:[{ id, title, createdAt, updatedAt, turns }] }`，按 updatedAt 倒序。
- `transcripts/<sessionId>.jsonl`：逐条追加 `{ ts, role:'user'|'assistant', text, reasoning?, tools?:[...] }`；assistant 条目的 text 截断 100KB，tools 记录本轮工具摘要（name/kind/args摘要/isError/durationMs）。append-only，单文件条目上限 500，超出丢弃最旧（重写文件）。
- ChatManager 集成：`ensure()` 创建新会话时写索引（title 先置「新对话」）；`run()` 投递用户消息时写 user 条目 + 更新 title（首条用户文本前 24 字，与前端 app.js:376 一致）与 `updatedAt`；`message` 事件落地时写 assistant 条目、`turns+1`。
- 全部写操作走"读-改-写"或 appendFileSync 语义，失败仅 logger.warn（投影不可阻塞对话主链路）。

### 1.3 会话 API（packages/sv-app/src/http.ts `handleApi` 增加）

- `GET /sv/api/sessions` → `{ sessions:[...] }`（从 SessionStore 读）
- `GET /sv/api/sessions/:id/messages` → `{ messages:[...] }`（读 transcript，按行 JSON.parse，坏行跳过）
- `DELETE /sv/api/sessions/:id` → 删索引条目 + transcript 文件，返回 `{ deleted:true }`
- 路由注册在现有 prefix handler（[http.ts:195-226](file:///Users/zhaoqi/project/singularity_voyage/packages/sv-app/src/http.ts#L195-L226)）里加分支即可。

前端联动（app.js）：启动时若有 localStorage 的 activeId，尝试 `GET messages` 补齐/替换当前会话消息（本地没有该会话历史时），使跨浏览器恢复会话成为可能。

---

## WS2 Trace 面板（web/trace.js 新建 + app.js / app.css / index.html）

新建 `packages/sv-app/web/trace.js`（零依赖、双端可跑：浏览器挂 `window.SvTrace`，node `import` 侧副作用挂 `globalThis.SvTrace`，供 `trace.test.mjs` 测试），参考 [frontend/trace.js](file:///Users/zhaoqi/project/company_project/invest-agent-dsh/frontend/trace.js)：

- `classify(name)`：`mcp__<server>__<tool>` → `{kind:'mcp', server}` 🔎；`web_search|web_fetch` → `'web'` 🌐；`skill` → `'skill'` 📘；`bash|shell|terminal*` → `'terminal'` ⌨；其余 → `'tool'` 🔧（模式表集中为常量，便于后续补 dsh 文件工具名）。
- `summarize(name, args)`：人话摘要——web_search → `搜索「query」`；web_fetch → `抓取 <url 域名+路径>`；mcp → `server · tool`；其余提取首个字符串型参数截断 40 字，兜底工具名。
- `render(container, tools)`：单条 assistant 消息的 trace 面板：
  - 类型分布行：`📘2 🌐4 🔎1`（>0 才显示；直接回答"这轮用没用查数工具"）
  - 行列表：徽章 + 摘要 + 耗时 + 失败红点；点击行展开 `args` / `result` JSON（pretty print，超 2KB 截断标记）
  - 连续 ≥3 次同 kind 自动折叠为「N 次 · 摘要列表」，失败的行强制展开且不折叠
- `app.js`：`handleEvent` 的 tool 分支改为按 `callId` 合并 start/end（保留旧字段兼容）；`refreshActiveMessage` 时对 `assistant.tools` 调 `SvTrace.render`。transcript 恢复的历史消息同样可渲染。
- `index.html` 在 app.js 之前引入 trace.js。
- 新建 `packages/sv-app/web/trace.test.mjs`（node:test，测 classify/summarize/折叠/分布行纯函数），对齐参考项目 `node --test frontend/trace.test.mjs` 的做法。

---

## WS3 Python MCP 查数服务模板 + fail-fast 接线

- 新建 `mcp/sv-demo-mcp/server.py`：官方 `mcp` SDK（FastMCP）stdio server，3 个演示工具：
  - `now()` → 当前时间（ISO 8601）
  - `text_stats(text)` → 字符数/词数/行数统计
  - `echo(text)` → 原样回显
  - 工具 docstring 用中文写清用途（模型可见）；返回结构化 dict。
- 新建 `mcp/requirements.txt`：`mcp>=1.2.0`。
- `packages/sv-app/cordis.patch.yml` 的 `insert:` 增加一行（参考 README 5.2 已验证的写法）：
  ```yaml
  - id: sv-mcp-demo
    name: '@deepseek-ai/dsh-mcp-client'
    config:
      serverName: sv-demo
      transport: stdio
      command: python3
      args: ['mcp/sv-demo-mcp/server.py']
      cwd: !!js process.cwd()
      failOnStartupError: true
  ```
  模型看到的工具名：`mcp__sv-demo__now` 等。`failOnStartupError: true` 是参考项目坑 #1 的直接教训：连不上宁可启动失败，不允许静默零工具。
- README 更新：
  - 「四步启动」前置条件补一句 MCP 模板依赖（`pip install -r mcp/requirements.txt`；不需要时删除 patch 中该行）
  - 5.2 节指向本地模板；补「加工具的规则」决策映射（参考项目 README 同款规则）：只读查数 → 新建独立 Python MCP server；有副作用/需要会话上下文 → SV 原生 TS 工具
  - 仓库结构 tree 增加 `mcp/`

---

## WS4 多供应商 LLM 预设 + 搜索韧性（config-store.ts / search-provider.ts / 设置面板）

### 4.1 LLM provider 预设（config-store.ts）

- 新增常量表 `SV_LLM_PRESETS`：
  - `deepseek` → `https://api.deepseek.com` + `deepseek-chat`
  - `qwen` → `https://dashscope.aliyuncs.com/compatible-mode/v1` + `qwen3-max`
  - `ark` → `https://ark.cn-beijing.volces.com/api/v3` + `doubao-seed-1-6-250615`
  - `openai` → `https://api.openai.com/v1` + `gpt-4o-mini`
  - `custom` → 无默认
- `SvLlmConfig` 增加 `provider` 字段；`load()` 时按 baseURL 反推 provider（匹配预设则为该预设，否则 `custom`，兼容既有 config.json）；`update()` 接受 `provider`，切换预设时仅当对应字段未被用户显式改过才覆写 baseURL/model（简单实现：patch 带 provider 时，若同 patch 未带 baseURL/model 则用预设默认值填充）。
- 环境变量默认值：`index.ts` 插件 config 增加 `llmProvider: !!js process.env.SV_LLM_PROVIDER ?? 'deepseek'`，构造 ConfigStore 默认值时消费。

### 4.2 搜索韧性（search-provider.ts）

- 增加韧性包装 `withRetry(fn, { attempts, timeoutMs, budgetMs })`：
  - 每次尝试叠加超时 signal（与请求自身 signal 组合）
  - 失败重试 `attempts` 次（默认 2，env `SV_SEARCH_RETRY_ATTEMPTS`），单次超时 `timeoutMs`（默认 15000，env `SV_SEARCH_API_TIMEOUT_MS`），重试阶段总预算 `budgetMs`（默认 30000，env `SV_SEARCH_RETRY_BUDGET_MS`）
  - 耗尽后抛出含「已重试 N 次」的明确错误（fail loud；与参考项目"降级到模型自带搜索"的差异已在取舍表说明，写入 README 一句话）
- 韧性参数进 `SvSearchConfig`（可被页面设置覆盖，env 作默认），`index.ts` 插件 config 注入三个 env 默认值。

### 4.3 设置面板（web/index.html / app.js / app.css）

- LLM 区：provider 下拉（5 个预设，选中即回填 baseURL/model 输入框，仍可手改）；custom 时展示纯手填。
- 搜索区：provider（已有 tavily/bocha）+ 折叠的「高级」块：重试次数/单次超时/总预算三个数字输入。
- `/sv/api/config` 的 patch 直通（config-store.update 已按字段校验，扩展 provider 与韧性字段校验即可）。
- `.env.example` 增加：`SV_LLM_PROVIDER`、`SV_SEARCH_RETRY_ATTEMPTS`、`SV_SEARCH_API_TIMEOUT_MS`、`SV_SEARCH_RETRY_BUDGET_MS`。

---

## 其他改动

- 根 [package.json](file:///Users/zhaoqi/project/singularity_voyage/package.json) 增加 `"test": "node --test packages/sv-app/test/ packages/sv-app/web/"`（node 内置 test runner，零新依赖）。
- 新增 `packages/sv-app/test/`（node:test）：
  - `sessions-store.test.ts`：索引增删、transcript append/截断（临时目录）
  - `chat-tool-events.test.ts`：callId start/end 关联、args/result 截断（构造假 frame/exec）
  - `config-presets.test.ts`：provider 预设反推与切换
  - `search-retry.test.ts`：重试/超时/预算（假 fetch）

## 涉及文件清单

| 操作 | 文件 |
|---|---|
| 改 | packages/sv-app/src/chat.ts、http.ts、config-store.ts、search-provider.ts、index.ts |
| 增 | packages/sv-app/src/sessions-store.ts |
| 改 | packages/sv-app/web/app.js、app.css、index.html |
| 增 | packages/sv-app/web/trace.js、trace.test.mjs |
| 增 | packages/sv-app/test/*（4 个测试文件） |
| 改 | packages/sv-app/cordis.patch.yml、.env.example、README.md、package.json（根） |
| 增 | mcp/sv-demo-mcp/server.py、mcp/requirements.txt |

## 验证

1. `pnpm build && pnpm typecheck` 通过；`pnpm test` 全绿。
2. `pip3 install -r mcp/requirements.txt` 后 `pnpm setup && pnpm dev`：dsh 启动不报 MCP 错（failOnStartupError 生效验证：临时把 server.py 路径改错，应启动失败——验证后改回）。
3. 浏览器 `http://127.0.0.1:3080/sv/`：
   - 设置面板切换 provider 预设、配置搜索 key、测试连通
   - 发「现在几点」→ 模型调用 `mcp__sv-demo__now`；trace 面板出现 🔎 分布行、可展开看到 args/result JSON、耗时
   - 让模型联网搜一个问题 → 🌐 行；断网/错误 key 重试后 fail loud，错误进 trace 且该行强制展开
   - 刷新页面/换隐身窗口 → 会话列表可从 `/sv/api/sessions` 恢复历史
4. `node scripts/check-web-search.mjs` 不存在，跳过；搜索单测覆盖韧性参数逻辑。
