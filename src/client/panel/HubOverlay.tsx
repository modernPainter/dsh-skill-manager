/**
 * 技能中枢浮层：注册在宿主 `shell.overlay` 插槽里的常驻挂载点。
 *
 * 本身不渲染入口 —— 入口是侧边栏顶部那行 DOM（见 sidebar-entry.ts），
 * 点击时派发 `dsh-skill-manager:toggle`，这里监听并开关居中大弹窗。
 * 关闭方式：右上角关闭按钮、点击遮罩、Esc。
 */

import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { SkillHubApi } from '../api.ts'
import { IconSkillOutline16 } from '../icons.tsx'
import { SKILL_MANAGER_TOGGLE_EVENT } from '../sidebar-entry.ts'
import { SkillHubPanel } from './SkillHubPanel.tsx'

export interface HubOverlayProps {
  api: SkillHubApi
  label: string
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  background: 'rgba(0, 0, 0, 0.4)',
}

const dialogStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: 'min(960px, 100%)',
  height: 'min(780px, 100%)',
  overflow: 'hidden',
  border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))',
  borderRadius: 16,
  background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-l1, #fff))',
  boxShadow: 'var(--dsw-shadow-lv3, 0 12px 40px rgba(0, 0, 0, 0.24))',
}

const headerStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  minHeight: 48,
  padding: '0 12px 0 16px',
  borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))',
}

const closeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  marginLeft: 'auto',
  padding: 0,
  border: 'none',
  borderRadius: 999,
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary, inherit)',
  fontSize: 18,
  lineHeight: 1,
  cursor: 'pointer',
}

/** 监听侧边栏入口事件并渲染技能中枢弹窗。 */
export function HubOverlay({ api, label }: HubOverlayProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onToggle = (): void => { setOpen((value) => !value) }
    window.addEventListener(SKILL_MANAGER_TOGGLE_EVENT, onToggle)
    return () => { window.removeEventListener(SKILL_MANAGER_TOGGLE_EVENT, onToggle) }
  }, [])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [open])

  if (!open) return null

  return (
    <div
      style={overlayStyle}
      role='presentation'
      onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}
    >
      <section style={dialogStyle} role='dialog' aria-modal='true' aria-label={label}>
        <header style={headerStyle}>
          <IconSkillOutline16 size={16} />
          <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--dsw-alias-label-primary, inherit)' }}>{label}</span>
          <button type='button' style={closeStyle} aria-label='关闭' onClick={() => { setOpen(false) }}>×</button>
        </header>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <SkillHubPanel api={api} mode='sidebar' />
        </div>
      </section>
    </div>
  )
}
