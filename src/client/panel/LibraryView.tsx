/** 技能库卡片网格 —— 参照 Skills Manager 的技能库界面：
 * 一张卡片一个技能，紧凑网格。
 *
 * 与 Skills Manager 的差异（按本项目宿主能力裁剪）：
 *   - 没有「按 Agent 部署」那一层，也不提供启用/停用（用户反馈不需要）；
 *   - 不区分 marketplace 安装量，来源只区分「个人」与「某个 Git 仓库」。
 */

import { useMemo, type CSSProperties, type JSX } from 'react'
import type { CatalogSkill, HubConfig } from '../../protocol.ts'
import { isDisplayNameDistinct } from '../helpers.ts'
import { dotStyle } from './format.ts'
import type { SkillHubState } from './useSkillHub.ts'

const GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
  gap: 8,
}

const CARD: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  minHeight: 78,
  padding: '8px 10px 6px',
  border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-l1, transparent)',
  cursor: 'pointer',
  textAlign: 'left',
  color: 'inherit',
  font: 'inherit',
}

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
  lineHeight: '15px',
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

const DELETE_BUTTON: CSSProperties = {
  padding: '2px 6px',
  border: '1px solid rgba(192, 57, 43, 0.4)',
  borderRadius: 6,
  background: 'transparent',
  color: '#c0392b',
  cursor: 'pointer',
  fontSize: 11,
  lineHeight: 1.3,
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
  const dot = skill.invocation.modelInvocable
    ? <span style={{ width: 6, height: 6, borderRadius: 999, flex: 'none', ...dotStyle(hubConfig?.dotModelColor) }} title='模型可调' />
    : skill.invocation.userInvocable
      ? <span style={{ width: 3, height: 7, borderRadius: 999, flex: 'none', ...dotStyle(hubConfig?.dotUserColor) }} title='用户可调' />
      : null

  return (
    <div
      style={CARD}
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
        {skill.writable
          ? null
          : <span style={BADGE} title='来自其它 Agent 目录，本插件不能改写，只读展示'>只读</span>}
        <span style={{ flex: 1 }} />
        {skill.writable
          ? <button type='button' style={DELETE_BUTTON} disabled={busy} onClick={(event) => { event.stopPropagation(); hub.requestDeleteSkill(skill.name) }}>删除</button>
          : null}
      </div>
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
