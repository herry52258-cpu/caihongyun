export const AUTO_REFRESH_INTERVAL_MS = 60_000

export const REFRESH_FAIL_TEXT = '刷新失败，请稍后再试'

export const refreshSuccessText = (count: number): string =>
  `已更新 ${count} 条线路`

export type RefreshRoutesResult =
  | { ok: true; count: number }
  | { ok: false; message: string }

export interface RouteGroupSnapshot {
  name?: string
  now?: string
  all?: unknown[]
}

export interface RouteProxySnapshot {
  global?: RouteGroupSnapshot
  groups?: RouteGroupSnapshot[]
}

export const selectableNodeNames = (all: unknown[] | undefined): string[] =>
  (all ?? [])
    .map((node) => {
      if (typeof node === 'string') return node
      if (node && typeof node === 'object' && 'name' in node) {
        const name = (node as { name?: unknown }).name
        return typeof name === 'string' ? name : ''
      }
      return ''
    })
    .filter((name) => name !== '' && name !== 'DIRECT' && name !== 'REJECT')

export const readGroupNodes = (
  data: RouteProxySnapshot | undefined,
  groupName: string | null,
): { names: string[]; now: string } => {
  if (!data) return { names: [], now: '' }
  const group =
    groupName && groupName !== 'GLOBAL'
      ? (data.groups?.find((item) => item.name === groupName) ?? data.global)
      : data.global
  return {
    names: selectableNodeNames(group?.all),
    now: group?.now ?? '',
  }
}

// 刷新后内核可能把选择重置成订阅默认值。原线路还在就选回去；
// 已经不在列表里就保持内核当前选择，不去断开系统代理。
export const nodeToReselect = (
  previous: string,
  names: string[],
  now: string,
): string | null => {
  if (!previous || !names.includes(previous) || now === previous) return null
  return previous
}

export const createAutoRefreshGate = (
  intervalMs = AUTO_REFRESH_INTERVAL_MS,
) => {
  let last = Number.NEGATIVE_INFINITY
  return {
    allow(at = Date.now()): boolean {
      if (at - last < intervalMs) return false
      last = at
      return true
    },
  }
}

export async function finishRouteRefresh(options: {
  previousNode: string
  groupName: string | null
  loadProxies: () => Promise<RouteProxySnapshot | undefined>
  selectNode?: (groupName: string, nodeName: string) => Promise<void>
  settleMs?: number
}): Promise<{ count: number; reselected: string | null }> {
  let data = await options.loadProxies()
  let parsed = readGroupNodes(data, options.groupName)
  if (parsed.names.length === 0 && options.previousNode) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    data = await options.loadProxies()
    parsed = readGroupNodes(data, options.groupName)
  }

  const reselected = nodeToReselect(
    options.previousNode,
    parsed.names,
    parsed.now,
  )
  if (reselected && options.groupName && options.selectNode) {
    try {
      await options.selectNode(options.groupName, reselected)
      if (options.settleMs && options.settleMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.settleMs))
      }
      await options.loadProxies()
    } catch {
      // 列表已经更新。选不回去时不要当成刷新失败，也不要断开当前代理。
    }
  }
  return { count: parsed.names.length, reselected }
}
