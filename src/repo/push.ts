/**
 * 推送到自有 Git 仓库 —— 上传与增量合并共用。
 *
 * 覆盖三种后端：
 *   - GitHub / Gitea：Git Data API（建 blob → 建 tree → 建 commit → 移分支）
 *   - GitLab：Commits API（一次提交携带多文件 action）
 *   - generic：明确报「不支持写入」，不静默降级
 *
 * 安全：Authorization 只出现在请求头，绝不进入错误信息或日志。
 */

import { errorText } from '../error-text.ts'
import type { GitRepoSource } from '../protocol/git.ts'
import { fetchRepoTreeBlobs } from './discovery-v2.ts'
import {
  NO_COMPRESSION,
  RepoFetchError,
  authHeaders,
  requestSignal,
  readBoundedJson,
  fetchJson,
  fetchRaw,
  apiUrl,
} from './git-client.ts'

/** 一个待写入仓库的文件（路径相对仓库根）。 */
export interface PushFile {
  path: string
  content: Buffer
}

export interface PushResult {
  commitSha: string
  branch: string
}

/** 是否为合法 UTF-8（决定用文本还是 base64 传输）。 */
function isUtf8(buffer: Buffer): boolean {
  const text = buffer.toString('utf8')
  return Buffer.from(text, 'utf8').equals(buffer)
}

async function postJson(
  source: GitRepoSource,
  url: string,
  method: 'POST' | 'PATCH' | 'PUT',
  payload: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    ...NO_COMPRESSION,
    ...authHeaders(source),
  }
  const response = await fetch(url, {
    method,
    headers,
    body: JSON.stringify(payload),
    signal: requestSignal(),
  })
  if (!response.ok) {
    // 读一小段响应体用于诊断，但绝不回显含凭据的请求头。
    let detail = ''
    try {
      const text = await response.text()
      detail = text.slice(0, 300)
    } catch {
      // ignore
    }
    throw new RepoFetchError(`push failed (HTTP ${response.status})${detail !== '' ? ': ' + detail : ''}`, response.status === 401 || response.status === 403 ? 403 : 502)
  }
  return readBoundedJson(response)
}

/** 读取分支当前 head commit SHA。 */
async function headSha(source: GitRepoSource, branch: string): Promise<{ commitSha: string; treeSha: string }> {
  if (source.backend === 'gitlab') {
    const { json } = await fetchJson(
      `${source.apiBase}/projects/${encodeURIComponent(source.slug)}/repository/branches/${encodeURIComponent(branch)}`,
      source,
      `branch ${branch}`,
    )
    const obj = json as Record<string, unknown>
    const commit = obj.commit as Record<string, unknown> | undefined
    const commitSha = typeof commit?.id === 'string' ? commit.id : ''
    if (commitSha === '') throw new RepoFetchError('cannot resolve branch head: ' + branch, 404)
    return { commitSha, treeSha: '' }
  }

  // GitHub / Gitea
  const { json: refJson } = await fetchJson(
    `${source.apiBase}/repos/${source.slug}/git/ref/heads/${encodeURIComponent(branch)}`,
    source,
    `ref ${branch}`,
  )
  const refObj = refJson as Record<string, unknown>
  const object = refObj.object as Record<string, unknown> | undefined
  const commitSha = typeof object?.sha === 'string' ? object.sha : ''
  if (commitSha === '') throw new RepoFetchError('cannot resolve branch head: ' + branch, 404)

  const { json: commitJson } = await fetchJson(
    `${source.apiBase}/repos/${source.slug}/git/commits/${commitSha}`,
    source,
    `commit ${commitSha}`,
  )
  const commitObj = commitJson as Record<string, unknown>
  const tree = commitObj.tree as Record<string, unknown> | undefined
  return { commitSha, treeSha: typeof tree?.sha === 'string' ? tree.sha : '' }
}

/** GitHub / Gitea：Git Data API 提交。 */
async function pushGitData(source: GitRepoSource, branch: string, files: readonly PushFile[], message: string): Promise<PushResult> {
  const { commitSha: parentSha, treeSha: baseTree } = await headSha(source, branch)

  const treeEntries: Array<Record<string, unknown>> = []
  for (const file of files) {
    const utf8 = isUtf8(file.content)
    if (utf8) {
      treeEntries.push({ path: file.path, mode: '100644', type: 'blob', content: file.content.toString('utf8') })
      continue
    }
    // 二进制：单独建 blob 再引用。
    const blob = await postJson(source, `${source.apiBase}/repos/${source.slug}/git/blobs`, 'POST', {
      content: file.content.toString('base64'),
      encoding: 'base64',
    })
    const sha = typeof (blob as Record<string, unknown>).sha === 'string' ? (blob as Record<string, unknown>).sha as string : ''
    if (sha === '') throw new RepoFetchError('blob creation returned no sha for ' + file.path, 502)
    treeEntries.push({ path: file.path, mode: '100644', type: 'blob', sha })
  }

  const tree = await postJson(source, `${source.apiBase}/repos/${source.slug}/git/trees`, 'POST', {
    ...(baseTree !== '' ? { base_tree: baseTree } : {}),
    tree: treeEntries,
  })
  const newTreeSha = typeof (tree as Record<string, unknown>).sha === 'string' ? (tree as Record<string, unknown>).sha as string : ''
  if (newTreeSha === '') throw new RepoFetchError('tree creation returned no sha', 502)

  const commit = await postJson(source, `${source.apiBase}/repos/${source.slug}/git/commits`, 'POST', {
    message,
    tree: newTreeSha,
    parents: [parentSha],
  })
  const newCommitSha = typeof (commit as Record<string, unknown>).sha === 'string' ? (commit as Record<string, unknown>).sha as string : ''
  if (newCommitSha === '') throw new RepoFetchError('commit creation returned no sha', 502)

  // 非强制移动分支：并发写入时由服务端拒绝，而不是覆盖别人的提交。
  await postJson(source, `${source.apiBase}/repos/${source.slug}/git/refs/heads/${encodeURIComponent(branch)}`, 'PATCH', {
    sha: newCommitSha,
    force: false,
  })
  return { commitSha: newCommitSha, branch }
}

/** GitLab：Commits API 一次提交多文件。 */
async function pushGitLab(source: GitRepoSource, branch: string, files: readonly PushFile[], message: string): Promise<PushResult> {
  const projectId = encodeURIComponent(source.slug)

  // 已存在文件必须用 update，否则服务端 400。逐个探测成本高，改为先拉树（含分页）。
  const existing = new Set<string>()
  try {
    for (const item of await fetchRepoTreeBlobs(source, branch)) existing.add(item.path)
  } catch {
    // 空仓库/首提交：按全部 create 处理，服务端会给出真实原因。
  }

  const actions = files.map((file) => ({
    action: existing.has(file.path) ? 'update' : 'create',
    file_path: file.path,
    content: isUtf8(file.content) ? file.content.toString('utf8') : file.content.toString('base64'),
    encoding: isUtf8(file.content) ? 'text' : 'base64',
  }))

  const result = await postJson(source, `${source.apiBase}/projects/${projectId}/repository/commits`, 'POST', {
    branch,
    commit_message: message,
    actions,
  })
  const commitSha = typeof (result as Record<string, unknown>).id === 'string' ? (result as Record<string, unknown>).id as string : ''
  if (commitSha === '') throw new RepoFetchError('gitlab commit returned no id', 502)
  return { commitSha, branch }
}

/** 把一组文件提交到指定分支。 */
export async function pushFiles(
  source: GitRepoSource,
  branch: string,
  files: readonly PushFile[],
  message: string,
): Promise<PushResult> {
  if (files.length === 0) throw new RepoFetchError('nothing to push', 400)
  switch (source.backend) {
    case 'github':
    case 'gitea':
      return pushGitData(source, branch, files, message)
    case 'gitlab':
      return pushGitLab(source, branch, files, message)
    case 'generic':
    case 'codeup':
      throw new RepoFetchError('this repository backend does not support push yet (supported: GitHub / Gitea / GitLab)', 501)
  }
}

/** 从仓库读取一个文件（用于增量合并上传前的 manifest 等）。 */
export async function readRepoFile(source: GitRepoSource, ref: string, path: string): Promise<Buffer> {
  // GitLab 的 files 路由返回 base64 JSON，不是原始字节；必须先解码，
  // 否则会把 `{"file_name":...}` 当成文件内容解析。云效 Codeup 同样是 base64 JSON。
  if (source.backend === 'gitlab' || source.backend === 'codeup') {
    const { json } = await fetchJson(apiUrl(source, 'contents', { ref, path }), source, `read ${path}`)
    const obj = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>
    const content = typeof obj.content === 'string' ? obj.content : ''
    if (content === '') throw new RepoFetchError('file not found: ' + path, 404)
    return Buffer.from(content, 'base64')
  }

  try {
    return await fetchRaw(apiUrl(source, 'file-raw', { ref, path }), source, `read ${path}`)
  } catch (error) {
    if (error instanceof RepoFetchError && error.status === 404) throw error
    // raw 不可用（自建网关常见）时退回 contents API。
    const { json } = await fetchJson(apiUrl(source, 'contents', { ref, path }), source, `read ${path}`)
    const obj = json as Record<string, unknown>
    const content = typeof obj.content === 'string' ? obj.content : ''
    if (content === '') throw new RepoFetchError('file not found: ' + path + ' (' + errorText(error) + ')', 404)
    return Buffer.from(content.replace(/\n/g, ''), 'base64')
  }
}
