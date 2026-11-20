/**
 * 「我的仓库」管理视图。
 *
 * 自包含实现（inline styles）：不改动既有 panel.module.css，也不依赖
 * SkillHub 既有的角色（role）语义，因此单独成页。
 *
 * 交互约定：所有危险操作（删除仓库、覆盖安装）都要经过二次确认；
 * 批量结果逐项反馈（成功/跳过/失败）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitRepoSource, RepoSkillManifestEntry } from '../../protocol.ts'
import { errorMessage } from '../helpers.ts'
import { Toast } from './Toast.tsx'
import { IconChevronDownOutline14, IconScanOutline16 } from '../icons.tsx'
import {
  managerApi,
  type InstallProgress,
  type PublicSkillEntry,
} from '../manager-api.ts'

export interface ManagerViewProps {
  /** 当前已安装 skills 名，用于上传的选择器。 */
  skills: string[]
  /** 安装成功后刷新目录。 */
  onChanged: () => void
  /** 仓库区标题行右侧的操作（导入入口由上层传入）。 */
  actions?: React.ReactNode
}

interface PendingConfirm {
  title: string
  message: string
  confirmLabel: string
  run: () => Promise<void>
}

/** 后端类型 → 界面文案（原始值如 codeup 对用户没有意义）。 */
const BACKEND_LABELS: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  gitea: 'Gitea',
  codeup: '云效 Codeup',
  generic: '通用 Git',
}

function backendLabel(backend: string | undefined): string {
  if (backend === undefined) return '未知'
  return BACKEND_LABELS[backend] ?? backend
}

/** 展示用仓库名：云效 slug 带一串组织 ID，界面上只保留「项目组/仓库」。 */
function repoDisplayName(slug: string): string {
  const parts = slug.split('/')
  return parts.length >= 3 ? parts.slice(-2).join('/') : slug
}

/** 令牌标签按仓库域名生成，避免把令牌内容当标签展示。 */
function authLabelFor(repoUrl: string): string {
  const value = repoUrl.trim()
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : 'https://' + value).hostname
  } catch {
    return '个人访问令牌'
  }
}

const box: React.CSSProperties = { border: '1px solid var(--dsh-border, #d9d9d9)', borderRadius: 8, padding: 12, marginBottom: 12 }
const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
const input: React.CSSProperties = { padding: '6px 8px', border: '1px solid var(--dsh-border, #d9d9d9)', borderRadius: 6, fontSize: 13, minWidth: 180 }
const button: React.CSSProperties = { padding: '5px 10px', border: '1px solid var(--dsh-border, #d9d9d9)', borderRadius: 6, background: 'transparent', cursor: 'pointer', fontSize: 13 }
const primary: React.CSSProperties = { ...button, borderColor: 'var(--dsh-accent, #3b82f6)', color: 'var(--dsh-accent, #3b82f6)' }
/** 带图标的小按钮：图标与文字垂直居中，间距 4px。 */
const buttonWithIcon: React.CSSProperties = { ...button, display: 'inline-flex', alignItems: 'center', gap: 4 }
const danger: React.CSSProperties = { ...button, borderColor: '#d9534f', color: '#d9534f' }
const muted: React.CSSProperties = { fontSize: 12, opacity: 0.7 }
const list: React.CSSProperties = { listStyle: 'none', margin: 0, padding: 0 }
const item: React.CSSProperties = { ...box, marginBottom: 8 }
const banner: React.CSSProperties = { ...box, borderColor: '#d9534f', color: '#a12f2b' }
/** 扫描结果卡片网格：一个 skills 一张卡，点卡片上的「安装」即装到本地 skills 库。 */
const cardGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, marginTop: 10 }
const card: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  minHeight: 110,
  padding: 10,
  border: '1px solid var(--dsh-border, #d9d9d9)',
  borderRadius: 10,
}
const badge: React.CSSProperties = {
  padding: '0 6px',
  border: '1px solid var(--dsh-border, #d9d9d9)',
  borderRadius: 999,
  fontSize: 11,
  opacity: 0.8,
}
const desc: React.CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  fontSize: 12,
  lineHeight: '17px',
  opacity: 0.75,
}
const path: React.CSSProperties = { fontSize: 11, opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

export function ManagerView(props: ManagerViewProps): React.JSX.Element {
  const [repos, setRepos] = useState<GitRepoSource[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  /** 云效公共技能库：进页面即拉取，不需要刷新按钮。 */
  const [publicSkills, setPublicSkills] = useState<PublicSkillEntry[]>([])
  const [publicMeta, setPublicMeta] = useState<{ ref: string; fileCount: number } | null>(null)
  const [publicLoading, setPublicLoading] = useState(true)
  const [publicError, setPublicError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      const payload = await managerApi.listRepos()
      setRepos(payload.repos)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const payload = await managerApi.listPublicSkills()
        if (cancelled) return
        setPublicSkills(payload.skills)
        setPublicMeta({ ref: payload.ref, fileCount: payload.fileCount })
        setPublicError(null)
      } catch (caught) {
        if (!cancelled) setPublicError('云效公共技能库加载失败：' + errorMessage(caught))
      } finally {
        if (!cancelled) setPublicLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const run = async (label: string, action: () => Promise<string | void>): Promise<void> => {
    setBusy(label)
    setError(null)
    setNotice(null)
    try {
      const message = await action()
      if (typeof message === 'string') setNotice(message)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(null)
    }
  }

  const confirm = (spec: PendingConfirm): void => setPending(spec)

  return (
    <div>
      <div style={{ ...row, marginBottom: 12, justifyContent: 'space-between' }}>
        <span style={muted}>管理自有 Git skills 仓库：扫描、安装与上传</span>
        {props.actions ?? null}
      </div>

      {error !== null || publicError !== null ? <div style={banner} role='alert'>{error ?? publicError}</div> : null}
      <Toast message={notice} onDone={() => { setNotice(null) }} />

      <PublicSkillsSection
        skills={publicSkills}
        meta={publicMeta}
        loading={publicLoading}
        installedNames={props.skills}
        busy={busy}
        run={run}
        confirm={confirm}
        onChanged={props.onChanged}
      />

      <ReposSection
        repos={repos}
        skills={props.skills}
        busy={busy}
        onRefresh={refresh}
        onChanged={props.onChanged}
        run={run}
        confirm={confirm}
      />

      {pending !== null ? (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}>
          <div style={{ background: 'var(--dsh-bg, #fff)', borderRadius: 10, padding: 18, width: 420, maxWidth: '90vw' }} role='dialog' aria-modal='true'>
            <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>{pending.title}</h3>
            <p style={{ margin: '0 0 16px', fontSize: 13, lineHeight: 1.6 }}>{pending.message}</p>
            <div style={{ ...row, justifyContent: 'flex-end' }}>
              <button type='button' style={button} onClick={() => { setPending(null) }}>取消</button>
              <button
                type='button'
                style={danger}
                onClick={() => {
                  const action = pending.run
                  setPending(null)
                  void action()
                }}
              >{pending.confirmLabel}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ───────────────────────────────────────────────────────────── 公共技能库

interface PublicSectionProps {
  skills: PublicSkillEntry[]
  meta: { ref: string; fileCount: number } | null
  loading: boolean
  /** 本地已安装的 skills 名（与仓库区共用同一份）。 */
  installedNames: string[]
  busy: string | null
  run: SectionProps['run']
  confirm: SectionProps['confirm']
  onChanged: () => void
}

/** 云效公共技能库：列表只读，安装复用仓库的落盘语义（覆盖前二次确认）。 */
function PublicSkillsSection(props: PublicSectionProps): React.JSX.Element {
  const install = async (entry: PublicSkillEntry, installed: boolean): Promise<void> => {
    const action = async (): Promise<string> => {
      const result = await managerApi.installPublicSkill(entry.name, installed)
      if (result.status !== 'installed') throw new Error(result.error ?? '安装失败')
      props.onChanged()
      return '已安装 ' + result.name
    }
    const label = 'public-install:' + entry.name
    if (!installed) {
      await props.run(label, action)
      return
    }
    props.confirm({
      title: '覆盖安装 ' + entry.name,
      message: `本地已存在同名 skills「${entry.name}」，将从云效公共技能库重新安装并覆盖（原版本进回收站）。`,
      confirmLabel: '覆盖安装',
      run: async () => { await props.run(label, action) },
    })
  }

  return (
    <section style={box}>
      <div style={{ ...row, marginBottom: 4 }}>
        <strong>云效公共技能库</strong>
        <span style={muted}>
          {props.meta !== null ? `${props.meta.ref} · ${props.meta.fileCount} 个文件 · ${props.skills.length} 个技能` : '加载中…'}
        </span>
      </div>
      {props.loading ? <p style={muted}>正在加载云效公共技能库…</p> : null}
      {!props.loading && props.skills.length === 0 ? <p style={muted}>公共技能库暂无可用技能。</p> : null}
      {props.skills.length > 0 ? (
        <div style={cardGrid}>
          {props.skills.map((entry) => {
            const installed = props.installedNames.includes(entry.name)
            return (
              <div key={entry.name} style={card}>
                <div style={{ ...row, gap: 6 }}>
                  <strong style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</strong>
                  {installed ? <span style={badge}>已安装</span> : null}
                </div>
                <div style={desc}>来自云效公共技能库</div>
                <div style={path} title={entry.path}>{entry.path}</div>
                <div style={{ ...row, gap: 6, marginTop: 'auto' }}>
                  <button
                    type='button'
                    style={primary}
                    disabled={props.busy !== null}
                    onClick={() => { void install(entry, installed) }}
                  >{installed ? '重新安装' : '安装'}</button>
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}

// ───────────────────────────────────────────────────────────── 仓库区

interface SectionProps {
  repos: GitRepoSource[]
  skills: string[]
  busy: string | null
  onRefresh: () => Promise<void>
  onChanged: () => void
  run: (label: string, action: () => Promise<string | void>) => Promise<void>
  confirm: (spec: PendingConfirm) => void
}

function ReposSection(props: SectionProps): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [branch, setBranch] = useState('')
  const [token, setToken] = useState('')
  /** 低频字段（分支、令牌）收进「高级选项」，默认只露仓库地址。 */
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const [activeSlug, setActiveSlug] = useState<string | null>(null)
  const [scan, setScan] = useState<{ skills: readonly RepoSkillManifestEntry[]; commitSha: string; ref: string; source: string } | null>(null)
  const [overwrite, setOverwrite] = useState(false)
  const [allowLocalOverwrite, setAllowLocalOverwrite] = useState(false)
  const [installProgress, setInstallProgress] = useState<InstallProgress | null>(null)
  const pollTimer = useRef<number | null>(null)

  const [uploadSlug, setUploadSlug] = useState('')
  const [uploadNames, setUploadNames] = useState<Set<string>>(new Set())
  const [uploadDir, setUploadDir] = useState('skills')

  useEffect(() => () => { if (pollTimer.current !== null) window.clearInterval(pollTimer.current) }, [])

  const activeRepo = props.repos.find((repo) => repo.slug === activeSlug)

  const addRepo = async (): Promise<string> => {
    if (url.trim() === '') throw new Error('请填写仓库 URL')
    let authId: string | undefined
    if (token.trim() !== '') {
      const created = await managerApi.addAuth(authLabelFor(url), token.trim())
      authId = created.auth.id
      setToken('')
    }
    await managerApi.addRepo({
      url: url.trim(),
      ...(authId !== undefined ? { authId } : {}),
      ...(branch.trim() !== '' ? { defaultBranch: branch.trim() } : {}),
    })
    setUrl('')
    await props.onRefresh()
    return '仓库已保存'
  }

  const doScan = async (repo: GitRepoSource): Promise<void> => {
    setActiveSlug(repo.slug)
    setScan(null)
    const result = await managerApi.scanRepo(repo.slug)
    setScan({ skills: result.skills, commitSha: result.commitSha, ref: result.ref, source: repo.slug })
    await props.onRefresh()
  }

  /** 安装指定的 skills 集合；单张卡片安装与「全部安装」共用这条路径。 */
  const startInstall = async (names: string[]): Promise<void> => {
    if (activeRepo === undefined || scan === null || names.length === 0) return
    const job = await managerApi.install({
      slug: activeRepo.slug,
      ref: scan.ref,
      names,
      ...(overwrite ? { overwrite: true } : { allowLocalOverwrite }),
    })
    setInstallProgress({
      ok: true,
      jobId: job.jobId,
      status: 'running',
      total: job.total,
      done: 0,
      installed: [],
      skipped: [],
      failed: [],
      overwritten: [],
    })
    if (pollTimer.current !== null) window.clearInterval(pollTimer.current)
    pollTimer.current = window.setInterval(() => {
      void (async () => {
        try {
          const progress = await managerApi.installProgress(job.jobId)
          setInstallProgress(progress)
          if (progress.status !== 'running') {
            if (pollTimer.current !== null) window.clearInterval(pollTimer.current)
            pollTimer.current = null
            if (progress.installed.length > 0) props.onChanged()
          }
        } catch (caught) {
          if (pollTimer.current !== null) window.clearInterval(pollTimer.current)
          pollTimer.current = null
          setInstallProgress((previous) => previous === null ? previous : { ...previous, status: 'error', error: errorMessage(caught) })
        }
      })()
    }, 700)
  }

  const doUpload = async (): Promise<string> => {
    if (uploadSlug === '') throw new Error('请选择目标仓库')
    if (uploadNames.size === 0) throw new Error('请选择要上传的 skills')
    const result = await managerApi.upload({
      slug: uploadSlug,
      names: [...uploadNames],
      ...(uploadDir.trim() !== '' ? { dir: uploadDir.trim() } : {}),
    })
    const rejected = result.rejected.length > 0
      ? '；被拒绝：' + result.rejected.map((entry) => entry.name + '（' + entry.reason + '）').join('、')
      : ''
    return `已推送 ${result.uploaded.length} 个 skills 到 ${result.branch} @ ${result.commitSha.slice(0, 8)}${rejected}`
  }

  return (
    <div>
      <section style={box}>
        <strong style={{ display: 'block', marginBottom: 8 }}>添加仓库</strong>
        <div style={{ ...row, marginBottom: advancedOpen ? 8 : 0 }}>
          <input style={{ ...input, flex: 1, minWidth: 260 }} placeholder='粘贴仓库地址，如 https://github.com/anthropics/skills' value={url} onChange={(event) => { setUrl(event.target.value) }} />
          <button type='button' style={primary} disabled={props.busy !== null} onClick={() => { void props.run('add-repo', addRepo) }}>保存</button>
          <button type='button' style={buttonWithIcon} onClick={() => { setAdvancedOpen((value) => !value) }}>
            <span style={{ display: 'inline-flex', transform: advancedOpen ? 'rotate(180deg)' : 'none', transition: 'transform 120ms ease' }}>
              <IconChevronDownOutline14 />
            </span>
            {advancedOpen ? '收起高级选项' : '高级选项'}
          </button>
        </div>
        {advancedOpen ? (
          <>
            <div style={{ ...row, marginBottom: 8 }}>
              <input style={input} placeholder='默认分支（main）' value={branch} onChange={(event) => { setBranch(event.target.value) }} />
            </div>
            <div style={{ ...row, marginBottom: 8 }}>
              <input
                style={{ ...input, flex: 1, minWidth: 260 }}
                type='password'
                placeholder='HTTPS Token（可选，仅存本机，不会回显）'
                value={token}
                onChange={(event) => { setToken(event.target.value) }}
              />
            </div>
          </>
        ) : null}
        <p style={muted}>支持 GitHub / GitLab / Gitea / 云效 Codeup；仓库根目录可含 skill-manifest.json，缺失时自动扫描目录。</p>
      </section>

      {props.repos.length === 0 ? <div style={box}>还没有配置仓库。添加后即可扫描、下载、上传 skills。</div> : null}

      <ul style={list}>
        {props.repos.map((repo) => (
          <li key={repo.slug} style={item}>
            <div style={row}>
              <strong title={repo.slug}>{repoDisplayName(repo.slug)}</strong>
              <span style={muted}>{backendLabel(repo.backend)} · {repo.defaultBranch}</span>
              {repo.lastCheckedAt !== undefined ? <span style={muted}>最近扫描 {new Date(repo.lastCheckedAt).toLocaleString()}</span> : null}
              <span style={{ flex: 1 }} />
              <button type='button' style={button} disabled={props.busy !== null} onClick={() => { void props.run('test:' + repo.slug, async () => {
                const result = await managerApi.testRepo(repo.slug)
                return result.ok ? `连接正常（${backendLabel(result.backend ?? repo.backend)}，默认分支 ${result.defaultBranch ?? repo.defaultBranch}）` : '连接失败：' + (result.error ?? '未知原因')
              }) }}>测试连接</button>
              <button type='button' style={buttonWithIcon} disabled={props.busy !== null} onClick={() => { void props.run('scan:' + repo.slug, async () => { await doScan(repo); return undefined }) }}>
                <IconScanOutline16 size={14} />扫描
              </button>
              <button type='button' style={danger} disabled={props.busy !== null} onClick={() => {
                props.confirm({
                  title: '删除仓库配置',
                  message: `将移除 ${repoDisplayName(repo.slug)} 的连接配置（不会删除已安装的 skills，也不会改动远端仓库）。`,
                  confirmLabel: '删除',
                  run: async () => { await props.run('delete:' + repo.slug, async () => { await managerApi.deleteRepo(repo.slug); await props.onRefresh(); return '仓库已删除' }) },
                })
              }}>删除</button>
            </div>
          </li>
        ))}
      </ul>

      {scan !== null ? (
        <section style={box}>
          <div style={row}>
            <strong>扫描结果 · {repoDisplayName(scan.source)}</strong>
            <span style={muted}>{scan.ref} @ {scan.commitSha.slice(0, 8)} · {scan.skills.length} 个 skills</span>
            <span style={{ flex: 1 }} />
            <label style={muted}><input type='checkbox' checked={overwrite} onChange={(event) => { setOverwrite(event.target.checked) }} /> 覆盖已存在</label>
            {overwrite ? <label style={muted}><input type='checkbox' checked={allowLocalOverwrite} onChange={(event) => { setAllowLocalOverwrite(event.target.checked) }} /> 允许覆盖本地修改</label> : null}
            <button
              type='button'
              style={primary}
              disabled={props.busy !== null || scan.skills.length === 0 || installProgress?.status === 'running'}
              onClick={() => {
                props.confirm({
                  title: '安装全部 skills',
                  message: `从 ${repoDisplayName(scan.source)} 安装 ${scan.skills.length} 个 skills；同名 skills${overwrite ? '将被覆盖（原版本进回收站）' : '会被跳过'}。`,
                  confirmLabel: '开始安装',
                  run: async () => { await props.run('install', async () => { await startInstall(scan.skills.map((entry) => entry.name)) }) },
                })
              }}
            >全部安装</button>
          </div>

          {scan.skills.length === 0 ? <p style={muted}>该分支下没有发现 skills 目录（需要 `&lt;name&gt;/SKILL.md` 或 manifest 条目）。</p> : null}
          <div style={cardGrid}>
            {scan.skills.map((entry) => {
              const installed = props.skills.includes(entry.name)
              return (
                <div key={entry.name} style={card}>
                  <div style={{ ...row, gap: 6 }}>
                    <strong style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</strong>
                    {entry.version !== undefined ? <span style={badge}>v{entry.version}</span> : null}
                    {installed ? <span style={badge}>已安装</span> : null}
                  </div>
                  <div style={desc}>{entry.description ?? '（manifest 未提供描述）'}</div>
                  <div style={path} title={entry.path}>{entry.path}</div>
                  <div style={{ ...row, gap: 6, marginTop: 'auto' }}>
                    <button
                      type='button'
                      style={primary}
                      disabled={props.busy !== null || installProgress?.status === 'running'}
                      onClick={() => {
                        props.confirm({
                          title: '安装 skills ' + entry.name,
                          message: `从 ${repoDisplayName(scan.source)} 安装 ${entry.name}${installed ? (overwrite ? '，覆盖本地同名 skills（原版本进回收站）' : '，本地已存在，将跳过') : ''}。`,
                          confirmLabel: '安装',
                          run: async () => { await props.run('install:' + entry.name, async () => { await startInstall([entry.name]) }) },
                        })
                      }}
                    >{installed && !overwrite ? '已安装' : '安装'}</button>
                  </div>
                </div>
              )
            })}
          </div>

          {installProgress !== null ? (
            <div style={{ marginTop: 10 }}>
              <div style={muted}>
                {installProgress.status === 'running'
                  ? `安装中 ${installProgress.done}/${installProgress.total}${installProgress.current !== undefined ? ' · ' + installProgress.current : ''}`
                  : `安装结束：成功 ${installProgress.installed.length}，跳过 ${installProgress.skipped.length}，失败 ${installProgress.failed.length}`}
                {installProgress.error !== undefined ? ' · ' + installProgress.error : ''}
              </div>
              {installProgress.skipped.length > 0 ? <div style={muted}>跳过：{installProgress.skipped.map((entry) => entry.name + '（' + entry.reason + '）').join('、')}</div> : null}
              {installProgress.failed.length > 0 ? <div style={{ ...muted, color: '#a12f2b' }}>失败：{installProgress.failed.map((entry) => entry.name + '（' + entry.error + '）').join('、')}</div> : null}
            </div>
          ) : null}
        </section>
      ) : null}

      <section style={box}>
        <strong style={{ display: 'block', marginBottom: 8 }}>上传本地 skills 到仓库</strong>
        <div style={{ ...row, marginBottom: 8 }}>
          <select style={input} value={uploadSlug} onChange={(event) => { setUploadSlug(event.target.value) }}>
            <option value=''>选择目标仓库</option>
            {props.repos.map((repo) => <option key={repo.slug} value={repo.slug}>{repoDisplayName(repo.slug)}</option>)}
          </select>
          <input style={input} placeholder='仓库内目录（skills）' value={uploadDir} onChange={(event) => { setUploadDir(event.target.value) }} />
          <button type='button' style={primary} disabled={props.busy !== null || uploadNames.size === 0} onClick={() => {
            props.confirm({
              title: '推送 skills 到仓库',
              message: `将 ${uploadNames.size} 个本地 skills 推送到所选仓库（上传前会做内容审计，命中阻断规则会被拒绝）。`,
              confirmLabel: '推送',
              run: async () => { await props.run('upload', doUpload) },
            })
          }}>推送 {uploadNames.size} 个</button>
        </div>
        <div style={{ ...row, maxHeight: 180, overflow: 'auto' }}>
          {props.skills.length === 0 ? <span style={muted}>没有可上传的本地 skills。</span> : props.skills.map((name) => (
            <label key={name} style={{ ...muted, fontSize: 12 }}>
              <input
                type='checkbox'
                checked={uploadNames.has(name)}
                onChange={(event) => {
                  setUploadNames((previous) => {
                    const next = new Set(previous)
                    if (event.target.checked) next.add(name)
                    else next.delete(name)
                    return next
                  })
                }}
              /> {name}
            </label>
          ))}
        </div>
      </section>
    </div>
  )
}
