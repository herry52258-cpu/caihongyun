import { useState } from 'react'
import { useNavigate } from 'react-router'
import { importProfile } from '@/services/cmds'

const API_BASE = 'https://13141069.xyz/api/v1'

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
      const authToken = data.data.auth_data

      // 获取订阅链接
      const subRes = await fetch(`${API_BASE}/user/getSubscribe`, {
        headers: { Authorization: authToken },
      })
      const subData = await subRes.json()
      const subUrl = subData.data?.subscribe_url
      if (!subUrl) {
        setError('获取订阅失败，请联系客服')
        setLoading(false)
        return
      }

      // 导入订阅到 Clash 核心
      await importProfile(subUrl, { with_proxy: false })
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
          <div style={{ fontSize: 48, marginBottom: 8 }}>🌈</div>
          <h1 style={{ color: '#fff', margin: 0, fontSize: 24, fontWeight: 700 }}>彩虹云</h1>
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
            <a
              href="https://13141069.xyz/#/register"
              target="_blank"
              rel="noreferrer"
              style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, textDecoration: 'none' }}
            >
              还没有账号？点此注册
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}
