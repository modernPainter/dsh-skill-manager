/**
 * 版本号工具 —— 从旧的自更新模块里抽出的纯函数。
 *
 * 本插件是独立项目，不再检查上游 dsh-skill-hub 的更新，也不再执行
 * `dsh plugin add`（那会把改造版覆盖回原版）。这里只保留展示与比较用的逻辑。
 */

import { createRequire } from 'node:module'

/** Installed plugin version, read from the package manifest. */
const require = createRequire(import.meta.url)
export const CURRENT_VERSION = (require('../package.json') as { version: string }).version

/** Normalize a release tag (`v1.2.3` → `1.2.3`) and parse it numerically. */
export function parseVersion(tag: string): [number, number, number] | null {
  const match = /^[vV]?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim())
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Compare two dotted version strings: negative when a < b, 0 equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return a.localeCompare(b, 'en')
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  }
  return 0
}
