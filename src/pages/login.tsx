import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useState } from 'react'
import { useNavigate } from 'react-router'

// 猫图打包进 App，不再从 caihongmao.org 远程加载（该域名走 Cloudflare，未连 VPN 时国内常被干扰）
import CAT_LOGO from '@/assets/image/cat-logo.svg'
import { importProfile, openWebUrl } from '@/services/cmds'
import { panelApiFetch } from '@/services/panel-api'

const APP_VERSION = 'v1.0.27'
// 面板/注册页用 cdn.caihongmao.org（走CF、SNI未被墙、完整面板镜像）；my. 常被GFW掐
const PANEL = 'https://p2.yuntanlu.com'

// 登录/API 走共享的双通道请求器：直连 IP:8080 优先(国内秒开)，my.(CF) 兜底。
// 原兜底 m.caihongmao.org(443) 已被 GFW 按 SNI 掐死，弃用。
const apiFetch = panelApiFetch

// 在应用内 WebView 窗口打开面板（提权运行时系统浏览器会"找不到应用程序"）
const openPanel = async (hashPath: string) => {
  const url = `${PANEL}/${hashPath}`
  const label = `panel-${hashPath.replace(/[^a-zA-Z]/g, '') || 'home'}`
  try {
    const existing = await WebviewWindow.getByLabel(label)
    if (existing) {
      await existing.setFocus()
      return
    }
    const win = new WebviewWindow(label, {
      url,
      title: '彩虹猫',
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
    try {
      await openWebUrl(url)
    } catch {
      // 忽略
    }
  }
}

export default function LoginPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleLogin = async () => {
    if (!email || !password) {
      setError('请输入邮箱和密码')
      return
    }
    setLoading(true)
    setError('')
    try {
      // 登录获取 token
      const res = await apiFetch('/passport/auth/login', {
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
      const authToken = data.data.auth_data
      // 保存 auth token，供原生购买页调用后台接口
      localStorage.setItem('caihongyun_auth', authToken)

      // 获取订阅链接
      const subRes = await apiFetch('/user/getSubscribe', {
        headers: { Authorization: authToken },
      })
      const subData = await subRes.json()
      const subUrl = subData.data?.subscribe_url
      if (!subUrl) {
        setError('获取订阅失败，请联系客服')
        setLoading(false)
        return
      }

      // 导入订阅到 Clash 核心。
      // 过期/未开通用户：订阅内容返回 403，importProfile 会失败——但这不该拦住登录。
      // 与 Android 一致：仍算登录成功、进首页，由首页显示到期状态并引导购买，
      // 否则用户只看到「网络错误」，会误以为软件坏了。
      try {
        await importProfile(subUrl, { with_proxy: false })
      } catch {
        // 订阅导入失败（多为套餐到期）：不报错，照常进首页引导续费
      }
      localStorage.setItem('caihongyun_initialized', '1')
      localStorage.setItem('caihongyun_email', email)
      navigate('/')
    } catch (e) {
      setError('网络错误，请稍后重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
      fontFamily: 'system-ui, sans-serif',
    }}>
      <div style={{
        background: 'rgba(255,255,255,0.05)',
        backdropFilter: 'blur(20px)',
        borderRadius: 20,
        padding: '40px 36px',
        width: 340,
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        border: '1px solid rgba(255,255,255,0.1)',
      }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <img src={CAT_LOGO} width={76} height={76} alt="彩虹猫" style={{ marginBottom: 8, display: 'inline-block' }} />
          <h1 style={{ color: '#fff', margin: 0, fontSize: 24, fontWeight: 700 }}>彩虹猫</h1>
          <p style={{ color: 'rgba(255,255,255,0.5)', margin: '6px 0 0', fontSize: 13 }}>
            安全自由，专属LGBT社群
          </p>
        </div>

        {/* 表单 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <input
            type="email"
            placeholder="邮箱"
            value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleLogin()}
            style={{
              padding: '12px 16px',
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.15)',
              background: 'rgba(255,255,255,0.08)',
              color: '#fff',
              fontSize: 15,
              outline: 'none',
            }}
          />
          <input
            type="password"
            placeholder="密码"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleLogin()}
            style={{
              padding: '12px 16px',
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.15)',
              background: 'rgba(255,255,255,0.08)',
              color: '#fff',
              fontSize: 15,
              outline: 'none',
            }}
          />

          {error && (
            <p style={{ color: '#ff6b6b', fontSize: 13, margin: 0, textAlign: 'center' }}>
              {error}
            </p>
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

          <div style={{ textAlign: 'center', marginTop: 8 }}>
            <span
              onClick={() => void openPanel('#/register')}
              style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, cursor: 'pointer' }}
            >
              还没有账号？点此注册
            </span>
          </div>

          {/* 版本号：便于用户/客服确认安装的是哪个版本 */}
          <div style={{ textAlign: 'center', marginTop: 6 }}>
            <span style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12, letterSpacing: 0.3 }}>彩虹猫桌面版 {APP_VERSION}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
