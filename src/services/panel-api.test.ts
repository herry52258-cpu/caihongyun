import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { describe, it } from 'node:test'

import {
  DOWNLOAD_HOSTS,
  CONNECT_FAIL_TEXT,
  LOGIN_FAIL_TEXT,
  PLAN_LOAD_FAIL_TEXT,
  PANEL_API_BUDGET_MS,
  PANEL_API_HOSTS,
  PANEL_HOST_STAGGER_MS,
  PANEL_HOST_STORAGE_KEY,
  PANEL_HOST_TIMEOUT_MS,
  PANEL_WEB_HOSTS,
  PANEL_WEB_ORIGIN,
  PanelRequestError,
  PanelTransportError,
  businessPurchaseMessage,
  classifyTransportText,
  isHostnameOnly,
  loginFailMessage,
  panelApiFetch,
  preferDownloadUrl,
  purchaseLoadMessage,
  resolvePanelPageUrl,
  type HostStorage,
  type PanelFetch,
} from './panel-api.ts'

const PASSWORD = 'SUPER_SECRET_PASSWORD_9f3a'
const QUERY_TOKEN = 'QUERYTOKEN_zz881'
const RAW_MARKER = 'RAW_EXCEPTION_MARKER'
const ORIGIN_IP = '203.0.113.55'

type Call = { url: string; init: RequestInit & { maxRedirections?: number } }

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html' },
  })
}

function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (!signal) {
      reject(new Error('missing-signal'))
      return
    }
    if (signal.aborted) {
      reject(new Error('aborted'))
      return
    }
    signal.addEventListener('abort', () => reject(new Error('aborted')), {
      once: true,
    })
  })
}

function scripted(handlers: PanelFetch[]): {
  fetchImpl: PanelFetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fetchImpl: PanelFetch = (url, init) => {
    calls.push({ url, init })
    const handler = handlers[calls.length - 1]
    if (!handler) return Promise.reject(new Error('unexpected-call'))
    return handler(url, init)
  }
  return { fetchImpl, calls }
}

function assertSafeText(text: string): void {
  assert.equal(text.includes(PASSWORD), false)
  assert.equal(text.includes(QUERY_TOKEN), false)
  assert.equal(text.includes(RAW_MARKER), false)
  assert.equal(text.includes(ORIGIN_IP), false)
  assert.equal(text.includes('<html'), false)
  assert.equal(text.includes('email='), false)
  assert.equal(text.toLowerCase().includes('bearer'), false)
}

function memoryStorage(initial: Record<string, string> = {}): HostStorage {
  const data = { ...initial }
  return {
    getItem: (key) => (Object.hasOwn(data, key) ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value
    },
  }
}

function mentionsHost(text: string, host: string): boolean {
  const escaped = host.replace(/[.]/g, '\\.')
  return new RegExp(`(^|[^a-z0-9-])${escaped}([^a-z0-9-.]|$)`, 'i').test(text)
}

describe('panel API host selection', () => {
  it('tries the new panel hosts before the old fallbacks', () => {
    assert.deepEqual(
      [...PANEL_API_HOSTS],
      [
        'np1.lianjieni.com',
        'np2.lianjieni.com',
        'nlogin.lianjieni.com',
        'login.lianjieni.com',
        'k7m2.lianjieni.com',
        'lianjieni.com',
        'p2.yuntanlu.com',
        'w1.yuntanlu.com',
        'w2.yuntanlu.com',
        'w3.yuntanlu.com',
      ],
    )
    assert.equal(PANEL_API_HOSTS[PANEL_API_HOSTS.length - 1], 'w3.yuntanlu.com')
    assert.deepEqual(
      [...DOWNLOAD_HOSTS],
      ['ndl.lianjieni.com', 'down.yuntanlu.com', 'dl.yuntanlu.com'],
    )
    assert.equal(PANEL_WEB_ORIGIN, 'https://np1.lianjieni.com')
    assert.equal(PANEL_HOST_TIMEOUT_MS, 8_000)
    assert.equal(PANEL_HOST_STAGGER_MS, 1_500)
    assert.equal(PANEL_API_BUDGET_MS, 20_000)
    assert.ok(
      PANEL_HOST_STAGGER_MS * (PANEL_API_HOSTS.length - 1) <
        PANEL_API_BUDGET_MS,
    )
    for (const host of PANEL_API_HOSTS) assert.equal(isHostnameOnly(host), true)
    for (const host of DOWNLOAD_HOSTS) assert.equal(isHostnameOnly(host), true)
    assert.equal(PANEL_API_HOSTS.includes('p1.yuntanlu.com' as never), false)
    assert.equal(isHostnameOnly('203.0.113.10'), false)
    assert.equal(isHostnameOnly('http://lianjieni.com'), false)
    assert.equal(isHostnameOnly('lianjieni.com'), true)
  })

  it('returns the first host when it sends panel JSON', async () => {
    const { fetchImpl, calls } = scripted([
      async () => jsonResponse(200, { data: { ok: true } }),
      async () => jsonResponse(200, { data: { auth_data: 'ok' } }),
      async () => jsonResponse(200, { data: { auth_data: 'second' } }),
    ])
    const res = await panelApiFetch(
      '/passport/auth/login',
      { method: 'POST', body: '{}' },
      { fetchImpl },
    )
    const data = await res.json()
    assert.equal(calls.length, 2)
    assert.equal(
      calls[0].url,
      'https://np1.lianjieni.com/api/v1/guest/comm/config',
    )
    assert.equal(calls[0].init.method, 'GET')
    assert.equal(calls[0].init.body, undefined)
    assert.equal(
      calls[1].url,
      'https://np1.lianjieni.com/api/v1/passport/auth/login',
    )
    assert.equal(calls[1].init.method, 'POST')
    assert.equal(calls[1].init.redirect, 'manual')
    assert.equal(calls[1].init.maxRedirections, 0)
    assert.equal(calls[0].init.route, 'direct')
    assert.equal(calls[1].init.route, 'direct')
    assert.equal(
      calls.some((call) => call.init.route === 'system'),
      false,
    )
    assert.equal(data.data.auth_data, 'ok')
  })

  it('fails over when the first host times out', async () => {
    const { fetchImpl, calls } = scripted([
      (_url, init) => hang(init.signal),
      async () => jsonResponse(200, { data: { ok: true } }),
      async () => jsonResponse(200, { data: { auth_data: 'fallback' } }),
    ])
    const res = await panelApiFetch(
      '/passport/auth/login',
      { method: 'POST' },
      { fetchImpl, hostTimeoutMs: 30, budgetMs: 5_000, staggerMs: 5_000 },
    )
    const data = await res.json()
    assert.equal(calls.length, 3)
    assert.equal(
      calls[0].url,
      'https://np1.lianjieni.com/api/v1/guest/comm/config',
    )
    assert.equal(
      calls[1].url,
      'https://np2.lianjieni.com/api/v1/guest/comm/config',
    )
    assert.equal(
      calls[2].url,
      'https://np2.lianjieni.com/api/v1/passport/auth/login',
    )
    assert.equal(calls[0].init.method, 'GET')
    assert.equal(calls[2].init.method, 'POST')
    assert.equal(data.data.auth_data, 'fallback')
  })

  it('fails over on a TLS or network exception without reading the exception', async () => {
    const { fetchImpl, calls } = scripted([
      async () => {
        throw new Error(`connect ${ORIGIN_IP} ${RAW_MARKER}`)
      },
      async () => jsonResponse(200, { data: { auth_data: 'fallback' } }),
    ])
    const logs: string[] = []
    const res = await panelApiFetch(
      '/user/getSubscribe',
      {},
      { fetchImpl, log: (line) => logs.push(line) },
    )
    const data = await res.json()
    assert.equal(calls.length, 2)
    assert.equal(data.data.auth_data, 'fallback')
    assert.deepEqual(logs, ['np1.lianjieni.com: 直连连不上或被拒绝'])
    assertSafeText(logs.join('\n'))
  })

  it('fails over on an HTTP error page', async () => {
    const { fetchImpl, calls } = scripted([
      async () => textResponse(502, `<html>${ORIGIN_IP} ${RAW_MARKER}</html>`),
      async () => jsonResponse(200, { data: { auth_data: 'fallback' } }),
    ])
    const logs: string[] = []
    const res = await panelApiFetch(
      '/user/info',
      {},
      { fetchImpl, log: (line) => logs.push(line) },
    )
    assert.equal((await res.json()).data.auth_data, 'fallback')
    assert.equal(calls.length, 2)
    assert.deepEqual(logs, ['np1.lianjieni.com: 直连HTTP 502'])
    assertSafeText(logs.join('\n'))
  })

  it('fails over when a host returns HTML instead of JSON', async () => {
    const { fetchImpl, calls } = scripted([
      async () => textResponse(200, `<html><body>${ORIGIN_IP}</body></html>`),
      async () =>
        jsonResponse(200, {
          data: { subscribe_url: 'https://lianjieni.com/s/example' },
        }),
    ])
    const logs: string[] = []
    const res = await panelApiFetch(
      '/user/getSubscribe',
      {},
      { fetchImpl, log: (line) => logs.push(line) },
    )
    const data = await res.json()
    assert.equal(calls.length, 2)
    assert.equal(data.data.subscribe_url, 'https://lianjieni.com/s/example')
    assert.deepEqual(logs, ['np1.lianjieni.com: 直连非JSON响应'])
  })

  it('shows a JSON business rejection immediately and does not try another host', async () => {
    const { fetchImpl, calls } = scripted([
      async () => jsonResponse(200, { data: { ok: true } }),
      async () => jsonResponse(422, { message: '邮箱或密码错误' }),
      async () => jsonResponse(200, { data: { auth_data: 'should-not-run' } }),
    ])
    const logs: string[] = []
    const res = await panelApiFetch(
      '/passport/auth/login',
      {
        method: 'POST',
        body: JSON.stringify({ email: 'user@example.com', password: PASSWORD }),
      },
      { fetchImpl, log: (line) => logs.push(line) },
    )
    const data = await res.json()
    assert.equal(res.ok, false)
    assert.equal(res.status, 422)
    assert.equal(data.message, '邮箱或密码错误')
    assert.equal(calls.length, 2)
    assert.deepEqual(logs, [])
    assert.equal(calls[0].init.body, undefined)
    assert.equal(JSON.stringify(calls[1].init).includes(PASSWORD), true)
    assert.equal(calls.filter((call) => call.init.method === 'POST').length, 1)
  })

  it('does not retry a banned-account JSON body', async () => {
    const { fetchImpl, calls } = scripted([
      async () => jsonResponse(200, { data: { ok: true } }),
      async () =>
        jsonResponse(200, { status: 'fail', message: '该账户已被停用' }),
      async () => jsonResponse(200, { data: { auth_data: 'nope' } }),
    ])
    const res = await panelApiFetch(
      '/passport/auth/login',
      { method: 'POST' },
      { fetchImpl },
    )
    const data = await res.json()
    assert.equal(calls.length, 2)
    assert.equal(data.message, '该账户已被停用')
  })

  it('stops once the overall budget is spent, including a slow body', async () => {
    let clock = 1_000_000
    const hosts = ['a.example', 'b.example', 'c.example']
    const calls: string[] = []
    const fetchImpl: PanelFetch = (url, init) => {
      calls.push(url)
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener(
          'abort',
          () => {
            clock += 40
            reject(new Error(`slow ${RAW_MARKER}`))
          },
          { once: true },
        )
      })
    }
    await assert.rejects(
      () =>
        panelApiFetch(
          '/passport/auth/login',
          {},
          {
            fetchImpl,
            hosts,
            hostTimeoutMs: 40,
            budgetMs: 70,
            now: () => clock,
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof PanelRequestError)
        assert.match(error.message, /a\.example: 直连超时/)
        assert.match(error.message, /b\.example: 直连超时/)
        assert.equal(error.message.includes('c.example'), false)
        assertSafeText(error.message)
        return true
      },
    )
    assert.deepEqual(calls, [
      'https://a.example/api/v1/passport/auth/login',
      'https://b.example/api/v1/passport/auth/login',
    ])
  })

  it('counts body reading toward the budget', async () => {
    let clock = 5_000
    const calls: string[] = []
    const fetchImpl: PanelFetch = (url, init) => {
      calls.push(url)
      init.signal?.addEventListener('abort', () => {
        clock += 100
      })
      return Promise.resolve({
        status: 200,
        text: () => new Promise<string>(() => {}),
      } as Response)
    }
    const started = Date.now()
    await assert.rejects(
      () =>
        panelApiFetch(
          '/user/getSubscribe',
          {},
          {
            fetchImpl,
            hosts: ['a.example', 'b.example'],
            hostTimeoutMs: PANEL_HOST_TIMEOUT_MS,
            budgetMs: 40,
            now: () => clock,
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof PanelRequestError)
        assert.match(error.message, /a\.example: 直连超时/)
        assert.equal(error.message.includes('b.example'), false)
        return true
      },
    )
    assert.deepEqual(calls, ['https://a.example/api/v1/user/getSubscribe'])
    assert.ok(Date.now() - started < 1_000)
  })

  it('keeps passwords, tokens, HTML and raw exceptions out of errors and logs', async () => {
    const warnings: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((item) => String(item)).join(' '))
    }
    const { fetchImpl } = scripted([
      async () => {
        throw new Error(`connect ${ORIGIN_IP} ${RAW_MARKER} ${PASSWORD}`)
      },
      async () => textResponse(500, `<html>${ORIGIN_IP} ${QUERY_TOKEN}</html>`),
      async () => textResponse(200, `<html>${RAW_MARKER}</html>`),
    ])
    const path = `/passport/auth/login?token=${QUERY_TOKEN}&email=user@example.com`
    try {
      await assert.rejects(
        () =>
          panelApiFetch(
            path,
            {
              method: 'POST',
              body: JSON.stringify({ password: PASSWORD }),
            },
            {
              fetchImpl,
              hosts: ['lianjieni.com', 'p2.yuntanlu.com', 'w1.yuntanlu.com'],
            },
          ),
        (error: unknown) => {
          assert.ok(error instanceof PanelRequestError)
          assert.equal(
            error.message,
            'lianjieni.com: 直连连不上或被拒绝；p2.yuntanlu.com: 直连HTTP 500；w1.yuntanlu.com: 直连非JSON响应',
          )
          assertSafeText(error.message)
          assert.equal(error.message.includes('token='), false)
          assert.equal(error.message.includes(path), false)
          return true
        },
      )
      assert.deepEqual(warnings, [
        'lianjieni.com: 直连连不上或被拒绝',
        'p2.yuntanlu.com: 直连HTTP 500',
        'w1.yuntanlu.com: 直连非JSON响应',
      ])
      assertSafeText(warnings.join('\n'))
    } finally {
      console.warn = original
    }
  })

  it('does not request an address or plain HTTP host', async () => {
    const calls: string[] = []
    const fetchImpl: PanelFetch = (url) => {
      calls.push(url)
      return Promise.resolve(jsonResponse(200, { data: { auth_data: 'ok' } }))
    }
    await panelApiFetch(
      '/passport/auth/login',
      { method: 'POST', body: '{}' },
      {
        fetchImpl,
        hosts: ['203.0.113.10', 'http://lianjieni.com', 'lianjieni.com'],
      },
    )
    assert.deepEqual(calls, [
      'https://lianjieni.com/api/v1/guest/comm/config',
      'https://lianjieni.com/api/v1/passport/auth/login',
    ])
    assert.equal(
      calls.some((url) => url.includes('203.0.113.10')),
      false,
    )
    assert.equal(
      calls.some((url) => url.startsWith('http://')),
      false,
    )
  })

  it('does not embed rejected hosts or origin addresses in the client sources', () => {
    const files = [
      'src/services/panel-api.ts',
      'src/services/desktop-update.ts',
      'src/pages/login.tsx',
      'src/pages/home.tsx',
      'src/main.tsx',
      'src-tauri/src/cmd/panel_http.rs',
    ]
    const banned = [
      'p1.yuntanlu.com',
      'p1.lianjieni.com',
      'p2.lianjieni.com',
      'dl.lianjieni.com',
      'my.caihongmao.org',
      'tongspa.com',
      '直连 IP',
      '8080',
    ]
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const word of banned) {
        assert.equal(
          mentionsHost(text, word),
          false,
          `${file} contains ${word}`,
        )
      }
      assert.equal(/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(text), false, file)
    }
    const api = readFileSync('src/services/panel-api.ts', 'utf8')
    const updater = readFileSync('src/services/desktop-update.ts', 'utf8')
    const login = readFileSync('src/pages/login.tsx', 'utf8')
    const home = readFileSync('src/pages/home.tsx', 'utf8')
    assert.equal(api.includes('http://'), false)
    assert.equal(updater.includes('http://'), false)
    assert.equal(api.includes('nlogin.lianjieni.com'), true)
    assert.equal(updater.includes('version-desktop.json'), true)
    assert.equal(updater.includes('DOWNLOAD_HOSTS'), true)
    assert.equal(login.includes('resolvePanelPageUrl'), true)
    assert.equal(home.includes('resolvePanelPageUrl'), true)
    assert.equal(login.includes('useAppVersion'), true)
    assert.equal(home.includes('useAppVersion'), true)
    assert.equal(updater.includes('readAppVersion'), true)
    assert.equal(updater.includes('raceHosts'), true)
    assert.equal(api.includes('raceHosts'), true)
    assert.equal(api.includes('k7m2.lianjieni.com'), true)
    assert.equal(api.includes('panel_http_fetch'), true)
    assert.equal(api.includes('withDirectThenProxy'), true)
    assert.equal(api.includes('@tauri-apps/plugin-http'), false)
    assert.equal(api.includes('网络或TLS失败'), false)
    assert.equal(updater.includes('panelTransportFetch'), true)
    assert.equal(updater.includes('withDirectThenProxy'), true)
    assert.equal(updater.includes('@tauri-apps/plugin-http'), false)
    assert.equal(home.includes('PLAN_LOAD_FAIL_TEXT'), true)
    assert.equal(home.includes('LOGIN_FAIL_TEXT'), true)
    assert.equal(home.includes('CONNECT_FAIL_TEXT'), true)
    assert.equal(home.includes('重试'), true)
    assert.equal(login.includes('LOGIN_FAIL_TEXT'), true)
    assert.equal(login.includes('safePanelError'), false)
    assert.equal(home.includes('网络或TLS失败'), false)
    const directHttp = readFileSync('src-tauri/src/cmd/panel_http.rs', 'utf8')
    assert.equal(directHttp.includes('.no_proxy()'), true)
    assert.equal(directHttp.includes('Sysproxy::get_system_proxy'), true)
    assert.equal(directHttp.includes('target_os'), false)
    for (const host of PANEL_API_HOSTS) {
      assert.equal(directHttp.includes(`"${host}"`), true)
    }
    for (const host of DOWNLOAD_HOSTS) {
      assert.equal(directHttp.includes(`"${host}"`), true)
    }
    assert.equal(/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(directHttp), false)
    assert.equal(/['"]v1\.0\.\d+['"]/.test(login), false)
    assert.equal(/['"]v1\.0\.\d+['"]/.test(home), false)
    assert.equal(/['"]v1\.0\.\d+['"]/.test(updater), false)
    assert.equal(
      JSON.parse(readFileSync('package.json', 'utf8')).version,
      '1.0.34',
    )
    assert.equal(
      JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).version,
      '1.0.34',
    )
    assert.match(
      readFileSync('src-tauri/Cargo.toml', 'utf8'),
      /^version = "1.0.34"$/m,
    )
  })

  it('tries a remembered panel host first and then the rest in order', async () => {
    const storage = memoryStorage({
      [PANEL_HOST_STORAGE_KEY]: 'login.lianjieni.com',
    })
    const { fetchImpl, calls } = scripted([
      async () => {
        throw new Error('down')
      },
      async () => jsonResponse(200, { data: { auth_data: 'ok' } }),
    ])
    const res = await panelApiFetch(
      '/passport/auth/login',
      {},
      { fetchImpl, storage, staggerMs: 5_000 },
    )
    assert.equal((await res.json()).data.auth_data, 'ok')
    assert.equal(
      calls[0].url,
      'https://login.lianjieni.com/api/v1/passport/auth/login',
    )
    assert.equal(
      calls[1].url,
      'https://np1.lianjieni.com/api/v1/passport/auth/login',
    )
    assert.equal(storage.getItem(PANEL_HOST_STORAGE_KEY), 'np1.lianjieni.com')
  })

  it('ignores a stored address and a rejected host', async () => {
    const storage = memoryStorage({
      [PANEL_HOST_STORAGE_KEY]: '203.0.113.10',
    })
    const { fetchImpl, calls } = scripted([
      async () => jsonResponse(200, { data: { auth_data: 'ok' } }),
    ])
    await panelApiFetch('/passport/auth/login', {}, { fetchImpl, storage })
    assert.equal(
      calls[0].url,
      'https://np1.lianjieni.com/api/v1/passport/auth/login',
    )
    storage.setItem(PANEL_HOST_STORAGE_KEY, 'w1.yuntanlu.com')
    const second = scripted([
      async () => jsonResponse(200, { data: { auth_data: 'ok' } }),
    ])
    await panelApiFetch(
      '/passport/auth/login',
      {},
      { fetchImpl: second.fetchImpl, storage },
    )
    assert.equal(
      second.calls[0].url,
      'https://np1.lianjieni.com/api/v1/passport/auth/login',
    )
    assert.equal(second.calls[0].url.includes('203.0.113.10'), false)
  })

  it('does not remember a host outside the panel list', async () => {
    const storage = memoryStorage()
    const { fetchImpl, calls } = scripted([
      async () => jsonResponse(200, { data: { ok: true } }),
      async () => jsonResponse(200, { data: { auth_data: 'ok' } }),
    ])
    await panelApiFetch(
      '/passport/auth/login',
      { method: 'POST', body: '{}' },
      { fetchImpl, storage, hosts: ['a.example'] },
    )
    assert.equal(calls.length, 2)
    assert.equal(storage.getItem(PANEL_HOST_STORAGE_KEY), null)
  })

  it('opens register and forgot-password on a new panel host', async () => {
    const storage = memoryStorage()
    const calls: string[] = []
    const fetchImpl: PanelFetch = (url) => {
      calls.push(url)
      return Promise.reject(new Error('down'))
    }
    const registerUrl = await resolvePanelPageUrl('#/register', {
      fetchImpl,
      storage,
      hostTimeoutMs: 20,
      budgetMs: 5_000,
    })
    assert.equal(registerUrl, 'https://np1.lianjieni.com/#/register')
    assert.equal(registerUrl.includes('p1.yuntanlu.com'), false)
    assert.equal(calls[0], 'https://np1.lianjieni.com/api/v1/guest/comm/config')
    assert.equal(calls.length, PANEL_WEB_HOSTS.length)
    assert.equal(
      calls.some((item) => item.includes('p1.yuntanlu.com')),
      false,
    )

    const working = memoryStorage()
    const forgetUrl = await resolvePanelPageUrl('#/forget', {
      fetchImpl: (url) =>
        url.startsWith('https://nlogin.lianjieni.com/')
          ? Promise.reject(new Error('down'))
          : Promise.resolve(jsonResponse(200, { data: { ok: true } })),
      storage: working,
    })
    assert.equal(forgetUrl, 'https://np1.lianjieni.com/#/forget')
    assert.equal(working.getItem(PANEL_HOST_STORAGE_KEY), 'np1.lianjieni.com')
  })

  it('starts the next host before the first timeout and aborts the loser', async () => {
    const calls: string[] = []
    let firstSignal: AbortSignal | undefined
    const started = Date.now()
    const fetchImpl: PanelFetch = (url, init) => {
      calls.push(url)
      if (calls.length === 1) {
        firstSignal = init.signal
        return hang(init.signal)
      }
      return Promise.resolve(jsonResponse(200, { data: { auth_data: 'fast' } }))
    }
    const res = await panelApiFetch(
      '/user/getSubscribe',
      {},
      {
        fetchImpl,
        hosts: ['a.example', 'b.example'],
        hostTimeoutMs: 5_000,
        staggerMs: 40,
        budgetMs: 5_000,
      },
    )
    assert.equal((await res.json()).data.auth_data, 'fast')
    assert.ok(Date.now() - started < 1_000)
    assert.deepEqual(calls, [
      'https://a.example/api/v1/user/getSubscribe',
      'https://b.example/api/v1/user/getSubscribe',
    ])
    assert.equal(firstSignal?.aborted, true)
    assert.equal(firstSignal?.reason, 'winner')
  })

  it('shows a JSON 4xx from a later host and does not log it as a failure', async () => {
    let firstSignal: AbortSignal | undefined
    const logs: string[] = []
    const fetchImpl: PanelFetch = (url, init) => {
      if (url.includes('a.example')) {
        firstSignal = init.signal
        return hang(init.signal)
      }
      return Promise.resolve(jsonResponse(422, { message: '邮箱或密码错误' }))
    }
    const res = await panelApiFetch(
      '/user/getSubscribe',
      {},
      {
        fetchImpl,
        hosts: ['a.example', 'b.example', 'c.example'],
        hostTimeoutMs: 5_000,
        staggerMs: 30,
        budgetMs: 5_000,
        log: (line) => logs.push(line),
      },
    )
    assert.equal(res.status, 422)
    assert.equal((await res.json()).message, '邮箱或密码错误')
    assert.equal(firstSignal?.aborted, true)
    assert.deepEqual(logs, [])
  })

  it('opens the next host immediately after a fast failure', async () => {
    const started = Date.now()
    const calls: string[] = []
    const fetchImpl: PanelFetch = (url) => {
      calls.push(url)
      if (calls.length === 1)
        return Promise.reject(new Error(`down ${RAW_MARKER}`))
      return Promise.resolve(jsonResponse(200, { data: { ok: true } }))
    }
    const res = await panelApiFetch(
      '/user/info',
      {},
      {
        fetchImpl,
        hosts: ['a.example', 'b.example'],
        staggerMs: 5_000,
        hostTimeoutMs: 5_000,
        budgetMs: 8_000,
      },
    )
    assert.equal((await res.json()).data.ok, true)
    assert.equal(calls.length, 2)
    assert.ok(Date.now() - started < 1_000)
  })

  it('sends a mutating POST only to the first host whose probe answered', async () => {
    const calls: Array<{ url: string; method: string; body: string }> = []
    let slow: AbortSignal | undefined
    const fetchImpl: PanelFetch = (url, init) => {
      calls.push({
        url,
        method: String(init.method ?? 'GET').toUpperCase(),
        body: typeof init.body === 'string' ? init.body : '',
      })
      if (url.includes('a.example')) {
        slow = init.signal
        return hang(init.signal)
      }
      if (url.endsWith('/guest/comm/config')) {
        return Promise.resolve(jsonResponse(200, { data: { ok: true } }))
      }
      return Promise.resolve(jsonResponse(422, { message: '邮箱或密码错误' }))
    }
    const res = await panelApiFetch(
      '/passport/auth/login',
      {
        method: 'POST',
        body: JSON.stringify({ password: PASSWORD }),
      },
      {
        fetchImpl,
        hosts: ['a.example', 'b.example', 'c.example'],
        hostTimeoutMs: 5_000,
        staggerMs: 40,
        budgetMs: 5_000,
      },
    )
    assert.equal(res.status, 422)
    assert.equal((await res.json()).message, '邮箱或密码错误')
    const posts = calls.filter((call) => call.method === 'POST')
    assert.equal(posts.length, 1)
    assert.equal(posts[0].url, 'https://b.example/api/v1/passport/auth/login')
    assert.equal(posts[0].body.includes(PASSWORD), true)
    assert.equal(calls.filter((call) => call.body.includes(PASSWORD)).length, 1)
    assert.equal(
      calls.some((call) => call.url.includes('c.example')),
      false,
    )
    assert.equal(slow?.aborted, true)
  })

  it('rewrites download links onto the host that answered', () => {
    assert.equal(
      preferDownloadUrl(
        'https://dl.yuntanlu.com/downloads/caihongmao-windows-v1.0.30.exe',
        'down.yuntanlu.com',
      ),
      'https://down.yuntanlu.com/downloads/caihongmao-windows-v1.0.30.exe',
    )
    assert.equal(
      preferDownloadUrl(
        'https://dl.yuntanlu.com/downloads/a.exe',
        'ndl.lianjieni.com',
      ),
      'https://ndl.lianjieni.com/downloads/a.exe',
    )
    assert.equal(
      preferDownloadUrl(
        'https://203.0.113.10/downloads/a.exe',
        'down.yuntanlu.com',
      ),
      '',
    )
    assert.equal(
      preferDownloadUrl('http://down.yuntanlu.com/a.exe', 'ndl.lianjieni.com'),
      '',
    )
    assert.equal(
      preferDownloadUrl('https://dl.yuntanlu.com/a.exe', '203.0.113.10'),
      'https://dl.yuntanlu.com/a.exe',
    )
  })

  it('keeps a direct success off the system proxy even when the proxy is on', async () => {
    const { fetchImpl, calls } = scripted([
      async () => jsonResponse(200, { data: [{ id: 1 }] }),
    ])
    const res = await panelApiFetch(
      '/user/plan/fetch',
      {},
      { fetchImpl, systemProxyEnabled: async () => true },
    )
    assert.equal((await res.json()).data[0].id, 1)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].init.route, 'direct')
  })

  it('retries the same hosts once through the proxy after every direct entry fails', async () => {
    const calls: Array<{ url: string; route?: string }> = []
    const fetchImpl: PanelFetch = (url, init) => {
      calls.push({ url, route: init.route })
      if (init.route === 'system' && url.includes('np1.lianjieni.com')) {
        return Promise.resolve(jsonResponse(200, { data: { plans: true } }))
      }
      return Promise.reject(new PanelTransportError('connect'))
    }
    const res = await panelApiFetch(
      '/user/plan/fetch',
      {},
      {
        fetchImpl,
        hosts: ['nlogin.lianjieni.com', 'np1.lianjieni.com'],
        systemProxyEnabled: async () => true,
        staggerMs: 5_000,
        hostTimeoutMs: 5_000,
        budgetMs: 8_000,
      },
    )
    assert.equal((await res.json()).data.plans, true)
    assert.deepEqual(
      calls.map((call) => `${call.route} ${call.url}`),
      [
        'direct https://nlogin.lianjieni.com/api/v1/user/plan/fetch',
        'direct https://np1.lianjieni.com/api/v1/user/plan/fetch',
        'system https://nlogin.lianjieni.com/api/v1/user/plan/fetch',
        'system https://np1.lianjieni.com/api/v1/user/plan/fetch',
      ],
    )
  })

  it('does not open a proxy round when the system proxy is off', async () => {
    const calls: string[] = []
    const fetchImpl: PanelFetch = (url) => {
      calls.push(url)
      return Promise.reject(new PanelTransportError('connect'))
    }
    await assert.rejects(
      () =>
        panelApiFetch(
          '/user/plan/fetch',
          {},
          {
            fetchImpl,
            hosts: ['a.example', 'b.example'],
            systemProxyEnabled: async () => false,
            staggerMs: 5_000,
            hostTimeoutMs: 30,
            budgetMs: 200,
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof PanelRequestError)
        assert.match(error.message, /a\.example: 直连连不上或被拒绝/)
        assert.match(error.message, /b\.example: 直连连不上或被拒绝/)
        assert.equal(error.message.includes('代理'), false)
        return true
      },
    )
    assert.equal(calls.length, 2)
  })

  it('does not send a business rejection through the proxy again', async () => {
    const { fetchImpl, calls } = scripted([
      async () => jsonResponse(200, { data: { ok: true } }),
      async () => jsonResponse(422, { message: '邮箱或密码错误' }),
    ])
    const res = await panelApiFetch(
      '/passport/auth/login',
      { method: 'POST', body: '{}' },
      { fetchImpl, systemProxyEnabled: async () => true },
    )
    assert.equal(res.status, 422)
    assert.equal(calls.length, 2)
    assert.equal(
      calls.every((call) => call.init.route === 'direct'),
      true,
    )
  })

  it('classifies timeout, refusal and certificate errors from both desktops', () => {
    assert.equal(classifyTransportText('operation timed out'), '超时')
    assert.equal(
      classifyTransportText('error sending request: timed out (os error 60)'),
      '超时',
    )
    assert.equal(
      classifyTransportText('连接尝试失败。 (os error 10060)'),
      '超时',
    )
    assert.equal(
      classifyTransportText('Connection refused (os error 61)'),
      '连不上或被拒绝',
    )
    assert.equal(
      classifyTransportText(
        '由于目标计算机积极拒绝，无法连接。 (os error 10061)',
      ),
      '连不上或被拒绝',
    )
    assert.equal(
      classifyTransportText('Connection reset by peer (os error 54)'),
      '连不上或被拒绝',
    )
    assert.equal(
      classifyTransportText(
        '远程主机强迫关闭了一个现有的连接。 (os error 10054)',
      ),
      '连不上或被拒绝',
    )
    assert.equal(
      classifyTransportText('invalid peer certificate: UnknownIssuer'),
      'TLS证书错误',
    )
    assert.equal(classifyTransportText('webpki: notvalid'), 'TLS证书错误')
    assert.equal(classifyTransportText('something else'), '请求失败')
  })

  it('gets a non-empty plan list on a direct socket while a local proxy refuses', async () => {
    const panelHits: string[] = []
    const panel = http.createServer((req, res) => {
      panelHits.push(req.url ?? '')
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          data: [{ id: 7, name: '年付', year_price: 9900 }],
        }),
      )
    })
    await new Promise<void>((resolve) => {
      panel.listen(0, '127.0.0.1', () => resolve())
    })
    const panelPort = (panel.address() as net.AddressInfo).port
    let proxyHits = 0
    const proxy = net.createServer((socket) => {
      proxyHits += 1
      socket.destroy()
    })
    await new Promise<void>((resolve) => {
      proxy.listen(0, '127.0.0.1', () => resolve())
    })
    const proxyPort = (proxy.address() as net.AddressInfo).port
    const fetchImpl: PanelFetch = async (_url, init) => {
      if (init.route === 'system') {
        await new Promise((_resolve, reject) => {
          const socket = net.connect(proxyPort, '127.0.0.1')
          socket.on('error', reject)
          socket.on('close', () => reject(new Error('proxy refused')))
        })
      }
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.get(
          {
            hostname: '127.0.0.1',
            port: panelPort,
            path: '/api/v1/user/plan/fetch',
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
          },
        )
        req.on('error', reject)
      })
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    try {
      const res = await panelApiFetch(
        '/user/plan/fetch',
        {},
        {
          fetchImpl,
          hosts: ['nlogin.lianjieni.com'],
          systemProxyEnabled: async () => true,
        },
      )
      const data = await res.json()
      assert.equal(Array.isArray(data.data), true)
      assert.ok(data.data.length > 0)
      assert.equal(data.data[0].name, '年付')
      assert.equal(proxyHits, 0)
      assert.ok(panelHits.some((path) => path.includes('/user/plan/fetch')))
    } finally {
      await new Promise<void>((resolve) => panel.close(() => resolve()))
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
    }
  })

  it('shows one plain sentence instead of hosts or status codes', () => {
    const refused = new PanelRequestError([
      {
        host: 'nlogin.lianjieni.com',
        reason: '直连连不上或被拒绝',
      },
      {
        host: 'np1.lianjieni.com',
        reason: '代理TLS证书错误',
      },
    ])
    for (const connected of [true, false]) {
      const text = purchaseLoadMessage(refused, connected)
      assert.equal(text, PLAN_LOAD_FAIL_TEXT)
      assert.equal(text.includes('nlogin'), false)
      assert.equal(text.includes('TLS'), false)
      assert.equal(text.includes('HTTP'), false)
    }
    const loginText = loginFailMessage(refused)
    assert.equal(loginText, LOGIN_FAIL_TEXT)
    assert.equal(loginText.includes('.'), false)
    assert.equal(CONNECT_FAIL_TEXT.includes('HTTP'), false)
    assert.equal(businessPurchaseMessage('流量已用尽', 403), '流量已用尽')
    assert.equal(businessPurchaseMessage('', 502), 'HTTP 502')
    assert.equal(businessPurchaseMessage('', 200), '请求失败')
  })
})
