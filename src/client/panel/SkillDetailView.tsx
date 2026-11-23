/**
 * Full-page skill detail view: metadata, upstream source card with
 * check/sync/follow-delete actions, and the raw SKILL.md body. Pure
 * presentation — every state value and action arrives as a prop, so the
 * panel stays the single owner of state.
 */

import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { marked } from 'marked'
import type { GroupsResponse, HubConfig, SkillDetail, SourceCheckResult, SourcesResponse } from '../../protocol.ts'
import { copyTextToClipboard, isDisplayNameDistinct, tt } from '../helpers.ts'
import { isProjectSource } from '../grouping.ts'
import { IconCopyOutline16 } from '../icons.tsx'
import css from './panel.module.css'
import { dotStyle, formatDateTime, shortSha } from './format.ts'
import { SourceStatusBadge } from './SourceStatusBadge.tsx'
import { sourceLabel } from './source-label.ts'

/** 不允许出现在渲染结果里的标签（marked 会原样放行 HTML）。 */
const DROPPED_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'button', 'svg', 'math', 'template'])
/** 只放行安全协议；`javascript:` / `data:` 一律清掉。 */
const SAFE_URL_RE = /^(https?:|mailto:|#|\/|\.)/i

/**
 * 把 marked 的输出过一遍浏览器解析树的清洗：丢掉危险标签、事件属性、
 * 内联样式与非安全链接。技能正文来自本机文件或下载的仓库技能，仍按
 * 不可信内容处理。
 */
function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const element of [...doc.body.querySelectorAll('*')]) {
    if (DROPPED_TAGS.has(element.tagName.toLowerCase())) { element.remove(); continue }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on') || name === 'style' || name === 'srcdoc') { element.removeAttribute(attribute.name); continue }
      if ((name === 'href' || name === 'src') && !SAFE_URL_RE.test(attribute.value.trim())) element.removeAttribute(attribute.name)
    }
  }
  return doc.body.innerHTML
}

/** SKILL.md 正文按 Markdown 渲染（标题/列表/代码块/表格），不再显示原始文本。 */
function MarkdownBody({ text }: { text: string }): JSX.Element {
  const html = useMemo(() => {
    try {
      return sanitizeHtml(marked.parse(text, { async: false, gfm: true }) as string)
    } catch {
      return ''
    }
  }, [text])
  return <div className={css.detailContent + ' ' + css.markdown} dangerouslySetInnerHTML={{ __html: html }} />
}

export interface SkillDetailViewProps {
  detail: SkillDetail
  hubConfig: HubConfig | null
  /** skillName → usage stat (count + last used). */
  uses: ReadonlyMap<string, { count: number; lastUsed?: number }>
  groupsState: GroupsResponse | null
  sourcesState: SourcesResponse | null
  sourceCheck: Readonly<Record<string, SourceCheckResult>>
  checkingSource: string | null
  syncingSource: string | null
  /** Whether the skill is currently hub-disabled (served from the .disabled file). */
  disabled?: boolean
  /** Re-enable a hub-disabled skill. */
  onEnable?: () => void
  onBack: () => void
  /** Render inside a modal shell instead of a full panel page. */
  modal?: boolean
  /** Check one source repo for upstream updates. */
  onCheck: (repo: string) => void
  /** Request syncing the skill (overwrites local edits; opens a confirm). */
  onSync: (repo: string, skills: string[]) => void
  /** Request following the upstream deletion (moves into the trash). */
  onFollowDelete: (repo: string, skills: string[]) => void
}

export function SkillDetailView(props: SkillDetailViewProps): JSX.Element {
  const { detail, hubConfig, uses, groupsState, sourcesState, sourceCheck, checkingSource, syncingSource, disabled, onEnable, onBack, onCheck, onSync, onFollowDelete, modal } = props
  // Project skills are never part of a tracked upstream source: a same-name
  // user skill must not leak its source card into the project detail page.
  const detailSource = detail.source !== undefined && isProjectSource(detail.source)
    ? undefined
    : sourcesState?.sources.find((source) => source.skills.includes(detail.name))
  const detailCheck = detailSource !== undefined ? sourceCheck[detailSource.repo] : undefined
  const [copied, setCopied] = useState<string | null>(null)
  const copyTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => { window.clearTimeout(copyTimer.current) }, [])
  const copyText = (text: string, key: string): void => {
    void copyTextToClipboard(text).then((ok) => {
      if (!ok) return
      setCopied(key)
      window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => { setCopied(null) }, 1200)
    })
  }
  return (
    <div className={css.panel + (modal === true ? ' ' + css.panelModal : '')}>
      <div className={css.detailHead}>
        {modal !== true ? <button type='button' className={css.back} onClick={onBack}>{tt('detail.back')}</button> : null}
        <span className={css.detailName + ' ' + css.detailNameWrap}>
          {detail.name}
          {isDisplayNameDistinct(detail.name, detail.displayName) ? <span className={css.displayName + ' ' + css.displayNameInline}>{detail.displayName}</span> : null}
          {detail.invocation.modelInvocable
            ? <span className={css.dot + ' ' + css.dotModel} style={dotStyle(hubConfig?.dotModelColor)} title={tt('legend.model')} />
            : detail.invocation.userInvocable
              ? <span className={css.dot + ' ' + css.dotUser} style={dotStyle(hubConfig?.dotUserColor)} title={tt('legend.user')} />
              : null}
          {/* 名称后的复制图标：复制 `/技能名`，粘贴到对话里可显式调用。 */}
          {detail.invocation.userInvocable ? (
            <button type='button' className={css.copyIcon} aria-label={tt('detail.copyMention')} title={tt('detail.copyMentionHint')} onClick={() => { copyText('/' + detail.name, 'name') }}>
              {copied === 'name' ? '✓' : <IconCopyOutline16 size={14} />}
            </button>
          ) : null}
        </span>
        <span className={css.actions + ' ' + css.detailActions}>
          {disabled === true && onEnable !== undefined ? <button type='button' className={css.opBtn} role='switch' aria-checked={false} aria-label={tt('row.enable')} onClick={onEnable}>{tt('row.enable')}</button> : null}
        </span>
        {modal === true ? <button type='button' className={css.detailClose} aria-label={tt('detail.close')} title={tt('detail.close')} onClick={onBack}>×</button> : null}
      </div>
      <div className={css.detailMeta}>
        <div className={css.detailMetaLine}>{tt('detail.provider')}: {detail.provider}</div>
        {detail.source !== undefined ? <div className={css.detailMetaLine}>{tt('detail.source')}: <span title={detail.source}>{sourceLabel(detail.source)}</span> <span className={css.detailSourceRaw}>({detail.source})</span></div> : null}
        {detail.addedAt !== undefined ? <div className={css.detailMetaLine}>{tt('detail.addedAt')}: {formatDateTime(detail.addedAt)}</div> : null}
        {detail.updatedAt !== undefined ? <div className={css.detailMetaLine}>{tt('detail.updatedAt')}: {formatDateTime(detail.updatedAt)}</div> : null}
        {detail.path !== undefined ? (
          <div className={css.detailMetaLine}>
            {tt('detail.path')}: {detail.path}
            <button type='button' className={css.copyIcon} aria-label={tt('detail.copyPath')} title={tt('detail.copyPath')} onClick={() => { const path = detail.path; if (path !== undefined) copyText(path, 'path') }}>
              {copied === 'path' ? '✓' : <IconCopyOutline16 size={13} />}
            </button>
          </div>
        ) : null}
        {detail.whenToUse !== undefined ? <div className={css.detailMetaLine}>{tt('detail.whenToUse')}: {detail.whenToUse}</div> : null}
        {detail.argumentHint !== undefined ? <div className={css.detailMetaLine}>{tt('detail.argumentHint')}: {detail.argumentHint}</div> : null}
        {(() => {
          const stat = uses.get(detail.name)
          if (stat === undefined || stat.count === 0) return null
          const at = stat.lastUsed !== undefined ? ' · ' + new Date(stat.lastUsed).toLocaleString() : ''
          return <div className={css.detailMetaLine}>{tt('detail.uses')}: {stat.count}{at}</div>
        })()}
        {(() => {
          const tags = (groupsState?.tags ?? []).filter((tag) => tag.skillNames.includes(detail.name)).map((tag) => tag.name)
          return tags.length > 0 ? <div className={css.detailMetaLine}>{tt('detail.groups')}: {tags.join(', ')}</div> : null
        })()}
      </div>
      {detailSource !== undefined ? (
        <div className={css.sourceCard}>
          <div className={css.sourceCardTitle}>
            <a className={css.sourceLink} href={'https://github.com/' + detailSource.repo} target='_blank' rel='noreferrer'>{detailSource.repo}</a>
            {detailSource.ref !== undefined ? <span className={css.badge + ' ' + css.badgeSource}>{detailSource.ref}</span> : null}
            <SourceStatusBadge check={detailCheck} />
          </div>
          <div className={css.detailMetaLine}>
            {tt('source.commit')}: {detailSource.commitSha === '' ? tt('source.unverified') : shortSha(detailSource.commitSha)}
          </div>
          <div className={css.buttons + ' ' + css.actionsTop}>
            <button type='button' className={css.opBtn} disabled={checkingSource !== null} onClick={() => { onCheck(detailSource.repo) }}>
              {checkingSource === detailSource.repo ? tt('source.checking') : tt('source.check')}
            </button>
            {disabled !== true ? (
              <>
                <button type='button' className={css.opBtn} disabled={syncingSource !== null} onClick={() => { onSync(detailSource.repo, [detail.name]) }}>
                  {syncingSource === detailSource.repo ? tt('source.syncing') : tt('source.sync')}
                </button>
                {detailCheck?.deleted.includes(detail.name) === true
                  ? <button type='button' className={css.opBtn + ' ' + css.opDanger} onClick={() => { onFollowDelete(detailSource.repo, [detail.name]) }}>{tt('source.followDelete')}</button>
                  : null}
              </>
            ) : null}
          </div>
        </div>
      ) : (
        <p className={css.hintLine}>{tt('source.private')}</p>
      )}
      <MarkdownBody text={detail.content} />
    </div>
  )
}
