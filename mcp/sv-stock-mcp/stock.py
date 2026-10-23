"""A 股行情数据访问层（akshare）。

只做「查数 + 归一化」，协议层在 `server.py`。akshare 依赖 pandas，
导入耗时约 2–4 秒，因此这里延迟导入：MCP 握手不受影响，首次查数才付这笔成本。

数据源：优先新浪 / 腾讯（稳定、无需 token），东方财富作为兜底。公开行情接口
有几十秒级延迟（非交易时段返回最近一个交易日的收盘数据），因此所有响应都带
`delay` 字段说明。

约定：
- 股票代码统一为 6 位数字（`600519`、`000001`），接受 `sh600519` / `600519.SH`；
- 日期参数接受 `20240101` / `2024-01-01` / `2024/01/01`；
- 输出列名统一为英文：个股 `volume` 单位为手、`amount` 单位为元，
  指数 `volume` 保留数据源原始口径；
- 每次响应都带 `source`，数据口径以它为准。
"""

from __future__ import annotations

import contextlib
import datetime
import math
import re
import socket
import sys
import time
from typing import Any, Callable

# akshare 的公开接口偶发超时；统一给 socket 一个上限，避免工具调用无限挂起
SOCKET_TIMEOUT_SECONDS = 30
SPOT_TTL_SECONDS = 60
INDEX_SPOT_TTL_SECONDS = 30
SYMBOL_TTL_SECONDS = 3600
BOARD_TTL_SECONDS = 60

REALTIME_DELAY = "约 15 秒–1 分钟延迟；非交易时段为最近一个交易日收盘数据"

MAJOR_INDICES: list[tuple[str, str]] = [
    ("000001", "上证指数"),
    ("399001", "深证成指"),
    ("399006", "创业板指"),
    ("000688", "科创50"),
    ("000300", "沪深300"),
    ("000905", "中证500"),
    ("000852", "中证1000"),
    ("899050", "北证50"),
]

# 新浪/腾讯/东财的列名并集：哪一列存在就输出哪一列
SPOT_COLUMNS = {
    "代码": "code",
    "名称": "name",
    "最新价": "price",
    "涨跌幅": "change_pct",
    "涨跌额": "change",
    "买入": "bid",
    "卖出": "ask",
    "成交量": "volume",
    "成交额": "amount",
    "振幅": "amplitude_pct",
    "最高": "high",
    "最低": "low",
    "今开": "open",
    "昨收": "prev_close",
    "量比": "volume_ratio",
    "换手率": "turnover_rate_pct",
    "市盈率-动态": "pe_dynamic",
    "市净率": "pb",
    "总市值": "market_cap",
    "流通市值": "float_market_cap",
    "涨速": "change_speed_pct",
    "60日涨跌幅": "change_60d_pct",
    "年初至今涨跌幅": "change_ytd_pct",
    "时间戳": "time",
}

HIST_COLUMNS = {
    "日期": "date",
    "时间": "time",
    "股票代码": "code",
    "开盘": "open",
    "收盘": "close",
    "最高": "high",
    "最低": "low",
    "成交量": "volume",
    "成交额": "amount",
    "振幅": "amplitude_pct",
    "涨跌幅": "change_pct",
    "涨跌额": "change",
    "换手率": "turnover_rate_pct",
    # 新浪/腾讯日线：date 为英文列，turnover 是换手率小数（0.0032 = 0.32%）
    "date": "date",
    "open": "open",
    "close": "close",
    "high": "high",
    "low": "low",
    "volume": "volume",
    "amount": "amount",
    "turnover": "turnover",
}

INDEX_SPOT_COLUMNS = {
    "代码": "code",
    "名称": "name",
    "最新价": "price",
    "涨跌幅": "change_pct",
    "涨跌额": "change",
    "成交量": "volume",
    "成交额": "amount",
    "振幅": "amplitude_pct",
    "最高": "high",
    "最低": "low",
    "今开": "open",
    "昨收": "prev_close",
}

INDEX_HIST_COLUMNS = {
    "date": "date",
    "open": "open",
    "close": "close",
    "high": "high",
    "low": "low",
    "volume": "volume",
    "amount": "amount",
}

BOARD_COLUMNS = {
    # 东方财富
    "排名": "rank",
    "板块名称": "name",
    "板块代码": "code",
    "最新价": "price",
    "涨跌幅": "change_pct",
    "总市值": "market_cap",
    "换手率": "turnover_rate_pct",
    "上涨家数": "up_count",
    "下跌家数": "down_count",
    "领涨股票": "leader",
    "领涨股票-涨跌幅": "leader_change_pct",
    # 同花顺
    "板块": "name",
    "总成交量": "volume",
    "总成交额": "amount",
    "净流入": "net_inflow",
    "均价": "avg_price",
    "领涨股": "leader",
    "领涨股-最新价": "leader_price",
    "领涨股-涨跌幅": "leader_change_pct",
    # 新浪行业
    "label": "label",
    "公司家数": "company_count",
    "平均价格": "avg_price",
    "涨跌额": "change",
    "股票名称": "leader",
    "个股-当前价": "leader_price",
    "个股-涨跌幅": "leader_change_pct",
}

NUMERIC_KEYS = {
    "price", "change", "change_pct", "volume", "amount", "amplitude_pct",
    "turnover_rate_pct", "open", "high", "low", "close", "prev_close",
    "bid", "ask", "volume_ratio", "pe_dynamic", "pb", "market_cap",
    "float_market_cap", "change_speed_pct", "change_60d_pct", "change_ytd_pct",
    "up_count", "down_count", "leader_change_pct", "leader_price",
    "net_inflow", "avg_price", "company_count", "rank",
}

_ak: Any = None
_cache: dict[str, tuple[float, Any]] = {}


class StockError(RuntimeError):
    """可展示给模型的查数失败原因（参数错误、数据源失败、无数据等）。"""


def _akshare() -> Any:
    global _ak
    if _ak is None:
        socket.setdefaulttimeout(SOCKET_TIMEOUT_SECONDS)
        try:
            # akshare 及部分依赖会在导入/调用时向 stdout 打印，stdio 协议下会污染 JSON-RPC
            with contextlib.redirect_stdout(sys.stderr):
                import akshare as akshare_module
        except ImportError as error:  # pragma: no cover - 取决于部署环境
            raise StockError(
                "缺少 akshare：请在 mcp/sv-stock-mcp 下用 Python 3.10+ 创建虚拟环境并安装依赖"
                "（python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt）"
            ) from error
        _ak = akshare_module
    return _ak


def _call(function: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """调用 akshare，吞掉其 stdout 输出，并对网络类失败重试一次。"""
    last_error: Exception | None = None
    for attempt in range(2):
        try:
            with contextlib.redirect_stdout(sys.stderr):
                return function(*args, **kwargs)
        except StockError:
            raise
        except Exception as error:  # akshare 内部会抛 requests / KeyError 等各类异常
            last_error = error
            if attempt == 0:
                time.sleep(0.6)
    raise StockError(f"数据源请求失败（{getattr(function, '__name__', 'akshare')}）：{last_error}") from last_error


def _cached(key: str, ttl: int, loader: Callable[[], Any]) -> Any:
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    value = loader()
    _cache[key] = (now, value)
    return value


def _jsonable(value: Any) -> Any:
    if value is None:
        return None
    if value.__class__.__name__ in ("NaTType", "NAType"):
        return None
    if hasattr(value, "item"):  # numpy 标量
        value = value.item()
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    if isinstance(value, str):
        return value.strip()
    return value


def _records(frame: Any, mapping: dict[str, str] | None = None) -> list[dict[str, Any]]:
    if frame is None or len(frame) == 0:
        return []
    if mapping:
        columns = {source: target for source, target in mapping.items() if source in frame.columns}
        if columns:
            frame = frame[list(columns)].rename(columns=columns)
    rows: list[dict[str, Any]] = []
    for raw in frame.to_dict("records"):
        row: dict[str, Any] = {}
        for key, value in raw.items():
            value = _jsonable(value)
            # 上游偶尔把数值返回成字符串（如新浪分钟线的成交额），统一转成数值
            if key in NUMERIC_KEYS and isinstance(value, str) and value:
                try:
                    value = float(value)
                except ValueError:
                    pass
            row[key] = value
        rows.append(row)
    return rows


def _norm_date(value: Any, default: datetime.date) -> datetime.date:
    text = str(value or "").strip()
    if not text:
        return default
    compact = re.sub(r"[-/.]", "", text)
    if not re.fullmatch(r"\d{8}", compact):
        raise StockError(f"日期格式不正确：{text}；请用 YYYYMMDD 或 YYYY-MM-DD")
    try:
        return datetime.datetime.strptime(compact, "%Y%m%d").date()
    except ValueError as error:
        raise StockError(f"日期不存在：{text}") from error


def _date_range(
    start_date: Any, end_date: Any, default_days: int
) -> tuple[datetime.date, datetime.date]:
    today = datetime.date.today()
    start = _norm_date(start_date, today - datetime.timedelta(days=default_days))
    end = _norm_date(end_date, today)
    if start > end:
        raise StockError(f"开始日期 {start.isoformat()} 晚于结束日期 {end.isoformat()}")
    return start, end


def _norm_code(value: Any) -> str:
    """把 `sh600519` / `600519.SH` / `600519` 统一成 6 位数字。"""
    text = str(value or "").strip().upper()
    match = re.fullmatch(r"(?:SH|SZ|BJ)?(\d{6})(?:\.(?:SH|SZ|BJ))?", text)
    if not match:
        raise StockError(f"股票代码格式不正确：{value}；A 股请用 6 位数字，如 600519")
    return match.group(1)


def _board_of(code: str) -> str:
    if code.startswith("688"):
        return "科创板"
    if code.startswith(("300", "301")):
        return "创业板"
    if code.startswith(("4", "8", "92")):
        return "北交所"
    if code.startswith("6"):
        return "沪市主板"
    if code.startswith(("000", "001", "002", "003")):
        return "深市主板"
    return "A股"


def _stock_prefix(code: str) -> str:
    if code.startswith(("6", "9")):
        return "sh" + code
    if code.startswith(("4", "8")):
        return "bj" + code
    return "sz" + code


def _index_prefix(code: str) -> str:
    """指数代码补全交易所前缀：上证 000xxx、深证 399xxx、北证 899xxx。"""
    digits = _norm_code(code)
    if digits.startswith(("000", "880", "950")):
        return "sh" + digits
    if digits.startswith(("399", "980")):
        return "sz" + digits
    if digits.startswith("899"):
        return "bj" + digits
    return "sh" + digits


def _symbol_frame() -> Any:
    def load() -> Any:
        akshare = _akshare()
        try:
            frame = _call(akshare.stock_info_a_code_name)
            if frame is not None and len(frame):
                frame = frame.rename(columns={"code": "代码", "name": "名称"})
                return frame[["代码", "名称"]]
        except StockError:
            pass
        # 兜底：用实时行情表里的代码/名称（同一数据源，通常更稳）
        spot, _source = _spot_frame()
        return spot[["代码", "名称"]]

    return _cached("symbols", SYMBOL_TTL_SECONDS, load)


def _spot_frame() -> Any:
    def load() -> Any:
        akshare = _akshare()
        errors: list[str] = []
        # 新浪全市场快照是当前网络环境下最稳定的来源；东财 push2 经常 403
        for function, source in (
            (getattr(akshare, "stock_zh_a_spot", None), "sina"),
            (getattr(akshare, "stock_zh_a_spot_em", None), "em"),
        ):
            if function is None:
                continue
            try:
                frame = _call(function)
                if frame is not None and len(frame):
                    return frame, source
            except StockError as error:
                errors.append(str(error))
        raise StockError("实时行情获取失败：" + "；".join(errors))

    return _cached("spot", SPOT_TTL_SECONDS, load)


def _spot_rows() -> list[dict[str, Any]]:
    frame, source = _spot_frame()
    rows = _records(frame, SPOT_COLUMNS)
    cleaned: list[dict[str, Any]] = []
    for row in rows:
        code = re.sub(r"\D", "", str(row.get("code") or ""))
        if len(code) != 6:
            continue
        row["code"] = code
        # 新浪成交量单位为股，统一折算成手（东财本身就是手）
        if source == "sina" and row.get("volume") is not None:
            row["volume"] = round(float(row["volume"]) / 100, 2)
        cleaned.append(row)
    return cleaned


def _index_spot_frame() -> Any:
    def load() -> Any:
        akshare = _akshare()
        errors: list[str] = []
        attempts: list[Callable[[], Any]] = []
        if hasattr(akshare, "stock_zh_index_spot_sina"):
            attempts.append(lambda: _call(akshare.stock_zh_index_spot_sina))
        if hasattr(akshare, "stock_zh_index_spot_em"):
            attempts.append(lambda: _call(akshare.stock_zh_index_spot_em, symbol="沪深重要指数"))
        for attempt in attempts:
            try:
                frame = attempt()
                if frame is not None and len(frame):
                    return frame
            except StockError as error:
                errors.append(str(error))
        raise StockError("指数行情获取失败：" + "；".join(errors))

    return _cached("index_spot", INDEX_SPOT_TTL_SECONDS, load)


def _find_symbol(keyword: str, limit: int) -> list[dict[str, Any]]:
    text = keyword.strip()
    if not text:
        raise StockError("keyword 不能为空")
    rows = _records(_symbol_frame())
    wanted = text.upper()
    exact_code: list[dict[str, Any]] = []
    exact_name: list[dict[str, Any]] = []
    prefix: list[dict[str, Any]] = []
    contains: list[dict[str, Any]] = []
    for row in rows:
        raw_code = str(row.get("代码") or "").strip()
        if not raw_code:
            continue
        code = raw_code.zfill(6)
        name = str(row.get("名称") or "")
        item = {"code": code, "name": name, "board": _board_of(code)}
        if code == wanted:
            exact_code.append(item)
        elif name == text:
            exact_name.append(item)
        elif code.startswith(wanted) or name.upper().startswith(wanted):
            prefix.append(item)
        elif wanted in name.upper() or wanted in code:
            contains.append(item)
    return (exact_code + exact_name + prefix + contains)[:limit]


def _resolve_symbol(value: Any) -> str:
    """代码直接归一化；中文名称/简称走一次模糊查找，唯一命中才放行。"""
    text = str(value or "").strip()
    if re.fullmatch(r"(?:SH|SZ|BJ)?\d{6}(?:\.(?:SH|SZ|BJ))?", text.upper()):
        return _norm_code(text)
    matches = _find_symbol(text, 5)
    if not matches:
        raise StockError(f"找不到股票：{text}；可先用 stock_search 按名称或代码搜索")
    exact = [item for item in matches if item["name"] == text]
    if len(exact) == 1:
        return exact[0]["code"]
    if len(matches) == 1:
        return matches[0]["code"]
    candidates = "、".join(f"{item['code']} {item['name']}" for item in matches)
    raise StockError(f"「{text}」匹配到多只股票，请改用代码：{candidates}")


def _name_of(code: str) -> str:
    try:
        for row in _records(_symbol_frame()):
            if re.sub(r"\D", "", str(row.get("代码") or "")).zfill(6) == code:
                return str(row.get("名称") or "")
    except StockError:
        return ""
    return ""


def _derive_changes(rows: list[dict[str, Any]], turnover_scale: float | None) -> list[dict[str, Any]]:
    """补涨跌幅/振幅/换手率，并统一换手率口径（小数 → 百分数）。"""
    previous_close: float | None = None
    for row in rows:
        turnover = row.pop("turnover", None)
        if turnover is not None and turnover_scale is not None:
            row["turnover_rate_pct"] = round(float(turnover) * turnover_scale, 3)
        close = row.get("close")
        if close is not None:
            close = float(close)
            if previous_close:
                row["change"] = round(close - previous_close, 4)
                row["change_pct"] = round((close / previous_close - 1) * 100, 3)
                high, low = row.get("high"), row.get("low")
                if high is not None and low is not None:
                    row["amplitude_pct"] = round((float(high) - float(low)) / previous_close * 100, 3)
            previous_close = close
    return rows


def _resample(rows: list[dict[str, Any]], period: str) -> list[dict[str, Any]]:
    if period == "daily" or not rows:
        return rows
    try:
        import pandas as pd  # akshare 的依赖，必然可用
    except ImportError:  # pragma: no cover
        return rows

    frame = pd.DataFrame(rows)
    frame["date"] = pd.to_datetime(frame["date"])
    frame = frame.set_index("date").sort_index()
    aggregation = {
        "open": "first",
        "high": "max",
        "low": "min",
        "close": "last",
        "volume": "sum",
        "amount": "sum",
    }
    aggregation = {key: value for key, value in aggregation.items() if key in frame.columns}
    rule = "W-FRI" if period == "weekly" else "ME"
    try:
        grouped = frame.resample(rule).agg(aggregation).dropna(subset=["close"])
    except ValueError:  # pandas < 2.2 使用 "M"
        grouped = frame.resample("M").agg(aggregation).dropna(subset=["close"])
    grouped = grouped.reset_index()
    grouped["date"] = grouped["date"].dt.strftime("%Y-%m-%d")
    result = _records(grouped)
    for row in result:
        for key in ("volume", "amount"):
            if row.get(key) is not None:
                row[key] = round(float(row[key]), 2)
    return _derive_changes(result, None)


def search(keyword: str, limit: int = 10) -> dict[str, Any]:
    limit = max(1, min(int(limit), 50))
    results = _find_symbol(keyword, limit)
    return {"keyword": keyword, "count": len(results), "results": results}


def quote(symbols: Any) -> dict[str, Any]:
    if isinstance(symbols, str):
        items = [part for part in re.split(r"[,，\s]+", symbols) if part]
    elif isinstance(symbols, (list, tuple)):
        items = [str(part) for part in symbols]
    else:
        raise StockError("symbols 必须是股票代码字符串（逗号分隔）或代码数组")
    if not items:
        raise StockError("symbols 不能为空")
    if len(items) > 20:
        raise StockError("一次最多查询 20 只股票")

    _frame, source = _spot_frame()
    lookup: dict[str, dict[str, Any]] = {row["code"]: row for row in _spot_rows()}

    results: list[dict[str, Any]] = []
    for item in items:
        try:
            code = _resolve_symbol(item)
        except StockError as error:
            results.append({"input": item, "error": str(error)})
            continue
        row = lookup.get(code)
        if row is None:
            results.append({"code": code, "error": "实时行情表中没有该代码（可能已退市或停牌）"})
            continue
        results.append(row)

    return {
        "fetched_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "delay": REALTIME_DELAY,
        "source": "新浪财经" if source == "sina" else "东方财富",
        "note": "volume 单位为手，amount 单位为元；换手率/市盈率/市值等字段取决于数据源，缺失时不返回",
        "count": len(results),
        "quotes": results,
    }


def _history_rows(
    code: str,
    start: datetime.date,
    end: datetime.date,
    period: str,
    adjust: str,
    is_minute: bool,
) -> tuple[list[dict[str, Any]], str]:
    akshare = _akshare()
    prefixed = _stock_prefix(code)
    errors: list[str] = []

    if is_minute:
        attempts: list[tuple[str, Callable[[], Any]]] = []
        if hasattr(akshare, "stock_zh_a_minute"):
            attempts.append(("sina", lambda: _call(
                akshare.stock_zh_a_minute, symbol=prefixed, period=period, adjust=adjust
            )))
        if hasattr(akshare, "stock_zh_a_hist_min_em"):
            attempts.append(("em", lambda: _call(
                akshare.stock_zh_a_hist_min_em,
                symbol=code,
                period=period,
                adjust=adjust,
                start_date=f"{start.isoformat()} 09:30:00",
                end_date=f"{end.isoformat()} 15:00:00",
            )))
        for source, attempt in attempts:
            try:
                frame = attempt()
            except StockError as error:
                errors.append(str(error))
                continue
            rows = _records(frame, {**HIST_COLUMNS, "day": "date", "时间": "time"})
            # 新浪分时接口会把当天尚未收完的 bar 返回成 NaN，丢弃这些行
            rows = [row for row in rows if row.get("close") is not None]
            if source == "sina":
                for row in rows:
                    if row.get("volume") is not None:
                        row["volume"] = round(float(row["volume"]) / 100, 2)
                rows = _derive_changes(rows, None)
            rows = [
                row for row in rows
                if row.get("date") and start.isoformat() <= str(row["date"])[:10] <= end.isoformat()
            ]
            rows.sort(key=lambda row: str(row.get("date") or ""))
            if rows:
                return rows, "新浪财经" if source == "sina" else "东方财富"
        raise StockError("分钟行情获取失败：" + ("；".join(errors) or "数据源无数据"))

    attempts = []
    if hasattr(akshare, "stock_zh_a_daily"):
        attempts.append(("sina", lambda: _call(
            akshare.stock_zh_a_daily,
            symbol=prefixed,
            start_date=start.strftime("%Y%m%d"),
            end_date=end.strftime("%Y%m%d"),
            adjust=adjust,
        )))
    if hasattr(akshare, "stock_zh_a_hist_tx"):
        attempts.append(("tx", lambda: _call(
            akshare.stock_zh_a_hist_tx,
            symbol=prefixed,
            start_date=start.strftime("%Y%m%d"),
            end_date=end.strftime("%Y%m%d"),
            adjust=adjust,
        )))
    if hasattr(akshare, "stock_zh_a_hist"):
        attempts.append(("em", lambda: _call(
            akshare.stock_zh_a_hist,
            symbol=code,
            period="daily",
            start_date=start.strftime("%Y%m%d"),
            end_date=end.strftime("%Y%m%d"),
            adjust=adjust,
        )))

    for source, attempt in attempts:
        try:
            frame = attempt()
        except StockError as error:
            errors.append(str(error))
            continue
        rows = _records(frame, HIST_COLUMNS)
        if not rows:
            continue
        # 新浪/腾讯成交量是股、换手率是小数；东财是手、换手率是百分数
        if source in ("sina", "tx"):
            for row in rows:
                if row.get("volume") is not None:
                    row["volume"] = round(float(row["volume"]) / 100, 2)
            rows = _derive_changes(rows, 100)
        else:
            rows = _derive_changes(rows, None)
        rows.sort(key=lambda row: str(row.get("date") or ""))
        rows = _resample(rows, period)
        if rows:
            return rows, {"sina": "新浪财经", "tx": "腾讯财经", "em": "东方财富"}[source]
    raise StockError("历史行情获取失败：" + ("；".join(errors) or "数据源无数据"))


def history(
    symbol: str,
    start_date: Any = "",
    end_date: Any = "",
    period: str = "daily",
    adjust: str = "qfq",
    limit: int = 500,
) -> dict[str, Any]:
    code = _resolve_symbol(symbol)
    period = (period or "daily").strip()
    if period not in ("daily", "weekly", "monthly", "1", "5", "15", "30", "60"):
        raise StockError("period 只支持 daily / weekly / monthly / 1 / 5 / 15 / 30 / 60")
    adjust = (adjust or "").strip().lower()
    if adjust not in ("", "qfq", "hfq"):
        raise StockError("adjust 只支持 qfq（前复权）/ hfq（后复权）/ ''（不复权）")
    if period in ("daily", "weekly", "monthly") and not adjust:
        adjust = "qfq"

    limit = max(1, min(int(limit), 2000))
    is_minute = period.isdigit()
    start, end = _date_range(start_date, end_date, 7 if is_minute else 365)
    rows, source = _history_rows(code, start, end, period, adjust, is_minute)

    total = len(rows)
    truncated = total > limit
    if truncated:
        rows = rows[-limit:]

    return {
        "symbol": code,
        "name": _name_of(code),
        "period": period,
        "adjust": adjust or "none",
        "start": start.isoformat(),
        "end": end.isoformat(),
        "source": source,
        "count": len(rows),
        "total": total,
        "truncated": truncated,
        "note": "个股 volume 单位为手，amount 单位为元；分钟线只保留数据源提供的最近若干交易日",
        "rows": rows,
    }


def index_history(
    symbol: str,
    start_date: Any = "",
    end_date: Any = "",
    period: str = "daily",
    limit: int = 500,
) -> dict[str, Any]:
    period = (period or "daily").strip()
    if period not in ("daily", "weekly", "monthly"):
        raise StockError("指数周期只支持 daily / weekly / monthly")
    limit = max(1, min(int(limit), 2000))
    start, end = _date_range(start_date, end_date, 365)
    prefixed = _index_prefix(str(symbol))
    digits = prefixed[2:]

    akshare = _akshare()
    errors: list[str] = []
    frame = None
    source = ""
    attempts: list[tuple[str, Callable[[], Any]]] = []
    if hasattr(akshare, "stock_zh_index_daily"):
        attempts.append(("sina", lambda: _call(akshare.stock_zh_index_daily, symbol=prefixed)))
    if hasattr(akshare, "stock_zh_index_daily_em"):
        attempts.append(("em", lambda: _call(
            akshare.stock_zh_index_daily_em,
            symbol=prefixed,
            start_date=start.strftime("%Y%m%d"),
            end_date=end.strftime("%Y%m%d"),
        )))
    for candidate, attempt in attempts:
        try:
            frame = attempt()
            if frame is not None and len(frame):
                source = candidate
                break
        except StockError as error:
            errors.append(str(error))
    if frame is None:
        raise StockError("指数历史行情获取失败：" + "；".join(errors))

    rows = _records(frame, INDEX_HIST_COLUMNS)
    rows = [
        row for row in rows
        if row.get("date") and start.isoformat() <= str(row["date"])[:10] <= end.isoformat()
    ]
    rows.sort(key=lambda row: str(row.get("date") or ""))
    rows = _derive_changes(rows, None)
    rows = _resample(rows, period)

    total = len(rows)
    truncated = total > limit
    if truncated:
        rows = rows[-limit:]

    name = next((label for code, label in MAJOR_INDICES if code == digits), "")
    return {
        "symbol": prefixed,
        "name": name,
        "period": period,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "source": "新浪财经" if source == "sina" else "东方财富",
        "count": len(rows),
        "total": total,
        "truncated": truncated,
        "note": "指数 volume 为数据源原始口径；周/月线由日线聚合",
        "rows": rows,
    }


def market_overview() -> dict[str, Any]:
    spot = _spot_rows()
    total = 0
    up = down = flat = limit_up = limit_down = 0
    amount_sum = 0.0
    changes: list[float] = []
    distribution = {
        "above_7": 0,
        "3_to_7": 0,
        "0_to_3": 0,
        "flat": 0,
        "minus_3_to_0": 0,
        "minus_7_to_3": 0,
        "below_minus_7": 0,
    }
    valid: list[dict[str, Any]] = []
    for row in spot:
        if not row.get("price") or row.get("change_pct") is None:
            continue
        change = float(row["change_pct"])
        code = str(row.get("code") or "")
        total += 1
        changes.append(change)
        if row.get("amount"):
            amount_sum += float(row["amount"])
        if change > 0:
            up += 1
        elif change < 0:
            down += 1
        else:
            flat += 1
        # 涨跌停按所属板块的常见幅度粗估（主板 10%，创业板/科创板 20%，北交所 30%）
        if code.startswith(("4", "8", "92")):
            band = 29.8
        elif code.startswith(("300", "301", "688")):
            band = 19.8
        else:
            band = 9.8
        if change >= band:
            limit_up += 1
        if change <= -band:
            limit_down += 1
        if change > 7:
            distribution["above_7"] += 1
        elif change > 3:
            distribution["3_to_7"] += 1
        elif change > 0:
            distribution["0_to_3"] += 1
        elif change == 0:
            distribution["flat"] += 1
        elif change > -3:
            distribution["minus_3_to_0"] += 1
        elif change > -7:
            distribution["minus_7_to_3"] += 1
        else:
            distribution["below_minus_7"] += 1
        valid.append(row)

    valid.sort(key=lambda row: float(row.get("change_pct") or 0), reverse=True)
    by_amount = sorted(
        [row for row in valid if row.get("amount")], key=lambda row: float(row["amount"]), reverse=True
    )

    indices: list[dict[str, Any]] = []
    indices_error = ""
    try:
        index_rows = _records(_index_spot_frame(), INDEX_SPOT_COLUMNS)
        lookup: dict[str, dict[str, Any]] = {}
        for row in index_rows:
            digits = re.sub(r"\D", "", str(row.get("code") or ""))
            if digits:
                lookup[digits.zfill(6)] = row
        for code, label in MAJOR_INDICES:
            row = lookup.get(code)
            if row:
                indices.append({"code": code, "name": row.get("name") or label, **{
                    key: value for key, value in row.items() if key not in ("code", "name")
                }})
    except StockError as error:
        indices_error = str(error)

    breadth = {
        "total": total,
        "up": up,
        "down": down,
        "flat": flat,
        "up_ratio": round(up / total, 4) if total else None,
        "limit_up_est": limit_up,
        "limit_down_est": limit_down,
        "median_change_pct": round(sorted(changes)[len(changes) // 2], 2) if changes else None,
        "distribution": distribution,
    }
    payload: dict[str, Any] = {
        "fetched_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "delay": REALTIME_DELAY,
        "source": "新浪财经 / 东方财富（akshare）",
        "indices": indices,
        "breadth": breadth,
        "turnover": {
            "total_amount": round(amount_sum, 2),
            "total_amount_yi": round(amount_sum / 1e8, 2),
        },
        "top_gainers": _brief(valid[:5]),
        "top_losers": _brief(list(reversed(valid[-5:]))),
        "top_turnover": _brief(by_amount[:5]),
    }
    if indices_error:
        payload["indices_error"] = indices_error
    return payload


def _brief(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    keys = ("code", "name", "price", "change_pct", "amount", "turnover_rate_pct")
    return [{key: row.get(key) for key in keys} for row in rows]


def industry_rank(limit: int = 20, direction: str = "top") -> dict[str, Any]:
    limit = max(1, min(int(limit), 100))
    direction = (direction or "top").strip().lower()
    if direction not in ("top", "bottom"):
        raise StockError("direction 只支持 top（涨幅榜）/ bottom（跌幅榜）")
    akshare = _akshare()
    errors: list[str] = []
    rows: list[dict[str, Any]] = []
    source = ""

    # 同花顺：成交量单位为万手、成交额/净流入单位为亿元
    if hasattr(akshare, "stock_board_industry_summary_ths"):
        try:
            frame = _cached(
                "industry_ths",
                BOARD_TTL_SECONDS,
                lambda: _call(akshare.stock_board_industry_summary_ths),
            )
            rows = _records(frame, BOARD_COLUMNS)
            for row in rows:
                if row.get("volume") is not None:
                    row["volume"] = round(float(row["volume"]) * 10000, 2)
                if row.get("amount") is not None:
                    row["amount"] = round(float(row["amount"]) * 1e8, 2)
                if row.get("net_inflow") is not None:
                    row["net_inflow"] = round(float(row["net_inflow"]) * 1e8, 2)
            source = "同花顺行业板块"
        except StockError as error:
            errors.append(str(error))

    # 新浪行业：涨跌幅是小数，成交量单位为股
    if not rows and hasattr(akshare, "stock_sector_spot"):
        try:
            frame = _cached(
                "industry_sina",
                BOARD_TTL_SECONDS,
                lambda: _call(akshare.stock_sector_spot, indicator="新浪行业"),
            )
            rows = _records(frame, BOARD_COLUMNS)
            for row in rows:
                if row.get("change_pct") is not None:
                    row["change_pct"] = round(float(row["change_pct"]) * 100, 2)
                if row.get("volume") is not None:
                    row["volume"] = round(float(row["volume"]) / 100, 2)
            source = "新浪行业板块"
        except StockError as error:
            errors.append(str(error))

    # 东方财富兜底（部分网络环境会 403）
    if not rows and hasattr(akshare, "stock_board_industry_name_em"):
        try:
            frame = _cached(
                "industry_em",
                BOARD_TTL_SECONDS,
                lambda: _call(akshare.stock_board_industry_name_em),
            )
            rows = _records(frame, BOARD_COLUMNS)
            source = "东方财富行业板块"
        except StockError as error:
            errors.append(str(error))

    if not rows:
        raise StockError("行业板块行情获取失败：" + ("；".join(errors) or "数据源无数据"))
    rows = [row for row in rows if row.get("change_pct") is not None]
    rows.sort(key=lambda row: float(row["change_pct"]), reverse=(direction == "top"))
    return {
        "fetched_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "delay": REALTIME_DELAY,
        "source": source,
        "direction": direction,
        "count": len(rows),
        "note": "volume 单位为手，amount 与 net_inflow 单位为元（不同数据源已换算到同一口径）",
        "boards": rows[:limit],
    }
