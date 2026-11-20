/**
 * 公司「公共技能库」Java 服务的只读客户端。
 *
 * 之前插件用云效 token 直连 Codeup 读取公共技能；现在统一改走这个内部服务，
 * 插件不再持有云效凭据。服务只有两个接口：列表与会话级详情。
 *
 * 约定：
 *   - `code === 200000` 才算成功，其余按上游错误处理（带出 message）。
 *   - 只放行 kebab-case 技能名（与仓库扫描同一套 isSkillName），名字会被
 *     直接当作落盘目录名，不能靠上游自觉。
 *   - 失败一律折成 PublicSkillsError，消息是给用户看的中文。
 */

import { isSkillName } from '@deepseek-ai/dsh-skill'
import { dump } from 'js-yaml'

const DEFAULT_BASE = 'http://192.168.50.236:8052'
const TIMEOUT_MS = 20_000
const SUCCESS_CODE = 200000

/** 列表接口的一条技能。 */
export interface PublicSkillEntry {
  name: string
  path: string
}

export interface PublicSkillsList {
  ref: string
  fileCount: number
  skills: PublicSkillEntry[]
}

export interface PublicSkillDetail {
  name: string
  path: string
  /** 正文（上游已剥掉 frontmatter）。 */
  content: string
  description: string | null
  whenToUse?: string
  /** Claude Code 的 `argument-hint`，原样带回 frontmatter。 */
  argumentHint?: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
}

/**
 * 把详情补成完整的 SKILL.md。
 *
 * 上游 detail 只返回正文（frontmatter 已被剥掉），而本地安装要求 SKILL.md
 * 自带 name / description；这里按官方解析器认的字段重建 frontmatter。
 * 用 yaml dump 输出标量，避免描述里的冒号等字符破坏语法。
 */
export function composeSkillMarkdown(detail: PublicSkillDetail): string {
  const description = (detail.description ?? '').trim() !== ''
    ? (detail.description ?? '').trim()
    : '云效公共技能库：' + detail.name
  const lines = [
    '---',
    'name: ' + dump(detail.name).trim(),
    'description: ' + dump(description).trim(),
  ]
  if (detail.whenToUse !== undefined) lines.push('whenToUse: ' + dump(detail.whenToUse).trim())
  if (detail.argumentHint !== undefined) lines.push('argument-hint: ' + dump(detail.argumentHint).trim())
  if (!detail.invocation.modelInvocable) lines.push('disable-model-invocation: true')
  if (!detail.invocation.userInvocable) lines.push('user-invocable: false')
  lines.push('---', '', detail.content.trim(), '')
  return lines.join('\n')
}

/** 公共技能库服务错误；`status` 直接作为路由的 HTTP 状态（400 入参 / 502 上游）。 */
export class PublicSkillsError extends Error {
  readonly status: number
  constructor(message: string, status = 502) {
    super(message)
    this.name = 'PublicSkillsError'
    this.status = status
  }
}

/** 服务基地址，去掉末尾斜杠（环境变量优先，测试/部署可覆盖）。 */
export function publicSkillsBaseUrl(): string {
  return (process.env.DSH_SKILLS_API_BASE ?? DEFAULT_BASE).trim().replace(/\/+$/, '')
}

interface Envelope {
  code?: unknown
  message?: unknown
  result?: unknown
}

/** GET 一个 JSON 接口并解出信封；网络/超时/解析错误都折成中文消息。 */
async function requestJson(path: string, params: Record<string, string>, fetchImpl: typeof fetch): Promise<unknown> {
  const url = new URL(publicSkillsBaseUrl() + path)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)

  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    const name = (error as { name?: unknown }).name
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new PublicSkillsError('公共技能库服务不可用（超时）')
    }
    throw new PublicSkillsError('公共技能库服务不可用（网络错误）')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new PublicSkillsError(`公共技能库服务返回 HTTP ${String(response.status)}`)
  }

  let payload: unknown
  try {
    payload = JSON.parse(await response.text())
  } catch {
    throw new PublicSkillsError('公共技能库服务返回了非 JSON 响应')
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new PublicSkillsError('公共技能库服务返回了意外的响应结构')
  }
  const envelope = payload as Envelope
  if (envelope.code !== SUCCESS_CODE) {
    const message = typeof envelope.message === 'string' && envelope.message.trim() !== ''
      ? envelope.message.trim()
      : '未知错误'
    throw new PublicSkillsError('公共技能库服务返回错误：' + message)
  }
  return envelope.result
}

/**
 * 拉取公共技能库的列表。
 * @param fetchImpl - 注入点（测试用）。
 * @returns 通过名字校验的技能；ref / fileCount 原样透传。
 */
export async function listPublicSkills(fetchImpl: typeof fetch = fetch): Promise<PublicSkillsList> {
  const result = await requestJson('/api/skills/list', {}, fetchImpl)
  const record = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>

  const rawSkills = Array.isArray(record.skills) ? record.skills : []
  const skills: PublicSkillEntry[] = []
  const seen = new Set<string>()
  for (const candidate of rawSkills) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const entry = candidate as Record<string, unknown>
    if (typeof entry.name !== 'string' || !isSkillName(entry.name)) continue
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    skills.push({ name: entry.name, path: typeof entry.path === 'string' && entry.path !== '' ? entry.path : entry.name })
  }

  return {
    ref: typeof record.ref === 'string' && record.ref !== '' ? record.ref : 'main',
    fileCount: typeof record.fileCount === 'number' && Number.isFinite(record.fileCount) ? record.fileCount : skills.length,
    skills,
  }
}

/**
 * 拉取单个技能的 SKILL.md。
 * 上游只给正文，不给额外文件 —— 每个技能目前只有一个 SKILL.md，够用。
 * @param name - 已校验过的技能名。
 * @param fetchImpl - 注入点（测试用）。
 */
export async function fetchPublicSkill(name: string, fetchImpl: typeof fetch = fetch): Promise<PublicSkillDetail> {
  if (!isSkillName(name)) throw new PublicSkillsError('技能名不合法（需要 kebab-case）', 400)

  const result = await requestJson('/api/skills/detail', { name }, fetchImpl)
  const record = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>
  const content = typeof record.content === 'string' ? record.content : ''
  if (content.trim() === '') throw new PublicSkillsError('公共技能库返回的技能内容为空')

  const invocation = (typeof record.invocation === 'object' && record.invocation !== null ? record.invocation : {}) as Record<string, unknown>
  return {
    name: typeof record.name === 'string' && record.name !== '' ? record.name : name,
    path: typeof record.path === 'string' && record.path !== '' ? record.path : name + '/SKILL.md',
    content,
    description: typeof record.description === 'string' && record.description !== '' ? record.description : null,
    ...(typeof record.whenToUse === 'string' && record.whenToUse.trim() !== '' ? { whenToUse: record.whenToUse.trim() } : {}),
    ...(typeof record.argumentHint === 'string' && record.argumentHint.trim() !== '' ? { argumentHint: record.argumentHint.trim() } : {}),
    invocation: {
      modelInvocable: invocation.modelInvocable !== false,
      userInvocable: invocation.userInvocable !== false,
    },
  }
}
