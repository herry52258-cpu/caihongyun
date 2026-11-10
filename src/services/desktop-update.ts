import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

import { openWebUrl } from './cmds'
import {
  DOWNLOAD_HOSTS,
  DOWNLOAD_HOST_STORAGE_KEY,
  PANEL_HOST_TIMEOUT_MS,
  browserHostStorage,
  isHostnameOnly,
  orderHosts,
  preferDownloadUrl,
  readPreferredHost,
  rememberPreferredHost,
} from './panel-api'

// 桌面版在线更新检查：启动时拉 /version-desktop.json（多域名抗封），
// 版本比当前高就弹窗提示，点「前往下载」用系统浏览器打开安装包（Win/Mac 需签名故不做全自动装，
// 但自动提示 + 一键跳下载已能免去人工提醒）。
// 发版时同步改 CURRENT_VERSION 与 login.tsx 的 APP_VERSION。
// 同目录的 version.json 是安卓清单，字段不同，桌面版不读它。
const CURRENT_VERSION = 'v1.0.31'

// 下载站先 down.yuntanlu.com，再 ndl.lianjieni.com，dl.yuntanlu.com 兜底。
const UPDATE_HOSTS = DOWNLOAD_HOSTS

async function fetchUpdate(): Promise<{
  info: Record<string, unknown>
  host: string
} | null> {
  const storage = browserHostStorage()
  const preferred = readPreferredHost(
    storage,
    UPDATE_HOSTS,
    DOWNLOAD_HOST_STORAGE_KEY,
  )
  for (const host of orderHosts(UPDATE_HOSTS, preferred)) {
    if (!isHostnameOnly(host)) continue
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), PANEL_HOST_TIMEOUT_MS)
    try {
      const res = await tauriFetch(`https://${host}/version-desktop.json`, {
        redirect: 'manual',
        maxRedirections: 0,
        signal: ctrl.signal,
      })
      if (!res.ok) continue
      const data: unknown = await res.json()
      if (data && typeof data === 'object') {
        rememberPreferredHost(
          storage,
          host,
          UPDATE_HOSTS,
          DOWNLOAD_HOST_STORAGE_KEY,
        )
        return { info: data as Record<string, unknown>, host }
      }
    } catch {
      // 换下一条通道。不记录底层异常、响应体或查询串。
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}

// v1.0.21 -> 10021，便于数值比较
function verNum(v: string): number {
  const parts = (v || '')
    .replace(/^v/i, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0)
  return (parts[0] || 0) * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0)
}

function showModal(version: string, changelog: string, url: string) {
  if (document.getElementById('chm-update-modal')) return
  const ov = document.createElement('div')
  ov.id = 'chm-update-modal'
  ov.style.cssText =
    'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99999;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;'
  const box = document.createElement('div')
  box.style.cssText =
    'background:#1e1e2e;border-radius:14px;padding:22px;max-width:420px;width:100%;box-sizing:border-box;color:#fff;font-family:system-ui,-apple-system,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.5);'
  const h = document.createElement('div')
  h.textContent = '发现新版本 ' + version
  h.style.cssText = 'font-size:17px;font-weight:700;margin:0 0 10px;'
  const c = document.createElement('div')
  c.textContent = changelog || '建议更新到最新版本'
  c.style.cssText =
    'font-size:13px;color:#c9c6d6;white-space:pre-wrap;line-height:1.55;margin:0 0 18px;'
  const btn = document.createElement('button')
  btn.textContent = '前往下载'
  btn.style.cssText =
    'width:100%;padding:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border:none;border-radius:9px;font-size:15px;font-weight:700;cursor:pointer;margin:0 0 8px;'
  btn.onclick = () => {
    openWebUrl(url)
    ov.remove()
  }
  const cl = document.createElement('div')
  cl.textContent = '稍后'
  cl.style.cssText =
    'text-align:center;color:#888;font-size:13px;cursor:pointer;padding:6px;'
  cl.onclick = () => ov.remove()
  box.appendChild(h)
  box.appendChild(c)
  box.appendChild(btn)
  box.appendChild(cl)
  ov.appendChild(box)
  ov.addEventListener('click', (e) => {
    if (e.target === ov) ov.remove()
  })
  document.body.appendChild(ov)
}

export async function checkDesktopUpdate(): Promise<void> {
  try {
    const found = await fetchUpdate()
    if (!found || typeof found.info.version !== 'string') return
    if (verNum(found.info.version) <= verNum(CURRENT_VERSION)) return
    const isMac = /Mac|Macintosh|Mac OS X/i.test(navigator.userAgent)
    const raw = isMac
      ? found.info.url_mac || found.info.url
      : found.info.url_win || found.info.url
    if (typeof raw !== 'string' || !raw) return
    const url = preferDownloadUrl(raw, found.host)
    if (!url) return
    const changelog =
      typeof found.info.changelog === 'string' ? found.info.changelog : ''
    showModal(found.info.version, changelog, url)
  } catch {
    // 更新检查失败静默，不打扰用户
  }
}
