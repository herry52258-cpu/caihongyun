import {
  Dialog,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
} from '@mui/material'
import { useState } from 'react'

import {
  REFRESH_FAIL_TEXT,
  refreshSuccessText,
  type RefreshRoutesResult,
} from '@/services/refresh-routes'
import { flagFor } from '@/utils/node-flag'

const NodePicker = ({
  open,
  nodes,
  current,
  refreshing,
  onSelect,
  onClose,
  onRefresh,
}: {
  open: boolean
  nodes: string[]
  current: string
  refreshing: boolean
  onSelect: (name: string) => void
  onClose: () => void
  onRefresh: () => Promise<RefreshRoutesResult>
}) => {
  const [tip, setTip] = useState('')

  const doRefresh = async () => {
    if (refreshing) return
    setTip('')
    try {
      const result = await onRefresh()
      setTip(result.ok ? refreshSuccessText(result.count) : result.message)
    } catch {
      setTip(REFRESH_FAIL_TEXT)
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
          background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
          color: '#fff',
        },
      }}
    >
      <DialogTitle sx={{ color: '#fff', fontWeight: 700, fontSize: 18 }}>
        选择线路
      </DialogTitle>
      <DialogContent sx={{ px: 2, pb: 2 }}>
        <style>
          {`@keyframes chy-route-spin { to { transform: rotate(360deg); } }`}
        </style>
        <button
          type="button"
          aria-label={refreshing ? '刷新中' : '刷新线路'}
          disabled={refreshing}
          onClick={() => void doRefresh()}
          style={{
            width: '100%',
            margin: '2px 0 10px',
            padding: '11px 14px',
            border: 'none',
            borderRadius: 12,
            background: refreshing
              ? 'rgba(124,77,255,0.35)'
              : 'linear-gradient(135deg,#e040fb,#7c4dff)',
            color: '#fff',
            fontSize: 15,
            fontWeight: 800,
            cursor: refreshing ? 'wait' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            boxShadow: refreshing ? 'none' : '0 8px 20px rgba(124,77,255,0.35)',
          }}
        >
          {refreshing ? (
            <span
              aria-hidden="true"
              style={{
                width: 16,
                height: 16,
                border: '2px solid rgba(255,255,255,0.35)',
                borderTopColor: '#fff',
                borderRadius: '50%',
                animation: 'chy-route-spin 0.7s linear infinite',
              }}
            />
          ) : (
            <span aria-hidden="true">🔄</span>
          )}
          {refreshing ? '刷新中...' : '刷新线路'}
        </button>
        {tip && (
          <div
            role="status"
            style={{
              textAlign: 'center',
              fontSize: 13.5,
              fontWeight: 700,
              paddingBottom: 8,
              color: tip.startsWith('已更新') ? '#7CFFB2' : '#ff8a80',
            }}
          >
            {tip}
          </div>
        )}
        <List sx={{ py: 0 }}>
          {nodes.length === 0 && (
            <div
              style={{
                color: 'rgba(255,255,255,0.5)',
                textAlign: 'center',
                padding: 20,
              }}
            >
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
                <span style={{ fontSize: 20, marginRight: 12 }}>
                  {flagFor(name)}
                </span>
                <span style={{ flex: 1, fontSize: 15, color: '#fff' }}>
                  {name}
                </span>
                {active && (
                  <span style={{ color: '#7c4dff', fontSize: 18 }}>✓</span>
                )}
              </ListItemButton>
            )
          })}
        </List>
      </DialogContent>
    </Dialog>
  )
}

export default NodePicker
