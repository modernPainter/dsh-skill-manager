/**
 * 轻提示：浮在面板底部居中，不占布局，几秒后自动消失。
 * 成功类结果（保存、同步、安装）用它；需要用户处理的错误仍走横幅。
 */

import { useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'

export interface ToastProps {
  /** 提示文案；null 表示不显示。 */
  message: string | null
  /** 自动消失或点关闭时调用，父组件据此清空 message。 */
  onDone: () => void
  /** 停留毫秒数；不传时按文案长度自适应。 */
  durationMs?: number
}

const wrapStyle: CSSProperties = {
  position: 'fixed',
  left: '50%',
  top: 16,
  transform: 'translateX(-50%)',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  maxWidth: 'min(560px, calc(100vw - 32px))',
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid #2e7d32',
  background: '#e8f5e9',
  color: '#1b5e20',
  boxShadow: '0 6px 20px rgba(0, 0, 0, 0.18)',
  fontSize: 13,
  lineHeight: '18px',
  zIndex: 90,
  pointerEvents: 'auto',
}

const closeStyle: CSSProperties = {
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  fontSize: 15,
  lineHeight: 1,
  color: 'inherit',
  opacity: 0.6,
  padding: 0,
}

export function Toast(props: ToastProps): React.JSX.Element | null {
  // 回调随父组件每次渲染更新，用 ref 持有最新引用，避免计时器被重置。
  const doneRef = useRef(props.onDone)
  doneRef.current = props.onDone
  const duration = props.durationMs ?? Math.min(6000, 2000 + (props.message?.length ?? 0) * 60)

  useEffect(() => {
    if (props.message === null) return
    const timer = window.setTimeout(() => { doneRef.current() }, duration)
    return () => { window.clearTimeout(timer) }
  }, [props.message, duration])

  if (props.message === null) return null
  return (
    <div style={wrapStyle} role='status' aria-live='polite'>
      <span aria-hidden='true'>✓</span>
      <span>{props.message}</span>
      <button type='button' style={closeStyle} aria-label='关闭提示' onClick={() => { doneRef.current() }}>×</button>
    </div>
  )
}
