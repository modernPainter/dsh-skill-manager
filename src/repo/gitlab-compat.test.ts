import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitRepoSource } from '../protocol/git.ts'
import { fetchRepoTreeBlobs } from './discovery-v2.ts'
import { readRepoFile } from './push.ts'
import { downloadRepoFile } from './install-v2.ts'

function makeSource(backend: 'github' | 'gitlab', apiBase: string): GitRepoSource {
  return {
    slug: 'group/proj',
    url: 'https://example.com/group/proj',
    apiBase,
    backend,
    defaultBranch: 'main',
    scenesPath: 'scenes',
    manifestPath: 'skill-manifest.json',
  }
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('仓库树读取', () => {
  it('GitHub 解包 { tree } 并跳过目录节点', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      tree: [
        { path: 'skills/a/SKILL.md', type: 'blob', size: 12 },
        { path: 'skills', type: 'tree' },
      ],
    })))

    const blobs = await fetchRepoTreeBlobs(makeSource('github', 'https://api.github.com'), 'main')
    expect(blobs).toEqual([{ path: 'skills/a/SKILL.md', size: 12 }])
  })

  it('GitLab 按 x-next-page 翻页，不静默截断', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const page = new URL(String(input)).searchParams.get('page')
      if (page === '1') {
        return jsonResponse([{ path: 'skills/a/SKILL.md', type: 'blob', size: 10 }], { 'x-next-page': '2' })
      }
      return jsonResponse([{ path: 'skills/b/SKILL.md', type: 'blob', size: 20 }])
    })
    vi.stubGlobal('fetch', fetchMock)

    const blobs = await fetchRepoTreeBlobs(makeSource('gitlab', 'https://gitlab.example.com/api/v4'), 'abc123')
    expect(blobs.map((blob) => blob.path)).toEqual(['skills/a/SKILL.md', 'skills/b/SKILL.md'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('GitLab 文件读取', () => {
  it('readRepoFile 解码 base64 content', async () => {
    const content = Buffer.from('# hello\n').toString('base64')
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ content, encoding: 'base64' })))

    const buffer = await readRepoFile(makeSource('gitlab', 'https://gitlab.example.com/api/v4'), 'main', 'SKILL.md')
    expect(buffer.toString('utf8')).toBe('# hello\n')
  })

  it('downloadRepoFile 走 GitLab files API 而不是元数据 JSON', async () => {
    const content = Buffer.from('body').toString('base64')
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ file_name: 'SKILL.md', content, encoding: 'base64' })))

    const buffer = await downloadRepoFile(makeSource('gitlab', 'https://gitlab.example.com/api/v4'), 'main', 'skills/a/SKILL.md')
    expect(buffer.toString('utf8')).toBe('body')
  })
})
