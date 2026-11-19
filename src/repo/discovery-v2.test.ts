import { describe, expect, it } from 'vitest'
import { diffSkillSets, mergeManifestAndScan, parseManifest, scanFromTree } from './discovery-v2.ts'
import { buildApiBase, detectBackend, extractSlug } from './git-client.ts'

describe('manifest 解析', () => {
  it('读取合法 manifest 并保留可选字段', () => {
    const manifest = parseManifest(JSON.stringify({
      schemaVersion: 1,
      name: 'team-skills',
      defaultBranch: 'trunk',
      skills: [
        { name: 'code-review', path: 'skills/code-review', version: '1.2.0', tags: ['quality'], auditHash: 'sha256:abc' },
        { name: 'bad name!', path: 'skills/bad' },
        { name: 'no-path' },
      ],
    }))
    expect(manifest.name).toBe('team-skills')
    expect(manifest.defaultBranch).toBe('trunk')
    expect(manifest.skills).toEqual([
      { name: 'code-review', path: 'skills/code-review', version: '1.2.0', tags: ['quality'], auditHash: 'sha256:abc' },
    ])
  })

  it('非 JSON 或缺少 skills 时报错', () => {
    expect(() => parseManifest('not json')).toThrow(/not valid JSON/)
    expect(() => parseManifest('{"schemaVersion":1}')).toThrow(/skills/)
  })
})

describe('目录扫描与合并', () => {
  const tree = [
    { path: 'README.md', size: 10 },
    { path: 'skills/alpha/SKILL.md', size: 100 },
    { path: 'skills/alpha/references/a.md', size: 20 },
    { path: 'skills/beta/SKILL.md', size: 90 },
    { path: 'nested/deep/gamma/SKILL.md', size: 80 },
  ]

  it('只识别目录包，忽略根目录与非法名', () => {
    expect(scanFromTree(tree).map((entry) => entry.name)).toEqual(['alpha', 'beta', 'gamma'])
    expect(scanFromTree([{ path: 'SKILL.md', size: 1 }])).toEqual([])
  })

  it('manifest 条目优先，目录扫描补齐缺失项', () => {
    const merged = mergeManifestAndScan(
      [{ name: 'alpha', path: 'custom/place/alpha', version: '2.0.0' }],
      scanFromTree(tree),
    )
    expect(merged.map((entry) => entry.name)).toEqual(['alpha', 'beta', 'gamma'])
    expect(merged[0].path).toBe('custom/place/alpha')
  })
})

describe('更新 diff', () => {
  it('按 path/version/auditHash 归类新增、更新、移除', () => {
    const diff = diffSkillSets(
      [{ name: 'a', path: 'skills/a' }, { name: 'b', path: 'skills/b', version: '1.0.0' }, { name: 'c', path: 'skills/c' }],
      [{ name: 'a', path: 'skills/a' }, { name: 'b', path: 'skills/b', version: '1.1.0' }, { name: 'd', path: 'skills/d' }],
    )
    expect(diff.added).toEqual(['d'])
    expect(diff.updated).toEqual(['b'])
    expect(diff.removed).toEqual(['c'])
  })
})

describe('仓库 URL 识别', () => {
  it('识别主流后端并推导 API base', () => {
    expect(detectBackend('https://github.com/o/r')).toBe('github')
    expect(detectBackend('https://gitlab.com/o/r')).toBe('gitlab')
    expect(detectBackend('https://gitea.example.com/o/r')).toBe('gitea')
    expect(detectBackend('https://git.company.com/o/r')).toBe('generic')

    expect(buildApiBase('https://github.com/o/r', 'github')).toBe('https://api.github.com')
    expect(buildApiBase('https://gitlab.example.com/o/r', 'gitlab')).toBe('https://gitlab.example.com/api/v4')
    expect(buildApiBase('https://gitea.example.com/o/r', 'gitea')).toBe('https://gitea.example.com/api/v1')
  })

  it('从 URL 提取 owner/repo 并容忍 .git 后缀', () => {
    expect(extractSlug('https://git.company.com/team/skills.git')).toBe('team/skills')
    expect(extractSlug('https://github.com/owner/repo/tree/main')).toBe('owner/repo')
    expect(extractSlug('not a url')).toBeNull()
  })
})
