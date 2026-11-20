/**
 * 云效公共技能库 · 路由域。
 *
 * 列表/安装都走公司内部 Java 服务（见 ../repo/skills-service.ts），插件不再
 * 用云效 token 直连 Codeup。安装语义与「自有仓库」完全一致：同一个
 * installSkillBundle 落盘入口、同样的 frontmatter 校验与冲突处理，只是
 * 包内只有 SKILL.md（上游 detail 只给正文）。
 */

import { isSkillName } from '@deepseek-ai/dsh-skill'
import { SKILL_MANAGER_API } from '../protocol.ts'
import { composeSkillMarkdown, fetchPublicSkill, listPublicSkills, PublicSkillsError } from '../repo/skills-service.ts'
import { parseFrontmatter, rootPath } from '../skillfs.ts'
import type { AuditFinding } from '../skillfs/audit.ts'
import { installSkillBundle, type BundleFile } from './install-bundle.ts'
import { installWithOverwrite } from './repos.ts'
import { retireNamePlaceholders } from './route-state.ts'
import {
  homeOf,
  readString,
  writeError,
  writeJson,
  type RouteSpec,
  type SkillHubRouteDeps,
} from './helpers.ts'

/** 审计告警按协议里的扁平结构返回（与 market 的 skills.sh 直装一致）。 */
function warningViews(findings: AuditFinding[] | undefined): Array<{ rule: string; severity: 'warn'; file: string; line?: number; message: string }> {
  return (findings ?? []).map((finding) => ({
    rule: finding.rule,
    severity: 'warn' as const,
    file: finding.file,
    ...(finding.line !== undefined ? { line: finding.line } : {}),
    message: finding.message,
  }))
}

export function publicSkillRoutes(deps: SkillHubRouteDeps): RouteSpec[] {
  return [
    // ─────────────────────────── 列表
    {
      path: SKILL_MANAGER_API.publicSkills,
      methods: ['GET'],
      handler: async ({ res }) => {
        try {
          const result = await listPublicSkills()
          writeJson(res, 200, { ok: true, ref: result.ref, fileCount: result.fileCount, skills: result.skills })
        } catch (error) {
          if (error instanceof PublicSkillsError) { writeError(res, error.status, error.message); return }
          throw error
        }
      },
    },

    // ─────────────────────────── 安装
    {
      path: SKILL_MANAGER_API.publicInstall,
      methods: ['POST'],
      jsonBody: true,
      handler: async ({ res, body }) => {
        const name = readString(body, 'name').trim()
        if (!isSkillName(name)) { writeError(res, 400, 'skill name must be kebab-case (lowercase letters, digits, dashes)'); return }
        const overwrite = body.overwrite === true

        let detail
        try {
          detail = await fetchPublicSkill(name)
        } catch (error) {
          if (error instanceof PublicSkillsError) { writeError(res, error.status, error.message); return }
          throw error
        }

        const skillFile = composeSkillMarkdown(detail)
        const files: BundleFile[] = [{ path: 'SKILL.md', size: Buffer.byteLength(skillFile), data: Buffer.from(skillFile, 'utf8') }]

        // frontmatter 名称必须等于技能名：落盘目录由 name 决定，不一致会写出
        // 一个「目录名 ≠ 注册名」的技能，provider 之后会报路径漂移。
        const parsed = parseFrontmatter(skillFile)
        if ('error' in parsed) {
          writeJson(res, 200, { ok: false, name, status: 'failed', error: 'SKILL.md rejected: ' + parsed.error })
          return
        }
        if (parsed.value.name !== name) {
          writeJson(res, 200, { ok: false, name, status: 'failed', error: `SKILL.md 的 frontmatter 名 "${parsed.value.name}" 与技能名 "${name}" 不一致` })
          return
        }

        const targetRoot = rootPath('user-dsh', homeOf(deps))
        const outcome = overwrite
          ? await installWithOverwrite(deps, targetRoot, name, files)
          : await installSkillBundle({
              targetRoot,
              files,
              label: name,
              existing: new Set(),
              retire: async (target) => (await retireNamePlaceholders(deps, targetRoot, target)) !== undefined,
            })
        if (outcome.status === 'installed') deps.invalidate?.()

        writeJson(res, 200, {
          ok: outcome.status !== 'failed',
          name: 'name' in outcome ? outcome.name : name,
          status: outcome.status,
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
          ...(outcome.replaced === true ? { replaced: true } : {}),
          ...(outcome.warnings !== undefined ? { warnings: warningViews(outcome.warnings) } : {}),
        })
      },
    },
  ]
}
