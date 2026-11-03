---
name: computer-use
description: 使用 app_list / app_launch / screen_observe / screen_zoom / computer_aim / computer_click / computer_type / computer_key / computer_scroll / computer_drag 等工具操作本机桌面应用。覆盖窗口与多显示器/Space、观察快照、坐标校准、键盘输入、权限与失败止损。用户要求打开应用、点击界面、填写表单、读取窗口内容时使用。
---

# Computer Use

## 适用场景

- 用户要求操作本机应用界面：打开/前置应用、观察窗口、点击、输入、快捷键、滚动、拖拽。
- 需要读取某个窗口的界面内容，或按步骤填写表单、提交页面。
- 任务 skill 需要驱动桌面应用时，先加载本 skill，再执行任务专属步骤。

不适用于：纯终端/文件操作、网页抓取、没有 GUI 的批处理。能用 shell/文件工具完成的，不要走桌面。

## 核心循环

观察 → 校准 → 操作 → 再观察。

1. `app_list` 找到目标应用；`app_launch` 启动或前置（需要立刻看到窗口时传 `bring_to_front: true`）。
2. `screen_observe` 取得窗口快照与元素树（默认 `ax`，零图片 token）。
3. `computer_aim` 把虚拟光标移到目标，返回含光标的局部截图；确认光标压在目标上。
4. 用 `computer_click(element=编号)` 或 `computer_click(screen_x=, screen_y=)` 操作。
5. 操作后重新 `screen_observe` 验证结果；窗口/页面变化后必须重新观察。

不要盲操作：没有新鲜快照的动作会被拒绝；快照约 45 秒过期，过期后重新观察。

## 快速路径：聊天 / 消息类

1. `app_launch` 前置应用；用应用内搜索，不要逐层点导航（飞书 `cmd+k`，Slack `cmd+k`，微信 `cmd+f`）。
2. 输入完整名称，一次搜索后只看前几条结果。
3. 处理同名 / 多候选：
   - 用户的限定词（公司 / 外部 / 个人）优先于记忆里的默认偏好；
   - 限定词只匹配一个结果就直接选；
   - 仍有两个候选，或选中的是「自己」（输入框提示“给自己发消息”），**先问一句再发送**。
4. 进入会话 → 点击输入框 → 输入/粘贴 → `return` 发送。
5. 发送后观察消息气泡或输入框清空，确认成功；不要只凭“按了 Enter”就结束。

## macOS：应用启动与窗口状态

先确认平台：`uname -s` 输出 `Darwin` 即 macOS。只通过 `app_list` / `app_launch` 启动应用，不用 `open -a` / `osascript` / `cliclick`。

### 1. 应用未打开

`app_list` 里没有目标应用 → `app_launch(name=显示名, bring_to_front=true)`。

中文名失败（`APP_NOT_INSTALLED`）时，换英文名或 bundle id 再试一次；例如飞书 → `Lark` / `com.bytedance.lark`。仍失败进入「未找到」。

### 2. 应用未找到

先只读检查安装位置，不做 GUI 操作：

- `ls /Applications | grep -i <关键词>`
- `ls ~/Applications | grep -i <关键词>`
- 或 `mdfind "kMDItemDisplayName == '*<关键词>*'c"`

找到后用 `app_launch` 的精确名称再试；找不到就告诉用户“未安装 / 名称不确定”，不要反复猜。

### 3. 已打开但最小化 / 隐藏 / 被遮挡

识别：`screen_observe` 返回 `on_current_space=true` 但 `is_on_screen=false`。

- 先 `app_launch(name/bundle_id, bring_to_front=true)` 一次；
- 仍失败 → 用主窗口 `window_id` 再 `screen_observe`（会自动前置）；
- 仍失败就请用户在 Dock 点一下或取消最小化；不要用 `osascript` / 原始 `cua-driver call` 绕过。

### 4. 已打开但不在主显示器 / 另一个 Space

- `on_current_space=false`：窗口在另一个桌面/Space。不要点击/输入；请用户切到那个桌面，或在当前桌面新开窗口（`cmd+n` / 应用的新建窗口）。
- 在外接屏但同一 Space：`screen_observe` 会标注显示器；坐标仍是窗口本地截图像素，继续用 `computer_aim` / `screen_x/screen_y`，不要用全屏坐标。
- 目标窗口被其它窗口完全遮挡（`is_on_screen=false`）按第 3 类处理。

每一类最多尝试一次；失败就停下说明卡点。不要在不同 `window_id` 之间来回切换，也不要在未确认前台窗口时盲点（例如误点到 uTools / 终端）。

## 坐标：不要手算

- 优先 `element` 编号。
- AX 无元素时：先用 `screen_zoom` 取目标局部图，再用 `computer_click(from_zoom=true, x=, y=)`。
- 需要校准时用 `computer_aim`，拿 `screen_x/screen_y` 点击；不要用整窗截图目测坐标。
- 如果 `screen_observe` 提示图片被缩放，不要自己乘比例；改用 `screen_zoom` / `computer_aim` 的坐标。
- 同一目标最多 aim 两次；两次点不中就停。

## 节奏

- 同一界面状态只观察一次；界面变化或失败才重新观察。
- 不要连续 `screen_observe` 多个窗口来“碰运气”；先确定哪个窗口在当前桌面。
- 需要读文本时优先 `query` + `ax`；需要看图标/布局时才用局部图。
- 对象有歧义时先用一句话问清，不要在内心反复推断；用户给出明确限定词时按限定词执行。

## 工具选择

| 目标 | 工具 |
|---|---|
| 找应用 / 启动 / 前置 | `app_list`、`app_launch` |
| 看窗口 | `screen_observe(window=标题/id/pid, query=关键词, mode=ax/native/vision)` |
| 放大局部 | `screen_zoom(window_id=, x1/y1/x2/y2=)` |
| 校准光标 | `computer_aim(element= / x= / y= / screen_x=, screen_y=)` |
| 点击 | `computer_click(element= / screen_x=, screen_y= / from_zoom=true, x=, y=)` |
| 双击 / 右键 | `computer_double_click` / `computer_right_click` |
| 输入 / 按键 | `computer_type(element=, text=)` / `computer_key(key=)` |
| 滚动 / 拖拽 / 等待 | `computer_scroll` / `computer_drag` / `computer_wait` |

参数细节以工具描述为准；本 skill 只讲流程与取舍。

## 窗口、多显示器与 Space

- 同名窗口可能多个：观察结果会列出候选；只操作标注「当前桌面」的窗口，并显式传它的 `window_id`。
- 窗口在外接屏或另一个 Space：不要直接输入/点击；在当前桌面的应用里新开标签页/窗口，再观察新的 `window_id`。
- 看 `显示器:` 与「该窗口不在当前 Space」提示；键盘输入被拒绝通常就是窗口不可交互，不要重试同一动作。
- 目标窗口不在前台时，`screen_observe` / 键盘动作会尝试前置；失败就告诉用户切桌面或手动打开窗口。

## 坐标与缩放

- 点击坐标是**窗口本地截图像素**，不是屏幕逻辑点；Retina 截图常是逻辑尺寸的 2 倍。
- `screen_observe` 会给出截图尺寸；按图内像素估位置。
- 图片被缩放时，先按返回的换算提示换回原截图坐标；`screen_zoom` 的图内坐标可用 `computer_click(from_zoom=true, x=, y=)` 自动换算。
- 优先用元素编号；AX 没有元素时才用坐标。坐标点击前用 `computer_aim` 校准。

## 输入与快捷键

- 先点击/聚焦输入控件，再 `computer_type`；自绘界面没有文本控件时用 `computer_key` 输入数字/短文本。
- 快捷键用 `computer_key`，如 `return`、`tab`、`escape`、`cmd+a`、`cmd+v`。
- 输入框已有旧内容：先 `cmd+a` 全选并确认高亮，再粘贴/输入，避免新旧叠加。
- 剪贴板粘贴失败或被沙箱拒绝时，回退 `computer_type(element=, text=)`。
- 密码、验证码、密钥必须由用户本人输入，不要代填。

## 安全与授权

- 用户已明确对象与内容（如「给某某发：你好」）视为已授权，直接执行，不要反复确认。
- 删除、支付、转账、退出登录、覆盖重要文件等不可逆操作先向用户确认。
- 不绕过登录页；不代填账号密码；不操作与任务无关的窗口。
- 只通过桌面工具操作 GUI：不要用终端 `open -a`、`osascript`、`cliclick`、`xdotool` 启动或操作应用。

## 失败止损

- 同一工具、同一错误连续失败 2 次就停下：说明卡在哪（窗口不在当前桌面 / 缺少输入控件 / 元素不在快照里），并告诉用户需要他做什么。
- 点击后界面无变化或跳到别的标签页：视为没点中，重新 `computer_aim` 定位，**不要重复点同一坐标**。
- 连续两次点不中就停下来，请用户手动点一下并说明卡点。
- 快照过期、元素编号失效、弹窗出现：重新 `screen_observe`，不要复用旧编号。

## 常见错误

| 现象 | 处理 |
|---|---|
| `cua-driver not found` | 安装 cua-driver 并确保在 PATH / 设置 `CUA_DRIVER_BIN` |
| 截图失败 / 看不到光标 | 给 CuaDriver.app 授予「屏幕录制」；失败时回退窗口 `zoom` 图 |
| AX 树为空 | 换 `mode="native"` 或先用 `screen_zoom` 看局部 |
| 键盘/输入被拒绝 | 目标窗口不在当前桌面或无法前置；换当前桌面窗口 |
| `screenshot_context_missing` | 先 `screen_observe` 建立快照，再 `screen_zoom` / 坐标点击 |
| 元素编号无效 | 快照过期或界面已变化；重新观察 |
| 点击无变化 | 重新 aim 校准；两次失败停下来问用户 |

## 与任务 skill 的关系

任务 skill（如日报、表单填写）应先加载本 skill，再只写业务专属步骤：URL、页面元素名称、字段校验、提交后的业务判断。通用窗口/坐标/输入/止损规则由本 skill 统一维护，避免重复。
