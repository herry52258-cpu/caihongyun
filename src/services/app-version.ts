import { getVersion } from '@tauri-apps/api/app'

import { version as packageVersion } from '@root/package.json'

/** package.json 版本。Tauri 不可用时（浏览器预览）用它，正式包以 getVersion 为准。 */
export const PACKAGE_VERSION = packageVersion

/** 显示成 v1.0.34。getVersion 与 package.json 都不带 v 前缀。 */
export function formatAppVersion(raw: string): string {
  const normalized = raw.trim().replace(/^v/i, '')
  return normalized ? `v${normalized}` : ''
}

/**
 * 正在运行的应用版本。
 * Windows / macOS 都走 Tauri getVersion（编译进安装包的 tauri.conf.json）。
 * 浏览器里没有 Tauri 运行时，回退到打包进来的 package.json。
 */
export async function readAppVersion(): Promise<string> {
  try {
    const fromApp = (await getVersion()).trim()
    if (fromApp) return fromApp.replace(/^v/i, '')
  } catch {
    // 非 Tauri 环境
  }
  return packageVersion
}
