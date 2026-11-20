/**
 * 自有 Git 仓库源 · 路由域。
 *
 * 与 Hub 其他域一致：只返回裸 RouteSpec，由 routes.ts 统一包上信任栅栏、
 * 方法检查、CSRF 标记头、总开关与 JSON 体读取 —— 认证 token 增删这类接口
 * 绝不另开一条更松的通路。
 *
 * 阶段 1 覆盖：仓库源 CRUD / 连接测试 / 扫描 / 同步快照 / 安装（异步任务，
 * 含本地改动冲突检测）/ 认证凭据 CRUD。上传在后续阶段补齐。
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { SKILL_MANAGER_API, type GitRepoSource, type RepoScanResult, type RepoSkillManifestEntry } from '../protocol.ts'
import { errorText } from '../error-text.ts'
import { apiUrl, extractSlug, fetchJson, RepoFetchError } from '../repo/git-client.ts'
import { fetchRepoTreeBlobs, mergeManifestAndScan, parseManifest, scanFromTree } from '../repo/discovery-v2.ts'
import { downloadRepoFile } from '../repo/install-v2.ts'
import { readSkillBundle } from '../repo/local-bundle.ts'
import { pushFiles, readRepoFile, type PushFile } from '../repo/push.ts'
import { hashSkillAt, moveIntoTrash, occupancyOf, rootPath, trashSourceOf } from '../skillfs.ts'
import type { ReposStore } from '../store/repos.ts'
import { installSkillBundle, type BundleFile } from './install-bundle.ts'
import { retireNamePlaceholders } from './route-state.ts'
import {
  homeOf,
  queryParam,
  readString,
  readStrings,
  writeError,
  writeJson,
  type RouteSpec,
  type SkillHubRouteDeps,
} from './helpers.ts'
import { asAuditText, auditSkillBundle, blockingReason, type AuditBundleFile, type AuditFinding } from '../skillfs/audit.ts'

// ─────────────────────────────────────────────────── 扫描

interface ScanDetail extends RepoScanResult {
  /** 扁平文件清单（安装时按 skill 目录过滤）。 */
  tree: Array<{ path: string; size: number }>
}

/** 扫描仓库：commit → manifest → tree → 合并。scan / sync / install 共用。 */
export async function scanRepoCore(repos: ReposStore, slug: string, ref: string): Promise<ScanDetail> {
  const repo = await repos.getRepo(slug)
  if (repo === undefined) throw new RepoFetchError('repo not found: ' + slug, 404)

  // 1. commit（同时拿到精确 SHA 与 tree SHA）
  const { json: commitJson } = await fetchJson(apiUrl(repo, 'commit', { ref }), repo, `commit ${slug}@${ref}`)
  const commitObj = (typeof commitJson === 'object' && commitJson !== null ? commitJson : {}) as Record<string, unknown>
  const commitSha = typeof commitObj.sha === 'string' ? commitObj.sha : typeof commitObj.id === 'string' ? commitObj.id : ''
  const treeObj = commitObj.tree as Record<string, unknown> | undefined
  const treeSha = typeof treeObj?.sha === 'string' ? treeObj.sha : commitSha
  if (commitSha === '') throw new RepoFetchError(`cannot resolve ${slug}@${ref} to a commit`, 404)

  // 2. manifest：缺失/损坏都退化为目录扫描，不阻断。
  //    走 readRepoFile 而不是裸 contents 路由 —— GitLab 需要 base64 解码。
  let manifest
  try {
    const buffer = await readRepoFile(repo, commitSha, repo.manifestPath)
    manifest = parseManifest(buffer.toString('utf8'))
  } catch (error) {
    if (!(error instanceof RepoFetchError)) throw error
    if (error.status !== 404) console.warn(`[dsh-skill-manager] manifest unavailable for ${slug}:`, errorText(error))
  }

  // 3. tree：同样可缺失，只是没有 fallback 发现结果。
  let tree: Array<{ path: string; size: number }> = []
  try {
    tree = await fetchRepoTreeBlobs(repo, commitSha, treeSha)
  } catch (error) {
    if (!(error instanceof RepoFetchError)) throw error
    if (error.status !== 404) console.warn(`[dsh-skill-manager] tree unavailable for ${slug}:`, errorText(error))
  }

  const skills = mergeManifestAndScan(manifest?.skills ?? [], scanFromTree(tree))
  return { slug, ref, commitSha, treeSha, ...(manifest !== undefined ? { manifest } : {}), skills, tree }
}

// ─────────────────────────────────────────────────── 安装任务

interface InstallJob {
  jobId: string
  slug: string
  ref: string
  total: number
  done: number
  current?: string
  installed: Array<{ name: string; path: string }>
  skipped: Array<{ name: string; reason: string }>
  failed: Array<{ name: string; error: string }>
  /** 覆盖了本地改动、按用户要求继续的 skill。 */
  overwritten: string[]
  status: 'running' | 'done' | 'cancelled' | 'error'
  error?: string
  controller: AbortController
  createdAt: number
  settledAt?: number
}

const installJobs = new Map<string, InstallJob>()
const INSTALL_JOB_TTL_MS = 5 * 60_000
const INSTALL_JOB_MAX = 50

function settle(job: InstallJob, status: InstallJob['status']): void {
  if (job.status !== 'running') return
  job.status = status
  job.settledAt = Date.now()
}

function gcJobs(now = Date.now()): void {
  for (const [id, job] of installJobs) {
    const settledAt = job.settledAt ?? job.createdAt
    if (job.status !== 'running' && now - settledAt > INSTALL_JOB_TTL_MS) installJobs.delete(id)
  }
  if (installJobs.size > INSTALL_JOB_MAX) {
    const finished = [...installJobs.entries()]
      .filter(([, job]) => job.status !== 'running')
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
    for (let i = 0; i < finished.length && installJobs.size > INSTALL_JOB_MAX; i++) installJobs.delete(finished[i][0])
  }
}

/** 目录内文件 → 行业内相对路径的 BundleFile 列表。 */
export async function fetchSkillFiles(source: GitRepoSource, ref: string, entry: RepoSkillManifestEntry, tree: ScanDetail['tree'], signal?: AbortSignal): Promise<BundleFile[]> {
  const prefix = entry.path.replace(/\/+$/, '') + '/'
  const files = tree.filter((file) => file.path.startsWith(prefix))
  if (files.length === 0) throw new RepoFetchError(`skill directory is empty or missing in this ref: ${entry.path}`, 422)

  const result: BundleFile[] = []
  for (const file of files) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const relative = file.path.slice(prefix.length)
    if (relative === '' || relative.split('/').includes('..')) {
      throw new RepoFetchError('unsafe repo path: ' + file.path, 422)
    }
    const data = await downloadRepoFile(source, ref, file.path, fetch, signal)
    result.push({ path: relative, size: data.length, data })
  }
  return result
}

/** 本地同名技能的当前哈希（目录包或扁平文件都没有时返回 undefined）。 */
async function currentLocalHash(targetRoot: string, name: string): Promise<string | undefined> {
  const dirHash = await hashSkillAt(join(targetRoot, name, 'SKILL.md'))
  if (dirHash !== undefined) return dirHash
  return hashSkillAt(join(targetRoot, name + '.md'))
}

/** 覆盖安装：先把现行版本移入回收站，再走统一落盘流程。 */
export async function installWithOverwrite(deps: SkillHubRouteDeps, targetRoot: string, name: string, files: BundleFile[]): Promise<{ status: 'installed' | 'skipped' | 'failed'; error?: string; replaced?: boolean; warnings?: AuditFinding[] }> {
  const occupancy = await occupancyOf(targetRoot, name)
  const existing = [...occupancy.enabled, ...(occupancy.bareDir !== undefined ? [occupancy.bareDir] : [])]
  let replaced = false
  for (const path of existing) {
    const moved = await moveIntoTrash(trashSourceOf(path))
    await deps.store.addTrash({ name, path: moved.path, movedAt: Date.now(), sourcePath: moved.source })
    replaced = true
  }

  const outcome = await installSkillBundle({
    targetRoot,
    files,
    label: name,
    existing: new Set(),
    retire: async (target) => (await retireNamePlaceholders(deps, targetRoot, target)) !== undefined,
  })
  return { status: outcome.status, ...(outcome.error !== undefined ? { error: outcome.error } : {}), ...(replaced || outcome.replaced === true ? { replaced: true } : {}), ...(outcome.warnings !== undefined ? { warnings: outcome.warnings } : {}) }
}

// ─────────────────────────────────────────────────── 路由

export interface RepoRouteDeps extends SkillHubRouteDeps {
  repos: ReposStore
}

export function repoV2Routes(deps: RepoRouteDeps): RouteSpec[] {
  const { repos } = deps

  const requireRepo = async (slug: string): Promise<GitRepoSource | undefined> => repos.getRepo(slug)

  return [
    // ─────────────────────────── 仓库源列表（GET）/ 新增或更新（POST）
    // 宿主路由表按路径唯一，同路径的多方法必须合并成一个 spec。
    {
      path: SKILL_MANAGER_API.repos,
      methods: ['GET', 'POST'],
      jsonBody: true,
      handler: async ({ req, res, body }) => {
        if (req.method === 'GET') {
          writeJson(res, 200, { ok: true, repos: await repos.listRepos(), auths: await repos.listAuths() })
          return
        }
        const url = readString(body, 'url').trim()
        if (url === '') { writeError(res, 400, 'url is required'); return }
        if (extractSlug(url) === null) { writeError(res, 400, 'invalid repository URL (expected https://host/owner/repo)'); return }
        const authId = readString(body, 'authId')
        if (authId !== '' && (await repos.getAuth(authId)) === undefined) { writeError(res, 400, 'unknown auth id: ' + authId); return }
        const repo = await repos.upsertRepo({
          url,
          ...(authId !== '' ? { authId } : {}),
          ...(readString(body, 'description') !== '' ? { description: readString(body, 'description') } : {}),
          ...(readString(body, 'defaultBranch') !== '' ? { defaultBranch: readString(body, 'defaultBranch') } : {}),
          ...(readString(body, 'manifestPath') !== '' ? { manifestPath: readString(body, 'manifestPath') } : {}),
          ...(readStrings(body, 'tags').length > 0 ? { tags: readStrings(body, 'tags') } : {}),
        })
        writeJson(res, 200, { ok: true, repo, repos: await repos.listRepos() })
      },
    },

    // ─────────────────────────── 删除仓库源
    {
      path: SKILL_MANAGER_API.repoDelete,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const slug = readString(body, 'slug').trim()
        if (slug === '') { writeError(res, 400, 'slug is required'); return }
        await repos.removeRepo(slug)
        writeJson(res, 200, { ok: true, repos: await repos.listRepos() })
      },
    },

    // ─────────────────────────── 测试连接
    {
      path: SKILL_MANAGER_API.repoTest,
      methods: ['GET'],
      handler: async ({ res, url }) => {
        const slug = queryParam(url, 'slug') ?? ''
        const repo = await requireRepo(slug)
        if (repo === undefined) { writeError(res, 404, 'repo not found: ' + slug); return }
        try {
          const { json } = await fetchJson(apiUrl(repo, 'branch-head', { ref: repo.defaultBranch }), repo, `test ${slug}`)
          const obj = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>
          const branch = typeof obj.name === 'string' ? obj.name : repo.defaultBranch
          writeJson(res, 200, { ok: true, backend: repo.backend, defaultBranch: branch })
        } catch (error) {
          // 连接测试是诊断接口：失败也回 200 + ok:false，GUI 直接展示原因。
          writeJson(res, 200, { ok: false, backend: repo.backend, error: errorText(error) })
        }
      },
    },

    // ─────────────────────────── 扫描
    {
      path: SKILL_MANAGER_API.repoScan,
      methods: ['GET'],
      handler: async ({ res, url }) => {
        const slug = queryParam(url, 'slug') ?? ''
        const repo = await requireRepo(slug)
        if (repo === undefined) { writeError(res, 404, 'repo not found: ' + slug); return }
        const ref = queryParam(url, 'ref') || repo.defaultBranch
        const scan = await scanRepoCore(repos, slug, ref)
        const { tree, ...rest } = scan
        // 扫描即记录快照：界面上「最近扫描」与上次 commit 都从这里来。
        await repos.updateRepoScanState(slug, {
          lastCommitSha: scan.commitSha,
          lastCheckedAt: Date.now(),
          ...(scan.manifest !== undefined ? { manifest: scan.manifest } : {}),
        })
        writeJson(res, 200, { ok: true, ...rest, fileCount: tree.length })
      },
    },

    // ─────────────────────────── 安装（异步任务）
    {
      path: SKILL_MANAGER_API.repoInstall,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const slug = readString(body, 'slug').trim()
        const repo = await requireRepo(slug)
        if (repo === undefined) { writeError(res, 404, 'repo not found: ' + slug); return }

        const ref = readString(body, 'ref').trim() || repo.defaultBranch
        const requested = readStrings(body, 'names')
        const overwrite = body.overwrite === true
        const allowLocalOverwrite = body.allowLocalOverwrite === true

        const scan = await scanRepoCore(repos, slug, ref)
        const selected = requested.length === 0
          ? scan.skills
          : scan.skills.filter((entry) => requested.includes(entry.name))
        if (selected.length === 0) { writeError(res, 400, 'no matching skills to install'); return }
        if (selected.length > 500) { writeError(res, 400, 'select at most 500 skills per install'); return }

        const jobId = 'inst_' + randomUUID()
        const controller = new AbortController()
        const job: InstallJob = {
          jobId,
          slug,
          ref,
          total: selected.length,
          done: 0,
          installed: [],
          skipped: [],
          failed: [],
          overwritten: [],
          status: 'running',
          controller,
          createdAt: Date.now(),
        }
        gcJobs()
        installJobs.set(jobId, job)

        const targetRoot = rootPath('user-dsh', homeOf(deps))
        const sourceRecord = await deps.store.getSource(slug)

        void (async () => {
          await mkdir(targetRoot, { recursive: true })
          let changed = false
          for (const entry of selected) {
            if (controller.signal.aborted) break
            job.current = entry.name
            try {
              // 冲突判定在下载前完成：命中冲突且用户未授权时，不浪费流量。
              const occupancy = await occupancyOf(targetRoot, entry.name)
              const exists = occupancy.enabled.length > 0
              if (exists && !overwrite) {
                job.skipped.push({ name: entry.name, reason: 'exists (set overwrite to replace)' })
                continue
              }
              if (exists && overwrite) {
                const baseline = sourceRecord?.localHashes?.[entry.name]
                const current = await currentLocalHash(targetRoot, entry.name)
                const modified = baseline !== undefined && current !== undefined && baseline !== current
                if (modified && !allowLocalOverwrite) {
                  job.skipped.push({ name: entry.name, reason: 'local-modified (confirm overwrite to replace your edits)' })
                  continue
                }
                if (modified) job.overwritten.push(entry.name)
              }

              const files = await fetchSkillFiles(repo, scan.commitSha, entry, scan.tree, controller.signal)
              const outcome = exists
                ? await installWithOverwrite(deps, targetRoot, entry.name, files)
                : await installSkillBundle({
                    targetRoot,
                    files,
                    label: entry.name,
                    existing: new Set(),
                    retire: async (name) => (await retireNamePlaceholders(deps, targetRoot, name)) !== undefined,
                  })

              if (outcome.status === 'installed') {
                const skillPath = join(targetRoot, entry.name, 'SKILL.md')
                await deps.store.addSourceSkill(slug, entry.path.split('/').slice(0, -1).join('/'), scan.commitSha, ref, entry.name)
                await deps.store.mergeSourceManifest(slug, Object.fromEntries(scan.tree.filter((file) => file.path.startsWith(entry.path + '/')).map((file) => [file.path, file.size])), entry.path)
                const hash = await hashSkillAt(skillPath)
                if (hash !== undefined) await deps.store.setSourceSkillHash(slug, entry.name, hash)
                job.installed.push({ name: entry.name, path: skillPath })
                changed = true
              } else {
                job.skipped.push({ name: entry.name, reason: outcome.error ?? outcome.status })
              }
            } catch (error) {
              if (controller.signal.aborted) break
              job.failed.push({ name: entry.name, error: errorText(error) })
            } finally {
              job.done += 1
            }
          }
          settle(job, controller.signal.aborted ? 'cancelled' : 'done')
          job.current = undefined
          if (changed) deps.invalidate?.()
        })().catch((error) => {
          settle(job, 'error')
          job.error = errorText(error)
          job.current = undefined
        })

        writeJson(res, 200, { ok: true, jobId, total: selected.length, commitSha: scan.commitSha, ref })
      },
    },

    // ─────────────────────────── 安装进度
    {
      path: SKILL_MANAGER_API.repoInstallProgress,
      methods: ['GET'],
      handler: async ({ res, url }) => {
        const jobId = queryParam(url, 'jobId') ?? ''
        if (jobId === '') { writeError(res, 400, 'jobId is required'); return }
        gcJobs()
        const job = installJobs.get(jobId)
        if (job === undefined) { writeError(res, 404, 'install job not found: ' + jobId); return }
        writeJson(res, 200, {
          ok: true,
          jobId: job.jobId,
          status: job.status,
          total: job.total,
          done: job.done,
          ...(job.current !== undefined ? { current: job.current } : {}),
          installed: [...job.installed],
          skipped: [...job.skipped],
          failed: [...job.failed],
          overwritten: [...job.overwritten],
          ...(job.error !== undefined ? { error: job.error } : {}),
        })
      },
    },

    // ─────────────────────────── 取消安装
    {
      path: SKILL_MANAGER_API.repoInstallCancel,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const jobId = readString(body, 'jobId')
        const job = installJobs.get(jobId)
        if (job === undefined) { writeError(res, 404, 'install job not found: ' + jobId); return }
        if (job.status === 'running') {
          job.controller.abort()
          settle(job, 'cancelled')
        }
        writeJson(res, 200, { ok: true, jobId, status: job.status })
      },
    },

    // ─────────────────────────── 上传本地技能（阶段 2）
    {
      path: SKILL_MANAGER_API.repoUpload,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const slug = readString(body, 'slug').trim()
        const repo = await requireRepo(slug)
        if (repo === undefined) { writeError(res, 404, 'repo not found: ' + slug); return }

        const names = readStrings(body, 'names')
        if (names.length === 0) { writeError(res, 400, 'names is required'); return }
        const branch = readString(body, 'branch').trim() || repo.defaultBranch
        const baseDir = (readString(body, 'dir').trim() || 'skills').replace(/^\/+|\/+$/g, '')

        const files: PushFile[] = []
        const entries: RepoSkillManifestEntry[] = []
        const rejected: Array<{ name: string; reason: string }> = []

        for (const name of names) {
          const definition = await deps.skills.get(name)
          if (definition?.path === undefined) { rejected.push({ name, reason: 'local skill not found' }); continue }

          let local
          try {
            local = await readSkillBundle(definition.path)
          } catch (error) {
            rejected.push({ name, reason: errorText(error) })
            continue
          }

          // 上传前审计：任何 block 级发现都拒绝整批中的该技能，不推半成品。
          const audited: AuditBundleFile[] = local.map((file) => {
            const normalized = asAuditText(file.path, file.content)
            return {
              path: file.path,
              size: file.content.length,
              ...(normalized !== undefined ? { text: normalized.text, ...(normalized.disguised === true ? { disguised: true } : {}) } : {}),
            }
          })
          const blocked = blockingReason(auditSkillBundle(audited))
          if (blocked !== undefined) { rejected.push({ name, reason: blocked }); continue }

          const targetDir = `${baseDir}/${name}`
          for (const file of local) files.push({ path: `${targetDir}/${file.path}`, content: file.content })
          entries.push({ name, path: targetDir, ...(readString(body, 'version') !== '' ? { version: readString(body, 'version') } : {}) })
        }

        if (rejected.length === names.length) {
          writeJson(res, 422, { ok: false, error: 'every selected skill was rejected', rejected })
          return
        }

        // 维护仓库 manifest：能读到就增量合并，读不到就新建。
        let manifest
        try {
          manifest = parseManifest((await readRepoFile(repo, branch, repo.manifestPath)).toString('utf8'))
        } catch {
          manifest = { schemaVersion: 1, name: repo.slug, skills: [] as RepoSkillManifestEntry[] }
        }
        const merged = new Map(manifest.skills.map((entry) => [entry.name, entry]))
        for (const entry of entries) merged.set(entry.name, entry)
        const nextManifest = {
          ...manifest,
          skills: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)),
        }
        files.push({ path: repo.manifestPath, content: Buffer.from(JSON.stringify(nextManifest, null, 2), 'utf8') })

        try {
          const pushed = await pushFiles(repo, branch, files, `chore(skill-manager): upload ${entries.map((e) => e.name).join(', ')}`)
          writeJson(res, 200, { ok: true, branch, commitSha: pushed.commitSha, uploaded: entries.map((e) => e.name), rejected, fileCount: files.length })
        } catch (error) {
          writeJson(res, 502, { ok: false, error: errorText(error), rejected })
        }
      },
    },

    // ─────────────────────────── 认证凭据：GET 列表 / POST 新增
    {
      path: SKILL_MANAGER_API.auths,
      methods: ['GET', 'POST'],
      jsonBody: true,
      handler: async ({ req, res, body }) => {
        if (req.method === 'GET') {
          writeJson(res, 200, { ok: true, auths: await repos.listAuths() })
          return
        }
        const type = readString(body, 'type') || 'https-token'
        if (type !== 'https-token') {
          // SSH key 是预留扩展点：明确回 400，而不是静默降级成匿名访问。
          writeError(res, 400, 'only https-token is supported; ssh-key is reserved for a later phase')
          return
        }
        const token = readString(body, 'token')
        if (token === '') { writeError(res, 400, 'token is required'); return }
        const auth = await repos.addAuth({ label: readString(body, 'label') || '未命名凭据', type: 'https-token', token })
        writeJson(res, 200, { ok: true, auth })
      },
    },
    {
      path: SKILL_MANAGER_API.authDelete,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const id = readString(body, 'id').trim()
        if (id === '') { writeError(res, 400, 'id is required'); return }
        await repos.removeAuth(id)
        writeJson(res, 200, { ok: true, auths: await repos.listAuths(), repos: await repos.listRepos() })
      },
    },
  ]
}
