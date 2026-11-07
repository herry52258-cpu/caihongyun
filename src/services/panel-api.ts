// 登录与面板请求的通道顺序。只有连接失败、超时，或明确不是业务 JSON 的响应才换下一条。
// 账号密码、验证码、限流等 JSON 业务结果必须原样返回，不能换线路重放。
export const API_CHANNELS = [
  'https://p2.yuntanlu.com/api/v1',
  'https://w1.yuntanlu.com/api/v1',
  'https://w2.yuntanlu.com/api/v1',
  'https://w3.yuntanlu.com/api/v1',
  'https://p1.yuntanlu.com/api/v1',
] as const

export const PANEL_LIMITS = {
  perChannelMs: 4000,
  totalMs: 12000,
  connectTimeoutMs: 2500,
} as const

const BUSINESS_MESSAGE_MAX = 80
const SAFE_HOSTS = new Set(
  API_CHANNELS.map((base) => {
    try {
      return new URL(base).host
    } catch {
      return ''
    }
  }).filter(Boolean),
)

export type PanelFailover = 'read' | 'mutation' | 'login'
export type PanelFailureCode = 'network' | 'timeout' | 'unavailable'
export type ChannelAction = 'return' | 'next' | 'stop'

export type PanelLimits = {
  perChannelMs: number
  totalMs: number
  connectTimeoutMs: number
}

type ChannelFetch = (
  url: string,
  init: RequestInit & { connectTimeout?: number },
) => Promise<Response>

export class PanelRequestError extends Error {
  readonly code: PanelFailureCode
  readonly status?: number
  readonly attempts: number
  readonly host?: string

  constructor(
    code: PanelFailureCode,
    info: { status?: number; attempts: number; host?: string },
  ) {
    super(code)
    this.name = 'PanelRequestError'
    this.code = code
    this.status = info.status
    this.attempts = info.attempts
    this.host = info.host
  }
}

export function isJsonEnvelope(body: string): boolean {
  const trimmed = body.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false
  try {
    const value: unknown = JSON.parse(trimmed)
    return value !== null && typeof value === 'object'
  } catch {
    return false
  }
}

function isUnsafeMethod(method: string): boolean {
  const normalized = method.toUpperCase()
  return normalized !== 'GET' && normalized !== 'HEAD'
}

export function resolveFailover(
  method: string,
  requested?: PanelFailover,
): PanelFailover {
  if (requested) return requested
  return isUnsafeMethod(method) ? 'mutation' : 'read'
}

/**
 * JSON 对象或数组一律视为应用已经处理过，不换线路。
 * 429 即使不是 JSON 也不换，避免把限流放大到其余线路。
 * 读请求和登录：非 JSON（HTML、空体）换线路。登录接口正常时总是返回 JSON 信封。
 * 其他写请求：只在 404/405/502/503/504 这类“应用没接住”的非 JSON 上换线路。
 * 写请求的 500/408/200 HTML 不重试，因为处理程序可能已经产生副作用。
 */
export function decideChannel(input: {
  method: string
  status: number
  body: string
  failover: PanelFailover
}): ChannelAction {
  if (isJsonEnvelope(input.body)) return 'return'
  if (input.status === 429) return 'stop'
  if (input.failover === 'read' || input.failover === 'login') return 'next'
  if (
    input.status === 404 ||
    input.status === 405 ||
    input.status === 502 ||
    input.status === 503 ||
    input.status === 504
  ) {
    return 'next'
  }
  return 'stop'
}

export function safeChannelHost(base: string): string | undefined {
  try {
    const host = new URL(base).host
    return SAFE_HOSTS.has(host) ? host : undefined
  } catch {
    return undefined
  }
}

export function loginTransportMessage(error: unknown): string | null {
  if (!(error instanceof PanelRequestError)) return null
  const parts = [`E_${error.code.toUpperCase()}`]
  if (typeof error.status === 'number') parts.push(String(error.status))
  parts.push(String(error.attempts))
  if (error.host) parts.push(error.host)
  const tag = parts.join('·')
  if (error.code === 'timeout') return `网络超时，请稍后重试（${tag}）`
  if (error.code === 'network') return `网络不可用，请稍后重试（${tag}）`
  return `服务器暂时不可用，请稍后重试（${tag}）`
}

export function loginBusinessMessage(message: unknown): string {
  const fallback = '登录失败，请检查账号密码'
  if (typeof message !== 'string') return fallback
  const text = message.replace(/\s+/g, ' ').trim()
  if (!text || text.length > BUSINESS_MESSAGE_MAX) return fallback
  if (/[<>]|https?:\/\/|bearer\s+\S+|token=|authorization\s*:/i.test(text))
    return fallback
  return text
}

function rebuildResponse(text: string, source: Response): Response {
  const headers = new Headers(source.headers)
  headers.delete('content-encoding')
  headers.delete('content-length')
  return new Response(text, {
    status: source.status,
    statusText: source.statusText,
    headers,
  })
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = 'name' in error ? String(error.name) : ''
  return name === 'AbortError'
}

function linkSignal(
  parent: AbortSignal | null | undefined,
  ms: number,
): {
  signal: AbortSignal
  cancel: () => void
  didTimeOut: () => boolean
} {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, ms)
  const onParent = () => controller.abort()
  parent?.addEventListener('abort', onParent, { once: true })
  return {
    signal: controller.signal,
    didTimeOut: () => timedOut || Boolean(parent?.aborted),
    cancel: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onParent)
    },
  }
}

export async function panelApiFetchWith(
  doFetch: ChannelFetch,
  path: string,
  init: RequestInit = {},
  options?: {
    failover?: PanelFailover
    channels?: readonly string[]
    limits?: Partial<PanelLimits>
  },
): Promise<Response> {
  const method = init.method || 'GET'
  const failover = resolveFailover(method, options?.failover)
  const channels = options?.channels?.length ? options.channels : API_CHANNELS
  const limits: PanelLimits = {
    perChannelMs: options?.limits?.perChannelMs ?? PANEL_LIMITS.perChannelMs,
    totalMs: options?.limits?.totalMs ?? PANEL_LIMITS.totalMs,
    connectTimeoutMs:
      options?.limits?.connectTimeoutMs ?? PANEL_LIMITS.connectTimeoutMs,
  }
  const started = Date.now()
  const deadline = started + limits.totalMs
  const total = new AbortController()
  const totalTimer = setTimeout(() => total.abort(), limits.totalMs)
  const onCallerAbort = () => total.abort()
  init.signal?.addEventListener('abort', onCallerAbort, { once: true })
  let attempts = 0
  let last = new PanelRequestError('network', { attempts: 0 })

  try {
    for (const base of channels) {
      if (init.signal?.aborted) {
        throw new PanelRequestError('timeout', {
          attempts,
          host: last.host,
          status: last.status,
        })
      }
      const remaining = deadline - Date.now()
      const minimumSlice = Math.min(200, limits.perChannelMs)
      if (total.signal.aborted || remaining < minimumSlice) {
        last = new PanelRequestError('timeout', {
          attempts,
          status: last.status,
          host: last.host,
        })
        break
      }
      attempts += 1
      const perChannelMs = Math.min(limits.perChannelMs, remaining)
      const host = safeChannelHost(base)
      const linked = linkSignal(total.signal, perChannelMs)
      try {
        const response = await doFetch(`${base}${path}`, {
          ...init,
          signal: linked.signal,
          connectTimeout: Math.min(limits.connectTimeoutMs, perChannelMs),
        })
        const text = await response.text()
        const action = decideChannel({
          method,
          status: response.status,
          body: text,
          failover,
        })
        if (action === 'return') return rebuildResponse(text, response)
        last = new PanelRequestError('unavailable', {
          status: response.status,
          attempts,
          host,
        })
        if (action === 'stop') throw last
      } catch (error) {
        if (error instanceof PanelRequestError) throw error
        const timedOut =
          linked.didTimeOut() || isAbortError(error) || total.signal.aborted
        last = new PanelRequestError(timedOut ? 'timeout' : 'network', {
          attempts,
          host,
        })
        if (total.signal.aborted) break
      } finally {
        linked.cancel()
      }
    }
    throw last
  } finally {
    clearTimeout(totalTimer)
    init.signal?.removeEventListener('abort', onCallerAbort)
  }
}

export async function panelApiFetch(
  path: string,
  init: RequestInit = {},
  options?: { failover?: PanelFailover },
): Promise<Response> {
  const { fetch: pluginFetch } = await import('@tauri-apps/plugin-http')
  return panelApiFetchWith(pluginFetch as ChannelFetch, path, init, options)
}
