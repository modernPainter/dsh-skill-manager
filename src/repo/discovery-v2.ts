/**
 * 自有仓库 manifest 解析 + 技能发现 —— 替代 Hub 原有的 GitHub tree 驱动逻辑。
 *
 * 优先级：
 *   1. 读取 skill-manifest.json（仓库根目录），从中列出 skill
 *   2. 如果 manifest 不存在或无法解析，fallback 到目录扫描（从仓库树识别 `<dir>/SKILL.md`）
 *   3. 两者合并去重（manifest 优先）
 */

import { isSkillName } from '@deepseek-ai/dsh-skill'
import type { GitRepoSource, RepoSkillManifest, RepoSkillManifestEntry } from '../protocol/git.ts'
import { apiUrl, fetchJson, RepoFetchError } from './git-client.ts'

// ───────────────────────────────────────────────────────────── 仓库树读取

/** 把各后端 `tree` / `contents` 的返回统一成 `{ path, size }` blob 列表。 */
export function normalizeTreeJson(json: unknown): Array<{ path: string; size: number }> {
  const blobs: Array<{ path: string; size: number }> = []
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (typeof value !== 'object' || value === null) return
    const obj = value as Record<string, unknown>
    // GitHub/Gitea recursive tree 包在 { tree: [...] } 里。
    if (Array.isArray(obj.tree)) {
      walk(obj.tree)
      return
    }
    const path = typeof obj.path === 'string' ? obj.path : ''
    if (path === '') return
    const type = typeof obj.type === 'string' ? obj.type : ''
    // GitLab 与 GitHub 用 blob/tree，Gitea contents 用 file/dir。
    if (type !== '' && type !== 'blob' && type !== 'file') return
    blobs.push({ path, size: typeof obj.size === 'number' ? obj.size : 0 })
  }
  walk(json)
  return blobs
}

/** GitLab 单次 tree 请求最多 100 条，超过必须翻页，否则技能清单会被静默截断。 */
const GITLAB_TREE_MAX_PAGES = 50

/** 云效 tree 接口只列一层，且不受 recursive 参数影响 —— 只能逐层下钻。 */
const CODEUP_TREE_PAGE_SIZE = 1000
const CODEUP_TREE_MAX_DIRS = 2000

/** 解析云效 tree 接口的单层条目。 */
function codeupTreeEntries(json: unknown): Array<{ path: string; type: string; size: number }> {
  if (!Array.isArray(json)) return []
  const entries: Array<{ path: string; type: string; size: number }> = []
  for (const item of json) {
    if (typeof item !== 'object' || item === null) continue
    const obj = item as Record<string, unknown>
    const path = typeof obj.path === 'string' ? obj.path : ''
    if (path === '') continue
    entries.push({
      path,
      type: typeof obj.type === 'string' ? obj.type : 'blob',
      size: typeof obj.size === 'number' ? obj.size : 0,
    })
  }
  return entries
}

/** 云效：先列目录再逐级下钻，结果与 GitHub 的递归 tree 对齐。 */
async function fetchCodeupTreeBlobs(source: GitRepoSource, ref: string): Promise<Array<{ path: string; size: number }>> {
  const blobs: Array<{ path: string; size: number }> = []
  const queue: string[] = ['']
  let visited = 0
  while (queue.length > 0 && visited < CODEUP_TREE_MAX_DIRS) {
    const dir = queue.shift() ?? ''
    visited += 1
    for (let page = 1; page <= GITLAB_TREE_MAX_PAGES; page += 1) {
      const url = apiUrl(source, 'tree', { ref, path: dir }) + `&page=${page}&perPage=${CODEUP_TREE_PAGE_SIZE}`
      const { json, response } = await fetchJson(url, source, `tree ${source.slug}@${ref} ${dir === '' ? '/' : dir} page ${page}`)
      for (const entry of codeupTreeEntries(json)) {
        if (entry.type === 'tree') queue.push(entry.path)
        else blobs.push({ path: entry.path, size: entry.size })
      }
      const next = Number(response.headers.get('x-next-page') ?? '')
      if (!Number.isFinite(next) || next <= page) break
    }
  }
  return blobs
}

/** 读取指定 ref 的完整 blob 清单（含后端适配与分页）。 */
export async function fetchRepoTreeBlobs(source: GitRepoSource, ref: string, treeSha?: string): Promise<Array<{ path: string; size: number }>> {
  if (source.backend === 'codeup') return fetchCodeupTreeBlobs(source, ref)
  if (source.backend !== 'gitlab') {
    const { json } = await fetchJson(apiUrl(source, 'tree', { ref, ...(treeSha !== undefined ? { treeSha } : {}) }), source, `tree ${source.slug}@${ref}`)
    return normalizeTreeJson(json)
  }

  // GitLab 的 tree 路由按 x-next-page 翻页。
  const treeRef = treeSha ?? ref
  const blobs: Array<{ path: string; size: number }> = []
  for (let page = 1; page <= GITLAB_TREE_MAX_PAGES; page += 1) {
    const url = `${source.apiBase}/projects/${encodeURIComponent(source.slug)}/repository/tree?ref=${encodeURIComponent(treeRef)}&recursive=true&per_page=100&page=${page}`
    const { json, response } = await fetchJson(url, source, `tree ${source.slug}@${treeRef} page ${page}`)
    blobs.push(...normalizeTreeJson(json))
    const next = Number(response.headers.get('x-next-page') ?? '')
    if (!Number.isFinite(next) || next <= page) break
  }
  return blobs
}

// ───────────────────────────────────────────────────────────── manifest 解析

/** 解析 skill-manifest.json 文本。 */
export function parseManifest(text: string): RepoSkillManifest {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new RepoFetchError('skill-manifest.json is not valid JSON: ' + (error instanceof Error ? error.message : String(error)), 422)
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new RepoFetchError('skill-manifest.json must be a JSON object', 422)
  }
  const obj = data as Record<string, unknown>

  const skillsRaw = obj.skills
  if (!Array.isArray(skillsRaw)) {
    throw new RepoFetchError('skill-manifest.json: "skills" must be an array', 422)
  }

  const skills: RepoSkillManifestEntry[] = []
  for (const item of skillsRaw) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    const path = typeof entry.path === 'string' ? entry.path.trim() : ''
    if (name === '' || path === '') continue
    if (!isSkillName(name)) continue

    const version = typeof entry.version === 'string' ? entry.version : undefined
    const description = typeof entry.description === 'string' ? entry.description : undefined
    const tags = Array.isArray(entry.tags) ? entry.tags.filter((t): t is string => typeof t === 'string') : undefined
    const auditHash = typeof entry.auditHash === 'string' ? entry.auditHash : undefined

    skills.push({ name, path, ...(version !== undefined ? { version } : {}), ...(description !== undefined ? { description } : {}), ...(tags !== undefined ? { tags } : {}), ...(auditHash !== undefined ? { auditHash } : {}) })
  }

  return {
    schemaVersion: typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 1,
    name: typeof obj.name === 'string' ? obj.name.trim() : '',
    ...(typeof obj.description === 'string' ? { description: obj.description } : {}),
    ...(typeof obj.defaultBranch === 'string' ? { defaultBranch: obj.defaultBranch } : {}),
    ...(Array.isArray(obj.tags) ? { tags: obj.tags.filter((t): t is string => typeof t === 'string') } : {}),
    skills,
  }
}

// ───────────────────────────────────────────────────────────── fallback 目录扫描

/**
 * 从仓库树 blob 列表 fallback 扫描识别 skill 目录。
 * 与 Hub 原 discovery.ts 的 discoverRepoEntries 逻辑一致，但返回 manifest 条目格式。
 */
export function scanFromTree(treeBlobs: readonly { path: string; size?: number }[]): RepoSkillManifestEntry[] {
  const seen = new Set<string>()
  const skills: RepoSkillManifestEntry[] = []

  for (const item of treeBlobs) {
    // 跳过根目录 SKILL.md（那是 repo-root skill，我们不支持这种模式，强制要求目录结构）
    if (!item.path.includes('/')) continue
    if (!item.path.endsWith('/SKILL.md')) continue

    // 提取 skill 目录路径：去掉 /SKILL.md 后缀
    // 允许 `<name>/SKILL.md`（仓库根目录直接放技能目录）与 `<group>/<name>/SKILL.md` 两种布局。
    const dir = item.path.slice(0, -'/SKILL.md'.length)

    // 提取名字：最后一段
    const slash = dir.lastIndexOf('/')
    const name = slash >= 0 ? dir.slice(slash + 1) : dir

    if (!isSkillName(name)) continue
    if (seen.has(dir)) continue
    seen.add(dir)

    skills.push({
      name,
      path: dir,
    })
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

// ───────────────────────────────────────────────────────────── 合并

/** 合并 manifest 条目（优先）与 fallback 扫描条目（去重按 name）。 */
export function mergeManifestAndScan(manifestEntries: readonly RepoSkillManifestEntry[], scanEntries: readonly RepoSkillManifestEntry[]): RepoSkillManifestEntry[] {
  const result: RepoSkillManifestEntry[] = [...manifestEntries]
  const seen = new Set(manifestEntries.map((e) => e.name))
  for (const entry of scanEntries) {
    if (!seen.has(entry.name)) {
      result.push(entry)
      seen.add(entry.name)
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}
