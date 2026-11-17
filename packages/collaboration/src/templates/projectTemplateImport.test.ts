import { describe, expect, it, vi } from 'vitest'
import type {
  SharedWorkspaceApi,
  WorkspaceAutomationRule,
  WorkspaceProjectAgent,
} from '../ports/SharedWorkspaceApi'
import type { CollaborationGroup, CollaborationProject } from '../types'
import type {
  TemplateImportBegin,
  TemplateImportContext,
  TemplateImportOperation,
  TemplateImportStepKind,
} from './projectTemplateImportTypes'
import { builtinCollaborationTemplates } from './builtins'
import { bindTemplate } from './document'
import { templateAgentBindings } from './agents'
import { applyProjectTemplate, resumeProjectTemplateImport } from './projectConfiguration'
import { TemplateImportRetryError } from './projectTemplateImport'
import {
  canonicalTemplateImportJson,
  readProjectTemplateImportIntent,
} from './projectTemplateImportIntent'

function fixture(embeddedAgents = true) {
  const document = structuredClone(builtinCollaborationTemplates()[0].document)
  const definition = document.spec.resources.collaboration.groups[0]
  const drafts = bindTemplate(
    document,
    embeddedAgents
      ? templateAgentBindings(document)
      : {
          [definition.key]: Object.fromEntries(
            definition.roles.map((role, index) => [
              role.key,
              {
                kind: 'human',
                id: String(index + 1),
                responsibility: role.responsibility,
              },
            ])
          ),
        }
  )
  const operations = new Map<string, TemplateImportOperation>()
  const identities = new Map<string, string>()
  const payloads = new Map<string, string>()
  const agents = new Map<string, WorkspaceProjectAgent>()
  const groups = new Map<string, CollaborationGroup>()
  const rules = new Map<string, WorkspaceAutomationRule>()
  const commits = { agent: 0, group: 0, automation: 0, board: 0 }
  const loseResponse = new Set<TemplateImportStepKind>()
  const rejectWrite = new Map<TemplateImportStepKind, unknown>()
  let project = {
    id: 'project',
    name: 'Project',
    description: '',
    version: 1,
    tags: ['existing'],
    board_views: {
      schema_version: 1,
      default_view_id: 'original',
      views: [{ id: 'original', name: 'Original', columns: [] }],
    },
  } as unknown as CollaborationProject
  const snapshot = (operation: TemplateImportOperation) =>
    structuredClone({
      ...operation,
      status: operation.steps.every(step => step.resourceId) ? 'completed' : 'pending',
    }) as TemplateImportOperation
  const read = (kind: TemplateImportStepKind, id: string) =>
    kind === 'agent'
      ? agents.get(id)
      : kind === 'group'
        ? groups.get(id)
        : kind === 'automation'
          ? rules.get(id)
          : project

  async function write(
    kind: TemplateImportStepKind,
    input: Record<string, unknown>,
    context: TemplateImportContext | undefined
  ) {
    if (!context) throw new Error('Durable writes require explicit context')
    const operation = operations.get(context.operationId)!
    const step = operation.steps.find(step => step.key === context.stepKey && step.kind === kind)!
    const identity = `${operation.id}/${step.key}`
    const body = canonicalTemplateImportJson(input)
    if (step.resourceId) {
      if (kind !== 'board' && payloads.get(identity) !== body)
        throw Object.assign(new Error('Step payload changed'), { status: 409 })
      return structuredClone(read(kind, step.resourceId))
    }
    if (rejectWrite.has(kind)) {
      const cause = rejectWrite.get(kind)
      rejectWrite.delete(kind)
      throw cause
    }
    commits[kind]++
    const id = kind === 'board' ? project.id : `${kind}-${commits[kind]}`
    if (kind === 'agent')
      agents.set(id, { ...input, id, name: String(input.name) } as WorkspaceProjectAgent)
    if (kind === 'group') groups.set(id, { ...input, id } as unknown as CollaborationGroup)
    if (kind === 'automation')
      rules.set(id, { ...input, id, projectId: project.id } as unknown as WorkspaceAutomationRule)
    if (kind === 'board')
      project = {
        ...project,
        version: project.version + 1,
        tags: (input.tags ?? project.tags) as string[],
        board_views: (input.boardViews ??
          project.board_views) as CollaborationProject['board_views'],
      }
    payloads.set(identity, body)
    step.resourceId = id
    if (loseResponse.delete(kind)) throw new TypeError('Failed to fetch')
    return structuredClone(read(kind, id))
  }

  function client(): SharedWorkspaceApi {
    return {
      templateImports: {
        begin: vi.fn(async (_projectId: string, input: TemplateImportBegin) => {
          const identity = canonicalTemplateImportJson(input)
          let id = identities.get(identity)
          if (!id) {
            id = `operation-${operations.size + 1}`
            identities.set(identity, id)
            operations.set(id, {
              id,
              projectId: project.id,
              protocolVersion: 1,
              status: 'pending',
              intent: structuredClone(input.intent),
              steps: structuredClone(input.steps),
            })
          }
          return snapshot(operations.get(id)!)
        }),
        get: vi.fn(async (_projectId: string, id: string) => snapshot(operations.get(id)!)),
        list: vi.fn(async () => [...operations.values()].map(snapshot)),
      },
      agents: {
        list: vi.fn(async () => [...agents.values()].map(agent => structuredClone(agent))),
        create: vi.fn(async (_projectId, input, context) => write('agent', input, context)),
      },
      projects: {
        get: vi.fn(async () => structuredClone(project)),
        listCollaborationGroups: vi.fn(async () =>
          [...groups.values()].map(group => structuredClone(group))
        ),
        createCollaborationGroup: vi.fn(async (_projectId, input, context) =>
          write('group', input, context)
        ),
        update: vi.fn(async (_projectId, input, context) => write('board', input, context)),
      },
      automations: {
        list: vi.fn(async () => [...rules.values()].map(rule => structuredClone(rule))),
        create: vi.fn(async (_projectId, input, context) =>
          write('automation', input as unknown as Record<string, unknown>, context)
        ),
      },
    } as unknown as SharedWorkspaceApi
  }
  return {
    document,
    drafts,
    client,
    operations,
    agents,
    groups,
    rules,
    commits,
    loseResponse,
    rejectWrite,
    currentProject: () => project,
  }
}

const apply = (api: SharedWorkspaceApi, f: ReturnType<typeof fixture>) =>
  applyProjectTemplate(api, 'project', f.document, f.drafts, 'zh-CN', 'Partial')

describe('durable project template imports', () => {
  it('lets two independent clients apply the same frozen configuration without duplicate resources', async () => {
    const f = fixture()
    const [first, second] = await Promise.all([apply(f.client(), f), apply(f.client(), f)])
    expect(first.map(group => group.id)).toEqual(second.map(group => group.id))
    expect(f.operations.size).toBe(1)
    expect(f.commits).toEqual({ agent: 6, group: 1, automation: 1, board: 1 })
    expect(f.currentProject().board_views!.views).toHaveLength(2)
  })

  it.each(['agent', 'group', 'automation', 'board'] as const)(
    'resumes exact owned receipts from a new client after losing the %s response',
    async kind => {
      const f = fixture()
      f.loseResponse.add(kind)
      const failure = await apply(f.client(), f).catch(error => error as TemplateImportRetryError)
      expect(failure).toBeInstanceOf(TemplateImportRetryError)
      expect(failure.retryBlocked).toBe(false)
      expect(failure.cause).toBeInstanceOf(TypeError)
      expect(failure.message).toContain('已完成')
      expect(failure.operation!.steps.some(step => step.kind === kind && step.resourceId)).toBe(
        true
      )
      const next = f.client()
      const groups = await resumeProjectTemplateImport(next, 'project', failure.operation!.id, 'en')
      expect(groups).toHaveLength(1)
      expect(f.operations.size).toBe(1)
      expect(f.commits).toEqual({ agent: 6, group: 1, automation: 1, board: 1 })
      expect(f.rules.values().next().value!.name).toContain('新任务')
      expect(readProjectTemplateImportIntent(failure.operation!).executionLocale).toBe('zh-CN')
    }
  )

  it('restores partial progress from GET without resolving current device or model defaults', async () => {
    const f = fixture()
    f.rejectWrite.set('group', Object.assign(new Error('Unavailable'), { status: 503 }))
    const error = await apply(f.client(), f).catch(error => error as TemplateImportRetryError)
    expect(f.commits.agent).toBe(6)
    expect(f.commits.group).toBe(0)
    const next = f.client()
    await resumeProjectTemplateImport(next, 'project', error.operation!.id, 'en')
    expect(next.templateImports!.begin).not.toHaveBeenCalled()
    expect(next.agents.create).not.toHaveBeenCalled()
    expect(f.commits).toEqual({ agent: 6, group: 1, automation: 1, board: 1 })
  })

  it('replays a completed operation without overwriting later board edits or automation changes', async () => {
    const f = fixture(false)
    await apply(f.client(), f)
    f.currentProject().tags.push('later-user-edit')
    f.currentProject().board_views!.views.push({ id: 'later', name: 'Later view', columns: [] })
    const rule = f.rules.values().next().value!
    rule.enabled = false
    const next = f.client()
    await apply(next, f)
    expect(next.projects.update).not.toHaveBeenCalled()
    expect(next.automations!.create).not.toHaveBeenCalled()
    expect(next.agents.create).not.toHaveBeenCalled()
    expect(f.currentProject().tags).toContain('later-user-edit')
    expect(f.currentProject().board_views!.views.map(view => view.id)).toContain('later')
    expect(rule.enabled).toBe(false)
  })

  it('ignores only its own saved automation when resuming a failed board step', async () => {
    const f = fixture(false)
    f.rejectWrite.set('board', new TypeError('Failed to fetch'))
    const error = await apply(f.client(), f).catch(error => error as TemplateImportRetryError)
    expect(f.commits.automation).toBe(1)
    const ownRule = f.rules.values().next().value!
    expect(ownRule.enabled).toBe(true)
    const unrelated = { ...ownRule, id: 'unrelated-rule', name: 'Another rule' }
    f.rules.set(unrelated.id, unrelated)
    await expect(
      resumeProjectTemplateImport(f.client(), 'project', error.operation!.id, 'zh-CN')
    ).rejects.toThrow('已有')
    expect(f.commits.board).toBe(0)
    f.rules.delete(unrelated.id)
    await resumeProjectTemplateImport(f.client(), 'project', error.operation!.id, 'zh-CN')
    expect(f.commits).toEqual({ agent: 0, group: 1, automation: 1, board: 1 })
  })

  it('does not fall back to ordinary writes when beginning an operation fails', async () => {
    const f = fixture(false)
    const api = f.client()
    vi.mocked(api.templateImports!.begin).mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(apply(api, f)).rejects.toBeInstanceOf(TemplateImportRetryError)
    expect(api.projects.createCollaborationGroup).not.toHaveBeenCalled()
    expect(api.agents.create).not.toHaveBeenCalled()
    expect(api.projects.update).not.toHaveBeenCalled()
  })

  it('reuses an operation whose begin response was lost before any resource write', async () => {
    const f = fixture(false)
    const api = f.client()
    const begin = vi.mocked(api.templateImports!.begin).getMockImplementation()!
    vi.mocked(api.templateImports!.begin).mockImplementationOnce(async (...args) => {
      await begin(...args)
      throw new TypeError('Failed to fetch')
    })
    await expect(apply(api, f)).rejects.toBeInstanceOf(TemplateImportRetryError)
    expect(f.commits).toEqual({ agent: 0, group: 0, automation: 0, board: 0 })
    await apply(f.client(), f)
    expect(f.operations.size).toBe(1)
    expect(f.commits).toEqual({ agent: 0, group: 1, automation: 1, board: 1 })
  })

  it('preserves confirmed progress and the mutation cause when status refresh also fails', async () => {
    const f = fixture()
    f.loseResponse.add('group')
    const api = f.client()
    const get = vi.mocked(api.templateImports!.get).getMockImplementation()!
    vi.mocked(api.templateImports!.get).mockImplementation(async (...args) => {
      if (f.commits.group) throw Object.assign(new Error('Status unavailable'), { status: 503 })
      return get(...args)
    })
    const error = await apply(api, f).catch(error => error as TemplateImportRetryError)
    expect(error.cause).toBeInstanceOf(TypeError)
    expect(error.operation!.steps.filter(step => step.resourceId)).toHaveLength(6)
    expect(error.message).toContain('6/9')
    await resumeProjectTemplateImport(f.client(), 'project', error.operation!.id, 'zh-CN')
    expect(f.commits).toEqual({ agent: 6, group: 1, automation: 1, board: 1 })
  })

  it.each(['project', 'intent', 'steps'] as const)(
    'rejects a mismatched %s before any resource write',
    async mismatch => {
      const f = fixture(false)
      const api = f.client()
      const begin = vi.mocked(api.templateImports!.begin).getMockImplementation()!
      vi.mocked(api.templateImports!.begin).mockImplementation(async (...args) => {
        const operation = await begin(...args)
        if (mismatch === 'project') operation.projectId = 'other-project'
        if (mismatch === 'intent') operation.intent = { altered: true }
        if (mismatch === 'steps') operation.steps[0].key = 'group:other'
        return operation
      })
      await expect(apply(api, f)).rejects.toThrow('不一致')
      expect(f.commits).toEqual({ agent: 0, group: 0, automation: 0, board: 0 })
    }
  )

  it('uses a distinct operation when actual requested configuration changes', async () => {
    const f = fixture(false)
    await apply(f.client(), f)
    delete f.document.spec.resources.collaboration.project.taskAssignment
    f.document.spec.resources.collaboration.groups[0].name = 'Intentional second group'
    f.drafts[0].name = 'Intentional second group'
    await apply(f.client(), f)
    expect(f.operations.size).toBe(2)
    expect(f.commits.group).toBe(2)
    expect(f.commits.board).toBe(2)
  })
})
