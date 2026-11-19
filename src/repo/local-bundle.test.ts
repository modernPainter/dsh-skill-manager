import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readSkillBundle } from './local-bundle.ts'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-bundle-'))
}

describe('readSkillBundle', () => {
  it('扁平 <name>.md 只打包自身，并映射为 SKILL.md', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'a.md'), '---\nname: a\ndescription: x\n---\nA', 'utf8')
    await writeFile(join(root, 'b.md'), 'B', 'utf8')

    const files = await readSkillBundle(join(root, 'a.md'))
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('SKILL.md')
    expect(files[0].content.toString('utf8')).toContain('name: a')
  })

  it('目录包递归读取，跳过点号文件', async () => {
    const root = await tempRoot()
    const dir = join(root, 'skill-a')
    await mkdir(join(dir, 'assets'), { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '# a', 'utf8')
    await writeFile(join(dir, 'assets', 'note.txt'), 'n', 'utf8')
    await writeFile(join(dir, '.hidden'), 'h', 'utf8')

    const files = await readSkillBundle(join(dir, 'SKILL.md'))
    expect(files.map((file) => file.path).sort()).toEqual(['SKILL.md', 'assets/note.txt'])
  })
})
