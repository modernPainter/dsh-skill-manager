/**
 * 自有 Git 仓库的浏览器端 API 客户端。
 *
 * 与 api.ts 相同的出行约定：同源 fetch、写操作带 CSRF 标记头、
 * 路径经 resolveApiUrl 处理反向代理前缀、出网接口用更长超时。
 */

import {
  SKILL_HUB_WRITE_HEADER,
  SKILL_HUB_WRITE_VALUE,
  SKILL_MANAGER_API,
  type GitAuthRef,
  type GitRepoSource,
  type RepoScanResult,
} from '../protocol.ts'
import { SkillHubApiError, resolveApiUrl } from './api.ts'

const LOCAL_TIMEOUT_MS = 15_000
const NETWORK_TIMEOUT_MS = 90_000
const INSTALL_TIMEOUT_MS = 120_000

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = LOCAL_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs)
  try {
    const response = await fetch(resolveApiUrl(path), { ...init, signal: controller.signal })
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new SkillHubApiError('HTTP ' + response.status + ': invalid JSON response')
    }
    if (!response.ok || (typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === false)) {
      const message = typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : 'HTTP ' + response.status
      throw new SkillHubApiError(message)
    }
    return body as T
  } catch (error) {
    if (controller.signal.aborted) throw new SkillHubApiError('请求超时（' + Math.round(timeoutMs / 1000) + 's）')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function post<T>(path: string, payload: unknown, timeoutMs = NETWORK_TIMEOUT_MS): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SKILL_HUB_WRITE_HEADER]: SKILL_HUB_WRITE_VALUE },
    body: JSON.stringify(payload),
  }, timeoutMs)
}

function get<T>(path: string, params: Record<string, string | undefined>, timeoutMs = NETWORK_TIMEOUT_MS): Promise<T> {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, value)
  const suffix = query.size > 0 ? '?' + query.toString() : ''
  return request<T>(path + suffix, {}, timeoutMs)
}

export interface ReposPayload {
  ok: true
  repos: GitRepoSource[]
  auths: GitAuthRef[]
}

export interface InstallProgress {
  ok: true
  jobId: string
  status: 'running' | 'done' | 'cancelled' | 'error'
  total: number
  done: number
  current?: string
  installed: Array<{ name: string; path: string }>
  skipped: Array<{ name: string; reason: string }>
  failed: Array<{ name: string; error: string }>
  overwritten: string[]
  error?: string
}

export interface UploadResult {
  ok: true
  branch: string
  commitSha: string
  uploaded: string[]
  rejected: Array<{ name: string; reason: string }>
  fileCount: number
}

/** 云效公共技能库的一条技能（列表接口只给名字与仓库内路径）。 */
export interface PublicSkillEntry {
  name: string
  path: string
}

export interface PublicSkillsPayload {
  ok: true
  ref: string
  fileCount: number
  skills: PublicSkillEntry[]
}

export interface PublicInstallResult {
  ok: boolean
  name: string
  status: 'installed' | 'skipped' | 'failed'
  error?: string
  replaced?: boolean
  warnings?: Array<{ rule: string; severity: 'warn'; file: string; line?: number; message: string }>
}

export const managerApi = {
  listRepos: () => get<ReposPayload>(SKILL_MANAGER_API.repos, {}, LOCAL_TIMEOUT_MS),
  addRepo: (input: { url: string; authId?: string; description?: string; defaultBranch?: string; manifestPath?: string }) =>
    post<ReposPayload & { repo: GitRepoSource }>(SKILL_MANAGER_API.repos, input),
  deleteRepo: (slug: string) => post<ReposPayload>(SKILL_MANAGER_API.repoDelete, { slug }),
  testRepo: (slug: string) => get<{ ok: boolean; backend?: string; defaultBranch?: string; error?: string }>(SKILL_MANAGER_API.repoTest, { slug }, NETWORK_TIMEOUT_MS),
  scanRepo: (slug: string, ref?: string) => get<RepoScanResult & { ok: true; fileCount: number }>(SKILL_MANAGER_API.repoScan, { slug, ref }, NETWORK_TIMEOUT_MS),
  install: (input: { slug: string; ref?: string; names: string[]; overwrite?: boolean; allowLocalOverwrite?: boolean }) =>
    post<{ ok: true; jobId: string; total: number; commitSha: string }>(SKILL_MANAGER_API.repoInstall, input, INSTALL_TIMEOUT_MS),
  installProgress: (jobId: string) => get<InstallProgress>(SKILL_MANAGER_API.repoInstallProgress, { jobId }, LOCAL_TIMEOUT_MS),
  cancelInstall: (jobId: string) => post<{ ok: true; status: string }>(SKILL_MANAGER_API.repoInstallCancel, { jobId }),
  upload: (input: { slug: string; names: string[]; branch?: string; dir?: string; version?: string }) =>
    post<UploadResult>(SKILL_MANAGER_API.repoUpload, input),
  addAuth: (label: string, token: string) => post<{ ok: true; auth: GitAuthRef }>(SKILL_MANAGER_API.auths, { label, token, type: 'https-token' }),
  deleteAuth: (id: string) => post<ReposPayload>(SKILL_MANAGER_API.authDelete, { id }),
  listPublicSkills: () => get<PublicSkillsPayload>(SKILL_MANAGER_API.publicSkills, {}, LOCAL_TIMEOUT_MS),
  installPublicSkill: (name: string, overwrite: boolean) => post<PublicInstallResult>(SKILL_MANAGER_API.publicInstall, { name, overwrite }, NETWORK_TIMEOUT_MS),
}
