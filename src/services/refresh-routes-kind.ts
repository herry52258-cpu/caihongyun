export type RefreshFailKind = 'network' | 'auth' | 'server'

export const REFRESH_FAIL_TEXT: Record<RefreshFailKind, string> = {
  network: '网络连接失败，请检查网络后重试。当前线路未改动。',
  auth: '登录已过期，线路没有更新。你仍然保持登录，当前线路也可以继续使用。',
  server: '服务器暂时无法更新线路，请稍后再试。当前线路未改动。',
}

const AUTH_HINT =
  /未登录|登陆已过期|登录已过期|登录过期|unauthorized|unauthenticated/i

export function isAuthFailure(status: number, message: string): boolean {
  return status === 401 || AUTH_HINT.test(message)
}

export function kindFromDownloadError(err: unknown): RefreshFailKind {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  if (isAuthFailure(0, msg) || /\b401\b/.test(msg)) return 'auth'
  if (/status\s*5\d\d|\b50[0-9]\b/.test(msg)) return 'server'
  if (/\b403\b|status\s*4\d\d/.test(msg)) return 'server'
  return 'network'
}

export function subscriptionPathname(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    const noHost = url.replace(/^https?:\/\/[^/]+/, '')
    return noHost.split('?')[0] || url
  }
}

// 订阅令牌变了才换地址，域名沿用上次能打开的那条，避免把还能用的线路域名换掉。
export function clashUrlForSubscribe(
  subUrl: string,
  storedUrl?: string,
): string {
  let host = 'p2.yuntanlu.com'
  if (storedUrl) {
    try {
      const storedHost = new URL(storedUrl).hostname
      if (storedHost) host = storedHost
    } catch {
      // 旧地址解析不了就用默认域名
    }
  }
  return `https://${host}${subscriptionPathname(subUrl)}?flag=verge`
}
