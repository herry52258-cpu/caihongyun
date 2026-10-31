import {
  deleteProfile,
  getProfiles,
  patchProfile,
  patchProfilesConfig,
  updateProfile,
} from '@/services/cmds'
import { panelApiFetch } from '@/services/panel-api'
import {
  clashUrlForSubscribe,
  isAuthFailure,
  kindFromDownloadError,
  REFRESH_FAIL_TEXT,
  type RefreshFailKind,
  subscriptionPathname,
} from '@/services/refresh-routes-kind'

export { REFRESH_FAIL_TEXT }

// 线路在登录时下载一次，写进本地订阅文件。首页看到的节点来自这份文件。
// 刷新时用当前登录态再要一次订阅；下载失败不会覆盖原文件，也不退出登录。

export class RefreshRoutesError extends Error {
  kind: RefreshFailKind

  constructor(kind: RefreshFailKind) {
    super(REFRESH_FAIL_TEXT[kind])
    this.name = 'RefreshRoutesError'
    this.kind = kind
  }
}

interface SubscribeBody {
  message?: string
  data?: {
    subscribe_url?: string
  }
}

async function readSubscribeUrl(auth: string): Promise<string> {
  let res: Response
  try {
    res = await panelApiFetch('/user/getSubscribe', {
      headers: { Authorization: auth },
    })
  } catch {
    throw new RefreshRoutesError('network')
  }

  let body: SubscribeBody
  try {
    body = (await res.json()) as SubscribeBody
  } catch {
    throw new RefreshRoutesError('server')
  }

  const message = String(body?.message || '')
  const subUrl = body?.data?.subscribe_url
  if (res.ok && typeof subUrl === 'string' && /^https?:\/\//i.test(subUrl)) {
    return subUrl
  }
  if (isAuthFailure(res.status, message)) {
    throw new RefreshRoutesError('auth')
  }
  throw new RefreshRoutesError('server')
}

// 已有远程订阅时只覆盖这一份；没有订阅时才新导入，并且只有导入成功才切换。
export async function refreshLoggedInRoutes(
  auth: string,
  importSubscription: (subUrl: string) => Promise<void>,
): Promise<void> {
  const subUrl = await readSubscribeUrl(auth)
  const profiles = await getProfiles()
  const active = (profiles.items ?? []).find(
    (item) => item?.uid && item.uid === profiles.current,
  )

  if (active?.uid && active.type === 'remote' && active.url) {
    const pathChanged =
      subscriptionPathname(active.url) !== subscriptionPathname(subUrl)
    const nextUrl = clashUrlForSubscribe(subUrl, active.url)
    const urlChanged = pathChanged && nextUrl !== active.url
    if (urlChanged) {
      try {
        await patchProfile(active.uid, { url: nextUrl })
      } catch {
        throw new RefreshRoutesError('server')
      }
    }
    try {
      await updateProfile(active.uid)
      return
    } catch (err) {
      if (urlChanged) {
        await patchProfile(active.uid, { url: active.url }).catch(() => {})
      }
      throw new RefreshRoutesError(kindFromDownloadError(err))
    }
  }

  const before = new Set(
    (profiles.items ?? [])
      .map((item) => item?.uid)
      .filter((uid): uid is string => !!uid),
  )
  try {
    await importSubscription(subUrl)
  } catch (err) {
    throw new RefreshRoutesError(kindFromDownloadError(err))
  }

  const after = await getProfiles()
  const created = (after.items ?? []).filter(
    (item) =>
      !!item?.uid &&
      !before.has(item.uid) &&
      (item.type === 'remote' || !!item.url),
  )
  const target = created[created.length - 1]
  if (!target?.uid) throw new RefreshRoutesError('server')

  let switched: boolean
  try {
    switched = await patchProfilesConfig({ current: target.uid })
  } catch {
    await deleteProfile(target.uid).catch(() => {})
    throw new RefreshRoutesError('server')
  }
  if (!switched) {
    await deleteProfile(target.uid).catch(() => {})
    throw new RefreshRoutesError('server')
  }
}
