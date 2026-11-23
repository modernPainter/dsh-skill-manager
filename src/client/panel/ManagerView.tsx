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

/** 安装动画的 keyframes，只注入一次。 */
const INSTALL_ANIM_STYLE = `
@keyframes dsh-spin { to { transform: rotate(360deg); } }
@keyframes dsh-install-flash {
  0% { box-shadow: 0 0 0 0 rgba(34,197,94,0.35); border-color: var(--dsh-border, #d9d9d9); }
  40% { box-shadow: 0 0 0 4px rgba(34,197,94,0.2); border-color: #22c55e; }
  100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); border-color: var(--dsh-border, #d9d9d9); }
}
.dsh-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: dsh-spin 0.7s linear infinite;
  vertical-align: middle;
}
.dsh-install-flash {
  animation: dsh-install-flash 0.9s ease-out;
}
`
let installAnimInjected = false

export interface ManagerViewProps {
  /** 当前已安装 skills 名。 */
  skills: string[]
  /** 有本地文件、可上传到仓库的技能名（运行时技能不在其中）。 */
  uploadableSkills: string[]
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
/** 不可用的主按钮：真正置灰，避免只有 disabled 属性但仍显示强调色。 */
const primaryDisabled: React.CSSProperties = { ...primary, borderColor: 'var(--dsh-border, #d9d9d9)', color: 'rgba(0,0,0,0.3)', cursor: 'not-allowed', opacity: 0.7 }
/** 卡片上的轻量按钮：灰边框、深灰字，默认低调；hover 时再显亮色。 */
const ghostCardBtn: React.CSSProperties = {
  padding: '3px 8px',
  border: '1px solid rgba(0,0,0,0.15)',
  borderRadius: 6,
  background: 'transparent',
  color: 'rgba(0,0,0,0.65)',
  cursor: 'pointer',
  fontSize: 12,
  lineHeight: 1.3,
}
/** 带图标的小按钮：图标与文字垂直居中，间距 4px。 */
const buttonWithIcon: React.CSSProperties = { ...button, display: 'inline-flex', alignItems: 'center', gap: 4 }
const danger: React.CSSProperties = { ...button, borderColor: '#d9534f', color: '#d9534f' }
const muted: React.CSSProperties = { fontSize: 12, opacity: 0.7 }
const list: React.CSSProperties = { listStyle: 'none', margin: 0, padding: 0 }
const item: React.CSSProperties = { ...box, marginBottom: 8 }
/** 扫描结果卡片网格：一个 skills 一张卡，紧凑高度。 */
const cardGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8, marginTop: 10 }
const card: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  minHeight: 78,
  padding: '8px 10px 6px',
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

/**
 * 云效公共技能库的持久化缓存：
 *   - 只在首次进入、本地完全没有缓存时自动拉取一次；
 *   - 刷新页面 / 切换页签 / 重启服务都直接复用缓存，不再自动请求；
 *   - 只有「更新」按钮才会重新拉取并覆盖缓存。
 */
const PUBLIC_CACHE_KEY = 'dsh-skill-manager:public-skills-cache'
interface PublicSkillsCache {
  skills: PublicSkillEntry[]
  meta: { ref: string; fileCount: number }
  atMs: number
}
function loadPublicCache(): PublicSkillsCache | null {
  try {
    const raw = localStorage.getItem(PUBLIC_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PublicSkillsCache
    if (!parsed.skills || !parsed.meta || typeof parsed.atMs !== 'number') return null
    return parsed
  } catch { return null }
}
function savePublicCache(cache: PublicSkillsCache): void {
  try { localStorage.setItem(PUBLIC_CACHE_KEY, JSON.stringify(cache)) } catch { /* quota / 禁用 storage 时静默跳过 */ }
}

export function ManagerView(props: ManagerViewProps): React.JSX.Element {
  const [repos, setRepos] = useState<GitRepoSource[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  /** 从 localStorage 取初始缓存；没有时才处于 loading 态等待首次自动拉取。 */
  const initialCache = loadPublicCache()
  const [publicSkills, setPublicSkills] = useState<PublicSkillEntry[]>(() => initialCache?.skills ?? [])
  const [publicMeta, setPublicMeta] = useState<{ ref: string; fileCount: number } | null>(() => initialCache?.meta ?? null)
  const [publicLoading, setPublicLoading] = useState(initialCache === null)
  const [publicError, setPublicError] = useState<string | null>(null)
  const [publicUpdatedAt, setPublicUpdatedAt] = useState<Date | null>(() => initialCache ? new Date(initialCache.atMs) : null)

  const loadPublicSkills = useCallback(async (announce = false): Promise<void> => {
    setPublicLoading(true)
    setPublicError(null)
    // 加载过程本身也用轻提示，不占列表布局。
    setNotice('正在加载云效公共技能库…')
    try {
      const payload = await managerApi.listPublicSkills()
      const meta = { ref: payload.ref, fileCount: payload.fileCount }
      const atMs = Date.now()
      savePublicCache({ skills: payload.skills, meta, atMs })
      setPublicSkills(payload.skills)
      setPublicMeta(meta)
      setPublicUpdatedAt(new Date(atMs))
      // 手动「更新」才有完成提示；首次自动加载成功后安静收起。
      setNotice(announce ? '云效公共技能库已更新，共 ' + payload.skills.length + ' 个技能' : null)
    } catch (caught) {
      setNotice(null)
      setPublicError('云效公共技能库加载失败：' + errorMessage(caught))
    } finally {
      setPublicLoading(false)
    }
  }, [])

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
  // 本地完全没有缓存（首次进入）才自动拉取一次；之后都由「更新」按钮触发。
  const didAutoFetchRef = useRef(initialCache !== null)
  useEffect(() => {
    if (didAutoFetchRef.current) return
    didAutoFetchRef.current = true
    void loadPublicSkills()
  }, [loadPublicSkills])

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

      <Toast message={notice} onDone={() => { setNotice(null) }} />
      <Toast
        message={error ?? publicError}
        tone='error'
        onDone={() => { setError(null); setPublicError(null) }}
      />

      <PublicSkillsSection
        skills={publicSkills}
        meta={publicMeta}
        loading={publicLoading}
        loadingError={publicError}
        updatedAt={publicUpdatedAt}
        onUpdate={() => { void loadPublicSkills(true) }}
        installedNames={props.skills}
        busy={busy}
        run={run}
        confirm={confirm}
        onChanged={props.onChanged}
      />

      <ReposSection
        repos={repos}
        skills={props.skills}
        uploadableSkills={props.uploadableSkills}
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
  loadingError: string | null
  updatedAt: Date | null
  onUpdate: () => void
  /** 本地已安装的 skills 名（与仓库区共用同一份）。 */
  installedNames: string[]
  busy: string | null
  run: SectionProps['run']
  confirm: SectionProps['confirm']
  onChanged: () => void
}

/** 云效公共技能库：列表只读，安装复用仓库的落盘语义（覆盖前二次确认）。 */
function PublicSkillsSection(props: PublicSectionProps): React.JSX.Element {
  /** 每张卡片独立的 loading 状态，不阻塞其它卡片。 */
  const [installing, setInstalling] = useState<Set<string>>(new Set())
  /** 安装成功后的短暂闪光：完成即清掉，让动画只跑一遍。 */
  const [flash, setFlash] = useState<Set<string>>(new Set())
  /** 只注入一次 keyframes，避免每次 render 都 appendChild。 */
  useEffect(() => {
    if (installAnimInjected) return
    installAnimInjected = true
    const style = document.createElement('style')
    style.textContent = INSTALL_ANIM_STYLE
    document.head.appendChild(style)
    return () => { /* 页面常驻，不必卸载 */ }
  }, [])

  const runInstall = async (entry: PublicSkillEntry): Promise<void> => {
    setInstalling((prev) => new Set(prev).add(entry.name))
    try {
      const result = await managerApi.installPublicSkill(entry.name, false)
      if (result.status !== 'installed') throw new Error(result.error ?? '安装失败')
      props.onChanged()
      // 触发成功闪光；900ms 后清除，让下一次同一技能能再动画。
      setFlash((prev) => new Set(prev).add(entry.name))
      window.setTimeout(() => setFlash((prev) => { const next = new Set(prev); next.delete(entry.name); return next }), 950)
    } finally {
      setInstalling((prev) => { const next = new Set(prev); next.delete(entry.name); return next })
    }
  }

  const install = async (entry: PublicSkillEntry, installed: boolean): Promise<void> => {
    if (installed) {
      props.confirm({
        title: '覆盖安装 ' + entry.name,
        message: `本地已存在同名 skills「${entry.name}」，将从云效公共技能库重新安装并覆盖（原版本进回收站）。`,
        confirmLabel: '覆盖安装',
        run: async () => { await runInstall(entry) },
      })
      return
    }
    await runInstall(entry)
  }

  return (
    <section style={box}>
      <div style={{ ...row, marginBottom: 4 }}>
        <strong>云效公共技能库</strong>
        <span style={muted}>
          {props.meta !== null
            ? `${props.meta.ref} · ${props.meta.fileCount} 个文件 · ${props.skills.length} 个技能`
            : props.loadingError !== null ? '加载失败' : '加载中…'}
        </span>
        <span style={{ flex: 1 }} />
        {props.updatedAt !== null ? <span style={muted}>上次更新 {props.updatedAt.toLocaleTimeString()}</span> : null}
        <button
          type='button'
          style={button}
          disabled={props.loading}
          onClick={() => { props.onUpdate() }}
        >{props.loading ? '更新中…' : '更新'}</button>
      </div>
      {!props.loading && props.skills.length === 0 ? <p style={muted}>公共技能库暂无可用技能。</p> : null}
      {props.skills.length > 0 ? (
        <div style={cardGrid}>
          {props.skills.map((entry) => {
            const installed = props.installedNames.includes(entry.name)
            const busyCard = installing.has(entry.name)
            const flashCard = flash.has(entry.name)
            return (
              <div key={entry.name} style={card} className={flashCard ? 'dsh-install-flash' : undefined}>
                <div style={{ ...row, gap: 6 }}>
                  <strong style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</strong>
                  {installed && !busyCard ? <span style={badge}>已安装</span> : null}
                </div>
                <div style={desc}>来自云效公共技能库</div>
                <div style={path} title={entry.path}>{entry.path}</div>
                <div style={{ ...row, gap: 6, marginTop: 'auto' }}>
                  <button
                    type='button'
                    style={ghostCardBtn}
                    disabled={busyCard}
                    onClick={() => { void install(entry, installed) }}
                  >
                    {busyCard
                      ? <><span className='dsh-spinner' style={{ marginRight: 4 }} />安装中…</>
                      : installed
                        ? '重新安装'
                        : '安装'}
                  </button>
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
  uploadableSkills: string[]
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

  /** 推送目标仓库：没有令牌的仓库不可写，不进下拉列表。 */
  const uploadRepos = props.repos.filter((entry) => entry.authId !== undefined && entry.authId !== '')

  const doUpload = async (): Promise<string> => {
    const repo = uploadRepos.find((entry) => entry.slug === uploadSlug)
    if (repo === undefined) throw new Error('请选择带令牌的仓库')
    if (uploadNames.size === 0) throw new Error('请选择要上传的 skills')
    const targetBranch = repo.defaultBranch.trim()
    if (targetBranch === '') throw new Error('该仓库没有分支名，请先在高级选项里设置默认分支')
    const result = await managerApi.upload({
      slug: repo.slug,
      branch: targetBranch,
      names: [...uploadNames],
      ...(uploadDir.trim() !== '' ? { dir: uploadDir.trim() } : {}),
    })
    const rejected = result.rejected.length > 0
      ? '；被拒绝：' + result.rejected.map((entry) => entry.name + '（' + entry.reason + '）').join('、')
      : ''
    return `已推送 ${result.uploaded.length} 个 skills 到 ${result.branch} @ ${result.commitSha.slice(0, 8)}${rejected}`
  }

  /** 推送的前置条件；为 null 才允许点。没有令牌的仓库不可写，也不能作为推送目标。 */
  const uploadRepo = uploadRepos.find((entry) => entry.slug === uploadSlug)
  const uploadBlocked = uploadSlug === ''
    ? '请选择目标仓库'
    : uploadRepo === undefined
      ? '该仓库没有令牌，无法推送'
      : uploadNames.size === 0
        ? '请选择要上传的 skills'
        : uploadRepo.defaultBranch.trim() === ''
          ? '该仓库没有分支名，请先在高级选项里设置默认分支'
          : null

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

      {props.repos.length === 0 ? <div style={box}>还没有配置仓库。添加后即可扫描、安装、上传 skills。</div> : null}

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
            <button type='button' style={{ ...button, padding: '2px 6px', fontSize: 11 }} onClick={() => { setScan(null) }}>关闭</button>
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
            {uploadRepos.map((repo) => <option key={repo.slug} value={repo.slug}>{repoDisplayName(repo.slug)}</option>)}
          </select>
          <input style={input} placeholder='仓库内目录（skills）' value={uploadDir} onChange={(event) => { setUploadDir(event.target.value) }} />
          <button
            type='button'
            style={props.busy !== null || uploadBlocked !== null ? primaryDisabled : primary}
            disabled={props.busy !== null || uploadBlocked !== null}
            title={uploadBlocked ?? '推送选中的 skills'}
            onClick={() => {
              props.confirm({
                title: '推送 skills 到仓库',
                message: `将 ${uploadNames.size} 个本地 skills 推送到 ${repoDisplayName(uploadSlug)}（上传前会做内容审计，命中阻断规则会被拒绝）。`,
                confirmLabel: '推送',
                run: async () => { await props.run('upload', doUpload) },
              })
            }}
          >推送 {uploadNames.size} 个</button>
        </div>
        {uploadRepos.length === 0 ? <p style={muted}>没有带令牌的仓库。添加仓库时填写 HTTPS Token 后才能推送。</p> : null}
        <div style={{ ...row, maxHeight: 180, overflow: 'auto' }}>
          {props.uploadableSkills.length === 0 ? <span style={muted}>没有可上传的本地 skills。</span> : props.uploadableSkills.map((name) => (
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
