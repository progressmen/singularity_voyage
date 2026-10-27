/**
 * 统一日志格式。
 *
 * 输出形如（时间前缀由 stdout 出口统一添加）：
 *   2026-10-22 18:12:03 [sv-app][memory] memory_extracted count=2
 *   2026-10-22 18:12:04 [sv-app][http] request method=POST path=/sv/api/chat status=200 durationMs=2453
 *
 * 约定：
 *  - 模块名固定（见 {@link SvLogModule}），便于 grep 与定位；
 *  - 事件名小写 snake_case，动作在前；
 *  - 固定字段顺序为「业务字段 → err」，err 永远在行尾；
 *  - 含空格的值加引号，数字与布尔裸写，undefined/null 省略；
 *  - 不打印密钥、完整 header、记忆正文与任务备注（只打 id 与长度）。
 *
 * 级别语义：info = 状态变化与成功写入；warn = 可降级失败；error = 请求/数据无法处理。
 * 同一批日志同时由 stdout 出口与按天切分的文件（logs/sv-YYYY-MM-DD.log）落盘。
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** sv-app 的模块标签。 */
export type SvLogModule = 'index' | 'chat' | 'http' | 'reminders' | 'memory' | 'tasks' | 'mail' | 'tool'

/** 日志字段值。 */
export type SvLogFields = Record<string, string | number | boolean | null | undefined>

function formatValue(value: string | number | boolean): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return /[\s"=]/.test(value) ? JSON.stringify(value) : value
}

/**
 * 拼装一行日志文本。
 * @param module - 模块标签。
 * @param event - 小写 snake_case 事件名。
 * @param fields - 业务字段；`err` 自动排到行尾。
 */
export function svLog(module: SvLogModule, event: string, fields: SvLogFields = {}): string {
  const parts = [`[sv-app][${module}]`, event]
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'err' || value === undefined || value === null) continue
    parts.push(`${key}=${formatValue(value)}`)
  }
  const error = fields.err
  if (typeof error === 'string' && error.length > 0) parts.push(`err=${formatValue(error)}`)
  return parts.join(' ')
}

/** 从任意 catch 值提取可读的错误信息（只取 message，不展开堆栈）。 */
export function svError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 把错误写入 debug 级别的一行，供需要堆栈时单独查看。 */
export function svErrorTrace(error: unknown): string {
  if (error instanceof Error && error.stack !== undefined) return error.stack
  return svError(error)
}

/** 插件在 Cordis 树中的 logger 名称。 */
export const SV_PLUGIN_NAME = '@singularity-voyage/sv-app'

/** 只需要 exporter 能力的 logger 结构（避免依赖完整 LoggerService 类型）。 */
export interface SvLogSinkHost {
  exporter(options: {
    colors?: number | false
    levels?: Record<string, number>
    export(message: { name: string; type: string; args: unknown[] }): void
  }): unknown
}

/** 本地时间前缀 `YYYY-MM-DD HH:mm:ss`，用于按时间定位。 */
function timestamp(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 本地日期串 `YYYY-MM-DD`。 */
function localDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 日志落盘目录：$SV_LOG_DIR 可覆盖，默认仓库根 logs/（运行日志接口读同一目录）。 */
export function svLogDir(): string {
  const override = process.env.SV_LOG_DIR?.trim()
  if (override !== undefined && override.length > 0) return override
  return join(import.meta.dirname, '..', '..', '..', 'logs')
}

/** 按天切分的日志文件名，如 `sv-2026-10-26.log`。 */
export function svLogFileName(date: Date = new Date()): string {
  return `sv-${localDate(date)}.log`
}

/** 串行写盘队列：避免并发 append 交错。 */
let logWriteChain: Promise<void> = Promise.resolve()

/**
 * 追加一行到当天日志文件；跨天自动切到新文件。
 * 写盘失败静默（日志不能反过来影响主流程）；返回的 Promise 便于测试等待落盘。
 * @param line - 完整日志行（不含换行）。
 * @param date - 决定分文件的日期，默认当前时间。
 */
export function appendSvLogLine(line: string, date: Date = new Date()): Promise<void> {
  const dir = svLogDir()
  const file = join(dir, svLogFileName(date))
  const text = line.endsWith('\n') ? line : `${line}\n`
  const next = logWriteChain.then(async () => {
    await mkdir(dir, { recursive: true })
    await appendFile(file, text)
  })
  logWriteChain = next.catch(() => undefined)
  return logWriteChain
}

/**
 * 为 sv-app 安装 stdout 与文件日志出口。
 *
 * dsh 默认不把 logger 输出打到控制台（只有启动失败时由 boot 自行打印），
 * 因此本插件自带一个只输出自身消息的 exporter：error / info / warn 三类，
 * debug（堆栈）留在 logger buffer 里按需查看。默认写入 stdout，同时按天
 * 追加到 logs/sv-YYYY-MM-DD.log，服务重启不会覆盖历史日志。
 * @param logger - `ctx.logger`。
 * @param write - 单行输出函数；默认写 stdout + 当天日志文件，并加时间前缀。
 */
export function installSvLogSink(
  logger: SvLogSinkHost,
  write: (line: string) => void = line => {
    const text = `${timestamp()} ${line}`
    process.stdout.write(`${text}\n`)
    void appendSvLogLine(text)
  },
): void {
  logger.exporter({
    colors: false,
    // 2 = 输出 error / info / warn，跳过 debug
    levels: { default: 2 },
    export: ({ name, type, args }) => {
      if (name !== SV_PLUGIN_NAME && !name.endsWith('/sv-app')) return
      if (type !== 'error' && type !== 'info' && type !== 'warn') return
      write(args.map(arg => (typeof arg === 'string' ? arg : String(arg))).join(' '))
    },
  })
}
