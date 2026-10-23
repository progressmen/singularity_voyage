"""SMTP 发信用例核心：配置解析、发送与 CLI。

两个入口共用本文件，避免维护两套 SMTP 实现：

- `server.py` 的 MCP 工具（模型可调用的 `send_email` / `mail_status`）；
- sv-app 的子进程 CLI（待办到期提醒与每日摘要，见
  `packages/sv-app/src/mail-notifier.ts`）。

配置优先级（文件优先，环境变量兜底）：

1. `$SV_HOME`（缺省 `$DSH_HOME/sv`，再缺省 `~/.dsh/sv`）下 `config.json` 的 `mail` 节；
2. `SV_MAIL_*` 环境变量。

注意：harness 拉起的 MCP 子进程会抹掉 `DSH_*` 以及名称含 KEY / PASSWORD /
SECRET / TOKEN 的环境变量，因此 `cordis.patch.yml` 里显式把 `SV_HOME` 与
`SV_MAIL_*` 透传进来；日常配置建议走 `/sv` 设置页（写入 config.json）。

CLI：

    python3 mcp/sv-mail-mcp/mailer.py status
    echo '{"subject":"s","body":"b"}' | python3 mcp/sv-mail-mcp/mailer.py send [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
import smtplib
import ssl
import sys
from email.header import Header
from email.message import EmailMessage
from email.utils import formatdate
from pathlib import Path
from typing import Any

DEFAULT_TIMEOUT_SECONDS = 20
# digestAt 形如 08:30；留空表示不发每日摘要
TIME_PATTERN = r"^([01]\d|2[0-3]):[0-5]\d$"


class MailError(RuntimeError):
    """发信失败（配置缺失、SMTP 拒绝等），message 直接展示给调用方。"""


def sv_dir() -> Path:
    """SV 数据目录，与 packages/sv-app/src/config-store.ts 的 svDataDir 对齐。"""
    override = os.environ.get("SV_HOME", "").strip()
    if override:
        return Path(override)
    dsh_home = os.environ.get("DSH_HOME", "").strip()
    base = Path(dsh_home) if dsh_home else Path.home() / ".dsh"
    return base / "sv"


def _file_mail_section() -> dict[str, Any]:
    """读取 config.json 的 mail 节；缺失或损坏时返回空字典。"""
    try:
        raw = (sv_dir() / "config.json").read_text("utf-8")
        parsed = json.loads(raw)
    except (OSError, ValueError):
        return {}
    mail = parsed.get("mail") if isinstance(parsed, dict) else None
    return mail if isinstance(mail, dict) else {}


def _as_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in ("1", "true", "yes", "on", "ssl"):
            return True
        if lowered in ("0", "false", "no", "off", "starttls"):
            return False
    return default


def _as_int(value: Any, default: int) -> int:
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError):
        return default
    return parsed if 1 <= parsed <= 65535 else default


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def split_recipients(value: Any) -> list[str]:
    """把逗号/分号分隔的收件人字符串（或列表）拆成地址列表。"""
    if isinstance(value, list):
        items = [str(item) for item in value]
    elif isinstance(value, str):
        items = value.replace(";", ",").split(",")
    else:
        items = []
    return [item.strip() for item in items if item.strip()]


def load_config() -> dict[str, Any]:
    """合并文件配置与环境变量，返回归一化后的邮件配置。"""
    file_cfg = _file_mail_section()

    def raw(key: str, env_key: str) -> Any:
        value = file_cfg.get(key)
        if value not in (None, "", []):
            return value
        return os.environ.get(env_key, "")

    secure = _as_bool(raw("secure", "SV_MAIL_SECURE"), True)
    user = _text(raw("user", "SV_MAIL_USER"))
    host = _text(raw("host", "SV_MAIL_HOST"))
    recipients = split_recipients(raw("to", "SV_MAIL_TO")) or ([user] if user else [])
    return {
        "enabled": _as_bool(raw("enabled", "SV_MAIL_ENABLED"), bool(host)),
        "host": host,
        "port": _as_int(raw("port", "SV_MAIL_PORT"), 465 if secure else 587),
        "secure": secure,
        "user": user,
        # 密码只用于登录，绝不进入 status / 日志
        "password": _text(raw("password", "SV_MAIL_PASSWORD")),
        "from": _text(raw("from", "SV_MAIL_FROM")) or user,
        "to": recipients,
        "notifyOnReminder": _as_bool(raw("notifyOnReminder", "SV_MAIL_NOTIFY_ON_REMINDER"), True),
        "digestAt": _text(raw("digestAt", "SV_MAIL_DIGEST_AT")),
    }


def redacted(config: dict[str, Any]) -> dict[str, Any]:
    """脱敏视图：只暴露是否已设置密码。"""
    return {
        "enabled": config["enabled"],
        "host": config["host"],
        "port": config["port"],
        "secure": config["secure"],
        "user": config["user"],
        "from": config["from"],
        "to": config["to"],
        "notifyOnReminder": config["notifyOnReminder"],
        "digestAt": config["digestAt"],
        "hasPassword": bool(config["password"]),
        "configured": bool(config["host"] and config["user"] and config["password"] and config["to"]),
    }


def send(subject: str, body: str, to: str | list[str] | None = None, dry_run: bool = False) -> dict[str, Any]:
    """发送一封纯文本邮件；配置不全时抛 MailError。"""
    config = load_config()
    recipients = split_recipients(to) if to else config["to"]
    missing = [
        label
        for label, value in (
            ("SMTP 主机 host", config["host"]),
            ("账号 user", config["user"]),
            ("应用密码 password", config["password"]),
            ("收件人 to", recipients),
        )
        if not value
    ]
    if missing:
        raise MailError(
            "邮件未配置完整，缺少：" + "、".join(missing)
            + "；请在 /sv 设置页填写 SMTP 账号与应用密码（或设置 SV_MAIL_* 环境变量）"
        )
    if not subject.strip():
        raise MailError("邮件主题不能为空")

    message = EmailMessage()
    message["Subject"] = Header(subject.strip(), "utf-8").encode()
    message["From"] = config["from"]
    message["To"] = ", ".join(recipients)
    message["Date"] = formatdate(localtime=True)
    message.set_content(body, subtype="plain", charset="utf-8")

    result: dict[str, Any] = {"ok": True, "to": recipients, "subject": subject.strip()}
    if dry_run:
        result["dryRun"] = True
        return result

    context = ssl.create_default_context()
    try:
        if config["secure"]:
            client: smtplib.SMTP = smtplib.SMTP_SSL(
                config["host"], config["port"], timeout=DEFAULT_TIMEOUT_SECONDS, context=context
            )
        else:
            client = smtplib.SMTP(config["host"], config["port"], timeout=DEFAULT_TIMEOUT_SECONDS)
            client.ehlo()
            client.starttls(context=context)
            client.ehlo()
        with client:
            client.login(config["user"], config["password"])
            client.send_message(message)
    except smtplib.SMTPException as error:
        raise MailError(f"SMTP 发信失败：{error}") from error
    except OSError as error:
        raise MailError(f"无法连接 {config['host']}:{config['port']}：{error}") from error
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="SV 邮件通道 CLI（供 sv-app 与 MCP server 复用）")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status", help="打印脱敏后的邮件配置")
    send_parser = sub.add_parser("send", help="从 stdin 读取 JSON 并发送邮件")
    send_parser.add_argument("--dry-run", action="store_true", help="只校验配置与参数，不连接 SMTP")
    args = parser.parse_args(argv)

    try:
        if args.command == "status":
            print(json.dumps({"ok": True, "config": redacted(load_config())}, ensure_ascii=False))
            return 0
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise MailError("stdin 必须是 JSON 对象")
        result = send(
            subject=str(payload.get("subject", "")),
            body=str(payload.get("body", "")),
            to=payload.get("to") or None,
            dry_run=args.dry_run,
        )
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (MailError, ValueError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
