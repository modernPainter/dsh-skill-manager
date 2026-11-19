/**
 * 场景（Scene）持久化 —— 独立 sidecar，每个 scene 还在 $DSH_HOME/scenes/{id}/ 下有独立 scene.json。
 *
 * 索引文件路径：$DSH_HOME/dsh-skill-manager-scenes.json（存场景列表索引）
 * 每个 scene 的 manifest：$DSH_HOME/scenes/{id}/scene.json
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { SceneManifest } from '../protocol/scene.ts'

export function scenesStatePath(home = join(homedir(), '.dsh')): string {
  return join(home, 'dsh-skill-manager-scenes.json')
}

export function scenesRoot(home = join(homedir(), '.dsh')): string {
  return join(home, 'scenes')
}

export function sceneManifestPath(id: string, home?: string): string {
  return join(scenesRoot(home), id, 'scene.json')
}

interface SceneIndexEntry {
  manifestPath: string
  remoteRepo?: string
  remotePath?: string
  remoteCommitSha?: string
}

interface ScenesIndexFile {
  version: number
  /** 场景 id → 记录摘要（完整 manifest 在各自 scene.json 里）。 */
  index: Record<string, SceneIndexEntry>
}

export class ScenesStore {
  private readonly indexFile: string
  private loaded = false
  private state: ScenesIndexFile = { version: 1, index: {} }

  constructor(indexFile: string = scenesStatePath()) {
    this.indexFile = indexFile
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await readFile(this.indexFile, 'utf8')
      this.state = JSON.parse(raw) as ScenesIndexFile
      if (!this.state.index) this.state.index = {}
    } catch {
      // 空状态
    }
    this.loaded = true
  }

  private async persistIndex(): Promise<void> {
    await mkdir(dirname(this.indexFile), { recursive: true })
    const tmp = this.indexFile + '.tmp'
    await writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8')
    await rename(tmp, this.indexFile)
  }

  // ── 列表 / 查询 ──

  async listScenes(): Promise<SceneManifest[]> {
    await this.ensureLoaded()
    const results: SceneManifest[] = []
    for (const [id, entry] of Object.entries(this.state.index)) {
      try {
        const raw = await readFile(entry.manifestPath, 'utf8')
        results.push(JSON.parse(raw) as SceneManifest)
      } catch {
        // scene.json 丢失 → 清理索引
        delete this.state.index[id]
      }
    }
    if (Object.keys(this.state.index).length > 0) {
      void this.persistIndex().catch(() => {})
    }
    return results.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  }

  async getScene(id: string): Promise<SceneManifest | undefined> {
    await this.ensureLoaded()
    const entry = this.state.index[id]
    if (!entry) return undefined
    try {
      const raw = await readFile(entry.manifestPath, 'utf8')
      return JSON.parse(raw) as SceneManifest
    } catch {
      return undefined
    }
  }

  /** 场景的远端备份引用（没备份过时返回空对象）。 */
  async getRemote(id: string): Promise<{ remoteRepo?: string; remotePath?: string; remoteCommitSha?: string }> {
    await this.ensureLoaded()
    const entry = this.state.index[id]
    if (!entry) return {}
    return {
      ...(entry.remoteRepo !== undefined ? { remoteRepo: entry.remoteRepo } : {}),
      ...(entry.remotePath !== undefined ? { remotePath: entry.remotePath } : {}),
      ...(entry.remoteCommitSha !== undefined ? { remoteCommitSha: entry.remoteCommitSha } : {}),
    }
  }

  /** 全部场景的远端备份引用（GET scenes 一次带回，GUI 不必逐条查询）。 */
  async listRemotes(): Promise<Record<string, { remoteRepo?: string; remotePath?: string; remoteCommitSha?: string }>> {
    await this.ensureLoaded()
    const result: Record<string, { remoteRepo?: string; remotePath?: string; remoteCommitSha?: string }> = {}
    for (const [id, entry] of Object.entries(this.state.index)) {
      if (entry.remoteRepo === undefined) continue
      result[id] = {
        remoteRepo: entry.remoteRepo,
        ...(entry.remotePath !== undefined ? { remotePath: entry.remotePath } : {}),
        ...(entry.remoteCommitSha !== undefined ? { remoteCommitSha: entry.remoteCommitSha } : {}),
      }
    }
    return result
  }

  // ── 写操作 ──

  async saveScene(manifest: SceneManifest): Promise<SceneManifest> {
    await this.ensureLoaded()
    const manifestPath = sceneManifestPath(manifest.id)
    await mkdir(dirname(manifestPath), { recursive: true })
    const tmp = manifestPath + '.tmp'
    await writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8')
    await rename(tmp, manifestPath)

    this.state.index[manifest.id] = {
      manifestPath,
      ...(this.state.index[manifest.id]?.remoteRepo !== undefined ? { remoteRepo: this.state.index[manifest.id].remoteRepo } : {}),
      ...(this.state.index[manifest.id]?.remotePath !== undefined ? { remotePath: this.state.index[manifest.id].remotePath } : {}),
      ...(this.state.index[manifest.id]?.remoteCommitSha !== undefined ? { remoteCommitSha: this.state.index[manifest.id].remoteCommitSha } : {}),
    }
    await this.persistIndex()
    return manifest
  }

  async removeScene(id: string): Promise<void> {
    await this.ensureLoaded()
    const manifestPath = sceneManifestPath(id)
    const sceneDir = dirname(manifestPath)
    try {
      await rm(sceneDir, { recursive: true, force: true })
    } catch {
      // 目录不存在没关系
    }
    delete this.state.index[id]
    await this.persistIndex()
  }

  async updateRemoteRef(id: string, patch: { remoteRepo?: string; remotePath?: string; remoteCommitSha?: string }): Promise<void> {
    await this.ensureLoaded()
    const entry = this.state.index[id]
    if (!entry) return
    if (patch.remoteRepo !== undefined) entry.remoteRepo = patch.remoteRepo
    if (patch.remotePath !== undefined) entry.remotePath = patch.remotePath
    if (patch.remoteCommitSha !== undefined) entry.remoteCommitSha = patch.remoteCommitSha
    await this.persistIndex()
  }
}
