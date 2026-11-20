/**
 * 自有 Git 仓库源持久化 —— 独立 sidecar，不破坏 Hub 原有的 state 文件结构。
 *
 * 路径：$DSH_HOME/dsh-skill-manager-repos.json
 * 写入模式：atomic（tmp + rename），与 Hub StoreCore 一致。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { GitAuthRef, GitRepoSource, RepoSkillManifest } from '../protocol/git.ts'
import { dshHome } from './paths.ts'
import { detectBackend, extractSlug, buildApiBase } from '../repo/git-client.ts'

/** Sidecar file path。 */
export function reposStatePath(home = dshHome()): string {
  return join(home, 'dsh-skill-manager-repos.json')
}

/** Wire shape persisted on disk。 */
export interface ReposStoreFile {
  version: number
  /** 认证凭据（敏感字段 token 序列化时会被 redact —— 但这里我们存明文，只在写入时处理）。 */
  auths: GitAuthRef[]
  /** 自有 Git 仓库源列表。 */
  repos: GitRepoSource[]
}

export const REPOS_STORE_VERSION = 1

/**
 * 修正历史记录：早期版本把云效仓库识别成 generic，且只截了「组织/项目组」两段，
 * 丢掉仓库名后 API 必然拼错。按 URL 重新识别后端，顺带纠正 slug 与 API base。
 */
function healRepoRecord(repo: GitRepoSource): GitRepoSource {
  const backend = detectBackend(repo.url)
  const apiBase = buildApiBase(repo.url, backend)
  const slug = extractSlug(repo.url)
  if (backend === repo.backend && apiBase === repo.apiBase && (slug === null || slug === repo.slug)) return repo
  return { ...repo, backend, apiBase, ...(slug !== null ? { slug } : {}) }
}

/**
 * 简化的 atomic 写入 —— Hub StoreCore 用的就是这个模式。
 */
async function atomicWrite(file: string, data: ReposStoreFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await rename(tmp, file)
}

export class ReposStore {
  private readonly file: string
  private loaded = false
  private state: ReposStoreFile = { version: REPOS_STORE_VERSION, auths: [], repos: [] }

  constructor(file: string = reposStatePath()) {
    this.file = file
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as ReposStoreFile
      if (parsed && typeof parsed === 'object') {
        this.state = {
          version: parsed.version ?? REPOS_STORE_VERSION,
          auths: Array.isArray(parsed.auths) ? parsed.auths : [],
          repos: Array.isArray(parsed.repos) ? parsed.repos.map((repo) => healRepoRecord(repo)) : [],
        }
      }
    } catch {
      // 文件不存在或损坏 → 用空状态启动
    }
    this.loaded = true
  }

  private async persist(): Promise<void> {
    await atomicWrite(this.file, this.state)
  }

  // ── 认证凭据 ──

  async listAuths(): Promise<GitAuthRef[]> {
    await this.ensureLoaded()
    // 回显时脱敏 token
    return this.state.auths.map((a) => this.sanitizeAuthForRead(a))
  }

  async getAuth(id: string): Promise<GitAuthRef | undefined> {
    await this.ensureLoaded()
    return this.state.auths.find((a) => a.id === id)
  }

  /** 新增认证凭据（会自动分配时间戳 id）。 */
  async addAuth(auth: Omit<GitAuthRef, 'id' | 'createdAt'>): Promise<GitAuthRef> {
    await this.ensureLoaded()
    const id = `auth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const ref: GitAuthRef = {
      id,
      createdAt: Date.now(),
      ...auth,
    }
    this.state.auths.push(ref)
    await this.persist()
    return this.sanitizeAuthForRead(ref)
  }

  async updateAuth(id: string, patch: Partial<GitAuthRef>): Promise<GitAuthRef | undefined> {
    await this.ensureLoaded()
    const auth = this.state.auths.find((a) => a.id === id)
    if (auth === undefined) return undefined
    Object.assign(auth, patch)
    await this.persist()
    return this.sanitizeAuthForRead(auth)
  }

  async removeAuth(id: string): Promise<void> {
    await this.ensureLoaded()
    const index = this.state.auths.findIndex((a) => a.id === id)
    if (index !== -1) {
      this.state.auths.splice(index, 1)
      // 清理引用该 auth 的仓库源
      for (const repo of this.state.repos) {
        if (repo.authId === id) delete repo.authId
      }
      await this.persist()
    }
  }

  /** 内部查找（返回完整凭据，包含明文 token）。 */
  findAuthInternal(id?: string): GitAuthRef | undefined {
    if (id === undefined) return undefined
    return this.state.auths.find((a) => a.id === id)
  }

  /** 返回 auth store interface —— 供 git-client 的 setAuthStore 注入。 */
  asAuthStore(): { getToken(authId?: string): string } {
    return {
      getToken: (authId) => {
        const auth = this.findAuthInternal(authId)
        return auth?.token ?? ''
      },
    }
  }

  // ── 仓库源 ──

  async listRepos(): Promise<GitRepoSource[]> {
    await this.ensureLoaded()
    return [...this.state.repos]
  }

  async getRepo(slug: string): Promise<GitRepoSource | undefined> {
    await this.ensureLoaded()
    return this.state.repos.find((r) => r.slug === slug)
  }

  /** 新增仓库源；已存在同名 slug 则更新。 */
  async upsertRepo(raw: {
    url: string
    authId?: string
    description?: string
    defaultBranch?: string
    scenesPath?: string
    manifestPath?: string
    tags?: readonly string[]
  }): Promise<GitRepoSource> {
    await this.ensureLoaded()
    const slug = extractSlug(raw.url)
    if (slug === null) throw new Error('无法解析仓库 URL')
    const backend = detectBackend(raw.url)
    const apiBase = buildApiBase(raw.url, backend)

    const normalized: GitRepoSource = {
      slug,
      url: raw.url.trim(),
      apiBase,
      backend,
      authId: raw.authId,
      description: raw.description,
      defaultBranch: raw.defaultBranch ?? 'main',
      scenesPath: raw.scenesPath ?? 'scenes',
      manifestPath: raw.manifestPath ?? 'skill-manifest.json',
      tags: raw.tags,
    }

    const existing = this.state.repos.find((r) => r.slug === slug)
    if (existing !== undefined) {
      // 保留远端同步状态（lastCommitSha / lastCheckedAt / manifest）
      Object.assign(normalized, {
        lastCommitSha: existing.lastCommitSha,
        lastCheckedAt: existing.lastCheckedAt,
        manifest: existing.manifest,
      })
      const index = this.state.repos.indexOf(existing)
      this.state.repos[index] = normalized
    } else {
      this.state.repos.push(normalized)
    }
    await this.persist()
    return normalized
  }

  async removeRepo(slug: string): Promise<void> {
    await this.ensureLoaded()
    const index = this.state.repos.findIndex((r) => r.slug === slug)
    if (index !== -1) {
      this.state.repos.splice(index, 1)
      await this.persist()
    }
  }

  async updateRepoScanState(slug: string, patch: { lastCommitSha?: string; lastCheckedAt?: number; manifest?: RepoSkillManifest }): Promise<GitRepoSource | undefined> {
    await this.ensureLoaded()
    const repo = this.state.repos.find((r) => r.slug === slug)
    if (repo === undefined) return undefined
    if (patch.lastCommitSha !== undefined) repo.lastCommitSha = patch.lastCommitSha
    if (patch.lastCheckedAt !== undefined) repo.lastCheckedAt = patch.lastCheckedAt
    if (patch.manifest !== undefined) repo.manifest = patch.manifest
    await this.persist()
    return repo
  }

  // ── 内部 ──

  /** 读侧脱敏：token 置空。 */
  private sanitizeAuthForRead(auth: GitAuthRef): GitAuthRef {
    const copy = { ...auth }
    delete copy.token
    return copy
  }
}
