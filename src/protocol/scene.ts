/**
 * 场景（Scene）数据模型 —— 一组 skill 的版本清单 + 可选配置快照。
 *
 * 场景 manifest 序列化为 scene.json，可单独存储（本地 sidecar）或打包成
 * bundle 推送到自有仓库的 scenes/{sceneId}/ 目录。
 */

/** 场景 manifest（scene.json）。 */
export interface SceneManifest {
  /** Schema 版本号。 */
  schemaVersion: number
  /** 场景唯一标识（kebab-case）。 */
  id: string
  /** 场景名称（人类可读，允许空格）。 */
  name: string
  /** 可选：场景描述。 */
  description?: string
  /** 创建时间戳（ISO 8601）。 */
  createdAt: string
  /** 最近更新时间戳（ISO 8601）。 */
  updatedAt: string
  /** 包含的 skill 版本清单。 */
  skills: readonly SceneSkillEntry[]
  /** 可选：配置文件快照（如 ~/.dsh/config.json 片段）。 */
  configSnapshot?: Record<string, unknown>
  /** 可选：场景级标签。 */
  tags?: readonly string[]
}

/** 场景内单个 skill 的精确快照 —— 恢复时按此清单拉取。 */
export interface SceneSkillEntry {
  /** skill 名称（匹配 SKILL.md frontmatter）。 */
  name: string
  /** 来源仓库 URL 或 slug。 */
  source: string
  /** 来源分支 / tag / commit SHA。 */
  ref: string
  /** 来源目录（仓库内相对路径）。 */
  path: string
  /** 来源 commit SHA（精确锁定，恢复时保证一致性）。 */
  commitSha: string
  /** 可选：该版本内容的 hash baseline，恢复时做改动检测。 */
  localHash?: string
}

/** 场景本地持久化记录（sidecar 内部用，不对外暴露）。 */
export interface SceneRecord {
  id: string
  /** scene.json 在本地文件系统的路径（$DSH_HOME/scenes/{id}/scene.json）。 */
  path: string
  /** 完整 manifest 内容。 */
  manifest: SceneManifest
  /** 推送到的远端仓库引用（可选，第一次推送后填写）。 */
  remoteRepo?: string
  /** 远端目录（可选）。 */
  remotePath?: string
  /** 远端 commit SHA（可选，最后一次推送的锁定）。 */
  remoteCommitSha?: string
}

/** 场景恢复时的冲突项 —— 覆盖 / 跳过的决策依据。 */
export interface SceneConflictItem {
  name: string
  /** 本地 skill 路径。 */
  localPath: string
  /** 冲突类型。 */
  type: 'missing' | 'version-update' | 'local-modified' | 'remote-removed'
  /** 人类可读描述。 */
  description: string
}

/** 场景恢复操作的请求 —— 前端逐项决策后批量应用。 */
export interface SceneRestoreRequest {
  /** 每个冲突项的决策：'override' | 'skip' | 'backup-then-override'。 */
  decisions: Record<string, 'override' | 'skip' | 'backup-then-override'>
}
