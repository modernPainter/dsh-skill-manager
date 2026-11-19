/**
 * 通用 Git HTTP 客户端 —— 替换 Hub 原有的 github-client.ts。
 *
 * 设计要点：
 *   - 通过仓库 URL 域名自动识别后端（GitHub / GitLab / Gitea / 通用 Git HTTP v2）
 *   - 统一 transport 层：fetchJson / fetchJsonRaw，上层按后端适配器组装 API URL
 *   - 认证：HTTPS + Bearer Token 是当前实现；SSH key 接口预留（type === 'ssh-key' 时报未实现）
 *   - 保留 Hub 原有的 ETag 缓存 / 速率限制识别 / 传输层重试 / 响应体上限 / 超时
 *
 * 后端 URL 映射规则（从 repo URL 解析 apiBase）：
 *   github.com     → https://api.github.com
 *   gitlab.com     → https://gitlab.com/api/v4
 *   gitea.com / 自建 Gitea → {host}/api/v1
 *   通用 Git HTTP  → {host}
 */

import { errorText } from '../error-text.ts'
import type { GitBackend, GitRepoSource } from '../protocol/git.ts'

// ───────────────────────────────────────────────────────────── 错误类型

/** Fetch failure carrying a useful HTTP status for the route layer. */
export class RepoFetchError extends Error {
  readonly status: number
  constructor(message: string, status = 502) {
    super(message)
    this.name = 'RepoFetchError'
    this.status = status
  }
}

// ───────────────────────────────────────────────────────────── 后端识别

/** 从仓库 URL 推断后端类型。 */
export function detectBackend(url: string): GitBackend {
  const host = extractHost(url).toLowerCase()
  if (host === 'github.com' || host.endsWith('.github.com')) return 'github'
  if (host === 'gitlab.com' || host.endsWith('.gitlab.com')) return 'gitlab'
  if (host.includes('gitea')) return 'gitea'
  return 'generic'
}

/** 从仓库 URL 提取 host（不含 scheme）。 */
export function extractHost(url: string): string {
  let value = url.trim()
  if (!/^https?:\/\//i.test(value)) value = 'https://' + value
  try {
    return new URL(value).hostname
  } catch {
    return ''
  }
}

/** 从仓库 URL 提取 slug（owner/repo 形式）。 */
export function extractSlug(url: string): string | null {
  const match = /^https?:\/\/[^/]+\/([^/#?]+\/[^/#?]+)/i.exec(url.trim())
  if (match === null) return null
  return match[1].replace(/\.git$/, '').replace(/\/+$/, '')
}

/** 根据后端类型和 host 组装 API base URL。 */
export function buildApiBase(url: string, backend: GitBackend): string {
  const host = extractHost(url)
  switch (backend) {
    case 'github':
      return 'https://api.github.com'
    case 'gitlab':
      return `https://${host}/api/v4`
    case 'gitea':
      return `https://${host}/api/v1`
    case 'generic':
      return `https://${host}`
  }
}

/** 规范化仓库源 —— 填充 backend / apiBase / defaultBranch 等字段。 */
export function normalizeRepoSource(raw: { url: string; backend?: GitBackend; defaultBranch?: string; scenesPath?: string; manifestPath?: string }): Omit<GitRepoSource, 'slug' | 'authId' | 'lastCommitSha' | 'lastCheckedAt' | 'manifest'> & { slug: string } {
  const url = raw.url.trim()
  const slug = extractSlug(url)
  if (slug === null) throw new RepoFetchError('无法解析仓库 URL：' + url, 400)
  const backend = raw.backend ?? detectBackend(url)
  const apiBase = buildApiBase(url, backend)
  return {
    slug,
    url,
    apiBase,
    backend,
    defaultBranch: raw.defaultBranch ?? 'main',
    scenesPath: raw.scenesPath ?? 'scenes',
    manifestPath: raw.manifestPath ?? 'skill-manifest.json',
  }
}

// ───────────────────────────────────────────────────────────── 认证

/** 当前活跃的 token（运行时可覆盖，每个请求按仓库源的 authId 查找）。 */
interface AuthStore {
  getToken(authId?: string): string
}
let authStore: AuthStore | null = null

/** 设置全局认证仓库（由上层 store 注入）。 */
export function setAuthStore(store: AuthStore): void {
  authStore = store
}

/** 为指定仓库源生成 Authorization header。 */
export function authHeaders(source: GitRepoSource): Record<string, string> {
  if (authStore === null) return {}
  const token = authStore.getToken(source.authId)
  if (token === '') return {}
  // GitHub / GitLab / Gitea 都用 Bearer token
  if (source.backend === 'github') return { authorization: `Bearer ${token}` }
  if (source.backend === 'gitlab') return { authorization: `Bearer ${token}` }
  if (source.backend === 'gitea') return { authorization: `token ${token}` }
  // generic Git HTTP：优先 Bearer，某些老后端用 Basic
  return { authorization: `Bearer ${token}` }
}

// ───────────────────────────────────────────────────────────── 传输层

/** 显式要求服务端返回未压缩实体 —— 代理场景规避 gzip/body 不匹配问题。 */
export const NO_COMPRESSION: Record<string, string> = { 'accept-encoding': 'identity' }

/** JSON API 默认请求头（含鉴权）。 */
export function apiHeaders(source: GitRepoSource, accept = 'application/json'): Record<string, string> {
  return { accept, ...NO_COMPRESSION, ...authHeaders(source) }
}

/** 原始文件下载请求头。 */
export function rawHeaders(source: GitRepoSource): Record<string, string> {
  return { ...NO_COMPRESSION, ...authHeaders(source) }
}

/** 后端速率限制识别 —— GitHub 403/429 + x-ratelimit-remaining；其他后端暂不识别。 */
export function rateLimitResetAt(response: Response, source: GitRepoSource): Date | undefined {
  if (source.backend !== 'github') return undefined
  if (response.status !== 403 && response.status !== 429) return undefined
  if (response.headers.get('x-ratelimit-remaining') !== '0') return undefined
  const reset = response.headers.get('x-ratelimit-reset')
  if (reset === null) return undefined
  const at = new Date(Number(reset) * 1000)
  return Number.isNaN(at.getTime()) ? undefined : at
}

/**
 * Build a RepoFetchError; when the response shows an exhausted rate limit,
 * report the reset time instead of a bare HTTP status.
 */
export function fetchError(context: string, response: Response, source: GitRepoSource, fallbackStatus = 502): RepoFetchError {
  const resetAt = rateLimitResetAt(response, source)
  if (resetAt !== undefined) {
    return new RepoFetchError(
      'rate limit reached (' + source.backend + '); retry after ' + resetAt.toLocaleTimeString(),
      403,
    )
  }
  return new RepoFetchError(context + ' (HTTP ' + response.status + ')', response.status === 404 ? 404 : fallbackStatus)
}

/** 是否限流/中断类错误。 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError' || error.message.includes('aborted') || error.message.includes('Abort'))
}

/** Hard cap on any Git API response body. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

/** Read a response body under a byte ceiling. */
export async function readBoundedResponse(response: Response, limit = MAX_RESPONSE_BYTES): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > limit) {
    throw new RepoFetchError('response exceeds the ' + limit + ' byte limit')
  }
  if (response.body === null) return Buffer.from(await response.arrayBuffer())
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => undefined)
        throw new RepoFetchError('response exceeds the ' + limit + ' byte limit')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

/** Parse a bounded JSON response. */
export async function readBoundedJson(response: Response): Promise<unknown> {
  const buffer = await readBoundedResponse(response)
  try {
    return JSON.parse(buffer.toString('utf8')) as unknown
  } catch {
    throw new Error('invalid JSON in response')
  }
}

/** Hard bound on every outbound request. */
export const REQUEST_TIMEOUT_MS = 30_000

/** Combine an optional caller signal with the per-request timeout. */
export function requestSignal(external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  return external !== undefined ? AbortSignal.any([external, timeout]) : timeout
}

/** 传输层抖动重试 —— 只对瞬时网络异常重试，不重试 HTTP 状态码。 */
const TRANSIENT_ATTEMPTS = 3
const TRANSIENT_BACKOFF_MS = [150, 400] as const

function isPermanentNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const cause = (error as Error & { cause?: unknown }).cause
  const causeText = cause instanceof Error
    ? cause.message + ' ' + String((cause as Error & { code?: unknown }).code ?? '')
    : typeof cause === 'object' && cause !== null ? String((cause as { code?: unknown }).code ?? '') : String(cause ?? '')
  return /ENOTFOUND|EAI_NONAME|ERR_INVALID_URL|Invalid URL|CERT_|SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE/i.test(error.message + ' ' + causeText)
}

async function sleepBeforeRetry(attempt: number): Promise<boolean> {
  const backoff = TRANSIENT_BACKOFF_MS[attempt]
  if (backoff === undefined) return false
  await new Promise((resolve) => setTimeout(resolve, backoff))
  return true
}

async function fetchWithRetry(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, context: string, signal?: AbortSignal): Promise<Response> {
  let last: unknown
  for (let attempt = 0; attempt < TRANSIENT_ATTEMPTS; attempt += 1) {
    try {
      return await fetchImpl(url, { headers, signal: requestSignal(signal) })
    } catch (error) {
      if (isAbortError(error)) throw error
      if (isPermanentNetworkError(error)) throw new RepoFetchError(context + ': ' + errorText(error))
      last = error
      if (!(await sleepBeforeRetry(attempt))) break
    }
  }
  throw new RepoFetchError(context + ': ' + errorText(last))
}

/** 不带缓存的统一 GET+JSON。 */
export async function fetchJson(
  url: string,
  source: GitRepoSource,
  context: string,
  fetchImpl: typeof fetch = fetch,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ json: unknown; response: Response }> {
  const finalHeaders = headers ?? apiHeaders(source)
  for (let attempt = 0; attempt < TRANSIENT_ATTEMPTS; attempt += 1) {
    const response = await fetchWithRetry(fetchImpl, url, finalHeaders, context, signal)
    if (!response.ok) throw fetchError(context, response, source)
    try {
      return { json: await readBoundedJson(response), response }
    } catch (error) {
      if (isAbortError(error) || error instanceof RepoFetchError) throw error
      if (!(await sleepBeforeRetry(attempt))) break
    }
  }
  throw new RepoFetchError('invalid response for ' + url)
}

/** 读取原始文件内容（Buffer）。 */
export async function fetchRaw(
  url: string,
  source: GitRepoSource,
  context: string,
  fetchImpl: typeof fetch = fetch,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<Buffer> {
  const finalHeaders = headers ?? rawHeaders(source)
  const response = await fetchWithRetry(fetchImpl, url, finalHeaders, context, signal)
  if (!response.ok) throw fetchError(context, response, source)
  return readBoundedResponse(response)
}

// ───────────────────────────────────────────────────────────── 后端特定 URL 组装

/** 仓库内容 API —— 各后端映射。 */
export function apiUrl(
  source: GitRepoSource,
  /** API 类型。 */
  kind: 'branch-default' | 'branch-head' | 'commit' | 'tree' | 'contents' | 'file-raw',
  params: { ref?: string; path?: string; treeSha?: string } = {},
): string {
  const { apiBase, slug, backend } = source
  const ref = params.ref ?? source.defaultBranch
  const encodedPath = params.path === undefined ? '' : params.path.split('/').map(encodeURIComponent).join('/')

  switch (backend) {
    case 'github': {
      switch (kind) {
        case 'branch-default':
        case 'branch-head':
          return `${apiBase}/repos/${slug}/branches/${encodeURIComponent(ref)}`
        case 'commit':
          return `${apiBase}/repos/${slug}/commits/${encodeURIComponent(ref)}`
        case 'tree': {
          const treeSha = params.treeSha ?? ref
          return `${apiBase}/repos/${slug}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`
        }
        case 'contents':
          return `${apiBase}/repos/${slug}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`
        case 'file-raw':
          return `https://raw.githubusercontent.com/${slug}/${encodeURIComponent(ref)}/${encodedPath}`
      }
      break
    }
    case 'gitlab': {
      const projectId = encodeURIComponent(slug)
      switch (kind) {
        case 'branch-default':
        case 'branch-head':
          return `${apiBase}/projects/${projectId}/repository/branches/${encodeURIComponent(ref)}`
        case 'commit':
          return `${apiBase}/projects/${projectId}/repository/commits/${encodeURIComponent(ref)}`
        case 'tree': {
          const treeRef = params.treeSha ?? ref
          return `${apiBase}/projects/${projectId}/repository/tree?ref=${encodeURIComponent(treeRef)}&recursive=true&per_page=100`
        }
        case 'contents':
        case 'file-raw':
          return `${apiBase}/projects/${projectId}/repository/files/${encodedPath}?ref=${encodeURIComponent(ref)}`
      }
      break
    }
    case 'gitea': {
      switch (kind) {
        case 'branch-default':
        case 'branch-head':
          return `${apiBase}/repos/${slug}/branches/${encodeURIComponent(ref)}`
        case 'commit':
          return `${apiBase}/repos/${slug}/commits/${encodeURIComponent(ref)}`
        case 'tree': {
          const treeRef = params.treeSha ?? ref
          return `${apiBase}/repos/${slug}/git/trees/${encodeURIComponent(treeRef)}?recursive=1`
        }
        case 'contents':
          return `${apiBase}/repos/${slug}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`
        case 'file-raw':
          return `${apiBase}/${slug}/raw/${encodeURIComponent(ref)}/${encodedPath}`
      }
      break
    }
    case 'generic': {
      // 通用 Git HTTP：优先尝试 GitHub 风格（最常见的自建 Gitea/GitLab 都兼容一部分）
      switch (kind) {
        case 'file-raw':
          return `https://${extractHost(source.url)}/${slug}/raw/${encodeURIComponent(ref)}/${encodedPath}`
        default:
          // 退回 GitHub 风格 API
          return `${apiBase}/repos/${slug}/commits/${encodeURIComponent(ref)}`
      }
    }
  }
  throw new RepoFetchError(`unsupported kind ${kind} for backend ${backend}`, 500)
}
