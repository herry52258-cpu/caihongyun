import {
  DnsOutlined,
  HelpOutlineRounded,
  HistoryEduOutlined,
  LogoutOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  RouterOutlined,
  SettingsOutlined,
  SpeedOutlined,
  StorefrontOutlined,
} from '@mui/icons-material'
import {
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  FormGroup,
  Grid,
  IconButton,
  Skeleton,
  Tooltip,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import { Suspense, lazy, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BasePage } from '@/components/base'
import { ClashModeCard } from '@/components/home/clash-mode-card'
import { CurrentProxyCard } from '@/components/home/current-proxy-card'
import { EnhancedCard } from '@/components/home/enhanced-card'
import { EnhancedTrafficStats } from '@/components/home/enhanced-traffic-stats'
import { HomeProfileCard } from '@/components/home/home-profile-card'
import { ProxyTunCard } from '@/components/home/proxy-tun-card'
import { useProfiles } from '@/hooks/use-profiles'
import { useVerge } from '@/hooks/use-verge'
import { entry_lightweight_mode, getProfiles, importProfile, openWebUrl, patchProfilesConfig, patchVergeConfig } from '@/services/cmds'

const LazyTestCard = lazy(() =>
  import('@/components/home/test-card').then((module) => ({
    default: module.TestCard,
  })),
)
const LazyIpInfoCard = lazy(() =>
  import('@/components/home/ip-info-card').then((module) => ({
    default: module.IpInfoCard,
  })),
)
const LazyClashInfoCard = lazy(() =>
  import('@/components/home/clash-info-card').then((module) => ({
    default: module.ClashInfoCard,
  })),
)
const LazySystemInfoCard = lazy(() =>
  import('@/components/home/system-info-card').then((module) => ({
    default: module.SystemInfoCard,
  })),
)

// 定义首页卡片设置接口
interface HomeCardsSettings {
  profile: boolean
  proxy: boolean
  network: boolean
  mode: boolean
  traffic: boolean
  info: boolean
  clashinfo: boolean
  systeminfo: boolean
  test: boolean
  ip: boolean
  [key: string]: boolean
}

// 首页设置对话框组件接口
interface HomeSettingsDialogProps {
  open: boolean
  onClose: () => void
  homeCards: HomeCardsSettings
  onSave: (cards: HomeCardsSettings) => void
}

const serializeCardFlags = (cards: HomeCardsSettings) =>
  Object.keys(cards)
    .sort()
    .map((key) => `${key}:${cards[key] ? 1 : 0}`)
    .join('|')

// 首页设置对话框组件
const HomeSettingsDialog = ({
  open,
  onClose,
  homeCards,
  onSave,
}: HomeSettingsDialogProps) => {
  const { t } = useTranslation()
  const [cards, setCards] = useState<HomeCardsSettings>(homeCards)
  const { patchVerge } = useVerge()

  const handleToggle = (key: string) => {
    setCards((prev: HomeCardsSettings) => ({
      ...prev,
      [key]: !prev[key],
    }))
  }

  const handleSave = async () => {
    await patchVerge({ home_cards: cards })
    onSave(cards)
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{t('home.page.settings.title')}</DialogTitle>
      <DialogContent>
        <FormGroup>
          <FormControlLabel
            control={
              <Checkbox
                checked={cards.profile || false}
                onChange={() => handleToggle('profile')}
              />
            }
            label={t('home.page.settings.cards.profile')}
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={cards.proxy || false}
                onChange={() => handleToggle('proxy')}
              />
            }
            label={t('home.page.settings.cards.currentProxy')}
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={cards.network || false}
                onChange={() => handleToggle('network')}
              />
            }
            label={t('home.page.settings.cards.network')}
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={cards.mode || false}
                onChange={() => handleToggle('mode')}
              />
            }
            label={t('home.page.settings.cards.proxyMode')}
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={cards.traffic || false}
                onChange={() => handleToggle('traffic')}
              />
            }
            label={t('home.page.settings.cards.traffic')}
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={cards.test || false}
                onChange={() => handleToggle('test')}
              />
            }
            label={t('home.page.settings.cards.tests')}
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={cards.ip || false}
                onChange={() => handleToggle('ip')}
              />
            }
            label={t('home.page.settings.cards.ip')}
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={cards.clashinfo || false}
                onChange={() => handleToggle('clashinfo')}
              />
            }
            label={t('home.page.settings.cards.clashInfo')}
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={cards.systeminfo || false}
                onChange={() => handleToggle('systeminfo')}
              />
            }
            label={t('home.page.settings.cards.systemInfo')}
          />
        </FormGroup>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('shared.actions.cancel')}</Button>
        <Button onClick={handleSave} color="primary">
          {t('shared.actions.save')}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

const CAIHONGYUN_INIT_KEY = 'caihongyun_initialized'
const API_BASE = 'https://my.caihongmao.org/api/v1'

const LoginDialog = ({ onSuccess }: { onSuccess: () => void }) => {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { mutateProfiles } = useProfiles()

  const handleLogin = async () => {
    if (!email || !password) { setError('请输入邮箱和密码'); return }
    setLoading(true); setError('')
    try {
      const res = await fetch(`${API_BASE}/passport/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!data.data?.auth_data) {
        setError(data.message || '登录失败，请检查账号密码')
        setLoading(false); return
      }
      const subRes = await fetch(`${API_BASE}/user/getSubscribe`, {
        headers: { Authorization: data.data.auth_data },
      })
      const subData = await subRes.json()
      const subUrl = subData.data?.subscribe_url
      if (!subUrl) { setError('获取订阅失败，请联系客服'); setLoading(false); return }
      const clashUrl = subUrl.includes('?') ? `${subUrl}&flag=verge` : `${subUrl}?flag=verge`
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
      await patchVergeConfig({ enable_system_proxy: true })
      localStorage.setItem(CAIHONGYUN_INIT_KEY, '1')
      onSuccess()
    } catch {
      setError('网络错误，请稍后重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open maxWidth="xs" fullWidth sx={{ '& .MuiPaper-root': { borderRadius: 3, background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)' } }}>
      <DialogContent sx={{ p: 4 }}>
        <Box sx={{ textAlign: 'center', mb: 3 }}>
          <Box sx={{ fontSize: 48 }}>🌈</Box>
          <Box sx={{ color: '#fff', fontSize: 22, fontWeight: 700, mt: 1 }}>彩虹猫</Box>
          <Box sx={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, mt: 0.5 }}>安全自由，专属LGBT社群</Box>
        </Box>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <input type="email" placeholder="邮箱" value={email} onChange={e => setEmail(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleLogin()}
            style={{ padding: '12px 16px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.08)', color: '#fff', fontSize: 15, outline: 'none', width: '100%', boxSizing: 'border-box' }} />
          <input type="password" placeholder="密码" value={password} onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleLogin()}
            style={{ padding: '12px 16px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.08)', color: '#fff', fontSize: 15, outline: 'none', width: '100%', boxSizing: 'border-box' }} />
          {error && <Box sx={{ color: '#ff6b6b', fontSize: 13, textAlign: 'center' }}>{error}</Box>}
          <button onClick={handleLogin} disabled={loading}
            style={{ padding: '13px', borderRadius: 10, border: 'none', background: loading ? 'rgba(255,255,255,0.2)' : 'linear-gradient(135deg, #e040fb, #7c4dff)', color: '#fff', fontSize: 16, fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer', marginTop: 4 }}>
            {loading ? '连接中...' : '登录并连接'}
          </button>
          <Box sx={{ textAlign: 'center', mt: 1, display: 'flex', justifyContent: 'space-between', px: 0.5 }}>
            <a href="https://my.caihongmao.org/#/register" target="_blank" rel="noreferrer"
              style={{ color: '#b388ff', fontSize: 13, textDecoration: 'none', fontWeight: 600 }}>
              ✨ 免费注册
            </a>
            <a href="https://my.caihongmao.org/#/forget" target="_blank" rel="noreferrer"
              style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13, textDecoration: 'none' }}>
              忘记密码
            </a>
          </Box>
        </Box>
      </DialogContent>
    </Dialog>
  )
}

const HomePage = () => {
  const { t } = useTranslation()
  const { verge } = useVerge()
  const { current, mutateProfiles } = useProfiles()
  const [loggedIn, setLoggedIn] = useState(!!localStorage.getItem(CAIHONGYUN_INIT_KEY))
  const proxyEnabled = verge?.enable_system_proxy ?? false

  const handleToggleProxy = async () => {
    await patchVergeConfig({ enable_system_proxy: !proxyEnabled })
  }

  const handleLogout = async () => {
    await patchVergeConfig({ enable_system_proxy: false })
    localStorage.removeItem(CAIHONGYUN_INIT_KEY)
    setLoggedIn(false)
  }

  const handleOpenDashboard = () => {
    openWebUrl('https://my.caihongmao.org/#/dashboard')
  }

  // 设置弹窗的状态
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [localHomeCards, setLocalHomeCards] = useState<{
    value: HomeCardsSettings
    baseSignature: string
  } | null>(null)

  // 卡片显示状态
  const defaultCards = useMemo<HomeCardsSettings>(
    () => ({
      info: false,
      profile: true,
      proxy: true,
      network: true,
      mode: true,
      traffic: true,
      clashinfo: true,
      systeminfo: true,
      test: true,
      ip: true,
    }),
    [],
  )

  const vergeHomeCards = useMemo<HomeCardsSettings | null>(
    () => (verge?.home_cards as HomeCardsSettings | undefined) ?? null,
    [verge],
  )

  const remoteHomeCards = useMemo<HomeCardsSettings>(
    () => vergeHomeCards ?? defaultCards,
    [defaultCards, vergeHomeCards],
  )

  const remoteSignature = useMemo(
    () => serializeCardFlags(remoteHomeCards),
    [remoteHomeCards],
  )

  const pendingLocalCards = useMemo<HomeCardsSettings | null>(() => {
    if (!localHomeCards) return null
    return localHomeCards.baseSignature === remoteSignature
      ? localHomeCards.value
      : null
  }, [localHomeCards, remoteSignature])

  const effectiveHomeCards = pendingLocalCards ?? remoteHomeCards

  // 文档链接函数
  const toGithubDoc = useLockFn(() => {
    return openWebUrl('https://clash-verge-rev.github.io/index.html')
  })

  // 新增：打开设置弹窗
  const openSettings = useCallback(() => {
    setSettingsOpen(true)
  }, [])

  const renderCard = useCallback(
    (cardKey: string, component: React.ReactNode, size: number = 6) => {
      if (!effectiveHomeCards[cardKey]) return null

      return (
        <Grid size={size} key={cardKey}>
          {component}
        </Grid>
      )
    },
    [effectiveHomeCards],
  )

  const criticalCards = useMemo(
    () => [
      renderCard(
        'profile',
        <HomeProfileCard current={current} onProfileUpdated={mutateProfiles} />,
      ),
      renderCard('proxy', <CurrentProxyCard />),
      renderCard('network', <NetworkSettingsCard />),
      renderCard('mode', <ClashModeEnhancedCard />),
    ],
    [current, mutateProfiles, renderCard],
  )

  // 新增：保存设置时用requestIdleCallback/setTimeout
  const handleSaveSettings = (newCards: HomeCardsSettings) => {
    if (window.requestIdleCallback) {
      window.requestIdleCallback(() =>
        setLocalHomeCards({
          value: newCards,
          baseSignature: remoteSignature,
        }),
      )
    } else {
      setTimeout(
        () =>
          setLocalHomeCards({
            value: newCards,
            baseSignature: remoteSignature,
          }),
        0,
      )
    }
  }

  const nonCriticalCards = useMemo(
    () => [
      renderCard(
        'traffic',
        <EnhancedCard
          title={t('home.page.cards.trafficStats')}
          icon={<SpeedOutlined />}
          iconColor="secondary"
        >
          <EnhancedTrafficStats />
        </EnhancedCard>,
        12,
      ),
      renderCard(
        'test',
        <Suspense fallback={<Skeleton variant="rectangular" height={200} />}>
          <LazyTestCard />
        </Suspense>,
      ),
      renderCard(
        'ip',
        <Suspense fallback={<Skeleton variant="rectangular" height={200} />}>
          <LazyIpInfoCard />
        </Suspense>,
      ),
      renderCard(
        'clashinfo',
        <Suspense fallback={<Skeleton variant="rectangular" height={200} />}>
          <LazyClashInfoCard />
        </Suspense>,
      ),
      renderCard(
        'systeminfo',
        <Suspense fallback={<Skeleton variant="rectangular" height={200} />}>
          <LazySystemInfoCard />
        </Suspense>,
      ),
    ],
    [t, renderCard],
  )
  const dialogKey = useMemo(
    () => `${serializeCardFlags(effectiveHomeCards)}:${settingsOpen ? 1 : 0}`,
    [effectiveHomeCards, settingsOpen],
  )
  return (
    <>
    {!loggedIn && <LoginDialog onSuccess={() => setLoggedIn(true)} />}
    <BasePage
      title={t('home.page.title')}
      contentStyle={{ padding: 2 }}
      header={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          {/* 暂停/恢复代理 */}
          <Tooltip title={proxyEnabled ? '暂停代理（使用软路由）' : '开启代理'} arrow>
            <Chip
              icon={proxyEnabled ? <PauseCircleOutlined fontSize="small" /> : <PlayCircleOutlined fontSize="small" />}
              label={proxyEnabled ? '已连接' : '已暂停'}
              size="small"
              onClick={handleToggleProxy}
              sx={{
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: 12,
                bgcolor: proxyEnabled ? 'rgba(0,200,83,0.15)' : 'rgba(255,255,255,0.08)',
                color: proxyEnabled ? '#00c853' : 'text.secondary',
                border: '1px solid',
                borderColor: proxyEnabled ? 'rgba(0,200,83,0.4)' : 'rgba(255,255,255,0.15)',
                '& .MuiChip-icon': { color: 'inherit' },
                '&:hover': { opacity: 0.8 },
              }}
            />
          </Tooltip>

          {/* 我的套餐 */}
          <Tooltip title="我的套餐 / 续费" arrow>
            <IconButton onClick={handleOpenDashboard} size="small" color="inherit">
              <StorefrontOutlined />
            </IconButton>
          </Tooltip>

          {/* 切换账号 */}
          <Tooltip title="退出登录 / 切换账号" arrow>
            <IconButton onClick={handleLogout} size="small" color="inherit">
              <LogoutOutlined />
            </IconButton>
          </Tooltip>

          <Tooltip title={t('home.page.tooltips.settings')} arrow>
            <IconButton onClick={openSettings} size="small" color="inherit">
              <SettingsOutlined />
            </IconButton>
          </Tooltip>
        </Box>
      }
    >
      <Grid container spacing={1.5} columns={{ xs: 6, sm: 6, md: 12 }}>
        {criticalCards}

        {nonCriticalCards}
      </Grid>

      {/* 首页设置弹窗 */}
      <HomeSettingsDialog
        key={dialogKey}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        homeCards={effectiveHomeCards}
        onSave={handleSaveSettings}
      />
    </BasePage>
    </>
  )
}

// 增强版网络设置卡片组件
const NetworkSettingsCard = () => {
  const { t } = useTranslation()
  return (
    <EnhancedCard
      title={t('home.page.cards.networkSettings')}
      icon={<DnsOutlined />}
      iconColor="primary"
      action={null}
    >
      <ProxyTunCard />
    </EnhancedCard>
  )
}

// 增强版 Clash 模式卡片组件
const ClashModeEnhancedCard = () => {
  const { t } = useTranslation()
  return (
    <EnhancedCard
      title={t('home.page.cards.proxyMode')}
      icon={<RouterOutlined />}
      iconColor="info"
      action={null}
    >
      <ClashModeCard />
    </EnhancedCard>
  )
}

export default HomePage
