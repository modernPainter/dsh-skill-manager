/**
 * 自有 Git 仓库源数据模型 —— 替换 Hub 原有的固定 GitHub marketSource。
 *
 * 设计要点：
 *   - 仓库 URL 是第一公民，通过域名自动识别后端（GitHub / GitLab / Gitea / 通用 Git HTTP）
 *   - 认证信息独立为 AuthRef，避免在各记录中重复携带敏感字段
 *   - 每个仓库维护 manifest 快照（skill-manifest.json 解析结果），离线时 GUI 也能展示
 */

/** Git 后端类型（通过 URL 域名自动识别，也可手动覆盖）。 */
export type GitBackend = 'github' | 'gitlab' | 'gitea' | 'codeup' | 'generic'

/** 认证方式。HTTPS + Token 是当前实现，SSH Key 预留在接口里。 */
export type GitAuthType = 'none' | 'https-token' | 'ssh-key'

/** 认证凭据（敏感，不落明文日志；序列化时只存引用 id）。 */
export interface GitAuthRef {
  /** 唯一 id，仓库源通过此字段引用凭据。 */
  id: string
  /** 显示用标签（如 "我的 GitHub PAT"）。 */
  label: string
  /** 认证类型。 */
  type: GitAuthType
  /** 创建时间戳。 */
  createdAt: number
  /** HTTPS Token（明文存本地 sidecar，序列化时会脱敏）。type === 'https-token' 时必填。 */
  token?: string
  /** SSH 私钥文件路径（type === 'ssh-key' 时使用，暂未实现）。 */
  sshKeyPath?: string
}

/** 自有 Git 仓库源 —— 替代原 Hub 的 MarketSourceRecord。 */
export interface GitRepoSource {
  /** 唯一 slug，URL 规范化后的结果（https://git.company.com/dsh/team-skills → dsh/team-skills）。 */
  slug: string
  /** 仓库原始 URL（用户填写）。 */
  url: string
  /** 规范化后的 API base URL（根据后端类型转换）。 */
  apiBase: string
  /** Git 后端类型（url 域名自动识别，可手动覆盖）。 */
  backend: GitBackend
  /** 认证凭据引用 id（空表示匿名）。 */
  authId?: string
  /** 描述（可选）。 */
  description?: string
  /** 默认分支（clone/pull 时使用）。缺省 "main"。 */
  defaultBranch: string
  /** 场景目录在仓库内的相对路径。缺省 "scenes"。 */
  scenesPath: string
  /** skill-manifest.json 相对仓库根目录的路径。缺省 "skill-manifest.json"。 */
  manifestPath: string
  /** 仓库级标签（用于 GUI 分组筛选）。 */
  tags?: readonly string[]
  /** 最后一次成功拉取的 commit SHA。 */
  lastCommitSha?: string
  /** 最后一次成功拉取的时间戳。 */
  lastCheckedAt?: number
  /** 最后一次 manifest 快照（解析后的 skill-manifest.json，离线时展示用）。 */
  manifest?: RepoSkillManifest
}

/** 仓库根目录 manifest（skill-manifest.json）。 */
export interface RepoSkillManifest {
  /** Schema 版本号（客户端做兼容判断）。 */
  schemaVersion: number
  /** 仓库标识（人类可读）。 */
  name: string
  /** 可选：简短描述。 */
  description?: string
  /** 可选：默认分支名（覆盖仓库源的 defaultBranch）。 */
  defaultBranch?: string
  /** 可选：仓库级标签。 */
  tags?: readonly string[]
  /** 必需：skill 列表。 */
  skills: readonly RepoSkillManifestEntry[]
}

/** manifest 中的单个 skill 条目。 */
export interface RepoSkillManifestEntry {
  /** skill 目录名（仓库内路径的最后一段）。 */
  name: string
  /** skill 目录在仓库内的相对路径（相对于 manifest 位置）。 */
  path: string
  /** 可选：该 skill 的版本号。 */
  version?: string
  /** 可选：skill 摘要（GUI 展示用，避免下载完整 SKILL.md）。 */
  description?: string
  /** 可选：标签，GUI 过滤用。 */
  tags?: readonly string[]
  /** 可选：审计规则快照的 hash，快速比对用。 */
  auditHash?: string
}

/** 仓库扫描结果 —— 与原 Hub 的 RepoDiscoverResponse 对齐。 */
export interface RepoScanResult {
  /** 仓库 slug。 */
  slug: string
  /** 当前 ref（commit SHA 或 branch name）。 */
  ref: string
  /** ref 对应的 commit SHA（精确锁定）。 */
  commitSha: string
  /** 仓库树 SHA（用于后续树操作）。 */
  treeSha: string
  /** manifest 解析结果（如果存在）。 */
  manifest?: RepoSkillManifest
  /** 可导入的 skill 列表（manifest 驱动 + fallback 目录扫描的合并结果）。 */
  skills: readonly RepoSkillManifestEntry[]
}

/** 连接测试结果 —— GUI 配置卡 "测试连接" 按钮用。 */
export interface ConnectionTestResult {
  ok: boolean
  /** 连接到的后端类型（成功时填充）。 */
  backend?: GitBackend
  /** 仓库默认分支（成功时填充）。 */
  defaultBranch?: string
  /** 错误信息（失败时填充，对用户可读）。 */
  error?: string
}
