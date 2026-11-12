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

// k7m2 只加在整表末尾，URL 仍是 https://主机/api/v1/...，不插队、不加 p1。
export const PANEL_API_HOSTS = [
  ...PANEL_WEB_HOSTS,
  ...PANEL_API_FALLBACK_HOSTS,
  'k7m2.lianjieni.com',
] as const

export const PANEL_WEB_ORIGIN = `https://${PANEL_WEB_HOSTS[0]}`

// 下载站。桌面更新清单和安装包都先走这里，dl 只做兜底。
export const DOWNLOAD_HOSTS = [
  'down.yuntanlu.com',
  'ndl.lianjieni.com',
  'dl.yuntanlu.com',
] as const

/**
 * 单主机超时。国内实测经常 1.4–2.3 秒，偶发超过 7 秒。
 * 登录、更新检查和同一套 API 通道共用。
 */
export const PANEL_HOST_TIMEOUT_MS = 8_000

/** 上一条还没答话时，最多再等这么久就并行开下一条。 */
export const PANEL_HOST_STAGGER_MS = 1_500

/** 全部线路一起竞速的总预算，含响应体读取和 JSON 解析。 */
export const PANEL_API_BUDGET_MS = 20_000

export const PANEL_HOST_STORAGE_KEY = 'caihongyun_panel_host'
export const DOWNLOAD_HOST_STORAGE_KEY = 'caihongyun_download_host'

const API_PREFIX = '/api/v1'

const HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

type BareFailReason =
  | '超时'
  | '连不上或被拒绝'
  | 'TLS证书错误'
  | '非JSON响应'
  | '请求失败'
  | `HTTP ${number}`

export type PanelFailReason =
  | BareFailReason
  | `直连${BareFailReason}`
  | `代理${BareFailReason}`

export type PanelRoute = 'direct' | 'system'

export type TransportKind = 'timeout' | 'connect' | 'tls' | 'other'

export class PanelTransportError extends Error {
  readonly kind: TransportKind

  constructor(kind: TransportKind) {
    super(kind)
    this.name = 'PanelTransportError'
    this.kind = kind
  }
}

/** 已连接且节点把请求拒掉时，购买页用这句话，不再笼统说网络失败。 */
export const EXPIRED_ACCOUNT_HINT =
  '账号已到期，可直接在这里续费；如果打不开，请先点「断开」再试'

export type PanelAttempt = {
  host: string
  reason: PanelFailReason
}

export type PanelRequestInit = RequestInit & {
  maxRedirections?: number
  route?: PanelRoute
  timeoutMs?: number
}

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
  staggerMs?: number
  now?: () => number
  log?: (line: string) => void
  storage?: HostStorage | null
  /** 测试里显式打开。正式包在直连全失败后读取系统代理，开着才再走一轮。 */
  systemProxyEnabled?: () => boolean | Promise<boolean>
}

export type HostAttemptResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: PanelFailReason }

const REASONS = new Set<string>([
  '超时',
  '连不上或被拒绝',
  'TLS证书错误',
  '非JSON响应',
  '请求失败',
])

function bareReason(reason: string): string {
  if (reason.startsWith('直连') || reason.startsWith('代理')) {
    return reason.slice(2)
  }
  return reason
}

export function isHostnameOnly(host: string): boolean {
  if (typeof host !== 'string') return false
  if (host.includes(':') || host.includes('/') || host.includes('@'))
    return false
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false
  return HOSTNAME_RE.test(host)
}

function isSafeReason(reason: string): reason is PanelFailReason {
  const bare = bareReason(reason)
  return REASONS.has(bare) || /^HTTP [1-5]\d\d$/.test(bare)
}

function formatAttempts(attempts: readonly PanelAttempt[]): string {
  const lines = attempts
    .filter((item) => isHostnameOnly(item.host) && isSafeReason(item.reason))
    .map((item) => `${item.host}: ${item.reason}`)
  if (lines.length === 0) return '请求失败'
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

export function classifyTransportText(message: string): BareFailReason {
  const text = message.toLowerCase()
  if (
    text.includes('timed out') ||
    text.includes('timeout') ||
    text.includes('etimedout') ||
    text.includes('wsaetimedout') ||
    text.includes('os error 10060') ||
    text.includes('os error 60') ||
    text.includes('超时')
  ) {
    return '超时'
  }
  if (
    text.includes('certificate') ||
    text.includes('unknownissuer') ||
    text.includes('webpki') ||
    text.includes('invalid peer') ||
    text.includes('cert verify') ||
    text.includes('notvalid') ||
    text.includes('unknown ca') ||
    text.includes('self signed') ||
    text.includes('self-signed') ||
    text.includes('invalid certificate')
  ) {
    return 'TLS证书错误'
  }
  if (
    text.includes('os error 10061') ||
    text.includes('os error 10054') ||
    text.includes('os error 61') ||
    text.includes('os error 54') ||
    text.includes('os error 111') ||
    text.includes('econnrefused') ||
    text.includes('econnreset') ||
    text.includes('enetunreach') ||
    text.includes('ehostunreach') ||
    text.includes('connection refused') ||
    text.includes('connection reset') ||
    text.includes('actively refused') ||
    text.includes('积极拒绝') ||
    text.includes('强迫关闭') ||
    text.includes('proxy') ||
    text.includes('tunnel') ||
    text.includes('dns') ||
    text.includes('unreachable') ||
    text.includes('handshake') ||
    text.includes('connect') ||
    text.includes('refused') ||
    text.includes('reset') ||
    text.includes('拒绝')
  ) {
    return '连不上或被拒绝'
  }
  return '请求失败'
}

export function classifyTransportFailure(
  error: unknown,
  timedOut: boolean,
): BareFailReason {
  if (timedOut) return '超时'
  if (error instanceof PanelTransportError) {
    if (error.kind === 'timeout') return '超时'
    if (error.kind === 'tls') return 'TLS证书错误'
    if (error.kind === 'connect') return '连不上或被拒绝'
    return '请求失败'
  }
  const message = error instanceof Error ? error.message : ''
  return classifyTransportText(message)
}

export function safePanelError(error: unknown): string {
  if (error instanceof PanelRequestError) return error.message
  return classifyTransportFailure(error, false)
}

function isConnectRefusal(reason: string): boolean {
  return bareReason(reason) === '连不上或被拒绝'
}

export function purchaseLoadMessage(
  error: unknown,
  connected: boolean,
): string {
  if (
    connected &&
    error instanceof PanelRequestError &&
    error.attempts.length > 0 &&
    error.attempts.every((item) => isConnectRefusal(item.reason))
  ) {
    return EXPIRED_ACCOUNT_HINT
  }
  return safePanelError(error)
}

export function businessPurchaseMessage(
  message: string,
  status: number,
): string {
  const text = message.trim()
  if (text) return text
  if (status >= 400 && status <= 599) return `HTTP ${status}`
  return '请求失败'
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
  reasonPrefix = '',
): void {
  const shown = `${reasonPrefix}${reason}` as PanelFailReason
  if (!isHostnameOnly(host) || !isSafeReason(shown)) return
  attempts.push({ host, reason: shown })
  log(`${host}: ${shown}`)
}

function httpReason(status: number): PanelFailReason {
  if (Number.isInteger(status) && status >= 300 && status <= 599) {
    return `HTTP ${status}`
  }
  return '非JSON响应'
}

const WINNER_REASON = 'winner'

function isSafeMethod(method: string | undefined): boolean {
  const normalized = (method ?? 'GET').toUpperCase()
  return normalized === 'GET' || normalized === 'HEAD'
}

type PanelHttpOutcome = {
  status: number
  body: string
  errorKind?: string | null
}

function headerRecord(
  headers: HeadersInit | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  new Headers(headers).forEach((value, key) => {
    out[key] = value
  })
  return out
}

function asTransportKind(kind: string | null | undefined): TransportKind {
  if (
    kind === 'timeout' ||
    kind === 'connect' ||
    kind === 'tls' ||
    kind === 'other'
  ) {
    return kind
  }
  return 'connect'
}

async function defaultFetch(
  url: string,
  init: PanelRequestInit,
): Promise<Response> {
  if (init.signal?.aborted) throw new PanelTransportError('timeout')
  const { invoke } = await import('@tauri-apps/api/core')
  const route: PanelRoute = init.route === 'system' ? 'system' : 'direct'
  const outcome = await new Promise<PanelHttpOutcome>((resolve, reject) => {
    const onAbort = () => reject(new PanelTransportError('timeout'))
    init.signal?.addEventListener('abort', onAbort, { once: true })
    void invoke<PanelHttpOutcome>('panel_http_fetch', {
      request: {
        url,
        method: init.method ?? 'GET',
        headers: headerRecord(init.headers),
        body: typeof init.body === 'string' ? init.body : null,
        route,
        timeoutMs: init.timeoutMs ?? PANEL_HOST_TIMEOUT_MS,
      },
    }).then(
      (value) => {
        init.signal?.removeEventListener('abort', onAbort)
        if (init.signal?.aborted) reject(new PanelTransportError('timeout'))
        else resolve(value)
      },
      () => {
        init.signal?.removeEventListener('abort', onAbort)
        reject(new PanelTransportError('connect'))
      },
    )
  })
  if (outcome.errorKind) {
    throw new PanelTransportError(asTransportKind(outcome.errorKind))
  }
  const status =
    outcome.status >= 200 && outcome.status <= 599 ? outcome.status : 502
  return new Response(outcome.body, { status })
}

export const panelTransportFetch: PanelFetch = defaultFetch

async function requestPanelHost(
  fetchImpl: PanelFetch,
  host: string,
  path: string,
  init: RequestInit,
  signal: AbortSignal,
  route: PanelRoute,
): Promise<HostAttemptResult<Response>> {
  const res = await fetchImpl(`https://${host}${API_PREFIX}${path}`, {
    ...init,
    redirect: 'manual',
    maxRedirections: 0,
    signal,
    route,
  })
  const text = await readBody(res, signal)
  if (!parsePanelJson(text)) {
    return { ok: false, reason: httpReason(res.status) }
  }
  const status = res.status >= 200 && res.status <= 599 ? res.status : 400
  return {
    ok: true,
    value: new Response(text, {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  }
}

export type RaceHostsOptions<T> = {
  hosts: readonly string[]
  attempt: (host: string, signal: AbortSignal) => Promise<HostAttemptResult<T>>
  hostTimeoutMs?: number
  budgetMs?: number
  staggerMs?: number
  now?: () => number
  log?: (line: string) => void
  /** 失败记在这里。调用方可以跨多次竞速累加，成功返回时里面只有没答话的主机。 */
  attempts?: PanelAttempt[]
  /** 写进失败原因前面，用来区分直连和代理兜底。 */
  reasonPrefix?: string
}

/**
 * Happy Eyeballs：先开第一台；1.5 秒还没答话就再开下一台。
 * 某台先失败（超时、TLS、非 JSON）就立刻补上下一台，不必把 1.5 秒等完。
 * 第一份成功结果胜出，其余请求 abort。总预算到点后不再开新的。
 * 面板 JSON（含密码错误这类 4xx）由 attempt 标成成功，不能当成线路失败。
 */
export function raceHosts<T>(
  options: RaceHostsOptions<T>,
): Promise<{ host: string; value: T }> {
  const hostTimeoutMs = options.hostTimeoutMs ?? PANEL_HOST_TIMEOUT_MS
  const budgetMs = options.budgetMs ?? PANEL_API_BUDGET_MS
  const staggerMs = options.staggerMs ?? PANEL_HOST_STAGGER_MS
  const now = options.now ?? Date.now
  const log = options.log ?? defaultLog
  const attempts = options.attempts ?? []
  const reasonPrefix = options.reasonPrefix ?? ''
  const hosts = options.hosts.filter(
    (host, index, list) => isHostnameOnly(host) && list.indexOf(host) === index,
  )
  const deadline = now() + budgetMs

  return new Promise((resolve, reject) => {
    let settled = false
    let cursor = 0
    let inflight = 0
    let staggerTimer: ReturnType<typeof setTimeout> | null = null
    const controllers = new Set<AbortController>()

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      if (staggerTimer !== null) {
        clearTimeout(staggerTimer)
        staggerTimer = null
      }
      fn()
    }

    const succeed = (host: string, value: T, keep: AbortController) => {
      finish(() => {
        for (const ctrl of controllers) {
          if (ctrl !== keep && !ctrl.signal.aborted) ctrl.abort(WINNER_REASON)
        }
        resolve({ host, value })
      })
    }

    const giveUp = () => {
      finish(() => {
        for (const ctrl of controllers) {
          if (!ctrl.signal.aborted) ctrl.abort()
        }
        reject(new PanelRequestError(attempts))
      })
    }

    const armStagger = () => {
      if (settled || staggerTimer !== null || cursor >= hosts.length) return
      const remaining = deadline - now()
      if (remaining <= 0) return
      const delay = Math.min(staggerMs, remaining)
      staggerTimer = setTimeout(() => {
        staggerTimer = null
        launch()
      }, delay)
    }

    const onAttemptEnd = () => {
      inflight -= 1
      if (settled) return
      if (inflight === 0 && (cursor >= hosts.length || deadline - now() <= 0)) {
        giveUp()
      }
    }

    const pullForward = () => {
      if (settled) return
      if (staggerTimer !== null) {
        clearTimeout(staggerTimer)
        staggerTimer = null
        launch()
        return
      }
      if (inflight === 0 && (cursor >= hosts.length || deadline - now() <= 0)) {
        giveUp()
      }
    }

    const launch = () => {
      if (settled) return
      if (cursor >= hosts.length || deadline - now() <= 0) {
        if (inflight === 0) giveUp()
        return
      }
      const host = hosts[cursor]
      cursor += 1
      const timeoutMs = Math.min(hostTimeoutMs, deadline - now())
      const ctrl = new AbortController()
      controllers.add(ctrl)
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        ctrl.abort()
      }, timeoutMs)
      inflight += 1
      armStagger()

      void Promise.resolve()
        .then(() => options.attempt(host, ctrl.signal))
        .then(
          (result) => {
            clearTimeout(timer)
            if (settled || ctrl.signal.reason === WINNER_REASON) return
            if (result.ok) {
              succeed(host, result.value, ctrl)
              return
            }
            record(attempts, log, host, result.reason, reasonPrefix)
            pullForward()
          },
          (error: unknown) => {
            clearTimeout(timer)
            if (settled || ctrl.signal.reason === WINNER_REASON) return
            record(
              attempts,
              log,
              host,
              classifyTransportFailure(error, timedOut || ctrl.signal.aborted),
              reasonPrefix,
            )
            pullForward()
          },
        )
        .finally(onAttemptEnd)
    }

    launch()
  })
}

// 登录 POST 可以并行（幂等），但同一通道还要下单、取消订单。
// 那些 POST 打两遍会出问题，所以改状态的请求不竞速正文：
// 先用无副作用的 GET /guest/comm/config 做上面的竞速，
// 只有先返回面板 JSON 的那一台收到真正的请求。
// GET/HEAD 没有副作用，直接竞速真正的请求，避免慢链路上再多一个往返。
const PROBE_PATH = '/guest/comm/config'

async function proxyRetryEnabled(deps: PanelApiDeps): Promise<boolean> {
  try {
    if (deps.systemProxyEnabled) return !!(await deps.systemProxyEnabled())
    if (deps.fetchImpl) return false
    const { invoke } = await import('@tauri-apps/api/core')
    const proxy = await invoke<{ enable?: boolean }>('get_sys_proxy')
    return proxy?.enable === true
  } catch {
    return false
  }
}

export async function withDirectThenProxy<T>(
  run: (route: PanelRoute) => Promise<T>,
  deps: PanelApiDeps = {},
): Promise<T> {
  try {
    return await run('direct')
  } catch (error) {
    if (!(error instanceof PanelRequestError)) throw error
    if (!(await proxyRetryEnabled(deps))) throw error
    try {
      return await run('system')
    } catch (fallback) {
      if (fallback instanceof PanelRequestError) {
        throw new PanelRequestError([...error.attempts, ...fallback.attempts])
      }
      throw error
    }
  }
}

async function panelApiFetchOnRoute(
  path: string,
  init: RequestInit = {},
  deps: PanelApiDeps = {},
  route: PanelRoute,
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? defaultFetch
  const storage =
    deps.storage === undefined ? browserHostStorage() : deps.storage
  const hostTimeoutMs = deps.hostTimeoutMs ?? PANEL_HOST_TIMEOUT_MS
  const budgetMs = deps.budgetMs ?? PANEL_API_BUDGET_MS
  const staggerMs = deps.staggerMs ?? PANEL_HOST_STAGGER_MS
  const now = deps.now ?? Date.now
  const log = deps.log ?? defaultLog
  const deadline = now() + budgetMs
  const apiPath = normalizePath(path)
  const { signal: _callerSignal, ...requestInit } = init
  const preferred = readPreferredHost(
    storage,
    PANEL_API_HOSTS,
    PANEL_HOST_STORAGE_KEY,
  )
  const hosts = orderHosts(deps.hosts ?? PANEL_API_HOSTS, preferred)
  const reasonPrefix = route === 'system' ? '代理' : '直连'
  const raceBase = {
    hostTimeoutMs,
    staggerMs,
    now,
    log,
    reasonPrefix,
  }

  const remember = (host: string) => {
    rememberPreferredHost(
      storage,
      host,
      PANEL_API_HOSTS,
      PANEL_HOST_STORAGE_KEY,
    )
  }

  if (isSafeMethod(requestInit.method)) {
    const found = await raceHosts({
      ...raceBase,
      hosts,
      budgetMs,
      attempt: (host, signal) =>
        requestPanelHost(fetchImpl, host, apiPath, requestInit, signal, route),
    })
    remember(found.host)
    return found.value
  }

  const attempts: PanelAttempt[] = []
  const failed = () => new Set(attempts.map((item) => item.host))

  while (deadline - now() > 0) {
    const candidates = hosts.filter((host) => !failed().has(host))
    if (candidates.length === 0) break
    let winner: { host: string; value: Response }
    try {
      winner = await raceHosts({
        ...raceBase,
        hosts: candidates,
        budgetMs: deadline - now(),
        attempts,
        attempt: (host, signal) =>
          requestPanelHost(
            fetchImpl,
            host,
            PROBE_PATH,
            { method: 'GET' },
            signal,
            route,
          ),
      })
    } catch (error) {
      if (error instanceof PanelRequestError) throw error
      throw new PanelRequestError(attempts)
    }

    if (deadline - now() <= 0) {
      record(attempts, log, winner.host, '超时', reasonPrefix)
      break
    }
    try {
      const posted = await raceHosts({
        ...raceBase,
        hosts: [winner.host],
        budgetMs: deadline - now(),
        attempts,
        attempt: (host, signal) =>
          requestPanelHost(
            fetchImpl,
            host,
            apiPath,
            requestInit,
            signal,
            route,
          ),
      })
      remember(posted.host)
      return posted.value
    } catch (error) {
      if (!(error instanceof PanelRequestError)) {
        record(
          attempts,
          log,
          winner.host,
          classifyTransportFailure(error, false),
          reasonPrefix,
        )
      }
    }
  }

  throw new PanelRequestError(attempts)
}

export async function panelApiFetch(
  path: string,
  init: RequestInit = {},
  deps: PanelApiDeps = {},
): Promise<Response> {
  return withDirectThenProxy(
    (route) => panelApiFetchOnRoute(path, init, deps, route),
    deps,
  )
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
        staggerMs: deps.staggerMs,
        now: deps.now,
        log: deps.log,
        hosts: PANEL_WEB_HOSTS,
        systemProxyEnabled: deps.systemProxyEnabled,
      },
    )
  } catch {
    // 新入口都不可用时仍打开第一个新入口，不退回旧域名。
  }
  return `${panelPageOrigin(deps.storage)}/${normalizeHash(hashPath)}`
}
