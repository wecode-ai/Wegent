import { describe, expect, it } from 'vitest'
import { projectSpaceChatRuntimeContext, type ProjectSpaceContext } from './project-space-context'

describe('projectSpaceChatRuntimeContext', () => {
  it.each(['local', 'backend'] as const)(
    'distinguishes project Issues from personal conversations in a %s project',
    projectStore => {
      const project: ProjectSpaceContext = {
        id: 'project-11',
        name: 'Wegent',
        project_key: 'WEG',
        project_store: projectStore,
        task_provider: 'native',
        provider_config: {},
      }
      const context = projectSpaceChatRuntimeContext(project)
      const prompt = context.projectSpaceChat.value

      expect(prompt).toContain(JSON.stringify({ id: project.id, name: project.name }))
      expect(prompt).toContain('"事项", "查一下事项"')
      expect(prompt).toContain('wework_space get_current_context')
      expect(prompt).toContain('list_board_items or search_board_items with the bound space_id')
      expect(prompt).toContain('bound:false together with a space_id')
      expect(prompt).toContain('"查个人任务", "我的个人任务"')
      expect(prompt).toContain('use the personal task/conversation capabilities instead')
      expect(prompt).toContain('Interpret bare "任务" or "tasks" using the current conversation')
      expect(prompt).toContain('Issue identifiers and titles')
      expect(prompt).toContain('no matching Issues were found in the current project')
      expect(prompt).toContain('Report access or query errors as errors, never as empty results')
      expect(context).not.toHaveProperty('dingtalkAITableProject')
    }
  )

  it('keeps explicit personal requests outside the bound DingTalk table', () => {
    const context = projectSpaceChatRuntimeContext({
      id: 'table-project',
      name: 'Project table',
      project_key: 'TABLE',
      project_store: 'backend',
      task_provider: 'dingtalk_aitable',
      provider_config: { base_id: 'base-1', table_id: 'table-1' },
    })

    expect(context.dingtalkAITableProject.value).toContain(
      'Explicit personal task or conversation requests retain their personal scope'
    )
    expect(context.dingtalkAITableProject.value).not.toContain('"my tasks"')
    expect(context.dingtalkAITableProject.value).toContain('"base_id": "base-1"')
    expect(context.dingtalkAITableProject.value).toContain('"table_id": "table-1"')
  })
})
