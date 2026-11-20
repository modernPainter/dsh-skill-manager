/**
 * 「我的仓库」与「场景备份」管理视图。
 *
 * 自包含实现（inline styles）：不改动既有 panel.module.css，也不依赖
 * SkillHub 既有的角色（role）语义 —— 这里的「场景」是 skill 版本清单 +
 * 配置快照，和设置里的「角色」是两个概念，因此单独成页。
 *
 * 交互约定：所有危险操作（删除仓库、删除场景、覆盖安装、覆盖恢复）都要
 * 经过二次确认；批量结果逐项反馈（成功/跳过/失败）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitRepoSource, RepoSkillManifestEntry, SceneManifest } from '../../protocol.ts'
import { errorMessage } from '../helpers.ts'
import { Toast } from './Toast.tsx'
import { IconChevronDownOutline14, IconScanOutline16 } from '../icons.tsx'
import {
  managerApi,
  type InstallProgress,
  type RestorePlanResult,
  type SceneRemoteRef,
} from '../manager-api.ts'

export interface ManagerViewProps {
  /** 当前页签：仓库管理或场景备份（一级 tab 已拆分，这里只渲染其一）。 */
  section: 'repos' | 'scenes'
  /** 当前已安装 skills 名，用于上传与场景创建的选择器。 */
  skills: string[]
  /** 安装/恢复成功后刷新目录。 */
  onChanged: () => void
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
  const [scenes, setScenes] = useState<SceneManifest[]>([])
  const [sceneRemotes, setSceneRemotes] = useState<Record<string, SceneRemoteRef>>({})
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  // 离线时场景列表照样能读（本地 sidecar），单独兜底不阻断仓库区。
  const loadScenes = useCallback(async (): Promise<void> => {
    try {
      const payload = await managerApi.listScenes()
      setScenes(payload.scenes)
      setSceneRemotes(payload.remotes)
    } catch {
      setScenes([])
      setSceneRemotes({})
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      const payload = await managerApi.listRepos()
      setRepos(payload.repos)
      await loadScenes()
    } catch (caught) {
      // 离线：仓库配置读不到时给出明确提示，但仍尝试展示本地场景。
      setError(errorMessage(caught))
      await loadScenes()
    }
  }, [loadScenes])

  useEffect(() => { void refresh() }, [refresh])

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
      <div style={{ ...row, marginBottom: 12 }}>
        <span style={muted}>{props.section === 'repos' ? '管理自有 Git skills 仓库：扫描、安装与上传' : '把一组 skills 打成快照，备份到仓库或按需恢复'}</span>
      </div>

      {error !== null ? <div style={banner} role='alert'>{error}</div> : null}
      <Toast message={notice} onDone={() => { setNotice(null) }} />

      {props.section === 'repos'
        ? <ReposSection
            repos={repos}
            skills={props.skills}
            busy={busy}
            onRefresh={refresh}
            onChanged={props.onChanged}
            run={run}
            confirm={confirm}
          />
        : <ScenesSection
            scenes={scenes}
            remotes={sceneRemotes}
            repos={repos}
            skills={props.skills}
            busy={busy}
            run={run}
            confirm={confirm}
            onRefresh={refresh}
            onInstalled={props.onChanged}
          />}

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
  const [scenesPath, setScenesPath] = useState('')
  const [token, setToken] = useState('')
  /** 低频字段（分支、目录、令牌）收进「高级选项」，默认只露仓库地址。 */
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
      ...(scenesPath.trim() !== '' ? { scenesPath: scenesPath.trim() } : {}),
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
              <input style={input} placeholder='场景目录（scenes）' value={scenesPath} onChange={(event) => { setScenesPath(event.target.value) }} />
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

// ───────────────────────────────────────────────────────────── 场景区

interface ScenesProps {
  scenes: SceneManifest[]
  remotes: Record<string, SceneRemoteRef>
  repos: GitRepoSource[]
  skills: string[]
  busy: string | null
  run: (label: string, action: () => Promise<string | void>) => Promise<void>
  confirm: (spec: PendingConfirm) => void
  onRefresh: () => Promise<void>
  onInstalled: () => void
}

function ScenesSection(props: ScenesProps): React.JSX.Element {
  const [sceneId, setSceneId] = useState('')
  const [sceneName, setSceneName] = useState('')
  const [sceneDesc, setSceneDesc] = useState('')
  const [includeConfig, setIncludeConfig] = useState(false)
  const [members, setMembers] = useState<Set<string>>(new Set())
  const [plan, setPlan] = useState<RestorePlanResult | null>(null)
  const [decisions, setDecisions] = useState<Record<string, 'override' | 'skip' | 'backup-then-override'>>({})
  const [backupSlug, setBackupSlug] = useState('')
  const [search, setSearch] = useState('')

  const visibleSkills = useMemo(
    () => props.skills.filter((name) => search === '' || name.toLowerCase().includes(search.toLowerCase())),
    [props.skills, search],
  )

  const create = async (): Promise<string> => {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(sceneId)) throw new Error('场景 id 只能是小写字母、数字和连字符')
    if (sceneName.trim() === '') throw new Error('请填写场景名称')
    if (members.size === 0) throw new Error('请至少选择一个 skills')
    await managerApi.createScene({
      id: sceneId,
      name: sceneName.trim(),
      ...(sceneDesc.trim() !== '' ? { description: sceneDesc.trim() } : {}),
      skills: [...members],
      ...(includeConfig ? { includeConfig: true } : {}),
    })
    setSceneId('')
    setSceneName('')
    setSceneDesc('')
    setMembers(new Set())
    await props.onRefresh()
    return '场景已创建'
  }

  const backup = async (scene: SceneManifest): Promise<string> => {
    if (backupSlug === '') throw new Error('请选择备份目标仓库')
    const result = await managerApi.backupScene({ id: scene.id, slug: backupSlug })
    await props.onRefresh()
    return `场景已备份到 ${result.branch} @ ${result.commitSha.slice(0, 8)}（${result.path}）`
  }

  const openPlan = async (scene: SceneManifest): Promise<void> => {
    const result = await managerApi.restorePlan(scene.id)
    setPlan(result)
    const initial: Record<string, 'override' | 'skip' | 'backup-then-override'> = {}
    for (const conflict of result.conflicts) initial[conflict.name] = conflict.type === 'missing' ? 'override' : 'skip'
    setDecisions(initial)
  }

  const applyRestore = async (): Promise<string> => {
    if (plan === null) return '没有待应用的变更'
    const result = await managerApi.restoreScene(plan.scene.id, decisions)
    setPlan(null)
    props.onInstalled()
    const notes = [
      `恢复完成：安装 ${result.installed.length}`,
      result.skipped.length > 0 ? `跳过 ${result.skipped.length}` : '',
      result.failed.length > 0 ? `失败 ${result.failed.length}` : '',
    ].filter((part) => part !== '').join('，')
    return notes
  }

  return (
    <div>
      <section style={box}>
        <strong style={{ display: 'block', marginBottom: 8 }}>从当前 skills 创建场景</strong>
        <div style={{ ...row, marginBottom: 8 }}>
          <input style={input} placeholder='场景 id（kebab-case，如 embedded-rpi）' value={sceneId} onChange={(event) => { setSceneId(event.target.value) }} />
          <input style={input} placeholder='名称' value={sceneName} onChange={(event) => { setSceneName(event.target.value) }} />
          <input style={{ ...input, flex: 1, minWidth: 220 }} placeholder='描述（可选）' value={sceneDesc} onChange={(event) => { setSceneDesc(event.target.value) }} />
          <label style={muted}><input type='checkbox' checked={includeConfig} onChange={(event) => { setIncludeConfig(event.target.checked) }} /> 包含配置快照</label>
          <button type='button' style={primary} disabled={props.busy !== null} onClick={() => { void props.run('create-scene', create) }}>创建</button>
        </div>
        <div style={{ ...row, marginBottom: 6 }}>
          <input style={input} placeholder='筛选 skills…' value={search} onChange={(event) => { setSearch(event.target.value) }} />
          <button type='button' style={button} onClick={() => { setMembers(new Set(visibleSkills)) }}>全选</button>
          <button type='button' style={button} onClick={() => { setMembers(new Set()) }}>清空</button>
          <span style={muted}>已选 {members.size}</span>
        </div>
        <div style={{ ...row, maxHeight: 160, overflow: 'auto' }}>
          {visibleSkills.map((name) => (
            <label key={name} style={{ ...muted, fontSize: 12 }}>
              <input
                type='checkbox'
                checked={members.has(name)}
                onChange={(event) => {
                  setMembers((previous) => {
                    const next = new Set(previous)
                    if (event.target.checked) next.add(name)
                    else next.delete(name)
                    return next
                  })
                }}
              /> {name}
            </label>
          ))}
          {visibleSkills.length === 0 ? <span style={muted}>没有匹配的本地 skills。</span> : null}
        </div>
      </section>

      <section style={{ ...box, display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 13 }}>备份目标</span>
        <select style={input} value={backupSlug} onChange={(event) => { setBackupSlug(event.target.value) }}>
          <option value=''>选择仓库</option>
          {props.repos.map((repo) => <option key={repo.slug} value={repo.slug}>{repoDisplayName(repo.slug)}</option>)}
        </select>
        <span style={muted}>备份会把 scene.json 与 skills 快照推送到仓库的场景目录。</span>
      </section>

      {props.scenes.length === 0 ? <div style={box}>还没有场景。</div> : null}

      <ul style={list}>
        {props.scenes.map((scene) => (
          <li key={scene.id} style={item}>
            <div style={row}>
              <strong>{scene.name}</strong>
              <span style={muted}>{scene.id} · {scene.skills.length} skills · 更新于 {new Date(scene.updatedAt).toLocaleString()}</span>
              <span style={{ flex: 1 }} />
              <button type='button' style={button} disabled={props.busy !== null} onClick={() => {
                props.confirm({
                  title: '备份场景',
                  message: `把「${scene.name}」推送到 ${backupSlug === '' ? '（未选择仓库）' : backupSlug}。`,
                  confirmLabel: '备份',
                  run: async () => { await props.run('backup:' + scene.id, async () => backup(scene)) },
                })
              }}>备份到仓库</button>
              <button type='button' style={primary} disabled={props.busy !== null} onClick={() => { void props.run('plan:' + scene.id, async () => { await openPlan(scene); return undefined }) }}>恢复…</button>
              <button type='button' style={danger} disabled={props.busy !== null} onClick={() => {
                props.confirm({
                  title: '删除场景',
                  message: `删除本地场景「${scene.name}」？已推送到仓库的副本不受影响。`,
                  confirmLabel: '删除',
                  run: async () => { await props.run('delete-scene:' + scene.id, async () => { await managerApi.deleteScene(scene.id); await props.onRefresh(); return '场景已删除' }) },
                })
              }}>删除</button>
            </div>
            <div style={muted}>
              {(() => {
                const remote = props.remotes[scene.id]
                if (remote?.remoteRepo === undefined) return '未备份到仓库（恢复将依赖来源仓库历史）'
                return `已备份到 ${remote.remoteRepo}${remote.remoteCommitSha !== undefined ? ' @ ' + remote.remoteCommitSha.slice(0, 8) : ''}${remote.remotePath !== undefined ? ' · ' + remote.remotePath : ''}`
              })()}
            </div>
          </li>
        ))}
      </ul>

      {plan !== null ? (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}>
          <div style={{ background: 'var(--dsh-bg, #fff)', borderRadius: 10, padding: 18, width: 560, maxWidth: '94vw', maxHeight: '86vh', overflow: 'auto' }} role='dialog' aria-modal='true'>
            <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>恢复场景：{plan.scene.name}</h3>
            <p style={{ ...muted, margin: '0 0 12px' }}>逐项确认要覆盖的内容；默认跳过已存在的 skills，绝不静默覆盖。</p>
            <ul style={list}>
              {plan.conflicts.map((conflict) => (
                <li key={conflict.name} style={{ ...item, padding: 10 }}>
                  <div style={row}>
                    <strong style={{ fontSize: 13 }}>{conflict.name}</strong>
                    <span style={muted}>{conflict.type === 'missing' ? '未安装' : conflict.type === 'local-modified' ? '本地已修改' : '版本更新'}</span>
                    <span style={{ flex: 1 }} />
                    <select
                      style={{ ...input, minWidth: 130 }}
                      value={decisions[conflict.name] ?? 'skip'}
                      onChange={(event) => {
                        const value = event.target.value as 'override' | 'skip' | 'backup-then-override'
                        setDecisions((previous) => ({ ...previous, [conflict.name]: value }))
                      }}
                    >
                      <option value='skip'>跳过</option>
                      <option value='override'>覆盖</option>
                      <option value='backup-then-override'>覆盖（原版进回收站）</option>
                    </select>
                  </div>
                  <div style={muted}>{conflict.description}</div>
                </li>
              ))}
            </ul>
            <div style={{ ...row, justifyContent: 'flex-end', marginTop: 12 }}>
              <button type='button' style={button} onClick={() => { setPlan(null) }}>取消</button>
              <button type='button' style={danger} onClick={() => { void props.run('restore', applyRestore) }}>应用变更</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
