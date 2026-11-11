// 面板 API 只走 HTTPS 主机名，不写 IP。
// 新入口指向同一套 Xboard，都在 Cloudflare 后面，按顺序先试。
// 旧域名只做兜底。已经否决的入口不进列表。
export const PANEL_WEB_HOSTS = [
  'nlogin.lianjieni.com',
  'np1.lianjieni.com',
  'login.lianjieni.com',
  'np2.lianjieni.com',
] as const

export const PANEL_API_FALLBACK_HOSTS = [
  'lianjieni.com',
  'p2.yuntanlu.com',
  'w1.yuntanlu.com',
  'w2.yuntanlu.com',
  'w3.yuntanlu.com',
] as const

export const PANEL_API_HOSTS = [
  ...PANEL_WEB_HOSTS,
  ...PANEL_API_FALLBACK_HOSTS,
] as const

export const PANEL_WEB_ORIGIN = `https://${PANEL_WEB_HOSTS[0]}`

// 下载站。桌面更新清单和安装包都先走这里，dl 只做兜底。
export const DOWNLOAD_HOSTS = [
  'down.yuntanlu.com',
  'ndl.lianjieni.com',
  'dl.yuntanlu.com',
] as const

/** 单主机超时。登录、更新检查和同一套 API 通道共用。 */
export const PANEL_HOST_TIMEOUT_MS = 1200

/** 所有主机加起来的预算，含响应体读取和 JSON 解析。 */
export const PANEL_API_BUDGET_MS = 12_000

export const PANEL_HOST_STORAGE_KEY = 'caihongyun_panel_host'
export const DOWNLOAD_HOST_STORAGE_KEY = 'caihongyun_download_host'

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

export type HostStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export type PanelApiDeps = {
  fetchImpl?: PanelFetch
  hosts?: readonly string[]
  hostTimeoutMs?: number
  budgetMs?: number
  now?: () => number
  log?: (line: string) => void
  storage?: HostStorage | null
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

export function browserHostStorage(): HostStorage | null {
  try {
    const storage = globalThis.localStorage
    if (
      storage == null ||
      typeof storage.getItem !== 'function' ||
      typeof storage.setItem !== 'function'
    ) {
      return null
    }
    return storage
  } catch {
    return null
  }
}

export function readPreferredHost(
  storage: HostStorage | null,
  allow: readonly string[],
  key: string,
): string | null {
  if (!storage) return null
  let raw: string | null
  try {
    raw = storage.getItem(key)
  } catch {
    return null
  }
  if (typeof raw !== 'string') return null
  const host = raw.trim().toLowerCase()
  if (!isHostnameOnly(host) || !allow.includes(host)) return null
  return host
}

export function rememberPreferredHost(
  storage: HostStorage | null,
  host: string,
  allow: readonly string[],
  key: string,
): void {
  if (!storage) return
  const normalized = host.trim().toLowerCase()
  if (!isHostnameOnly(normalized) || !allow.includes(normalized)) return
  try {
    storage.setItem(key, normalized)
  } catch {
    // 记不住就按原顺序试，不影响本次结果。
  }
}

export function orderHosts(
  hosts: readonly string[],
  preferred: string | null,
): string[] {
  const list: string[] = []
  for (const host of hosts) {
    if (!isHostnameOnly(host) || list.includes(host)) continue
    list.push(host)
  }
  if (!preferred || !list.includes(preferred)) return list
  return [preferred, ...list.filter((host) => host !== preferred)]
}

export function orderedPanelHosts(storage?: HostStorage | null): string[] {
  const store = storage === undefined ? browserHostStorage() : storage
  const preferred = readPreferredHost(
    store,
    PANEL_API_HOSTS,
    PANEL_HOST_STORAGE_KEY,
  )
  return orderHosts(PANEL_API_HOSTS, preferred)
}

export function panelPageOrigin(storage?: HostStorage | null): string {
  const store = storage === undefined ? browserHostStorage() : storage
  const preferred = readPreferredHost(
    store,
    PANEL_WEB_HOSTS,
    PANEL_HOST_STORAGE_KEY,
  )
  return `https://${preferred ?? PANEL_WEB_HOSTS[0]}`
}

function normalizeHash(hashPath: string): string {
  if (hashPath.startsWith('#') || hashPath.startsWith('/')) return hashPath
  return `/${hashPath}`
}

export function preferDownloadUrl(url: string, host: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return ''
  }
  if (parsed.protocol !== 'https:') return ''
  if (parsed.username || parsed.password) return ''
  if (!isHostnameOnly(parsed.hostname)) return ''
  const allow = DOWNLOAD_HOSTS as readonly string[]
  if (!allow.includes(parsed.hostname)) return parsed.toString()
  if (!isHostnameOnly(host) || !allow.includes(host)) return parsed.toString()
  parsed.hostname = host
  return parsed.toString()
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
  const storage =
    deps.storage === undefined ? browserHostStorage() : deps.storage
  const hostTimeoutMs = deps.hostTimeoutMs ?? PANEL_HOST_TIMEOUT_MS
  const budgetMs = deps.budgetMs ?? PANEL_API_BUDGET_MS
  const now = deps.now ?? Date.now
  const log = deps.log ?? defaultLog
  const deadline = now() + budgetMs
  const attempts: PanelAttempt[] = []
  const apiPath = normalizePath(path)
  const { signal: _callerSignal, ...requestInit } = init
  const preferred = readPreferredHost(
    storage,
    PANEL_API_HOSTS,
    PANEL_HOST_STORAGE_KEY,
  )
  const hosts = orderHosts(deps.hosts ?? PANEL_API_HOSTS, preferred)

  for (const host of hosts) {
    const remaining = deadline - now()
    if (remaining <= 0) break

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
        rememberPreferredHost(
          storage,
          host,
          PANEL_API_HOSTS,
          PANEL_HOST_STORAGE_KEY,
        )
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

export async function resolvePanelPageUrl(
  hashPath: string,
  deps: PanelApiDeps = {},
): Promise<string> {
  try {
    await panelApiFetch(
      '/guest/comm/config',
      {},
      {
        fetchImpl: deps.fetchImpl,
        storage: deps.storage,
        hostTimeoutMs: deps.hostTimeoutMs,
        budgetMs: deps.budgetMs,
        now: deps.now,
        log: deps.log,
        hosts: PANEL_WEB_HOSTS,
      },
    )
  } catch {
    // 新入口都不可用时仍打开第一个新入口，不退回旧域名。
  }
  return `${panelPageOrigin(deps.storage)}/${normalizeHash(hashPath)}`
}
