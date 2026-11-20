/**
 * 技能库卡片网格 —— 参照 Skills Manager 的技能库界面：
 * 一张卡片一个技能，卡片上直接给出来源、启用开关与操作菜单。
 *
 * 与 Skills Manager 的差异（按本项目宿主能力裁剪）：
 *   - 没有「按 Agent 部署」那一层，dsh 只有自身的启用/停用；
 *   - 不区分 marketplace 安装量，来源只区分「个人」与「某个 Git 仓库」。
 */

import { useEffect, useMemo, useState, type CSSProperties, type JSX } from 'react'
import type { CatalogSkill, HubConfig } from '../../protocol.ts'
import { isDisplayNameDistinct } from '../helpers.ts'
import { dotStyle } from './format.ts'
import type { SkillHubState } from './useSkillHub.ts'

const GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
  gap: 10,
}

const CARD: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  minHeight: 118,
  padding: '12px 12px 10px',
  border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-l1, transparent)',
  cursor: 'pointer',
  textAlign: 'left',
  color: 'inherit',
  font: 'inherit',
}

const CARD_OFF: CSSProperties = { opacity: 0.55 }

const NAME: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  paddingRight: 34,
  fontSize: 13,
  fontWeight: 600,
}

const NAME_TEXT: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

const DESCRIPTION: CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  fontSize: 12,
  lineHeight: '17px',
  color: 'var(--dsw-alias-label-secondary, #666)',
}

const FOOTER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 'auto',
  fontSize: 11,
  color: 'var(--dsw-alias-label-tertiary, #888)',
}

const BADGE: CSSProperties = {
  maxWidth: 140,
  overflow: 'hidden',
  padding: '1px 6px',
  border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))',
  borderRadius: 999,
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const SWITCH: CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 10,
  display: 'inline-flex',
  alignItems: 'center',
  width: 28,
  height: 16,
  padding: 2,
  border: 'none',
  borderRadius: 999,
  background: 'var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.2))',
  cursor: 'pointer',
}

const SWITCH_ON: CSSProperties = { background: 'var(--dsw-alias-brand-primary, #2f6bff)' }

const THUMB: CSSProperties = {
  width: 12,
  height: 12,
  borderRadius: 999,
  background: '#fff',
  transition: 'transform 120ms ease',
}

const MENU_BUTTON: CSSProperties = {
  width: 22,
  height: 22,
  padding: 0,
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  lineHeight: 1,
}

const MENU: CSSProperties = {
  position: 'absolute',
  right: 8,
  bottom: 34,
  zIndex: 5,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 96,
  padding: 4,
  border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))',
  borderRadius: 8,
  background: 'var(--dsw-specific-menu, #fff)',
  boxShadow: '0 6px 20px rgba(0, 0, 0, 0.18)',
}

const MENU_ITEM: CSSProperties = {
  padding: '6px 8px',
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 12,
  textAlign: 'left',
}

interface SkillCardProps {
  skill: CatalogSkill
  origin?: string
  useCount: number
  hubConfig: HubConfig | null
  busy: boolean
  duplicate: boolean
  hub: SkillHubState
}

function SkillCard({ skill, origin, useCount, hubConfig, busy, duplicate, hub }: SkillCardProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  // 点击别处或按 Esc 关闭「⋯」菜单；菜单按钮与菜单本体已 stopPropagation，
  // 不会被这里误关。用 click 避免菜单项在 mousedown 阶段被卸载而点不动。
  useEffect(() => {
    if (!menuOpen) return
    const close = (): void => { setMenuOpen(false) }
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('click', close)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])
  const disabled = skill.modelOverride === true
  const dot = skill.invocation.modelInvocable
    ? <span style={{ width: 6, height: 6, borderRadius: 999, flex: 'none', ...dotStyle(hubConfig?.dotModelColor) }} title='模型可调' />
    : skill.invocation.userInvocable
      ? <span style={{ width: 3, height: 7, borderRadius: 999, flex: 'none', ...dotStyle(hubConfig?.dotUserColor) }} title='用户可调' />
      : null

  return (
    <div
      style={disabled ? { ...CARD, ...CARD_OFF } : CARD}
      role='button'
      tabIndex={0}
      onClick={() => { void hub.openDetail(skill.name, skill.workspace) }}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void hub.openDetail(skill.name, skill.workspace) } }}
    >
      <div style={NAME}>
        {dot}
        <span style={NAME_TEXT} title={skill.name}>{skill.name}</span>
        {duplicate ? <span style={{ ...BADGE, color: '#c0392b' }}>重名</span> : null}
        {isDisplayNameDistinct(skill.name, skill.displayName) ? <span style={{ ...BADGE, flex: 'none' }}>{skill.displayName}</span> : null}
      </div>
      <div style={DESCRIPTION}>{skill.shortDescription ?? skill.description}</div>
      <div style={FOOTER}>
        <span style={BADGE} title={origin ?? '个人'}>{origin ?? '个人'}</span>
        {useCount > 0 && hubConfig?.showUseCount !== false ? <span>{useCount} 次</span> : null}
        {skill.writable || skill.toggleable === true
          ? null
          : <span style={BADGE} title='来自其它 Agent 目录，本插件不能改写，只读展示'>只读</span>}
        {disabled ? <span style={BADGE}>已停用</span> : null}
        <span style={{ flex: 1 }} />
        <button
          type='button'
          style={MENU_BUTTON}
          aria-label='更多操作'
          aria-haspopup='menu'
          aria-expanded={menuOpen}
          onClick={(event) => { event.stopPropagation(); setMenuOpen((value) => !value) }}
        >⋯</button>
      </div>

      {skill.writable || skill.toggleable === true ? (
        <button
          type='button'
          role='switch'
          aria-checked={!disabled}
          aria-label={disabled ? '启用 skills' : '停用 skills'}
          title={disabled ? '启用 skills' : '停用 skills'}
          disabled={busy}
          style={disabled ? SWITCH : { ...SWITCH, ...SWITCH_ON }}
          onClick={(event) => { event.stopPropagation(); void hub.toggle(skill, disabled) }}
        >
          <span style={{ ...THUMB, transform: disabled ? 'translateX(0)' : 'translateX(12px)' }} />
        </button>
      ) : null}

      {menuOpen ? (
        <div style={MENU} role='menu' onClick={(event) => { event.stopPropagation() }}>
          <button type='button' role='menuitem' style={MENU_ITEM} onClick={() => { setMenuOpen(false); void hub.openDetail(skill.name, skill.workspace) }}>详情</button>
          {skill.writable || skill.toggleable === true ? (
            <button type='button' role='menuitem' style={MENU_ITEM} disabled={busy} onClick={() => { setMenuOpen(false); void hub.toggle(skill, disabled) }}>{disabled ? '启用' : '停用'}</button>
          ) : null}
          {skill.writable ? (
            <button type='button' role='menuitem' style={{ ...MENU_ITEM, color: '#c0392b' }} disabled={busy} onClick={() => { setMenuOpen(false); hub.requestDeleteSkill(skill.name) }}>删除</button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** 技能库主页：所有本地技能（自建 / 导入 / 仓库下载）以卡片网格呈现。 */
export function LibraryView({ hub }: { hub: SkillHubState }): JSX.Element {
  const skills = useMemo(
    () => hub.sorted.filter((skill) => !skill.source.startsWith('project-')),
    [hub.sorted],
  )
  const duplicates = useMemo(() => new Set(hub.catalog?.duplicateNames ?? []), [hub.catalog])
  if (skills.length === 0) return <div />
  return (
    <div style={GRID}>
      {skills.map((skill) => (
        <SkillCard
          key={skill.name}
          skill={skill}
          origin={hub.origins[skill.name]}
          useCount={hub.uses.get(skill.name)?.count ?? 0}
          hubConfig={hub.hubConfig}
          busy={hub.busyNames.has(skill.name)}
          duplicate={duplicates.has(skill.name)}
          hub={hub}
        />
      ))}
    </div>
  )
}
