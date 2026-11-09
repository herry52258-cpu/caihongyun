import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  PANEL_API_BUDGET_MS,
  PANEL_API_HOSTS,
  PANEL_HOST_TIMEOUT_MS,
  PANEL_WEB_ORIGIN,
  PanelRequestError,
  isHostnameOnly,
  panelApiFetch,
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

describe('panel API host selection', () => {
  it('keeps lianjieni.com first and drops rejected hosts', () => {
    assert.deepEqual(
      [...PANEL_API_HOSTS],
      [
        'lianjieni.com',
        'p2.yuntanlu.com',
        'w1.yuntanlu.com',
        'w2.yuntanlu.com',
        'w3.yuntanlu.com',
      ],
    )
    assert.equal(PANEL_WEB_ORIGIN, 'https://lianjieni.com')
    assert.equal(PANEL_HOST_TIMEOUT_MS, 2500)
    assert.equal(PANEL_API_BUDGET_MS, 10_000)
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
      'https://lianjieni.com/api/v1/passport/auth/login',
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
      'https://p2.yuntanlu.com/api/v1/passport/auth/login',
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
    assert.deepEqual(logs, ['lianjieni.com: 网络或TLS失败'])
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
    assert.deepEqual(logs, ['lianjieni.com: HTTP 502'])
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
    assert.deepEqual(logs, ['lianjieni.com: 非JSON响应'])
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
      'tongspa.com',
      '直连 IP',
      '8080',
    ]
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const word of banned) {
        assert.equal(text.includes(word), false, `${file} contains ${word}`)
      }
      assert.equal(/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(text), false, file)
    }
    const api = readFileSync('src/services/panel-api.ts', 'utf8')
    const updater = readFileSync('src/services/desktop-update.ts', 'utf8')
    assert.equal(api.includes('http://'), false)
    assert.equal(updater.includes('http://'), false)
    assert.equal(api.includes('lianjieni.com'), true)
  })
})
