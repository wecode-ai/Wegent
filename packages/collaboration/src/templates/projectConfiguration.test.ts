import { describe, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi, WorkspaceAutomationRule } from '../ports/SharedWorkspaceApi'
import type { CollaborationGroup, CollaborationProject } from '../types'
import { builtinCollaborationTemplates } from './builtins'
import { bindTemplate, templateFromProject, validateTemplate } from './document'
import { applyProjectTemplate } from './projectConfiguration'
import { PartialTemplateApplyError } from './apply'

function fixture() {
  const document = structuredClone(builtinCollaborationTemplates()[0].document)
  const definition = document.spec.resources.collaboration.groups[0]
  const drafts = bindTemplate(document, {
    [definition.key]: Object.fromEntries(
      definition.roles.map(role => [
        role.key,
        {
          kind: 'agent',
          id: role.key === definition.leaderRole ? 'coordinator' : 'executor',
          responsibility: '',
        },
      ])
    ),
  })
  const group = {
    ...drafts[0],
    id: 'live-group-id',
    owner_type: 'project',
    owner_id: 'project-1',
    coordination_mode: 'manager',
    execution_requirements: { required_tags: [] },
  } as unknown as CollaborationGroup
  const project = {
    id: 'project-1',
    name: 'Workflow',
    description: '',
    version: 7,
    tags: ['business'],
    board_views: {
      schema_version: 1,
      default_view_id: 'original',
      views: [{ id: 'original', name: 'Existing', columns: [] }],
    },
  } as unknown as CollaborationProject
  const api = {
    projects: {
      get: vi.fn(async () => project),
      update: vi.fn(async () => project),
      createCollaborationGroup: vi.fn(async () => group),
    },
    automations: {
      list: vi.fn(async () => [] as WorkspaceAutomationRule[]),
      create: vi.fn(),
    },
  } as unknown as SharedWorkspaceApi
  return { api, document, drafts, group, project }
}

describe('template execution defaults', () => {
  it('routes new tasks to the persisted group and makes stage tags the default board without removing existing views', async () => {
    const { api, document, drafts, group, project } = fixture()
    await applyProjectTemplate(api, project.id, document, drafts, 'zh-CN', 'Partial')
    expect(api.automations!.create).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        enabled: true,
        triggerType: 'event',
        eventType: 'task.created',
        targetKind: 'collaboration_group',
        targetId: group.id,
        eventConfig: { executionTarget: 'existing_issue' },
      })
    )
    const update = vi.mocked(api.projects.update).mock.calls[0][1]
    const views = update.boardViews!
    expect(views.views[0].id).toBe('original')
    const defaultView = views.views.find(view => view.id === views.default_view_id)!
    expect(
      defaultView.columns.filter(column => column.type === 'tag').map(column => column.value)
    ).toEqual(document.spec.resources.collaboration.project.board!.tags)
    expect(defaultView.columns[0].type).toBe('unmatched')
    expect(update.tags).toContain('business')
    const exported = templateFromProject(
      {
        ...project,
        board_views: views,
        automatic_processing_rules: [
          {
            eventType: 'task.created',
            targetKind: 'collaboration_group',
            targetId: group.id,
            enabled: true,
          } as WorkspaceAutomationRule,
        ],
      },
      [group],
      'exported'
    )
    expect(exported.spec.resources.collaboration.project.taskAssignment).toEqual({
      enabled: true,
      groupKey: 'group-1',
    })
    expect(exported.spec.resources.collaboration.project.board?.tags).toEqual(
      document.spec.resources.collaboration.project.board?.tags
    )
    expect(exported.spec.resources.collaboration.groups[0].roles[0].defaultKind).toBe('agent')
    expect(JSON.stringify(exported)).not.toContain(group.id)
  })

  it('rejects a competing creation rule before adding any group', async () => {
    const { api, document, drafts } = fixture()
    vi.mocked(api.automations!.list).mockResolvedValue([
      { eventType: 'task.created', enabled: true } as WorkspaceAutomationRule,
    ])
    await expect(
      applyProjectTemplate(api, 'project-1', document, drafts, 'zh-CN', 'Partial')
    ).rejects.toThrow('已有')
    expect(api.projects.createCollaborationGroup).not.toHaveBeenCalled()
    expect(api.projects.update).not.toHaveBeenCalled()
  })

  it('reports partial configuration failure without recreating saved groups', async () => {
    const { api, document, drafts } = fixture()
    vi.mocked(api.projects.update).mockRejectedValue(new Error('Version conflict'))
    await expect(
      applyProjectTemplate(api, 'project-1', document, drafts, 'zh-CN', 'Partial')
    ).rejects.toBeInstanceOf(PartialTemplateApplyError)
    expect(api.projects.createCollaborationGroup).toHaveBeenCalledTimes(1)
    expect(api.automations!.create).toHaveBeenCalledTimes(1)
  })

  it('validates logical routing references, role types and tag constraints', () => {
    for (const mutate of [
      (d: ReturnType<typeof fixture>['document']) => {
        d.spec.resources.collaboration.project.taskAssignment!.groupKey = 'foreign-group-id'
      },
      (d: ReturnType<typeof fixture>['document']) => {
        d.spec.resources.collaboration.project.board!.tags = ['a', 'a']
      },
      (d: ReturnType<typeof fixture>['document']) => {
        d.spec.resources.collaboration.project.board!.tags = ['x'.repeat(33)]
      },
    ]) {
      const { document } = fixture()
      mutate(document)
      expect(() => validateTemplate(document)).toThrow()
    }
  })
})

it('preserves routing filters and selects the enabled rule when exporting a project', async () => {
  const { api, project, group, drafts, document } = fixture()
  const rules = [
    {
      eventType: 'task.created',
      targetKind: 'collaboration_group',
      targetId: group.id,
      enabled: false,
    },
    {
      eventType: 'task.created',
      targetKind: 'collaboration_group',
      targetId: group.id,
      enabled: true,
      eventConfig: { tags: ['review'], priorities: ['high'] },
    },
  ] as WorkspaceAutomationRule[]
  const exported = templateFromProject(
    { ...project, automatic_processing_rules: rules },
    [group],
    'filtered'
  )
  expect(exported.spec.resources.collaboration.project.taskAssignment).toEqual({
    enabled: true,
    groupKey: 'group-1',
    tags: ['review'],
    priorities: ['high'],
  })
  document.spec.resources.collaboration.project.taskAssignment =
    exported.spec.resources.collaboration.project.taskAssignment
  document.spec.resources.collaboration.project.taskAssignment!.groupKey = 'main'
  await applyProjectTemplate(api, project.id, document, drafts, 'zh-CN', 'Partial')
  expect(api.automations!.create).toHaveBeenCalledWith(
    project.id,
    expect.objectContaining({
      eventConfig: { executionTarget: 'existing_issue', tags: ['review'], priorities: ['high'] },
    })
  )
})
