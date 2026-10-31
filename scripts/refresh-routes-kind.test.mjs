import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  REFRESH_FAIL_TEXT,
  clashUrlForSubscribe,
  isAuthFailure,
  kindFromDownloadError,
  subscriptionPathname,
} from '../src/services/refresh-routes-kind.ts'

describe('refresh route errors', () => {
  it('treats expired login as auth and keeps the copy explicit', () => {
    assert.equal(isAuthFailure(401, ''), true)
    assert.equal(isAuthFailure(403, '未登录或登陆已过期'), true)
    assert.equal(isAuthFailure(403, '订阅已到期'), false)
    assert.match(REFRESH_FAIL_TEXT.auth, /登录已过期/)
    assert.match(REFRESH_FAIL_TEXT.auth, /仍然保持登录/)
    assert.match(REFRESH_FAIL_TEXT.network, /当前线路未改动/)
    assert.match(REFRESH_FAIL_TEXT.server, /当前线路未改动/)
  })

  it('classifies download failures without treating plan 403 as logout', () => {
    assert.equal(
      kindFromDownloadError(
        '导入订阅失败: failed to fetch remote profile with status 403',
      ),
      'server',
    )
    assert.equal(
      kindFromDownloadError('failed to fetch remote profile with status 500'),
      'server',
    )
    assert.equal(kindFromDownloadError('401 Unauthorized'), 'auth')
    assert.equal(
      kindFromDownloadError('error sending request: operation timed out'),
      'network',
    )
  })

  it('keeps the working host when only the subscribe token changes', () => {
    assert.equal(
      subscriptionPathname('https://w1.yuntanlu.com/s/OLD?flag=verge'),
      '/s/OLD',
    )
    assert.equal(
      clashUrlForSubscribe(
        'https://p2.yuntanlu.com/s/NEW',
        'https://w1.yuntanlu.com/s/OLD?flag=verge',
      ),
      'https://w1.yuntanlu.com/s/NEW?flag=verge',
    )
  })
})
