/**
 * 本地技能目录 → 可推送文件列表。
 * 上传共用：统一跳过点号条目、限制单文件与整包体积。
 */

import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { MAX_SKILL_FILE_BYTES } from '../skillfs/audit.ts'

/** 单个 bundle 的硬上限，避免把整个工作区推进 git。 */
export const MAX_BUNDLE_BYTES = 20 * 1024 * 1024
/** 单个 bundle 的文件数上限。 */
export const MAX_BUNDLE_FILES = 400

export interface LocalBundleFile {
  /** 相对技能目录的路径（正斜杠）。 */
  path: string
  content: Buffer
}

/** 递归读取技能目录；超限时抛错（调用方转成 422）。 */
export async function readLocalSkillFiles(dir: string): Promise<LocalBundleFile[]> {
  const result: LocalBundleFile[] = []
  let total = 0

  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      if (result.length >= MAX_BUNDLE_FILES) throw new Error(`bundle exceeds ${MAX_BUNDLE_FILES} files`)
      const buffer = await readFile(full)
      if (buffer.length > MAX_SKILL_FILE_BYTES) throw new Error(`file too large: ${entry.name}`)
      total += buffer.length
      if (total > MAX_BUNDLE_BYTES) throw new Error('bundle exceeds the 20MB limit')
      result.push({ path: relative(dir, full).split('\\').join('/'), content: buffer })
    }
  }

  await walk(dir)
  return result
}

/**
 * 按「仓库目录形态」读取一个本地技能：
 *   - `<name>/SKILL.md` 目录包 → 递归读取该目录
 *   - 扁平 `<name>.md` → 只取这个文件，并映射为 `SKILL.md`
 *
 * 扁平技能若直接对父目录递归，会把同级其它技能一起打包进仓库。
 */
export async function readSkillBundle(definitionPath: string): Promise<LocalBundleFile[]> {
  if (basename(definitionPath) === 'SKILL.md') return readLocalSkillFiles(dirname(definitionPath))

  const buffer = await readFile(definitionPath)
  if (buffer.length > MAX_SKILL_FILE_BYTES) throw new Error(`file too large: ${basename(definitionPath)}`)
  return [{ path: 'SKILL.md', content: buffer }]
}
