import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  DEDICATED_LINE_NOTE,
  buildPlans,
  pickDefaultPlan,
} from './purchase-plans.ts'

const NOTE =
  '强烈推荐少人共享专线。常刷 TikTok、看 YouTube 或在线 4K 视频，优先考虑专线，减少多人争抢带宽。实际流畅度仍受本地网络和时段影响。'

describe('purchase plan order', () => {
  it('keeps the dedicated-line note only on the purchase dialog', () => {
    assert.equal(DEDICATED_LINE_NOTE, NOTE)
    const home = readFileSync('src/pages/home.tsx', 'utf8')
    assert.equal(home.includes('DEDICATED_LINE_NOTE'), true)
    assert.equal(home.includes(NOTE), false)
    for (const file of [
      'src/pages/login.tsx',
      'src/services/panel-api.ts',
      'src/services/desktop-update.ts',
      'src/services/refresh-routes.ts',
    ]) {
      assert.equal(readFileSync(file, 'utf8').includes(NOTE), false, file)
      assert.equal(
        readFileSync(file, 'utf8').includes('DEDICATED_LINE_NOTE'),
        false,
        file,
      )
    }
  })

  it('shows plans in server order and does not rewrite prices', () => {
    const plans = buildPlans([
      {
        id: 17,
        name: '独享版·小圈子',
        month_price: 5000,
        year_price: 48000,
      },
      {
        id: 3,
        name: '标准版',
        month_price: 1500,
        year_price: 12800,
        onetime_price: 99900,
      },
    ])
    assert.deepEqual(
      plans.map((plan) => [plan.id, plan.period, plan.price]),
      [
        [17, 'month_price', 5000],
        [17, 'year_price', 48000],
        [3, 'month_price', 1500],
        [3, 'year_price', 12800],
        [3, 'onetime_price', 99900],
      ],
    )
    assert.equal(plans[4].orig, 199900)
    const reversed = buildPlans([
      { id: 3, name: '标准版', year_price: 12800 },
      { id: 17, name: '独享版·小圈子', year_price: 48000 },
    ])
    assert.deepEqual(
      reversed.map((plan) => plan.id),
      [3, 17],
    )
  })

  it('still defaults to the first yearly price in server order', () => {
    const plans = buildPlans([
      {
        id: 17,
        name: '独享版·小圈子',
        month_price: 5000,
        year_price: 48000,
      },
      { id: 3, name: '标准版', year_price: 12800 },
    ])
    const selected = pickDefaultPlan(plans)
    assert.equal(selected?.id, 17)
    assert.equal(selected?.period, 'year_price')
    assert.equal(selected?.price, 48000)
    const onetimeOnly = buildPlans([
      { id: 9, name: '永久版', onetime_price: 99900 },
    ])
    assert.equal(pickDefaultPlan(onetimeOnly)?.period, 'onetime_price')
    assert.equal(pickDefaultPlan([]), null)
  })
})
