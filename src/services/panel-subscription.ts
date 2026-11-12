import { importProfile } from './cmds'
import {
  CONNECT_FAIL_TEXT,
  PANEL_API_HOSTS,
  isHostnameOnly,
  orderedPanelHosts,
} from './panel-api'

// 单条订阅下载超时。短于内核默认的 20 秒，失败后尽快换下一个面板入口。
const SUBSCRIPTION_TIMEOUT_SECONDS = 8

// 只替换订阅 URL 的主机名，路径原样保留。
// 失败原因只保留主机名，不把订阅路径或底层异常带进错误。
export async function importPanelSubscription(subUrl: string): Promise<void> {
  const path = subUrl.replace(/^https?:\/\/[^/]+/, '')
  const attempts: string[] = []
  if (!path.startsWith('/')) {
    throw new Error(CONNECT_FAIL_TEXT)
  }
  for (const host of orderedPanelHosts()) {
    if (
      !isHostnameOnly(host) ||
      !(PANEL_API_HOSTS as readonly string[]).includes(host)
    ) {
      continue
    }
    const base = `https://${host}${path}`
    const clashUrl = base.includes('?')
      ? `${base}&flag=verge`
      : `${base}?flag=verge`
    try {
      await importProfile(clashUrl, {
        with_proxy: false,
        timeout_seconds: SUBSCRIPTION_TIMEOUT_SECONDS,
      })
      return
    } catch {
      attempts.push(host)
    }
  }
  if (attempts.length > 0) {
    console.warn(`订阅导入失败，已尝试 ${attempts.length} 个入口`)
  }
  throw new Error(CONNECT_FAIL_TEXT)
}
