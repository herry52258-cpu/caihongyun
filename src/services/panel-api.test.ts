import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  DOWNLOAD_HOSTS,
  PANEL_API_BUDGET_MS,
  PANEL_API_HOSTS,
  PANEL_HOST_STORAGE_KEY,
  PANEL_HOST_TIMEOUT_MS,
  PANEL_WEB_HOSTS,
  PANEL_WEB_ORIGIN,
  PanelRequestError,
  isHostnameOnly,
  panelApiFetch,
  preferDownloadUrl,
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
        'nlogin.lianjieni.com',
        'np1.lianjieni.com',
        'login.lianjieni.com',
        'np2.lianjieni.com',
        'lianjieni.com',
        'p2.yuntanlu.com',
        'w1.yuntanlu.com',
        'w2.yuntanlu.com',
        'w3.yuntanlu.com',
      ],
    )
    assert.deepEqual(
      [...DOWNLOAD_HOSTS],
      ['down.yuntanlu.com', 'ndl.lianjieni.com', 'dl.yuntanlu.com'],
    )
    assert.equal(PANEL_WEB_ORIGIN, 'https://nlogin.lianjieni.com')
    assert.equal(PANEL_HOST_TIMEOUT_MS, 1200)
    assert.equal(PANEL_API_BUDGET_MS, 12_000)
    assert.ok(
      PANEL_API_BUDGET_MS >= PANEL_API_HOSTS.length * PANEL_HOST_TIMEOUT_MS,
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
      async () => jsonResponse(200, { data: { auth_data: 'ok' } }),
      async () => jsonResponse(200, { data: { auth_data: 'second' } }),
    ])
    const res = await panelApiFetch(
      '/passport/auth/login',
      { method: 'POST', body: '{}' },
      { fetchImpl },
    )
    const data = await res.json()
    assert.equal(calls.length, 1)
    assert.equal(
      calls[0].url,
      'https://nlogin.lianjieni.com/api/v1/passport/auth/login',
    )
    assert.equal(calls[0].init.redirect, 'manual')
    assert.equal(calls[0].init.maxRedirections, 0)
    assert.equal(data.data.auth_data, 'ok')
  })

  it('fails over when the first host times out', async () => {
    const { fetchImpl, calls } = scripted([
      (_url, init) => hang(init.signal),
      async () => jsonResponse(200, { data: { auth_data: 'fallback' } }),
    ])
    const res = await panelApiFetch(
      '/passport/auth/login',
      { method: 'POST' },
      { fetchImpl, hostTimeoutMs: 30, budgetMs: 5_000 },
    )
    const data = await res.json()
    assert.equal(calls.length, 2)
    assert.equal(
      calls[1].url,
      'https://np1.lianjieni.com/api/v1/passport/auth/login',
    )
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
    assert.deepEqual(logs, ['nlogin.lianjieni.com: 网络或TLS失败'])
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
    assert.deepEqual(logs, ['nlogin.lianjieni.com: HTTP 502'])
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
    assert.deepEqual(logs, ['nlogin.lianjieni.com: 非JSON响应'])
  })

  it('shows a JSON business rejection immediately and does not try another host', async () => {
    const { fetchImpl, calls } = scripted([
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
    assert.equal(calls.length, 1)
    assert.deepEqual(logs, [])
    assert.equal(JSON.stringify(calls[0].init).includes(PASSWORD), true)
  })

  it('does not retry a banned-account JSON body', async () => {
    const { fetchImpl, calls } = scripted([
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
    assert.equal(calls.length, 1)
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
        assert.match(error.message, /a\.example: 超时/)
        assert.match(error.message, /b\.example: 超时/)
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
        assert.match(error.message, /a\.example: 超时/)
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
            'lianjieni.com: 网络或TLS失败；p2.yuntanlu.com: HTTP 500；w1.yuntanlu.com: 非JSON响应',
          )
          assertSafeText(error.message)
          assert.equal(error.message.includes('token='), false)
          assert.equal(error.message.includes(path), false)
          return true
        },
      )
      assert.deepEqual(warnings, [
        'lianjieni.com: 网络或TLS失败',
        'p2.yuntanlu.com: HTTP 500',
        'w1.yuntanlu.com: 非JSON响应',
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
      {},
      {
        fetchImpl,
        hosts: ['203.0.113.10', 'http://lianjieni.com', 'lianjieni.com'],
      },
    )
    assert.deepEqual(calls, [
      'https://lianjieni.com/api/v1/passport/auth/login',
    ])
  })

  it('does not embed rejected hosts or origin addresses in the client sources', () => {
    const files = [
      'src/services/panel-api.ts',
      'src/services/desktop-update.ts',
      'src/pages/login.tsx',
      'src/pages/home.tsx',
      'src/main.tsx',
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
    assert.equal(login.includes('v1.0.31'), true)
    assert.equal(updater.includes('v1.0.31'), true)
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
      { fetchImpl, storage },
    )
    assert.equal((await res.json()).data.auth_data, 'ok')
    assert.equal(
      calls[0].url,
      'https://login.lianjieni.com/api/v1/passport/auth/login',
    )
    assert.equal(
      calls[1].url,
      'https://nlogin.lianjieni.com/api/v1/passport/auth/login',
    )
    assert.equal(
      storage.getItem(PANEL_HOST_STORAGE_KEY),
      'nlogin.lianjieni.com',
    )
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
      'https://nlogin.lianjieni.com/api/v1/passport/auth/login',
    )
    storage.setItem(PANEL_HOST_STORAGE_KEY, 'p1.yuntanlu.com')
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
      'https://nlogin.lianjieni.com/api/v1/passport/auth/login',
    )
    assert.equal(second.calls[0].url.includes('203.0.113.10'), false)
  })

  it('does not remember a host outside the panel list', async () => {
    const storage = memoryStorage()
    const { fetchImpl } = scripted([
      async () => jsonResponse(200, { data: { auth_data: 'ok' } }),
    ])
    await panelApiFetch(
      '/passport/auth/login',
      {},
      { fetchImpl, storage, hosts: ['a.example'] },
    )
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
    assert.equal(registerUrl, 'https://nlogin.lianjieni.com/#/register')
    assert.equal(registerUrl.includes('p1.'), false)
    assert.equal(
      calls[0],
      'https://nlogin.lianjieni.com/api/v1/guest/comm/config',
    )
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
})
