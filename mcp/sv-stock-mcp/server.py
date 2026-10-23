"""SV 股票行情 MCP 服务（stdio，JSON-RPC 2.0）。

与 `sv-mail-mcp` 同款协议实现：不依赖 `mcp` SDK，只用标准库处理
`initialize` / `tools/list` / `tools/call`（外加 `ping`）。查数逻辑在
`stock.py`，依赖 akshare。

对外工具（dsh 注册为 `mcp__sv-stock__<name>`）：

- `stock_search`      —— 按代码/名称搜索 A 股
- `stock_quote`       —— 实时快照（有几十秒延迟）
- `stock_history`     —— 个股日/周/月线与分钟线
- `index_history`     —— 指数日/周/月线
- `market_overview`   —— 指数、涨跌家数、成交额、涨跌分布（判断整体行情）
- `industry_rank`     —— 行业板块涨跌幅排行（判断轮动方向）

启动（由 dsh 托管，无需手动运行）：
    mcp/sv-stock-mcp/.venv/bin/python mcp/sv-stock-mcp/server.py
"""

from __future__ import annotations

import json
import sys
from typing import Any

import stock
from stock import StockError

SERVER_INFO = {"name": "sv-stock", "version": "0.1.0"}
FALLBACK_PROTOCOL_VERSION = "2025-06-18"

TOOLS: list[dict[str, Any]] = [
    {
        "name": "stock_search",
        "description": (
            "按代码或名称搜索 A 股，返回代码、名称与所属板块。"
            "不知道股票代码时先用它把「贵州茅台」这类名称解析成 6 位代码。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "keyword": {"type": "string", "description": "代码前缀或名称关键词，如 600519、茅台"},
                "limit": {"type": "integer", "description": "最多返回条数，默认 10，上限 50", "default": 10},
            },
            "required": ["keyword"],
            "additionalProperties": False,
        },
    },
    {
        "name": "stock_quote",
        "description": (
            "查询一只或多只 A 股的实时快照：最新价、涨跌幅、今开/最高/最低、昨收、"
            "成交量与成交额、买一/卖一价等。数据来自公开行情接口，有约 15 秒–1 分钟延迟，"
            "非交易时段返回最近收盘数据。换手率/市盈率/市值等字段取决于数据源，缺失时不返回。"
            "symbols 支持 6 位代码（600519）、带前缀（sh600519）或股票名称，多个用逗号分隔。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "symbols": {
                    "type": ["string", "array"],
                    "items": {"type": "string"},
                    "description": "股票代码或名称；字符串用逗号分隔，或直接传字符串数组；一次最多 20 只",
                }
            },
            "required": ["symbols"],
            "additionalProperties": False,
        },
    },
    {
        "name": "stock_history",
        "description": (
            "查询 A 股历史 K 线：period 取 daily/weekly/monthly 或 1/5/15/30/60（分钟），"
            "adjust 取 qfq（前复权，默认）/hfq/空字符串（不复权）。"
            "返回 date、open、high、low、close、volume（手）、amount（元）、涨跌幅、换手率等。"
            "用于趋势、均线、量能与回撤分析；默认取最近一年、最多 2000 行（超出保留最新）。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "symbol": {"type": "string", "description": "6 位股票代码，如 600519"},
                "start_date": {"type": "string", "description": "开始日期 YYYYMMDD 或 YYYY-MM-DD；默认日线近一年、分钟线近 7 天"},
                "end_date": {"type": "string", "description": "结束日期，默认今天"},
                "period": {
                    "type": "string",
                    "enum": ["daily", "weekly", "monthly", "1", "5", "15", "30", "60"],
                    "description": "K 线周期，默认 daily",
                    "default": "daily",
                },
                "adjust": {
                    "type": "string",
                    "enum": ["qfq", "hfq", ""],
                    "description": "复权方式，默认 qfq（前复权）",
                    "default": "qfq",
                },
                "limit": {"type": "integer", "description": "最多返回行数，默认 500，上限 2000", "default": 500},
            },
            "required": ["symbol"],
            "additionalProperties": False,
        },
    },
    {
        "name": "index_history",
        "description": (
            "查询指数历史 K 线，用于大盘趋势判断。"
            "常用代码：上证指数 000001、深证成指 399001、创业板指 399006、科创50 000688、"
            "沪深300 000300、中证500 000905、中证1000 000852、北证50 899050。"
            "period 取 daily/weekly/monthly（周/月线由日线聚合），默认近一年。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "symbol": {"type": "string", "description": "指数代码，如 000001 或 sh000001"},
                "start_date": {"type": "string", "description": "开始日期 YYYYMMDD 或 YYYY-MM-DD，默认近一年"},
                "end_date": {"type": "string", "description": "结束日期，默认今天"},
                "period": {
                    "type": "string",
                    "enum": ["daily", "weekly", "monthly"],
                    "description": "K 线周期，默认 daily",
                    "default": "daily",
                },
                "limit": {"type": "integer", "description": "最多返回行数，默认 500，上限 2000", "default": 500},
            },
            "required": ["symbol"],
            "additionalProperties": False,
        },
    },
    {
        "name": "market_overview",
        "description": (
            "A 股整体行情快照：主要指数表现、上涨/下跌/平盘家数、涨停跌停粗估、涨跌幅分布、"
            "两市成交额，以及涨幅榜/跌幅榜/成交额榜前 5。用于判断市场情绪、赚钱效应与趋势强弱。"
            "有约 15 秒–1 分钟延迟；涨停/跌停按涨跌幅绝对值 ≥9.8% 粗估。"
        ),
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "industry_rank",
        "description": (
            "行业板块涨跌幅排行（东方财富行业分类），含板块涨跌幅、总市值、上涨/下跌家数、"
            "领涨股票。direction=top 取涨幅榜、bottom 取跌幅榜，用于观察板块轮动与强势方向。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "description": "返回板块数，默认 20，上限 100", "default": 20},
                "direction": {
                    "type": "string",
                    "enum": ["top", "bottom"],
                    "description": "top=涨幅榜（默认），bottom=跌幅榜",
                    "default": "top",
                },
            },
            "additionalProperties": False,
        },
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
    try:
        if name == "stock_search":
            payload = stock.search(
                keyword=str(arguments.get("keyword", "")),
                limit=int(arguments.get("limit", 10)),
            )
        elif name == "stock_quote":
            payload = stock.quote(arguments.get("symbols"))
        elif name == "stock_history":
            payload = stock.history(
                symbol=str(arguments.get("symbol", "")),
                start_date=arguments.get("start_date", ""),
                end_date=arguments.get("end_date", ""),
                period=str(arguments.get("period", "daily")),
                adjust=str(arguments.get("adjust", "qfq")),
                limit=int(arguments.get("limit", 500)),
            )
        elif name == "index_history":
            payload = stock.index_history(
                symbol=str(arguments.get("symbol", "")),
                start_date=arguments.get("start_date", ""),
                end_date=arguments.get("end_date", ""),
                period=str(arguments.get("period", "daily")),
                limit=int(arguments.get("limit", 500)),
            )
        elif name == "market_overview":
            payload = stock.market_overview()
        elif name == "industry_rank":
            payload = stock.industry_rank(
                limit=int(arguments.get("limit", 20)),
                direction=str(arguments.get("direction", "top")),
            )
        else:
            return _error(request_id, -32602, f"未知工具：{name}")
    except StockError as error:
        return _text_result(request_id, str(error), is_error=True)
    except (TypeError, ValueError) as error:
        return _text_result(request_id, f"参数错误：{error}", is_error=True)
    except Exception as error:  # 兜底：避免异常直接打断 stdio 循环
        return _text_result(request_id, f"查询失败：{error}", is_error=True)
    return _text_result(request_id, {"ok": True, **payload})


def handle(request: dict[str, Any]) -> dict[str, Any] | None:
    request_id = request.get("id")
    method = request.get("method")
    if request_id is None:  # 通知（notifications/initialized 等）
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
