import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

// 面板 API 双通道（顺序即优先级）：
//   1) 直连 IP:8080 裸 HTTP —— 实测国内 0.16s 又快又稳，绕开 Cloudflare / TLS-SNI / GFW SNI 剥离
//   2) my.caihongmao.org（Cloudflare HTTPS）—— 海外/直连 IP 被封时的兜底
// 之前桌面版只用 my.（CF），国内一被墙就一直转圈/续费失败；改为直连优先即可秒开。
// 用 @tauri-apps/plugin-http（Rust reqwest 层）而非浏览器 fetch，才能可靠地打明文 http。
const API_CHANNELS = [
  // p2 优先:国内可裸连;p1 被部分ISP按SNI封,退为兜底
  'https://p2.yuntanlu.com/api/v1',
  'https://w1.yuntanlu.com/api/v1',
  'https://w2.yuntanlu.com/api/v1',
  'https://w3.yuntanlu.com/api/v1',
  'https://p1.yuntanlu.com/api/v1',
]

// 带超时的 fetch：某通道连接层挂死时，8 秒超时快速回退下一条
async function fetchWithTimeout(url: string, init: RequestInit, ms = 4500): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    return await tauriFetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

// 依次尝试各通道；只有“连接层失败（连不上/超时）”才切下一条，
// 拿到任何 HTTP 状态码（含 4xx）即视为通道可用，直接返回。
export async function panelApiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  let lastErr: unknown
  for (const base of API_CHANNELS) {
    try {
      return await fetchWithTimeout(`${base}${path}`, init)
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr
}
