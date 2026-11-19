/**
 * 场景（Scene）路由域：场景 CRUD、备份到自有仓库、恢复计划与恢复执行。
 *
 * 语义要点：
 *   - 场景 = 一组 skill 的版本清单（名字 + 来源仓库 + commit SHA）+ 可选配置快照
 *   - 备份把 scene.json 推到仓库 `{scenesPath}/{id}/scene.json`
 *   - 恢复不改写任何没有确认过的 skill：先出计划，按逐项决策执行
 *   - 覆盖一律先进回收站，失败可回退
 */

import { join } from 'node:path'
import {
  SKILL_MANAGER_API,
  resolveHubConfig,
  type GitRepoSource,
  type SceneConflictItem,
  type SceneManifest,
  type SceneSkillEntry,
} from '../protocol.ts'
import { errorText } from '../error-text.ts'
import { hashSkillAt, rootPath } from '../skillfs.ts'
import { RepoFetchError } from '../repo/git-client.ts'
import { pushFiles, type PushFile } from '../repo/push.ts'
import { readSkillBundle } from '../repo/local-bundle.ts'
import type { ScenesStore } from '../store/scenes.ts'
import { fetchSkillFiles, installWithOverwrite, scanRepoCore, type RepoRouteDeps } from './repos.ts'
import {
  homeOf,
  queryParam,
  readString,
  readStrings,
  writeError,
  writeJson,
  type RouteSpec,
} from './helpers.ts'
import { installSkillBundle } from './install-bundle.ts'
import { retireNamePlaceholders } from './route-state.ts'

export interface SceneRouteDeps extends RepoRouteDeps {
  scenes: ScenesStore
}

/** 场景 id 语法：kebab-case，且不能逃逸出 scenes 目录。 */
const SCENE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** 把技能按仓库目录形态读取为推送文件（扁平 <name>.md 会映射成 SKILL.md）。 */
async function bundleSkill(definitionPath: string): Promise<PushFile[]> {
  return (await readSkillBundle(definitionPath)).map((file) => ({ path: file.path, content: file.content }))
}

/** 从来源记录里推断技能在仓库中的目录。 */
function skillPathOf(source: { root: string; manifest?: Record<string, number> }, name: string): string {
  for (const path of Object.keys(source.manifest ?? {})) {
    const marker = '/' + name + '/SKILL.md'
    if (path.endsWith(marker)) return path.slice(0, -'/SKILL.md'.length)
  }
  const root = source.root === '' || source.root === 'repo-root' ? '' : source.root
  return root === '' ? name : `${root}/${name}`
}

/** 一个技能的本地内容哈希。 */
async function localSkillHash(targetRoot: string, name: string): Promise<string | undefined> {
  return (await hashSkillAt(join(targetRoot, name, 'SKILL.md'))) ?? (await hashSkillAt(join(targetRoot, name + '.md')))
}

export function sceneRoutes(deps: SceneRouteDeps): RouteSpec[] {
  const { scenes, repos } = deps
  const targetRoot = (): string => rootPath('user-dsh', homeOf(deps))

  return [
    // ─────────────────────────── 场景列表（GET）/ 新建或覆盖（POST）
    {
      path: SKILL_MANAGER_API.scenes,
      methods: ['GET', 'POST'],
      jsonBody: true,
      handler: async ({ req, res, body }) => {
        if (req.method === 'GET') {
          writeJson(res, 200, { ok: true, scenes: await scenes.listScenes(), remotes: await scenes.listRemotes() })
          return
        }
        const id = readString(body, 'id').trim()
        if (!SCENE_ID_RE.test(id)) { writeError(res, 400, 'id must be kebab-case (a-z, 0-9, dashes, max 64)'); return }
        const name = readString(body, 'name').trim()
        if (name === '') { writeError(res, 400, 'name is required'); return }

        // skills 缺省 = 当前全部已安装技能；显式给出则只取这些名字。
        const requested = readStrings(body, 'skills')
        const sources = await deps.store.listSources()
        const tracked = new Map<string, { repo: string; ref?: string; commitSha: string; root: string; manifest?: Record<string, number> }>()
        for (const source of sources) {
          for (const skillName of source.skills) {
            tracked.set(skillName, {
              repo: source.repo,
              ...(source.ref !== undefined ? { ref: source.ref } : {}),
              commitSha: source.commitSha,
              root: source.root,
              ...(source.manifest !== undefined ? { manifest: source.manifest } : {}),
            })
          }
        }

        const names = requested.length > 0 ? requested : [...tracked.keys()]
        if (names.length === 0) { writeError(res, 400, 'no installed skills to record'); return }

        const entries: SceneSkillEntry[] = []
        for (const skillName of names) {
          const source = tracked.get(skillName)
          const hash = await localSkillHash(targetRoot(), skillName)
          entries.push({
            name: skillName,
            source: source?.repo ?? '',
            ref: source?.ref ?? '',
            path: source !== undefined ? skillPathOf(source, skillName) : skillName,
            commitSha: source?.commitSha ?? '',
            ...(hash !== undefined ? { localHash: hash } : {}),
          })
        }

        const now = new Date().toISOString()
        const manifest: SceneManifest = {
          schemaVersion: 1,
          id,
          name,
          ...(readString(body, 'description') !== '' ? { description: readString(body, 'description') } : {}),
          createdAt: now,
          updatedAt: now,
          skills: entries,
          ...(body.includeConfig === true ? { configSnapshot: { ...resolveHubConfig(deps.config?.() ?? {}) } } : {}),
          ...(readStrings(body, 'tags').length > 0 ? { tags: readStrings(body, 'tags') } : {}),
        }
        // 覆盖式保存：同 id 再次创建即更新，createdAt 沿用旧值。
        const existing = await scenes.getScene(id)
        if (existing !== undefined) manifest.createdAt = existing.createdAt
        await scenes.saveScene(manifest)
        writeJson(res, 200, { ok: true, scene: manifest })
      },
    },

    // ─────────────────────────── 删除场景
    {
      path: SKILL_MANAGER_API.sceneDelete,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const id = readString(body, 'id').trim()
        if (!SCENE_ID_RE.test(id)) { writeError(res, 400, 'invalid scene id'); return }
        await scenes.removeScene(id)
        writeJson(res, 200, { ok: true, scenes: await scenes.listScenes() })
      },
    },

    // ─────────────────────────── 备份到仓库
    {
      path: SKILL_MANAGER_API.sceneBackup,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const id = readString(body, 'id').trim()
        if (!SCENE_ID_RE.test(id)) { writeError(res, 400, 'invalid scene id'); return }
        const slug = readString(body, 'slug').trim()
        const repo = await repos.getRepo(slug)
        if (repo === undefined) { writeError(res, 404, 'repo not found: ' + slug); return }

        const scene = await scenes.getScene(id)
        if (scene === undefined) { writeError(res, 404, 'scene not found: ' + id); return }

        const branch = readString(body, 'branch').trim() || repo.defaultBranch
        const basePath = (readString(body, 'path').trim() || repo.scenesPath).replace(/^\/+|\/+$/g, '')
        const sceneDir = basePath === '' ? id : `${basePath}/${id}`

        // 备份 = scene.json + 每个技能的当前文件快照（离线仓库也能恢复）。
        const files: PushFile[] = []
        for (const entry of scene.skills) {
          const localDir = await deps.skills.get(entry.name)
          const manifestPath = localDir?.path
          if (manifestPath === undefined) continue
          let skillFiles: PushFile[]
          try {
            skillFiles = await bundleSkill(manifestPath)
          } catch (error) {
            writeError(res, 422, `cannot bundle ${entry.name}: ${errorText(error)}`)
            return
          }
          for (const file of skillFiles) {
            files.push({ path: `${sceneDir}/skills/${entry.name}/${file.path}`, content: file.content })
          }
        }

        // 重新采集当前本地哈希，让备份与内容一致。
        const refreshed: SceneManifest = {
          ...scene,
          updatedAt: new Date().toISOString(),
          skills: await Promise.all(scene.skills.map(async (entry) => {
            const hash = await localSkillHash(targetRoot(), entry.name)
            return hash !== undefined ? { ...entry, localHash: hash } : entry
          })),
        }
        files.push({ path: `${sceneDir}/scene.json`, content: Buffer.from(JSON.stringify(refreshed, null, 2), 'utf8') })

        const pushed = await pushFiles(repo, branch, files, `chore(skill-manager): backup scene ${id}`)
        await scenes.saveScene(refreshed)
        await scenes.updateRemoteRef(id, { remoteRepo: slug, remotePath: sceneDir, remoteCommitSha: pushed.commitSha })

        writeJson(res, 200, { ok: true, scene: refreshed, commitSha: pushed.commitSha, branch, path: sceneDir, fileCount: files.length })
      },
    },

    // ─────────────────────────── 恢复计划
    {
      path: SKILL_MANAGER_API.sceneRestorePlan,
      methods: ['GET'],
      handler: async ({ res, url }) => {
        const id = queryParam(url, 'id') ?? ''
        if (!SCENE_ID_RE.test(id)) { writeError(res, 400, 'invalid scene id'); return }
        const scene = await scenes.getScene(id)
        if (scene === undefined) { writeError(res, 404, 'scene not found: ' + id); return }

        const conflicts: SceneConflictItem[] = []
        const root = targetRoot()
        for (const entry of scene.skills) {
          const installed = await deps.skills.get(entry.name)
          if (installed?.path === undefined) {
            conflicts.push({ name: entry.name, localPath: '', type: 'missing', description: '本地未安装，将直接安装' })
            continue
          }
          const current = await localSkillHash(root, entry.name)
          if (entry.localHash !== undefined && current !== undefined && current === entry.localHash) {
            // 本地内容已与场景记录一致：不需要任何决策，不列进计划。
            continue
          }
          if (entry.localHash !== undefined && current !== undefined) {
            conflicts.push({ name: entry.name, localPath: installed.path, type: 'local-modified', description: '本地内容与场景记录不一致（可能被手工修改）' })
          } else {
            conflicts.push({ name: entry.name, localPath: installed.path, type: 'version-update', description: `将覆盖为场景记录的版本${entry.commitSha !== '' ? ' @' + entry.commitSha.slice(0, 8) : ''}` })
          }
        }
        writeJson(res, 200, { ok: true, scene, conflicts })
      },
    },

    // ─────────────────────────── 执行恢复
    {
      path: SKILL_MANAGER_API.sceneRestore,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const id = readString(body, 'id').trim()
        if (!SCENE_ID_RE.test(id)) { writeError(res, 400, 'invalid scene id'); return }
        const scene = await scenes.getScene(id)
        if (scene === undefined) { writeError(res, 404, 'scene not found: ' + id); return }

        const raw = typeof body.decisions === 'object' && body.decisions !== null ? body.decisions as Record<string, unknown> : {}
        const decisions = new Map<string, 'override' | 'skip' | 'backup-then-override'>()
        for (const [name, value] of Object.entries(raw)) {
          if (value === 'override' || value === 'skip' || value === 'backup-then-override') decisions.set(name, value)
        }

        const root = targetRoot()
        const installed: string[] = []
        const skipped: Array<{ name: string; reason: string }> = []
        const failed: Array<{ name: string; error: string }> = []
        const trashed: string[] = []

        // 备份快照优先：sceneDir/skills/<name> 是备份时一起推上去的内容，
        // 即使来源仓库不可达/历史被改写，也能按快照还原。
        const remote = await scenes.getRemote(id)
        const resolveFiles = async (entry: SceneSkillEntry): Promise<{ repo: GitRepoSource; files: Awaited<ReturnType<typeof fetchSkillFiles>> }> => {
          const reasons: string[] = []
          if (remote.remoteRepo !== undefined) {
            const backupRepo = await repos.getRepo(remote.remoteRepo)
            if (backupRepo !== undefined) {
              try {
                const backupRef = remote.remoteCommitSha ?? backupRepo.defaultBranch
                const backupPath = `${remote.remotePath ?? backupRepo.scenesPath + '/' + id}/skills/${entry.name}`
                const snapshot = await scanRepoCore(repos, backupRepo.slug, backupRef)
                return {
                  repo: backupRepo,
                  files: await fetchSkillFiles(backupRepo, snapshot.commitSha, { name: entry.name, path: backupPath }, snapshot.tree),
                }
              } catch (error) {
                reasons.push('snapshot: ' + errorText(error))
              }
            } else {
              reasons.push('snapshot repo not configured: ' + remote.remoteRepo)
            }
          }

          const sourceRepo = await repos.getRepo(entry.source)
          if (sourceRepo === undefined) {
            throw new RepoFetchError('source repo not configured: ' + (entry.source || '(local-only)') + (reasons.length > 0 ? '; ' + reasons.join('; ') : ''), 404)
          }
          if (entry.commitSha === '') throw new RepoFetchError('scene entry has no commit sha', 422)
          const scan = await scanRepoCore(repos, sourceRepo.slug, entry.commitSha)
          return { repo: sourceRepo, files: await fetchSkillFiles(sourceRepo, entry.commitSha, { name: entry.name, path: entry.path }, scan.tree) }
        }

        for (const entry of scene.skills) {
          const decision = decisions.get(entry.name) ?? 'skip'
          if (decision === 'skip') { skipped.push({ name: entry.name, reason: 'skipped by user' }); continue }

          try {
            const { repo, files } = await resolveFiles(entry)

            const exists = (await deps.skills.get(entry.name))?.path !== undefined
            if (exists) {
              const outcome = await installWithOverwrite(deps, root, entry.name, files)
              if (outcome.status !== 'installed') { failed.push({ name: entry.name, error: outcome.error ?? outcome.status }); continue }
              trashed.push(entry.name)
            } else {
              const outcome = await installSkillBundle({
                targetRoot: root,
                files,
                label: entry.name,
                existing: new Set(),
                retire: async (name) => (await retireNamePlaceholders(deps, root, name)) !== undefined,
              })
              if (outcome.status !== 'installed') { failed.push({ name: entry.name, error: outcome.error ?? outcome.status }); continue }
            }

            const hash = await hashSkillAt(join(root, entry.name, 'SKILL.md'))
            if (hash !== undefined) await deps.store.setSourceSkillHash(repo.slug, entry.name, hash)
            installed.push(entry.name)
          } catch (error) {
            failed.push({ name: entry.name, error: errorText(error) })
          }
        }

        if (installed.length > 0) deps.invalidate?.()
        writeJson(res, 200, { ok: true, installed, skipped, failed, replaced: trashed })
      },
    },
  ]
}
