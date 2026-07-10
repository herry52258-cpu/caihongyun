import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  Menu,
  MenuItem,
} from '@mui/material'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { selectNodeForGroup } from 'tauri-plugin-mihomo-api'

import { useCurrentProxy } from '@/hooks/use-current-proxy'
import { useProfiles } from '@/hooks/use-profiles'
import { useSystemProxyState } from '@/hooks/use-system-proxy-state'
import { useProxiesData } from '@/providers/app-data-context'
import {
  getProfiles,
  importProfile,
  openWebUrl,
  patchProfilesConfig,
  patchVergeConfig,
  updateProfile,
} from '@/services/cmds'

const CAIHONGYUN_INIT_KEY = 'caihongyun_initialized'
const API_BASE = 'https://my.caihongmao.org/api/v1'
const CAT_LOGO = 'https://caihongmao.org/logo-cat.svg'
const PANEL = 'https://my.caihongmao.org'

// 在应用内 WebView 窗口打开（不依赖系统默认浏览器；提权运行时外部打开会"找不到应用程序"）
const openWindow = async (url: string, label: string, title = '彩虹猫') => {
  try {
    const existing = await WebviewWindow.getByLabel(label)
    if (existing) {
      await existing.setFocus()
      return
    }
    const win = new WebviewWindow(label, {
      url,
      title,
      width: 480,
      height: 800,
      center: true,
      resizable: true,
    })
    await new Promise<void>((resolve, reject) => {
      win.once('tauri://created', () => resolve())
      win.once('tauri://error', (e) => reject(e))
    })
  } catch {
    // 兜底：尝试系统浏览器
    try {
      await openWebUrl(url)
    } catch {
      // 忽略
    }
  }
}

const openPanel = (hashPath: string) =>
  openWindow(
    `${PANEL}/${hashPath}`,
    `panel-${hashPath.replace(/[^a-zA-Z]/g, '') || 'home'}`,
  )

const AUTH_KEY = 'caihongyun_auth'
const authHeaders = (): Record<string, string> => ({
  'Content-Type': 'application/json',
  Authorization: localStorage.getItem(AUTH_KEY) || '',
})

// 套餐周期 key -> 中文后缀（与后台 OrderSave 旧版字段一致）
const PERIODS: [string, string][] = [
  ['month_price', '/月'],
  ['quarter_price', '/季'],
  ['half_year_price', '/半年'],
  ['year_price', '/年'],
  ['two_year_price', '/2年'],
  ['three_year_price', '/3年'],
  ['onetime_price', '/永久'],
]

type PlanItem = {
  id: number
  name: string
  price: number
  period: string
  label: string
  orig: number | null
}
type PayItem = { id: number; name: string }

const yuan = (cents: number): string =>
  cents % 100 === 0 ? `¥${cents / 100}` : `¥${(cents / 100).toFixed(2)}`

const buildPlans = (data: unknown[]): PlanItem[] => {
  const out: PlanItem[] = []
  for (const raw of data || []) {
    const pl = raw as Record<string, unknown>
    for (const [key, label] of PERIODS) {
      const price = pl[key]
      if (price != null && Number(price) > 0) {
        const cents = Number(price)
        out.push({
          id: Number(pl.id),
          name: String(pl.name ?? '套餐'),
          price: cents,
          period: key,
          label,
          orig: key === 'onetime_price' && cents === 99900 ? 199900 : null,
        })
      }
    }
  }
  return out
}

// ---------- 工具 ----------
const FLAGS: [string, string][] = [
  ['香港', '🇭🇰'], ['Hong Kong', '🇭🇰'], ['HK', '🇭🇰'],
  ['台湾', '🇹🇼'], ['臺灣', '🇹🇼'], ['Taiwan', '🇹🇼'], ['TW', '🇹🇼'],
  ['日本', '🇯🇵'], ['东京', '🇯🇵'], ['大阪', '🇯🇵'], ['Japan', '🇯🇵'], ['JP', '🇯🇵'],
  ['新加坡', '🇸🇬'], ['狮城', '🇸🇬'], ['Singapore', '🇸🇬'], ['SG', '🇸🇬'],
  ['洛杉矶', '🇺🇸'], ['圣何塞', '🇺🇸'], ['硅谷', '🇺🇸'], ['美国', '🇺🇸'], ['United States', '🇺🇸'], ['US', '🇺🇸'],
  ['首尔', '🇰🇷'], ['韩国', '🇰🇷'], ['Korea', '🇰🇷'], ['KR', '🇰🇷'],
  ['伦敦', '🇬🇧'], ['英国', '🇬🇧'], ['UK', '🇬🇧'],
  ['德国', '🇩🇪'], ['Germany', '🇩🇪'], ['DE', '🇩🇪'],
  ['法国', '🇫🇷'], ['France', '🇫🇷'], ['FR', '🇫🇷'],
  ['俄罗斯', '🇷🇺'], ['RU', '🇷🇺'],
  ['印度', '🇮🇳'], ['IN', '🇮🇳'],
  ['泰国', '🇹🇭'], ['TH', '🇹🇭'],
  ['马来', '🇲🇾'], ['MY', '🇲🇾'],
  ['越南', '🇻🇳'], ['VN', '🇻🇳'],
  ['土耳其', '🇹🇷'], ['TR', '🇹🇷'],
  ['加拿大', '🇨🇦'], ['CA', '🇨🇦'],
  ['澳大利亚', '🇦🇺'], ['澳洲', '🇦🇺'], ['AU', '🇦🇺'],
]

const flagFor = (name: string): string => {
  for (const [k, v] of FLAGS) {
    if (name.toLowerCase().includes(k.toLowerCase())) return v
  }
  return '🌐'
}

const fmtGB = (bytes: number): string => {
  if (!bytes || bytes <= 0) return '0'
  return (bytes / 1024 / 1024 / 1024).toFixed(1)
}

// ---------- 登录弹窗 ----------
const LoginDialog = ({ onSuccess }: { onSuccess: () => void }) => {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { mutateProfiles } = useProfiles()

  const handleLogin = async () => {
    if (!email || !password) {
      setError('请输入邮箱和密码')
      return
    }
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_BASE}/passport/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!data.data?.auth_data) {
        setError(data.message || '登录失败，请检查账号密码')
        setLoading(false)
        return
      }
      // 保存 auth token，供原生购买页调用后台接口
      localStorage.setItem(AUTH_KEY, data.data.auth_data)
      const subRes = await fetch(`${API_BASE}/user/getSubscribe`, {
        headers: { Authorization: data.data.auth_data },
      })
      const subData = await subRes.json()
      const subUrl = subData.data?.subscribe_url
      if (!subUrl) {
        setError('获取订阅失败，请联系客服')
        setLoading(false)
        return
      }
      const clashUrl = subUrl.includes('?')
        ? `${subUrl}&flag=verge`
        : `${subUrl}?flag=verge`
      await importProfile(clashUrl, { with_proxy: false })
      await mutateProfiles()
      // 自动激活刚导入的订阅配置
      const profiles = await getProfiles()
      const items = profiles.items ?? []
      if (items.length > 0) {
        const lastItem = items[items.length - 1]
        if (lastItem?.uid) {
          await patchProfilesConfig({ current: lastItem.uid })
          await mutateProfiles()
        }
      }
      // 不自动连接：登录后停留在断开状态，由用户手动点"连接"
      localStorage.setItem(CAIHONGYUN_INIT_KEY, '1')
      localStorage.setItem('caihongyun_email', email)
      onSuccess()
    } catch {
      setError('网络错误，请稍后重试')
    } finally {
      setLoading(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    padding: '12px 16px',
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.15)',
    background: 'rgba(255,255,255,0.08)',
    color: '#fff',
    fontSize: 15,
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  }

  return (
    <Dialog
      open
      maxWidth="xs"
      fullWidth
      sx={{
        '& .MuiPaper-root': {
          borderRadius: 3,
          background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
        },
      }}
    >
      <DialogContent sx={{ p: 4 }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <img
            src={CAT_LOGO}
            width={72}
            height={72}
            alt="彩虹猫"
            style={{ objectFit: 'contain' }}
          />
          <div style={{ color: '#fff', fontSize: 22, fontWeight: 700, marginTop: 8 }}>
            彩虹猫
          </div>
          <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, marginTop: 4 }}>
            安全自由，专属 LGBT 社群
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input
            type="email"
            placeholder="邮箱"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
            style={inputStyle}
          />
          <input
            type="password"
            placeholder="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
            style={inputStyle}
          />
          {error && (
            <div style={{ color: '#ff6b6b', fontSize: 13, textAlign: 'center' }}>
              {error}
            </div>
          )}
          <button
            onClick={handleLogin}
            disabled={loading}
            style={{
              padding: '13px',
              borderRadius: 10,
              border: 'none',
              background: loading
                ? 'rgba(255,255,255,0.2)'
                : 'linear-gradient(135deg, #e040fb, #7c4dff)',
              color: '#fff',
              fontSize: 16,
              fontWeight: 700,
              cursor: loading ? 'not-allowed' : 'pointer',
              marginTop: 4,
            }}
          >
            {loading ? '连接中...' : '登录并连接'}
          </button>
          <div
            style={{
              textAlign: 'center',
              marginTop: 8,
              display: 'flex',
              justifyContent: 'space-between',
              padding: '0 4px',
            }}
          >
            <span
              onClick={() => void openPanel('#/register')}
              style={{ color: '#b388ff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
            >
              ✨ 免费注册
            </span>
            <span
              onClick={() => void openPanel('#/forget')}
              style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13, cursor: 'pointer' }}
            >
              忘记密码
            </span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------- 节点选择弹窗 ----------
const NodePicker = ({
  open,
  nodes,
  current,
  onSelect,
  onClose,
}: {
  open: boolean
  nodes: string[]
  current: string
  onSelect: (name: string) => void
  onClose: () => void
}) => (
  <Dialog
    open={open}
    onClose={onClose}
    maxWidth="xs"
    fullWidth
    sx={{
      '& .MuiPaper-root': {
        borderRadius: 3,
        background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
        color: '#fff',
      },
    }}
  >
    <DialogTitle sx={{ color: '#fff', fontWeight: 700, fontSize: 18 }}>
      选择线路
    </DialogTitle>
    <DialogContent sx={{ px: 1, pb: 2 }}>
      <List>
        {nodes.length === 0 && (
          <div style={{ color: 'rgba(255,255,255,0.5)', textAlign: 'center', padding: 20 }}>
            暂无可用线路
          </div>
        )}
        {nodes.map((name) => {
          const active = name === current
          return (
            <ListItemButton
              key={name}
              onClick={() => onSelect(name)}
              sx={{
                borderRadius: 2,
                mb: 0.5,
                border: active
                  ? '1px solid #7c4dff'
                  : '1px solid rgba(255,255,255,0.08)',
                background: active ? 'rgba(124,77,255,0.18)' : 'transparent',
                '&:hover': { background: 'rgba(255,255,255,0.06)' },
              }}
            >
              <span style={{ fontSize: 20, marginRight: 12 }}>{flagFor(name)}</span>
              <span style={{ flex: 1, fontSize: 15, color: '#fff' }}>{name}</span>
              {active && <span style={{ color: '#7c4dff', fontSize: 18 }}>✓</span>}
            </ListItemButton>
          )
        })}
      </List>
    </DialogContent>
  </Dialog>
)

// ---------- 原生购买页 ----------
const PurchaseDialog = ({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) => {
  const [plans, setPlans] = useState<PlanItem[]>([])
  const [payments, setPayments] = useState<PayItem[]>([])
  const [selected, setSelected] = useState<PlanItem | null>(null)
  const [payId, setPayId] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [buying, setBuying] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  const [noAuth, setNoAuth] = useState(false)

  useEffect(() => {
    if (!open) return
    setError('')
    setDone('')
    const token = localStorage.getItem(AUTH_KEY)
    if (!token) {
      setNoAuth(true)
      return
    }
    setNoAuth(false)
    setLoading(true)
    void (async () => {
      try {
        const pr = await fetch(`${API_BASE}/user/plan/fetch`, {
          headers: authHeaders(),
        })
        const pj = await pr.json()
        const list = buildPlans(pj.data || [])
        setPlans(list)
        setSelected(
          list.find((p) => p.period === 'year_price') ||
            list.find((p) => p.period === 'onetime_price') ||
            list[0] ||
            null,
        )
        const mr = await fetch(`${API_BASE}/user/order/getPaymentMethod`, {
          headers: authHeaders(),
        })
        const mj = await mr.json()
        const pays: PayItem[] = (mj.data || []).map((o: Record<string, unknown>) => ({
          id: Number(o.id),
          name: String(o.name || '支付'),
        }))
        setPayments(pays)
        setPayId(pays[0]?.id ?? null)
      } catch {
        setError('加载套餐失败，请检查网络')
      } finally {
        setLoading(false)
      }
    })()
  }, [open])

  const cancelPending = async () => {
    try {
      const r = await fetch(`${API_BASE}/user/order/fetch`, {
        headers: authHeaders(),
      })
      const j = await r.json()
      for (const o of j.data || []) {
        if (o.status === 0) {
          await fetch(`${API_BASE}/user/order/cancel`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ trade_no: o.trade_no }),
          })
        }
      }
    } catch {
      // 忽略
    }
  }

  const onBuy = async () => {
    if (!selected || payId == null || buying) return
    setBuying(true)
    setError('')
    setDone('')
    try {
      const saveBody = JSON.stringify({
        plan_id: selected.id,
        period: selected.period,
      })
      let res = await fetch(`${API_BASE}/user/order/save`, {
        method: 'POST',
        headers: authHeaders(),
        body: saveBody,
      })
      let sj = await res.json()
      if (!res.ok) {
        const msg = String(sj.message || '')
        if (/未付|开通中|pending|unpaid/i.test(msg)) {
          await cancelPending()
          res = await fetch(`${API_BASE}/user/order/save`, {
            method: 'POST',
            headers: authHeaders(),
            body: saveBody,
          })
          sj = await res.json()
        }
      }
      if (!res.ok) {
        setError(sj.message || '下单失败')
        return
      }
      const tradeNo = String(sj.data ?? '')
      if (!tradeNo) {
        setError('下单失败')
        return
      }
      const co = await fetch(`${API_BASE}/user/order/checkout`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ trade_no: tradeNo, method: payId }),
      })
      const cj = await co.json()
      if (!co.ok) {
        setError(cj.message || '支付发起失败')
        return
      }
      if (cj.type === -1) {
        setDone('开通成功！可关闭本页')
        return
      }
      const payUrl = cj.data ? String(cj.data) : ''
      if (!payUrl || payUrl === 'true') {
        setError('支付发起失败')
        return
      }
      await openWindow(payUrl, 'cashier', '支付')
      setDone('已打开支付页面，付款完成后关闭即可')
    } catch {
      setError('下单出错，请重试')
    } finally {
      setBuying(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="xs"
      fullWidth
      sx={{
        '& .MuiPaper-root': {
          borderRadius: 3,
          background: 'linear-gradient(135deg,#1a1a2e,#16213e)',
          color: '#fff',
        },
      }}
    >
      <DialogTitle sx={{ fontWeight: 800 }}>💎 购买 / 升级套餐</DialogTitle>
      <DialogContent sx={{ pb: 3 }}>
        {noAuth ? (
          <div style={{ textAlign: 'center', padding: '16px 4px' }}>
            <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: 14, lineHeight: 1.8 }}>
              旧版本升级需要重新登录一次。
              <br />
              请从右上角菜单「退出登录」后重新登录，再来购买。
            </div>
          </div>
        ) : loading ? (
          <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.6)', padding: 24 }}>
            加载套餐中…
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {plans.map((p) => {
                const active = selected?.period === p.period && selected?.id === p.id
                return (
                  <div
                    key={`${p.id}-${p.period}`}
                    onClick={() => setSelected(p)}
                    style={{
                      border: active
                        ? '1.5px solid #e040fb'
                        : '1px solid rgba(255,255,255,0.12)',
                      background: active
                        ? 'rgba(224,64,251,0.12)'
                        : 'rgba(255,255,255,0.04)',
                      borderRadius: 14,
                      padding: '13px 16px',
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div style={{ fontSize: 15, fontWeight: 700 }}>
                      {p.name}
                      <span
                        style={{
                          color: 'rgba(255,255,255,0.5)',
                          fontWeight: 400,
                          fontSize: 13,
                          marginLeft: 4,
                        }}
                      >
                        {p.label}
                      </span>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <span style={{ fontSize: 19, fontWeight: 800 }}>{yuan(p.price)}</span>
                      {p.orig && (
                        <span
                          style={{
                            marginLeft: 6,
                            color: 'rgba(255,255,255,0.4)',
                            textDecoration: 'line-through',
                            fontSize: 13,
                          }}
                        >
                          {yuan(p.orig)}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
              {plans.length === 0 && (
                <div style={{ color: 'rgba(255,255,255,0.5)', textAlign: 'center', padding: 16 }}>
                  暂无可购买套餐
                </div>
              )}
            </div>
            {payments.length > 1 && (
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                {payments.map((pay) => {
                  const on = payId === pay.id
                  return (
                    <div
                      key={pay.id}
                      onClick={() => setPayId(pay.id)}
                      style={{
                        flex: 1,
                        textAlign: 'center',
                        padding: '10px 0',
                        borderRadius: 10,
                        cursor: 'pointer',
                        fontSize: 14,
                        fontWeight: 600,
                        border: on
                          ? '1.5px solid #7c4dff'
                          : '1px solid rgba(255,255,255,0.12)',
                        background: on ? 'rgba(124,77,255,0.15)' : 'transparent',
                      }}
                    >
                      {pay.name}
                    </div>
                  )
                })}
              </div>
            )}
            {error && (
              <div style={{ color: '#ff6b6b', fontSize: 13, textAlign: 'center', marginTop: 12 }}>
                {error}
              </div>
            )}
            {done && (
              <div style={{ color: '#7CFFB2', fontSize: 13, textAlign: 'center', marginTop: 12 }}>
                {done}
              </div>
            )}
            <button
              onClick={() => void onBuy()}
              disabled={buying || !selected}
              style={{
                width: '100%',
                marginTop: 16,
                padding: 14,
                borderRadius: 12,
                border: 'none',
                background: buying
                  ? 'rgba(255,255,255,0.2)'
                  : 'linear-gradient(135deg,#e040fb,#7c4dff)',
                color: '#fff',
                fontSize: 16,
                fontWeight: 800,
                cursor: buying ? 'wait' : 'pointer',
              }}
            >
              {buying
                ? '处理中…'
                : selected
                  ? `立即开通 · ${yuan(selected.price)} ${selected.label}`
                  : '请选择套餐'}
            </button>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ---------- 主页（一键连接） ----------
const HomePage = () => {
  const [loggedIn, setLoggedIn] = useState(
    !!localStorage.getItem(CAIHONGYUN_INIT_KEY),
  )
  const { current, mutateProfiles } = useProfiles()
  const { indicator, configState, toggleSystemProxy } = useSystemProxyState()
  const { proxies } = useProxiesData()
  const { currentProxy, primaryGroupName, refreshProxy } = useCurrentProxy()

  const [busy, setBusy] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [purchaseOpen, setPurchaseOpen] = useState(false)
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null)
  const [refreshing, setRefreshing] = useState(false)

  const connected = configState
  const realConnected = indicator

  // 当前代理组 & 节点列表
  const group = useMemo(() => {
    if (!proxies || !primaryGroupName) return null
    if (primaryGroupName === 'GLOBAL') return proxies.global
    return (
      proxies.groups?.find(
        (g: { name?: string }) => g.name === primaryGroupName,
      ) ?? proxies.global
    )
  }, [proxies, primaryGroupName])

  const nodes = useMemo(() => {
    const all = (group as { all?: unknown[] })?.all ?? []
    return all
      .map((n) => (typeof n === 'string' ? n : (n as { name?: string })?.name))
      .filter((n): n is string => !!n && n !== 'DIRECT' && n !== 'REJECT')
  }, [group])

  const currentNode =
    currentProxy?.name || (group as { now?: string })?.now || ''

  // 订阅流量
  const extra = current?.extra
  const used = extra ? extra.upload + extra.download : 0
  const total = extra?.total ?? 0
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0
  const expireStr = extra?.expire
    ? new Date(extra.expire * 1000).toLocaleDateString('zh-CN')
    : '长期有效'

  const handleConnect = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      await toggleSystemProxy(!connected)
    } finally {
      setTimeout(() => setBusy(false), 400)
    }
  }, [busy, connected, toggleSystemProxy])

  const handleSelectNode = useCallback(
    async (name: string) => {
      if (!primaryGroupName) return
      try {
        await selectNodeForGroup(primaryGroupName, name)
        await refreshProxy?.()
      } catch {
        // 忽略切换失败
      }
      setPickerOpen(false)
    },
    [primaryGroupName, refreshProxy],
  )

  const handleRefreshSub = useCallback(async () => {
    setMenuAnchor(null)
    if (!current?.uid || refreshing) return
    setRefreshing(true)
    try {
      await updateProfile(current.uid)
      await mutateProfiles()
    } catch {
      // 忽略
    } finally {
      setRefreshing(false)
    }
  }, [current?.uid, refreshing, mutateProfiles])

  const handleLogout = useCallback(async () => {
    setMenuAnchor(null)
    await patchVergeConfig({ enable_system_proxy: false })
    localStorage.removeItem(CAIHONGYUN_INIT_KEY)
    setLoggedIn(false)
  }, [])

  const openPurchase = useCallback(() => {
    setMenuAnchor(null)
    setPurchaseOpen(true)
  }, [])

  if (!loggedIn) {
    return <LoginDialog onSuccess={() => setLoggedIn(true)} />
  }

  const statusText = busy
    ? '正在切换...'
    : connected
      ? realConnected
        ? '已连接 · 已保护'
        : '已开启'
      : '未连接'

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background:
          'radial-gradient(1200px 600px at 50% -10%, #241b4a 0%, #16213e 45%, #0f1526 100%)',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <style>
        {`
          @keyframes cat-pulse {
            0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(124,77,255,0.55); }
            70% { transform: scale(1.02); box-shadow: 0 0 0 24px rgba(124,77,255,0); }
            100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(124,77,255,0); }
          }
          @keyframes ring-spin { to { transform: rotate(360deg); } }
        `}
      </style>

      {/* 顶部栏 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '18px 22px 6px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src={CAT_LOGO} width={30} height={30} alt="" style={{ objectFit: 'contain' }} />
          <span
            style={{
              fontSize: 18,
              fontWeight: 800,
              letterSpacing: 1,
              background: 'linear-gradient(135deg, #e040fb, #7c4dff, #2196f3)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            彩虹猫
          </span>
        </div>
        <button
          onClick={(e) => setMenuAnchor(e.currentTarget)}
          style={{
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.12)',
            color: '#fff',
            borderRadius: 10,
            width: 38,
            height: 34,
            fontSize: 18,
            cursor: 'pointer',
          }}
        >
          ☰
        </button>
        <Menu
          anchorEl={menuAnchor}
          open={Boolean(menuAnchor)}
          onClose={() => setMenuAnchor(null)}
          slotProps={{ paper: { sx: { bgcolor: '#1a1a2e', color: '#fff', minWidth: 180 } } }}
        >
          <MenuItem onClick={openPurchase}>🛒 购买 / 升级套餐</MenuItem>
          <MenuItem onClick={handleRefreshSub}>
            {refreshing ? '⏳ 刷新中...' : '🔄 刷新订阅'}
          </MenuItem>
          <MenuItem
            onClick={() => {
              setMenuAnchor(null)
              void openPanel('#/dashboard')
            }}
          >
            🌐 打开后台
          </MenuItem>
          <MenuItem onClick={handleLogout} sx={{ color: '#ff6b6b' }}>
            🚪 退出登录
          </MenuItem>
        </Menu>
      </div>

      {/* 中间连接按钮 */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 20,
        }}
      >
        <div style={{ position: 'relative', width: 220, height: 220 }}>
          {/* 彩虹光环 */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '50%',
              padding: 4,
              background: connected
                ? 'conic-gradient(#e040fb,#7c4dff,#2196f3,#00e5ff,#e040fb)'
                : 'conic-gradient(rgba(255,255,255,0.15),rgba(255,255,255,0.05))',
              animation: connected ? 'ring-spin 6s linear infinite' : 'none',
              WebkitMask:
                'radial-gradient(farthest-side, transparent calc(100% - 6px), #000 calc(100% - 5px))',
            }}
          />
          <button
            onClick={handleConnect}
            disabled={busy}
            style={{
              position: 'absolute',
              inset: 14,
              borderRadius: '50%',
              border: 'none',
              cursor: busy ? 'wait' : 'pointer',
              background: connected
                ? 'radial-gradient(circle at 50% 35%, #2a2350 0%, #14102b 100%)'
                : 'radial-gradient(circle at 50% 35%, #23283d 0%, #141826 100%)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              animation: connected ? 'cat-pulse 2.4s ease-out infinite' : 'none',
            }}
          >
            <img
              src={CAT_LOGO}
              width={84}
              height={84}
              alt=""
              style={{
                objectFit: 'contain',
                filter: connected ? 'none' : 'grayscale(0.7) opacity(0.7)',
              }}
            />
            <span
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: connected ? '#c9b6ff' : 'rgba(255,255,255,0.55)',
              }}
            >
              {connected ? '点击断开' : '点击连接'}
            </span>
          </button>
        </div>

        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: connected ? '#7CFFB2' : 'rgba(255,255,255,0.6)',
          }}
        >
          {statusText}
        </div>

        {/* 节点选择 */}
        <button
          onClick={() => setPickerOpen(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: 'rgba(255,255,255,0.07)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 30,
            padding: '9px 18px',
            color: '#fff',
            fontSize: 14,
            cursor: 'pointer',
            maxWidth: 320,
          }}
        >
          <span style={{ fontSize: 18 }}>{currentNode ? flagFor(currentNode) : '🌐'}</span>
          <span
            style={{
              maxWidth: 220,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {currentNode || '选择线路'}
          </span>
          <span style={{ opacity: 0.5, marginLeft: 2 }}>▾</span>
        </button>
      </div>

      {/* 底部订阅信息 + 购买 */}
      <div style={{ padding: '0 22px 22px' }}>
        <div
          style={{
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 16,
            padding: '14px 16px',
            marginBottom: 12,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 13,
              color: 'rgba(255,255,255,0.7)',
              marginBottom: 8,
            }}
          >
            <span>
              已用 {fmtGB(used)}G / {total > 0 ? `${fmtGB(total)}G` : '不限量'}
            </span>
            <span>到期：{expireStr}</span>
          </div>
          <div
            style={{
              height: 7,
              borderRadius: 4,
              background: 'rgba(255,255,255,0.1)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${pct}%`,
                height: '100%',
                borderRadius: 4,
                background: 'linear-gradient(90deg,#e040fb,#7c4dff,#2196f3)',
              }}
            />
          </div>
        </div>
        <button
          onClick={openPurchase}
          style={{
            width: '100%',
            padding: 14,
            borderRadius: 14,
            border: 'none',
            background: 'linear-gradient(135deg,#e040fb,#7c4dff)',
            color: '#fff',
            fontSize: 16,
            fontWeight: 800,
            cursor: 'pointer',
            boxShadow: '0 8px 24px rgba(124,77,255,0.35)',
          }}
        >
          🚀 购买 / 升级套餐
        </button>
      </div>

      <NodePicker
        open={pickerOpen}
        nodes={nodes}
        current={currentNode}
        onSelect={handleSelectNode}
        onClose={() => setPickerOpen(false)}
      />

      <PurchaseDialog
        open={purchaseOpen}
        onClose={() => setPurchaseOpen(false)}
      />
    </div>
  )
}

export default HomePage
