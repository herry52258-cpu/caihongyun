// 登录和已登记的只读请求才会在非 JSON、超时或连接失败时换线路。
// 下单、取消、支付和生成邀请码遇到结果不明的失败只打一次，并提示待确认。
// AbortSignal 和 connectTimeout 只是尽力取消；到期由本地计时器拒绝，不证明套接字已断开。
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
export type PanelFailureCode =
  | 'network'
  | 'timeout'
  | 'unavailable'
  | 'unconfirmed'
export type ChannelAction = 'return' | 'next' | 'stop'

const LOGIN_PATH = '/passport/auth/login'
const READ_PATHS = new Set([
  '/user/getSubscribe',
  '/user/plan/fetch',
  '/user/order/getPaymentMethod',
  '/user/order/fetch',
  '/user/invite/fetch',
])
const SIDE_EFFECT_PATHS = new Set([
  '/user/order/save',
  '/user/order/cancel',
  '/user/order/checkout',
  '/user/invite/save',
])

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

function normalizePath(path: string): string {
  const withoutQuery = path.split('?')[0] || path
  if (withoutQuery.length > 1 && withoutQuery.endsWith('/')) {
    return withoutQuery.slice(0, -1)
  }
  return withoutQuery
}

export function resolveFailover(
  method: string,
  path: string,
  requested?: PanelFailover,
): PanelFailover {
  const normalized = normalizePath(path)
  if (normalized === LOGIN_PATH && requested !== 'mutation') return 'login'
  if (SIDE_EFFECT_PATHS.has(normalized) || isUnsafeMethod(method))
    return 'mutation'
  if (READ_PATHS.has(normalized) && !isUnsafeMethod(method)) return 'read'
  return 'mutation'
}

/**
 * JSON 对象或数组一律视为应用已经给出结论，不换线路。
 * 429 即使不是 JSON 也不换，避免放大限流。
 * 只有登录和已登记的只读 GET/HEAD 可以在非 JSON 时换线路。
 * 有副作用的请求遇到任何非 JSON 都停止。502/503/504 也不能自动重放，
 * 因为订单或邀请码可能已经写成功。
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
  if (error.code === 'unconfirmed') return null
  return `服务器暂时不可用，请稍后重试（${tag}）`
}

export function mutationUnconfirmedMessage(error: unknown): string | null {
  if (!(error instanceof PanelRequestError)) return null
  const parts = [`E_${error.code.toUpperCase()}`]
  if (typeof error.status === 'number') parts.push(String(error.status))
  parts.push(String(error.attempts))
  if (error.host) parts.push(error.host)
  const tag = parts.join('·')
  if (error.status === 429) return `请求过于频繁，请稍后再试（${tag}）`
  if (
    error.code === 'unconfirmed' ||
    error.code === 'unavailable' ||
    error.code === 'timeout' ||
    error.code === 'network'
  ) {
    return `操作结果待确认，请勿重复提交（${tag}）`
  }
  return null
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

class DeadlineError extends Error {
  constructor() {
    super('deadline')
    this.name = 'DeadlineError'
  }
}

function observeDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  parent: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  let settled = false
  return new Promise<T>((resolve, reject) => {
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      parent.removeEventListener('abort', onParent)
      settle()
    }
    const timer = setTimeout(() => {
      controller.abort()
      finish(() => reject(new DeadlineError()))
    }, ms)
    const onParent = () => {
      controller.abort()
      finish(() =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      )
    }
    if (parent.aborted) {
      onParent()
      return
    }
    parent.addEventListener('abort', onParent, { once: true })
    work(controller.signal).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    )
  })
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
  const failover = resolveFailover(method, path, options?.failover)
  const channels = options?.channels?.length ? options.channels : API_CHANNELS
  const attemptChannels =
    failover === 'mutation' ? channels.slice(0, 1) : channels
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
    for (const base of attemptChannels) {
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
      try {
        const { response, text } = await observeDeadline(
          async (signal) => {
            const fetched = await doFetch(`${base}${path}`, {
              ...init,
              signal,
              connectTimeout: Math.min(limits.connectTimeoutMs, perChannelMs),
            })
            return { response: fetched, text: await fetched.text() }
          },
          perChannelMs,
          total.signal,
        )
        const action = decideChannel({
          method,
          status: response.status,
          body: text,
          failover,
        })
        if (action === 'return') return rebuildResponse(text, response)
        const stopped = new PanelRequestError(
          failover === 'mutation' && response.status !== 429
            ? 'unconfirmed'
            : 'unavailable',
          { status: response.status, attempts, host },
        )
        if (action === 'stop' || failover === 'mutation') throw stopped
        last = stopped
      } catch (error) {
        if (error instanceof PanelRequestError) throw error
        const timedOut =
          error instanceof DeadlineError ||
          isAbortError(error) ||
          total.signal.aborted
        if (failover === 'mutation') {
          throw new PanelRequestError('unconfirmed', { attempts, host })
        }
        last = new PanelRequestError(timedOut ? 'timeout' : 'network', {
          attempts,
          host,
        })
        if (total.signal.aborted) break
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
