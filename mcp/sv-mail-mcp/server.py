"""SV 邮件 MCP 服务（stdio，JSON-RPC 2.0）。

刻意不依赖 `mcp` SDK：发一封信不值得再装一套 Python 运行时。本文件只用
标准库，Python 3.9+ 即可运行；协议面只实现 MCP 必需的
`initialize` / `tools/list` / `tools/call`（外加 `ping`）。

对外工具（dsh 注册为 `mcp__sv-mail__<name>`）：

- `send_email`  —— 发送纯文本邮件，`to` 留空发给配置里的「自己」
- `mail_status` —— 查询配置是否完整（不回传密码）

SMTP 实现在同目录 `mailer.py`；sv-app 的待办提醒与每日摘要复用它的 CLI，
因此「模型手动发信」和「自动提醒」只有一套配置与一套发信逻辑。

启动（由 dsh 托管，无需手动运行）：
    python3 mcp/sv-mail-mcp/server.py
"""

from __future__ import annotations

import json
import sys
from typing import Any

from mailer import MailError, load_config, redacted, send

SERVER_INFO = {"name": "sv-mail", "version": "0.1.0"}
# 客户端请求哪个版本就回哪个：本服务只用到稳定的 tools 能力，语义与版本无关
FALLBACK_PROTOCOL_VERSION = "2025-06-18"

TOOLS: list[dict[str, Any]] = [
    {
        "name": "send_email",
        "description": (
            "给自己（或指定地址）发送一封纯文本邮件。"
            "用户说「把这段发我邮箱」「发邮件告诉我」「邮件提醒我」时调用。"
            "to 留空表示发送到设置页配置的默认收件人（通常是用户自己）；多个收件人用英文逗号分隔。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "subject": {"type": "string", "description": "邮件主题"},
                "body": {"type": "string", "description": "正文，纯文本，支持多行"},
                "to": {"type": "string", "description": "收件人；留空发给配置的默认收件人"},
            },
            "required": ["subject", "body"],
            "additionalProperties": False,
        },
    },
    {
        "name": "mail_status",
        "description": "查询邮件通道配置状态（SMTP 主机、账号、默认收件人、是否启用提醒）。发信失败后可先调它确认是否已配置。",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
]


def _ok(request_id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def _text_result(request_id: Any, payload: Any, is_error: bool = False) -> dict[str, Any]:
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    return _ok(request_id, {"content": [{"type": "text", "text": text}], "isError": is_error})


def call_tool(request_id: Any, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    if name == "send_email":
        try:
            result = send(
                subject=str(arguments.get("subject", "")),
                body=str(arguments.get("body", "")),
                to=arguments.get("to") or None,
            )
        except MailError as error:
            # 工具级失败用 isError 返回，让模型看到可操作的原因
            return _text_result(request_id, str(error), is_error=True)
        return _text_result(request_id, result)
    if name == "mail_status":
        return _text_result(request_id, {"ok": True, "config": redacted(load_config())})
    return _error(request_id, -32602, f"未知工具：{name}")


def handle(request: dict[str, Any]) -> dict[str, Any] | None:
    request_id = request.get("id")
    method = request.get("method")
    # 通知（无 id）无需响应
    if request_id is None:
        return None
    if method == "initialize":
        params = request.get("params") or {}
        requested = params.get("protocolVersion")
        version = requested if isinstance(requested, str) and requested else FALLBACK_PROTOCOL_VERSION
        return _ok(request_id, {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER_INFO,
        })
    if method == "ping":
        return _ok(request_id, {})
    if method == "tools/list":
        return _ok(request_id, {"tools": TOOLS})
    if method == "tools/call":
        params = request.get("params") or {}
        name = params.get("name")
        arguments = params.get("arguments") or {}
        if not isinstance(name, str) or not isinstance(arguments, dict):
            return _error(request_id, -32602, "tools/call 参数非法")
        return call_tool(request_id, name, arguments)
    return _error(request_id, -32601, f"未知方法：{method}")


def main() -> int:
    # stdio 传输：一行一个 JSON-RPC 消息
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            continue
        if not isinstance(request, dict):
            continue
        response = handle(request)
        if response is None:
            continue
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
