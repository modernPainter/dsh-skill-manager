/**
 * 自有仓库 skill 下载与落地 —— 通用 Git HTTP 客户端下载 + Hub 原有的审计/临时目录/原子 rename 流程。
 *
 * 复用 Hub 的：
 *   - 内容审计（skillfs/audit.ts）
 *   - 临时目录 + 原子 rename
 *   - 启动时清理残留临时目录
 *
 * 替换 Hub 的：
 *   - downloadGitHubFile → 通用 downloadRepoFile（通过 git-client.ts 的 apiUrl 组装后端特定 URL）
 */

import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { GitRepoSource, RepoSkillManifestEntry } from '../protocol/git.ts'
import { errorText } from '../error-text.ts'
import { mapConcurrent } from '../concurrency.ts'
import { parseFrontmatter } from '../skillfs.ts'
import { asAuditText, auditSkillBundle, blockingReason, MAX_SKILL_FILE_BYTES, type AuditBundleFile } from '../skillfs/audit.ts'
import { RepoFetchError, apiUrl, fetchJson, fetchRaw } from './git-client.ts'

/**
 * 下载仓库内的单个文件。
 * 优先级：后端原生 raw URL（如 GitHub raw.githubusercontent.com）→ API contents endpoint → 通用 contents API。
 */
export async function downloadRepoFile(
  source: GitRepoSource,
  ref: string,
  path: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

  const context = `download ${path} from ${source.slug}@${ref}`

  // GitLab 的 raw 路由返回的是文件元数据 JSON，必须先走 files API 再 base64 解码。
  if (source.backend === 'gitlab') {
    const { json } = await fetchJson(apiUrl(source, 'contents', { ref, path }), source, context, fetchImpl, undefined, signal)
    const obj = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>
    const content = typeof obj.content === 'string' ? obj.content : ''
    if (content === '') throw new RepoFetchError(context + ': no content field in GitLab API response', 422)
    return Buffer.from(content, 'base64')
  }

  // 方案 1：后端原生 raw URL（GitHub / Gitea / generic 的自建 raw 路由）
  const rawUrl = apiUrl(source, 'file-raw', { ref, path })
  try {
    const buffer = await fetchRaw(rawUrl, source, context, fetchImpl, undefined, signal)
    if (buffer.length > 0) return buffer
  } catch (error) {
    // raw URL 失败 → 继续尝试 API endpoint
    if (error instanceof DOMException && error.name === 'AbortError') throw error
  }

  // 方案 2：contents API（GitHub / Gitea 返回 { content: base64, encoding }）
  const contentsUrl = apiUrl(source, 'contents', { ref, path })
  const { json } = await fetchJson(contentsUrl, source, context, fetchImpl, undefined, signal)

  const obj = json as Record<string, unknown>
  if (Array.isArray(obj)) {
    throw new RepoFetchError(context + ': path is a directory, not a file', 422)
  }
  const content = typeof obj.content === 'string' ? obj.content : ''
  const encoding = typeof obj.encoding === 'string' ? obj.encoding : 'base64'
  if (content !== '' && (encoding === 'base64' || encoding === '')) {
    return Buffer.from(content.replace(/\n/g, ''), 'base64')
  }

  throw new RepoFetchError(context + ': download failed (raw + API both unreachable)', 502)
}

/**
 * 下载完整 skill 目录 —— 需要先获取该 skill 目录下的所有文件列表。
 *
 * 步骤：
 *   1. 通过仓库树 API 获取指定 ref 的递归文件列表
 *   2. 过滤出 skill.path 下的所有 blob
 *   3. 并发下载每个文件到临时目录
 *   4. 审计 + frontmatter 校验 + 原子 rename
 *
 * 与 Hub 原 downloadRepoSkill 的区别：
 *   - 参数从 RepoSkillEntry 改为 RepoSkillManifestEntry + GitRepoSource
 *   - 仓库树获取改为后端适配（apiUrl('tree', ...)）
 */
export async function downloadRepoSkill(
  source: GitRepoSource,
  ref: string,
  entry: RepoSkillManifestEntry,
  /** skill.path 下要下载的文件列表（从仓库树过滤而来）。 */
  files: readonly { path: string; size: number }[],
  targetRoot: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  onProgress?: (bytes: number, file: string) => void,
): Promise<{ targetDir: string; skillPath: string }> {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

  const context = `install ${entry.name} from ${source.slug}@${ref}`

  // 预检：用 manifest + tree size 做预算检查
  const preflight = blockingReason(auditSkillBundle(files.map((file) => ({ path: file.path.slice(entry.path.length + 1), size: file.size }))))
  if (preflight !== undefined) throw new RepoFetchError(preflight, 422)

  const targetDir = join(targetRoot, entry.name)
  await mkdir(targetRoot, { recursive: true })

  const tempDir = await mkdtemp(join(targetRoot, '.' + entry.name + '.import-'))
  let renamed = false
  try {
    const audited: AuditBundleFile[] = []
    await mapConcurrent(files, 6, async (file) => {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

      // file.path 是仓库完整路径（如 skills/code-review/SKILL.md）
      // 去掉 entry.path 前缀拿到 skill 内相对路径
      const relative = file.path.startsWith(entry.path + '/') ? file.path.slice(entry.path.length + 1) : file.path
      if (relative === '' || relative.includes('..')) throw new RepoFetchError('unsafe repo path: ' + file.path, 422)

      const target = join(tempDir, relative)
      const buffer = await downloadRepoFile(source, ref, file.path, fetchImpl, signal)
      if (buffer.length > MAX_SKILL_FILE_BYTES) {
        throw new RepoFetchError(`skill rejected by content audit: ${relative} is ${buffer.length} bytes, over the per-file limit`, 422)
      }

      const normalized = asAuditText(relative, buffer)
      audited.push({
        path: relative,
        size: buffer.length,
        ...(normalized !== undefined ? { text: normalized.text, ...(normalized.disguised ? { disguised: true } : {}) } : {}),
      })

      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, buffer)
      onProgress?.(buffer.length, relative)
    })

    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

    let text: string
    try {
      text = await readFile(join(tempDir, 'SKILL.md'), 'utf8')
    } catch {
      throw new RepoFetchError(context + ': downloaded skill has no SKILL.md', 422)
    }
    const parsed = parseFrontmatter(text)
    if ('error' in parsed) throw new RepoFetchError(context + ': downloaded skill rejected: ' + parsed.error, 422)
    if (parsed.value.name !== entry.name) {
      throw new RepoFetchError(context + ': downloaded skill declares name "' + parsed.value.name + '", expected "' + entry.name + '"', 422)
    }

    const blocked = blockingReason(auditSkillBundle(audited, parsed.value.description))
    if (blocked !== undefined) throw new RepoFetchError(blocked, 422)

    await rename(tempDir, targetDir)
    renamed = true
    return { targetDir, skillPath: join(targetDir, 'SKILL.md') }
  } finally {
    if (!renamed) {
      try {
        await rm(tempDir, { recursive: true, force: true })
      } catch (firstError) {
        await new Promise((resolve) => setTimeout(resolve, 60))
        try {
          await rm(tempDir, { recursive: true, force: true })
        } catch (secondError) {
          console.warn(`[dsh-skill-manager] cleanup tempDir failed ${tempDir}:`, errorText(secondError), 'first:', errorText(firstError))
        }
      }
    }
  }
}

/** 启动时清理残留临时目录（复用 Hub 的同名函数）。 */
export async function cleanupLeftoverImportDirs(targetRoot: string): Promise<number> {
  const { readdir, rm: rm2 } = await import('node:fs/promises')
  let names: string[]
  try {
    names = await readdir(targetRoot)
  } catch {
    return 0
  }
  let cleaned = 0
  for (const name of names) {
    if (!/^\..*\.(?:import|install|foreign)-/.test(name)) continue
    const full = join(targetRoot, name)
    try {
      await rm2(full, { recursive: true, force: true })
      cleaned += 1
    } catch (error) {
      console.warn(`[dsh-skill-manager] startup cleanup failed ${full}:`, errorText(error))
    }
  }
  if (cleaned > 0) console.warn(`[dsh-skill-manager] startup cleaned ${cleaned} leftover import temp dir(s) in ${targetRoot}`)
  return cleaned
}
