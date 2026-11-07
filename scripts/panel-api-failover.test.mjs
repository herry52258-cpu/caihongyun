import assert from 'node:assert/strict'
import test from 'node:test'

import {
  API_CHANNELS,
  decideChannel,
  loginBusinessMessage,
  loginTransportMessage,
  panelApiFetchWith,
  PanelRequestError,
} from '../src/services/panel-api.ts'

const FAST = { perChannelMs: 50, totalMs: 120, connectTimeoutMs: 20 }
const SECRET = 'panel-test-secret'
const EMAIL = 'person@example.com'
const TOKEN = 'Bearer panel-test-token'
const SUBSCRIBE = 'https://p2.yuntanlu.com/s/panel-test-sub'
const HTML = `<!DOCTYPE html><html><body>${SECRET} ${EMAIL} ${TOKEN} ${SUBSCRIBE}</body></html>`

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function htmlResponse(status, headers = {}) {
  return new Response(HTML, {
    status,
    headers: { 'content-type': 'text/html', ...headers },
  })
}

function publicView(error) {
  return JSON.stringify({
    name: error.name,
    message: error.message,
    code: error.code,
    status: error.status,
    attempts: error.attempts,
    host: error.host,
    ui: loginTransportMessage(error),
  })
}

function assertNoSecrets(text) {
  assert.equal(text.includes(SECRET), false)
  assert.equal(text.includes(EMAIL), false)
  assert.equal(text.includes('panel-test-token'), false)
  assert.equal(text.includes('panel-test-sub'), false)
  assert.equal(text.includes('<html'), false)
  assert.equal(text.includes('DOCTYPE'), false)
  assert.equal(text.includes('Authorization'), false)
}

test('首站 HTML 后备用线路 JSON 成功，且不泄漏正文', async () => {
  const seen = []
  const response = await panelApiFetchWith(
    async (url, init) => {
      seen.push({
        url,
        connectTimeout: init.connectTimeout,
        headers: JSON.stringify(init.headers ?? {}),
      })
      if (seen.length === 1)
        return htmlResponse(200, { 'set-cookie': 'session=panel-test-cookie' })
      return jsonResponse(200, {
        data: { auth_data: 'should-stay-in-body' },
        message: 'ok',
      })
    },
    '/passport/auth/login',
    {
      method: 'POST',
      headers: { Authorization: TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: SECRET }),
    },
    { failover: 'login', channels: API_CHANNELS, limits: FAST },
  )
  assert.equal(seen.length, 2)
  assert.equal(
    seen[0].url.startsWith(
      'https://p2.yuntanlu.com/api/v1/passport/auth/login',
    ),
    true,
  )
  assert.equal(seen[1].url.startsWith('https://w1.yuntanlu.com/api/v1/'), true)
  assert.equal(seen[0].connectTimeout, 20)
  assert.equal(seen[1].headers.includes('panel-test-cookie'), false)
  const data = await response.json()
  assert.equal(data.message, 'ok')
  assert.equal(response.status, 200)
})

test('登录 5xx HTML 换线路；写请求 500 HTML 不重试', async () => {
  let loginCalls = 0
  const login = await panelApiFetchWith(
    async () => {
      loginCalls += 1
      if (loginCalls === 1) return htmlResponse(503)
      return jsonResponse(200, { data: { auth_data: 'ok' }, message: 'ok' })
    },
    '/passport/auth/login',
    { method: 'POST', body: JSON.stringify({ password: SECRET }) },
    {
      failover: 'login',
      channels: ['https://a.test/api/v1', 'https://b.test/api/v1'],
      limits: FAST,
    },
  )
  assert.equal(loginCalls, 2)
  assert.equal((await login.json()).message, 'ok')

  let orderCalls = 0
  await assert.rejects(
    () =>
      panelApiFetchWith(
        async () => {
          orderCalls += 1
          return htmlResponse(500)
        },
        '/user/order/save',
        {
          method: 'POST',
          body: JSON.stringify({ plan_id: 1, password: SECRET }),
        },
        {
          channels: ['https://a.test/api/v1', 'https://b.test/api/v1'],
          limits: FAST,
        },
      ),
    (error) => {
      assert.equal(error instanceof PanelRequestError, true)
      assert.equal(error.code, 'unavailable')
      assert.equal(error.status, 500)
      assert.equal(orderCalls, 1)
      assertNoSecrets(publicView(error))
      return true
    },
  )
})

test('合法 JSON 的业务拒绝、验证码和限流都不换线路', async () => {
  for (const sample of [
    { status: 401, message: '邮箱或密码错误' },
    { status: 422, message: '验证码错误' },
    { status: 429, message: '请求过于频繁' },
    { status: 403, message: '账号已冻结' },
  ]) {
    let calls = 0
    const response = await panelApiFetchWith(
      async () => {
        calls += 1
        return jsonResponse(sample.status, {
          message: sample.message,
          data: null,
        })
      },
      '/passport/auth/login',
      {
        method: 'POST',
        body: JSON.stringify({ email: EMAIL, password: SECRET }),
      },
      { failover: 'login', channels: API_CHANNELS, limits: FAST },
    )
    assert.equal(calls, 1)
    assert.equal(response.status, sample.status)
    const data = await response.json()
    assert.equal(loginBusinessMessage(data.message), sample.message)
  }
})

test('429 HTML 不轮询，避免放大封禁', async () => {
  let calls = 0
  await assert.rejects(
    () =>
      panelApiFetchWith(
        async () => {
          calls += 1
          return htmlResponse(429)
        },
        '/passport/auth/login',
        { method: 'POST' },
        { failover: 'login', channels: API_CHANNELS, limits: FAST },
      ),
    (error) => {
      assert.equal(calls, 1)
      assert.equal(error.code, 'unavailable')
      assert.equal(error.status, 429)
      assertNoSecrets(publicView(error))
      return true
    },
  )
})

test('写请求的网关 503 可以换线路，JSON 500 不可以', async () => {
  let gatewayCalls = 0
  const saved = await panelApiFetchWith(
    async () => {
      gatewayCalls += 1
      if (gatewayCalls === 1) return htmlResponse(503)
      return jsonResponse(200, { data: 'trade-1', message: 'ok' })
    },
    '/user/order/save',
    { method: 'POST' },
    {
      channels: ['https://a.test/api/v1', 'https://b.test/api/v1'],
      limits: FAST,
    },
  )
  assert.equal(gatewayCalls, 2)
  assert.equal((await saved.json()).data, 'trade-1')

  let appCalls = 0
  const rejected = await panelApiFetchWith(
    async () => {
      appCalls += 1
      return jsonResponse(500, { message: '库存服务失败' })
    },
    '/user/order/save',
    { method: 'POST' },
    { channels: API_CHANNELS, limits: FAST },
  )
  assert.equal(appCalls, 1)
  assert.equal((await rejected.json()).message, '库存服务失败')
})

test('读请求的非 JSON 会换线路，JSON 错误不会', async () => {
  let calls = 0
  const ok = await panelApiFetchWith(
    async () => {
      calls += 1
      if (calls === 1) return htmlResponse(404)
      return jsonResponse(200, {
        data: { subscribe_url: 'hidden' },
        message: 'ok',
      })
    },
    '/user/getSubscribe',
    { headers: { Authorization: TOKEN } },
    {
      channels: ['https://a.test/api/v1', 'https://b.test/api/v1'],
      limits: FAST,
    },
  )
  assert.equal(calls, 2)
  assert.equal((await ok.json()).message, 'ok')

  let jsonCalls = 0
  const kept = await panelApiFetchWith(
    async () => {
      jsonCalls += 1
      return jsonResponse(500, { message: '维护中' })
    },
    '/user/plan/fetch',
    {},
    { channels: API_CHANNELS, limits: FAST },
  )
  assert.equal(jsonCalls, 1)
  assert.equal((await kept.json()).message, '维护中')
})

test('全部网络失败给出网络诊断且不含敏感字段', async () => {
  await assert.rejects(
    () =>
      panelApiFetchWith(
        async () => {
          throw new Error(`connect failed ${SECRET} ${SUBSCRIBE}`)
        },
        '/passport/auth/login',
        {
          method: 'POST',
          headers: { Authorization: TOKEN },
          body: JSON.stringify({ email: EMAIL, password: SECRET }),
        },
        { failover: 'login', channels: API_CHANNELS, limits: FAST },
      ),
    (error) => {
      assert.equal(error.code, 'network')
      assert.equal(error.attempts, API_CHANNELS.length)
      assert.equal(error.host, 'p1.yuntanlu.com')
      const ui = loginTransportMessage(error)
      assert.match(
        ui,
        /^网络不可用，请稍后重试（E_NETWORK·5·p1\.yuntanlu\.com）$/,
      )
      assertNoSecrets(publicView(error))
      return true
    },
  )
})

test('全部超时受总耗时限制，不会按通道数无限挂起', async () => {
  const started = Date.now()
  await assert.rejects(
    () =>
      panelApiFetchWith(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error('should have aborted')),
              5000,
            )
            init.signal.addEventListener('abort', () => {
              clearTimeout(timer)
              const error = new Error('aborted')
              error.name = 'AbortError'
              reject(error)
            })
          }),
        '/passport/auth/login',
        { method: 'POST', body: JSON.stringify({ password: SECRET }) },
        {
          failover: 'login',
          channels: API_CHANNELS,
          limits: { perChannelMs: 80, totalMs: 150, connectTimeoutMs: 30 },
        },
      ),
    (error) => {
      assert.equal(error.code, 'timeout')
      assert.ok(error.attempts >= 1)
      assert.ok(error.attempts < API_CHANNELS.length)
      assert.match(
        loginTransportMessage(error),
        /^网络超时，请稍后重试（E_TIMEOUT·/,
      )
      assertNoSecrets(publicView(error))
      return true
    },
  )
  assert.ok(Date.now() - started < 1000)
})

test('业务文案保留短句，丢掉 HTML、链接和过长正文', () => {
  assert.equal(loginBusinessMessage('邮箱或密码错误'), '邮箱或密码错误')
  assert.equal(loginBusinessMessage('验证码错误'), '验证码错误')
  assert.equal(loginBusinessMessage('请求过于频繁'), '请求过于频繁')
  assert.equal(loginBusinessMessage(`坏了 ${HTML}`), '登录失败，请检查账号密码')
  assert.equal(
    loginBusinessMessage(`见 ${SUBSCRIBE}`),
    '登录失败，请检查账号密码',
  )
  assert.equal(loginBusinessMessage('x'.repeat(81)), '登录失败，请检查账号密码')
  assert.equal(loginBusinessMessage(undefined), '登录失败，请检查账号密码')
})

test('请求过程中取消会停止，不再打后面的线路', async () => {
  const controller = new AbortController()
  let calls = 0
  const started = Date.now()
  await assert.rejects(
    () =>
      panelApiFetchWith(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            calls += 1
            if (calls === 1) setTimeout(() => controller.abort(), 30)
            const timer = setTimeout(() => reject(new Error('late')), 5000)
            init.signal.addEventListener('abort', () => {
              clearTimeout(timer)
              const error = new Error('aborted')
              error.name = 'AbortError'
              reject(error)
            })
          }),
        '/passport/auth/login',
        {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({ password: SECRET }),
        },
        {
          failover: 'login',
          channels: API_CHANNELS,
          limits: { perChannelMs: 2000, totalMs: 5000, connectTimeoutMs: 1000 },
        },
      ),
    (error) => {
      assert.equal(calls, 1)
      assert.equal(error.code, 'timeout')
      assertNoSecrets(publicView(error))
      return true
    },
  )
  assert.ok(Date.now() - started < 1000)
})

test('调用方已取消时不再请求任何线路', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  await assert.rejects(
    () =>
      panelApiFetchWith(
        async () => {
          calls += 1
          return jsonResponse(200, { message: 'ok' })
        },
        '/passport/auth/login',
        {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({ password: SECRET }),
        },
        { failover: 'login', channels: API_CHANNELS, limits: FAST },
      ),
    (error) => {
      assert.equal(calls, 0)
      assert.equal(error.code, 'timeout')
      assertNoSecrets(publicView(error))
      return true
    },
  )
})

test('策略表：登录 HTML 继续，JSON 停止，写请求 500 停止，写请求 502 继续', () => {
  assert.equal(
    decideChannel({
      method: 'POST',
      status: 200,
      body: HTML,
      failover: 'login',
    }),
    'next',
  )
  assert.equal(
    decideChannel({
      method: 'POST',
      status: 401,
      body: JSON.stringify({ message: '邮箱或密码错误' }),
      failover: 'login',
    }),
    'return',
  )
  assert.equal(
    decideChannel({
      method: 'POST',
      status: 500,
      body: HTML,
      failover: 'mutation',
    }),
    'stop',
  )
  assert.equal(
    decideChannel({
      method: 'POST',
      status: 502,
      body: HTML,
      failover: 'mutation',
    }),
    'next',
  )
  assert.equal(
    decideChannel({
      method: 'POST',
      status: 200,
      body: HTML,
      failover: 'mutation',
    }),
    'stop',
  )
  assert.equal(
    decideChannel({ method: 'GET', status: 404, body: HTML, failover: 'read' }),
    'next',
  )
  assert.equal(
    decideChannel({
      method: 'GET',
      status: 500,
      body: JSON.stringify({ message: '维护中' }),
      failover: 'read',
    }),
    'return',
  )
})
