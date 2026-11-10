import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  REFRESH_FAIL_TEXT,
  createAutoRefreshGate,
  finishRouteRefresh,
  refreshSuccessText,
  selectableNodeNames,
} from './refresh-routes.ts'

const GROUP = '节点选择'

function snapshot(names: string[], now: string) {
  return {
    groups: [
      {
        name: GROUP,
        now,
        all: names.map((name) => ({ name })),
      },
    ],
  }
}

// 模拟面板：第一次给出 N 条线路，刷新后再给出 N+1 条。没有真实订阅。
function mockPanelRoutes() {
  const before = ['香港-01', '日本-01', '美国-01']
  const after = [...before, '新加坡-01']
  let calls = 0
  return {
    before,
    after,
    async fetch() {
      calls += 1
      return calls === 1 ? before : after
    },
  }
}

describe('refresh routes', () => {
  it('counts selectable nodes and ignores direct or reject', () => {
    assert.deepEqual(
      selectableNodeNames([
        '香港-01',
        'DIRECT',
        'REJECT',
        { name: '日本-01' },
        { name: '' },
      ]),
      ['香港-01', '日本-01'],
    )
  })

  it('throttles foreground refresh to 60 seconds', () => {
    const gate = createAutoRefreshGate(60_000)
    assert.equal(gate.allow(1_000), true)
    assert.equal(gate.allow(1_000), false)
    assert.equal(gate.allow(30_000), false)
    assert.equal(gate.allow(61_000), true)
  })

  it('uses a fixed failure message without a link', () => {
    assert.match(REFRESH_FAIL_TEXT, /刷新失败/)
    assert.equal(REFRESH_FAIL_TEXT.includes('http'), false)
    assert.equal(refreshSuccessText(4), '已更新 4 条线路')
  })

  it('shows the new route and keeps the selected node', async () => {
    const panel = mockPanelRoutes()
    const first = await panel.fetch()
    assert.equal(first.length, 3)

    let now = '香港-01'
    const selected: string[] = []
    const refreshed = await panel.fetch()
    assert.equal(refreshed.length, first.length + 1)

    const result = await finishRouteRefresh({
      previousNode: '日本-01',
      groupName: GROUP,
      loadProxies: async () => snapshot(refreshed, now),
      selectNode: async (_group, name) => {
        selected.push(name)
        now = name
      },
    })

    assert.equal(result.count, 4)
    assert.deepEqual(selected, ['日本-01'])
    assert.equal(refreshSuccessText(result.count), '已更新 4 条线路')
    assert.equal(now, '日本-01')
  })

  it('leaves the live selection alone when it is already current', async () => {
    const selected: string[] = []
    const result = await finishRouteRefresh({
      previousNode: '日本-01',
      groupName: GROUP,
      loadProxies: async () =>
        snapshot(['香港-01', '日本-01', '新加坡-01'], '日本-01'),
      selectNode: async (_group, name) => {
        selected.push(name)
      },
    })

    assert.equal(result.count, 3)
    assert.equal(result.reselected, null)
    assert.deepEqual(selected, [])
  })

  it('does not switch nodes or disconnect when the selected route is gone', async () => {
    const selected: string[] = []
    const result = await finishRouteRefresh({
      previousNode: '日本-01',
      groupName: GROUP,
      loadProxies: async () => snapshot(['香港-01', '美国-01'], '香港-01'),
      selectNode: async (_group, name) => {
        selected.push(name)
      },
    })

    assert.equal(result.count, 2)
    assert.equal(result.reselected, null)
    assert.deepEqual(selected, [])
  })
})
