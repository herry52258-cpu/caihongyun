import { useEffect, useState } from 'react'

import {
  PACKAGE_VERSION,
  formatAppVersion,
  readAppVersion,
} from '@/services/app-version'

/** 登录页和设置里显示的版本号。先用 package 版本，再换成安装包里的 getVersion。 */
export function useAppVersion(): string {
  const [version, setVersion] = useState(() =>
    formatAppVersion(PACKAGE_VERSION),
  )

  useEffect(() => {
    let active = true
    readAppVersion()
      .then((value) => {
        if (active) setVersion(formatAppVersion(value))
      })
      .catch(() => {
        // readAppVersion 失败时保留 package.json 版本
      })
    return () => {
      active = false
    }
  }, [])

  return version
}
