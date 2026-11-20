import { describe, expect, it } from 'vitest'
import { composeSkillMarkdown, fetchPublicSkill, listPublicSkills, PublicSkillsError } from './skills-service.ts'

/** 构造一个返回固定 JSON 的 fetch 替身。 */
function jsonFetch(payload: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch
}

describe('公共技能库服务客户端', () => {
  it('列表只保留合法技能名，并透传 ref / fileCount', async () => {
    const result = await listPublicSkills(jsonFetch({
      code: 200000,
      message: 'success',
      result: {
        fileCount: 3,
        ref: 'main',
        skills: [
          { name: 'agent-browser', path: 'agent-browser' },
          { name: 'bad name!', path: 'bad' },
          { name: 'ai-image-generation', path: 'ai-image-generation' },
          { name: 'agent-browser', path: 'duplicate' },
        ],
      },
    }))
    expect(result.ref).toBe('main')
    expect(result.fileCount).toBe(3)
    expect(result.skills).toEqual([
      { name: 'agent-browser', path: 'agent-browser' },
      { name: 'ai-image-generation', path: 'ai-image-generation' },
    ])
  })

  it('detail 返回正文，并按需回退 name / path', async () => {
    const detail = await fetchPublicSkill('agent-browser', jsonFetch({
      code: 200000,
      result: { content: '# body', description: 'Browser automation', invocation: { modelInvocable: true, userInvocable: true } },
    }))
    expect(detail.name).toBe('agent-browser')
    expect(detail.path).toBe('agent-browser/SKILL.md')
    expect(detail.content).toContain('body')
  })

  it('把剥掉 frontmatter 的正文补回 name / description', () => {
    const text = composeSkillMarkdown({
      name: 'agent-browser',
      path: 'agent-browser/SKILL.md',
      content: '# body',
      description: 'Browser: automation',
      invocation: { modelInvocable: false, userInvocable: true },
    })
    expect(text.startsWith('---\n')).toBe(true)
    expect(text).toContain('name: agent-browser')
    // 描述里的冒号必须被 YAML 引号包裹，否则会破坏 frontmatter。
    expect(text).toContain('description: \'Browser: automation\'')
    expect(text).toContain('disable-model-invocation: true')
    expect(text).toContain('# body')
  })

  it('code 非 200000 时带出上游 message', async () => {
    await expect(listPublicSkills(jsonFetch({ code: 500001, message: 'boom' })))
      .rejects.toThrow(/boom/)
    await expect(listPublicSkills(jsonFetch({ code: 500001, message: 'boom' })))
      .rejects.toBeInstanceOf(PublicSkillsError)
  })

  it('空正文与非法名字直接拒绝', async () => {
    await expect(fetchPublicSkill('agent-browser', jsonFetch({ code: 200000, result: { content: '   ' } })))
      .rejects.toThrow(/内容为空/)
    await expect(fetchPublicSkill('Bad Name')).rejects.toThrow(/不合法/)
  })

  it('超时折成中文可读错误', async () => {
    const timeoutFetch = (async () => { throw new DOMException('timeout', 'TimeoutError') }) as typeof fetch
    await expect(listPublicSkills(timeoutFetch)).rejects.toThrow(/超时/)
  })
})
