/**
 * 千问在线语音合成（Qwen-Audio-TTS WebSocket）。
 *
 * 与 DashScope Python SDK 的 SpeechSynthesizer 流程一致：
 *   run-task → task-started → continue-task（文本）→ finish-task → task-finished，
 * 音频以 WebSocket 二进制帧返回；同时兼容旧版网关在 result-generated
 * 里用 base64 回传音频的实现。
 *
 * 服务地址、模型、音色、语速与 API Key 都由 /sv 设置页写入 config.json，
 * 这里只负责一次合成任务的协议交互。
 */
import { randomUUID } from 'node:crypto'

/** 语音合成配置（密钥只留在服务端）。 */
export interface SvTtsConfig {
  /** WebSocket 服务地址，如 wss://cn-beijing.maas.qianwenaiapi.com/api-ws/v1/inference。 */
  baseURL: string
  /** 模型 id，如 qwen-audio-3.1-tts-flash。 */
  model: string
  /** 音色 id，如 longanhuan_v3.1。 */
  voice: string
  /** 语速，范围 0.5–2.0，默认 1.0。 */
  rate: number
  /** API Key；空字符串表示未配置。 */
  apiKey: string
}

/** 单次 continue-task 的文本上限（服务端约定 20000 字符）。 */
export const MAX_TTS_TEXT = 20_000

/** 整次合成任务的超时毫秒（文本越长等待越久）。 */
function taskTimeoutMs(text: string): number {
  return Math.min(180_000, Math.max(60_000, 30_000 + text.length * 20))
}

/**
 * 归一化 WebSocket 地址：允许填写 http(s) 或省略协议，最终统一为 ws(s) URL。
 * @param raw - 用户填写的地址。
 * @returns 合法的 ws(s) URL；无法解析时返回 undefined。
 */
export function normalizeTtsUrl(raw: string): string | undefined {
  const value = raw.trim()
  if (value.length === 0) return undefined
  // 带协议时只接受 WebSocket / HTTP(S)；其它协议（ftp:// 等）直接判非法
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    if (!/^(ws|wss|http|https):/i.test(value)) return undefined
  }
  let candidate = value
  if (/^https:\/\//i.test(candidate)) candidate = `wss://${candidate.slice('https://'.length)}`
  else if (/^http:\/\//i.test(candidate)) candidate = `ws://${candidate.slice('http://'.length)}`
  else if (!/^wss?:\/\//i.test(candidate)) candidate = `wss://${candidate}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

/** 语速收敛到服务端支持的 0.5–2.0。 */
function clampRate(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(2, Math.max(0.5, value))
}

interface WsMessageEventLike {
  data: unknown
}

interface WsCloseEventLike {
  code?: number
}

interface WsLike {
  binaryType: string
  send(data: string): void
  close(): void
  addEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: WsMessageEventLike & WsCloseEventLike) => void,
  ): void
}

type WsConstructor = new (url: string, options?: { headers?: Record<string, string> }) => WsLike

/** 服务端事件的最小结构（只取合成需要的字段）。 */
interface TtsServerEvent {
  header?: {
    event?: string
    error_code?: string
    error_message?: string
  }
  payload?: {
    output?: {
      audio?: {
        data?: unknown
      }
    }
    error_code?: string
    error_message?: string
  }
}

/**
 * 合成一段文本，返回 mp3 音频。
 * @param config - 语音合成配置。
 * @param text - 待合成文本（纯文本，最多 {@link MAX_TTS_TEXT} 字符）。
 * @returns 音频字节。
 */
export async function synthesizeSpeech(config: SvTtsConfig, text: string): Promise<Buffer> {
  const apiKey = config.apiKey.trim()
  if (apiKey.length === 0) throw new Error('未配置语音合成 API Key，请在设置中填写')
  const voice = config.voice.trim()
  if (voice.length === 0) throw new Error('音色不能为空')
  const model = config.model.trim()
  if (model.length === 0) throw new Error('语音合成模型不能为空')
  const plain = text.trim()
  if (plain.length === 0) throw new Error('待朗读文本不能为空')
  if (plain.length > MAX_TTS_TEXT) throw new Error(`单次朗读文本最多 ${MAX_TTS_TEXT} 字`)
  const url = normalizeTtsUrl(config.baseURL)
  if (url === undefined) throw new Error('语音合成服务地址必须是 ws:// 或 wss:// URL')
  const WebSocketImpl = (globalThis as { WebSocket?: WsConstructor }).WebSocket
  if (WebSocketImpl === undefined) throw new Error('当前 Node 运行环境不支持 WebSocket，无法调用语音合成')

  const taskId = randomUUID()
  return new Promise<Buffer>((resolve, reject) => {
    const audio: Buffer[] = []
    let settled = false
    let started = false
    const ws = new WebSocketImpl(url, {
      headers: {
        Authorization: `bearer ${apiKey}`,
        'X-DashScope-DataInspection': 'enable',
      },
    })
    ws.binaryType = 'arraybuffer'

    const timer = setTimeout(() => {
      fail(new Error(`语音合成超时（超过 ${Math.round(taskTimeoutMs(plain) / 1000)} 秒未完成）`))
    }, taskTimeoutMs(plain))

    const cleanup = (): void => {
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        // 连接可能已经关闭；忽略重复关闭错误
      }
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const finish = (): void => {
      if (settled) return
      settled = true
      cleanup()
      if (audio.length === 0) {
        reject(new Error('语音合成未返回音频数据'))
        return
      }
      resolve(Buffer.concat(audio))
    }

    const sendJson = (value: unknown): void => {
      ws.send(JSON.stringify(value))
    }

    ws.addEventListener('open', () => {
      sendJson({
        header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
        payload: {
          task_group: 'audio',
          task: 'tts',
          function: 'SpeechSynthesizer',
          model,
          parameters: {
            text_type: 'PlainText',
            voice,
            format: 'mp3',
            sample_rate: 24000,
            volume: 50,
            rate: clampRate(config.rate),
            pitch: 1,
            enable_markdown_filter: false,
          },
          input: {},
        },
      })
    })

    ws.addEventListener('message', event => {
      const data = event.data
      if (typeof data === 'string') {
        let message: TtsServerEvent
        try {
          message = JSON.parse(data) as TtsServerEvent
        } catch {
          return
        }
        const header = message.header ?? {}
        switch (header.event) {
          case 'task-started':
            if (!started) {
              started = true
              sendJson({
                header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
                payload: { input: { text: plain } },
              })
              sendJson({
                header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
                payload: { input: {} },
              })
            }
            break
          case 'result-generated': {
            // 旧版网关把音频放在 JSON 里；新版走二进制帧。
            const base64 = message.payload?.output?.audio?.data
            if (typeof base64 === 'string' && base64.length > 0) {
              audio.push(Buffer.from(base64, 'base64'))
            }
            break
          }
          case 'task-finished':
            finish()
            break
          case 'task-failed': {
            const code = header.error_code ?? message.payload?.error_code
            const detail = header.error_message ?? message.payload?.error_message
            fail(new Error(`语音合成失败${code === undefined ? '' : `（${code}）`}${detail === undefined ? '' : `：${detail}`}`))
            break
          }
          default:
            break
        }
        return
      }
      if (data instanceof ArrayBuffer) {
        if (data.byteLength > 0) audio.push(Buffer.from(data))
        return
      }
      if (ArrayBuffer.isView(data)) {
        if (data.byteLength > 0) audio.push(Buffer.from(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)))
      }
    })

    ws.addEventListener('error', () => {
      fail(new Error('无法连接语音合成服务，请检查服务地址、API Key 与网络'))
    })

    ws.addEventListener('close', event => {
      if (!settled) fail(new Error(`语音合成连接中断（code ${event.code ?? 0}）`))
    })
  })
}
