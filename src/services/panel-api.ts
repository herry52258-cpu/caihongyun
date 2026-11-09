// 面板 API 只走 HTTPS 主机名。lianjieni.com 是国内可访问的主入口；
// 其后的 yuntanlu 主机是历史备用，不代表复测通过。已否决的旧入口不在此列表。
export const PANEL_API_HOSTS = [
  'lianjieni.com',
  'p2.yuntanlu.com',
  'w1.yuntanlu.com',
  'w2.yuntanlu.com',
  'w3.yuntanlu.com',
] as const

export const PANEL_WEB_ORIGIN = 'https://lianjieni.com'

/** 单主机超时。登录和同一套 API 通道共用这一个常量。 */
export const PANEL_HOST_TIMEOUT_MS = 2500

/** 所有主机加起来的预算，含响应体读取和 JSON 解析。 */
export const PANEL_API_BUDGET_MS = 10_000

const API_PREFIX = '/api/v1'

const HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

export type PanelFailReason =
  | '超时'
  | '网络或TLS失败'
  | '非JSON响应'
  | `HTTP ${number}`

export type PanelAttempt = {
  host: string
  reason: PanelFailReason
}

export type PanelRequestInit = RequestInit & { maxRedirections?: number }

export type PanelFetch = (
  url: string,
  init: PanelRequestInit,
) => Promise<Response>

export type PanelApiDeps = {
  fetchImpl?: PanelFetch
  hosts?: readonly string[]
  hostTimeoutMs?: number
  budgetMs?: number
  now?: () => number
  log?: (line: string) => void
}

const REASONS = new Set<string>(['超时', '网络或TLS失败', '非JSON响应'])

export function isHostnameOnly(host: string): boolean {
  if (typeof host !== 'string') return false
  if (host.includes(':') || host.includes('/') || host.includes('@'))
    return false
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false
  return HOSTNAME_RE.test(host)
}

function isSafeReason(reason: string): reason is PanelFailReason {
  return REASONS.has(reason) || /^HTTP [1-5]\d\d$/.test(reason)
}

function formatAttempts(attempts: readonly PanelAttempt[]): string {
  const lines = attempts
    .filter((item) => isHostnameOnly(item.host) && isSafeReason(item.reason))
    .map((item) => `${item.host}: ${item.reason}`)
  if (lines.length === 0) return '网络或TLS失败'
  return lines.join('；')
}

export class PanelRequestError extends Error {
  readonly attempts: readonly PanelAttempt[]

  constructor(attempts: readonly PanelAttempt[]) {
    super(formatAttempts(attempts))
    this.name = 'PanelRequestError'
    this.attempts = attempts
  }
}

export function safePanelError(error: unknown): string {
  if (error instanceof PanelRequestError) return error.message
  return '网络或TLS失败'
}

function defaultLog(line: string): void {
  console.warn(line)
}

function normalizePath(path: string): string {
  if (path.startsWith('/')) return path
  return `/${path}`
}

function parsePanelJson(text: string): boolean {
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (!trimmed.startsWith('{')) return false
  try {
    const value: unknown = JSON.parse(trimmed)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return false
    }
    return 'data' in value || 'message' in value || 'status' in value
  } catch {
    return false
  }
}

function readBody(res: Response, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('aborted'))
    if (signal.aborted) {
      fail()
      return
    }
    const onAbort = () => fail()
    signal.addEventListener('abort', onAbort, { once: true })
    res.text().then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) fail()
        else resolve(value)
      },
      () => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) fail()
        else reject(new Error('read-failed'))
      },
    )
  })
}

function record(
  attempts: PanelAttempt[],
  log: (line: string) => void,
  host: string,
  reason: PanelFailReason,
): void {
  if (!isHostnameOnly(host) || !isSafeReason(reason)) return
  attempts.push({ host, reason })
  log(`${host}: ${reason}`)
}

function httpReason(status: number): PanelFailReason {
  if (Number.isInteger(status) && status >= 300 && status <= 599) {
    return `HTTP ${status}`
  }
  return '非JSON响应'
}

async function defaultFetch(
  url: string,
  init: PanelRequestInit,
): Promise<Response> {
  const { fetch } = await import('@tauri-apps/plugin-http')
  return fetch(url, init)
}

export async function panelApiFetch(
  path: string,
  init: RequestInit = {},
  deps: PanelApiDeps = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? defaultFetch
  const hosts = deps.hosts ?? PANEL_API_HOSTS
  const hostTimeoutMs = deps.hostTimeoutMs ?? PANEL_HOST_TIMEOUT_MS
  const budgetMs = deps.budgetMs ?? PANEL_API_BUDGET_MS
  const now = deps.now ?? Date.now
  const log = deps.log ?? defaultLog
  const deadline = now() + budgetMs
  const attempts: PanelAttempt[] = []
  const apiPath = normalizePath(path)
  const { signal: _callerSignal, ...requestInit } = init

  for (const host of hosts) {
    const remaining = deadline - now()
    if (remaining <= 0) break
    if (!isHostnameOnly(host)) continue

    const timeoutMs = Math.min(hostTimeoutMs, remaining)
    const ctrl = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, timeoutMs)

    try {
      const res = await fetchImpl(`https://${host}${API_PREFIX}${apiPath}`, {
        ...requestInit,
        redirect: 'manual',
        maxRedirections: 0,
        signal: ctrl.signal,
      })
      const text = await readBody(res, ctrl.signal)
      if (parsePanelJson(text)) {
        const status = res.status >= 200 && res.status <= 599 ? res.status : 400
        return new Response(text, {
          status,
          headers: { 'content-type': 'application/json' },
        })
      }
      record(attempts, log, host, httpReason(res.status))
    } catch {
      record(
        attempts,
        log,
        host,
        timedOut || ctrl.signal.aborted ? '超时' : '网络或TLS失败',
      )
    } finally {
      clearTimeout(timer)
    }
  }

  throw new PanelRequestError(attempts)
}
