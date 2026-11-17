import { describe, expect, it, vi } from 'vitest'
import { builtinCollaborationTemplates } from './builtins'
import {
  bindTemplate,
  exportTemplate,
  importTemplate,
  templateFromProject,
  validateTemplate,
} from './document'
import {
  materializeTemplateAgents,
  readTemplateAgents,
  templateAgentBindings,
  templateRoutingResolver,
} from './agents'
import { PartialTemplateApplyError } from './apply'
import { applyProjectTemplate } from './projectConfiguration'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { TemplateRoutingResolver } from './types'
import type { CollaborationGroup } from '../types'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const routing: TemplateRoutingResolver = async runtime => ({
  executionPolicy: { mode: 'fixed', environment_id: 'destination-device' },
  modelPolicy: {
    mode: 'fixed',
    model: {
      runtime,
      provider: 'openai',
      model_id: 'destination-default',
      source: 'native',
    },
  },
})

it('saves an unconfigured Agent without resolving a live device or model', async () => {
  expect(await templateRoutingResolver()('codex')).toEqual({
    executionPolicy: { mode: 'user_select' },
    modelPolicy: { mode: 'user_select' },
  })
})
it('persists explicit configuration as a definition and leaves admission to execution', async () => {
  const model = {
    runtime: 'codex' as const,
    provider: 'company',
    model_id: 'selected',
  }
  expect(await templateRoutingResolver('device', { codex: model })('codex')).toEqual({
    executionPolicy: { mode: 'fixed', environment_id: 'device' },
    modelPolicy: { mode: 'fixed', model },
  })
})

function fixture() {
  const document = structuredClone(builtinCollaborationTemplates()[0].document)
  const drafts = bindTemplate(document, templateAgentBindings(document))
  const create = vi.fn(async (_projectId: string, input: Record<string, unknown>) => ({
    id: `new-${input.name}`,
    name: String(input.name),
    ...input,
  }))
  const api = { agents: { create, list: vi.fn(async () => []) } } as unknown as SharedWorkspaceApi
  return { document, drafts, create, api }
}

describe('self-contained template Agents', () => {
  it('creates and binds all roles and stages in an account without existing Agents', async () => {
    const { document, drafts, create, api } = fixture()
    const result = await materializeTemplateAgents(
      api,
      'new-account-project',
      document,
      drafts,
      'partial',
      undefined,
      routing
    )
    expect(create).toHaveBeenCalledTimes(6)
    expect(result.agentIds.size).toBe(6)
    expect(result.drafts[0].leader.id).toBe('new-项目负责人')
    expect(result.drafts[0].stages[0].assignee?.id).toBe('new-产品经理')
    expect(JSON.stringify(result.drafts)).not.toContain('template-agent:')
    expect(create).toHaveBeenCalledWith(
      'new-account-project',
      expect.objectContaining({
        systemPrompt: document.spec.resources.collaboration.agents![0].systemPrompt,
        capabilityMode: 'follow_device',
      })
    )
  })

  it('creates each referenced definition once, even across groups, and ignores unused definitions', async () => {
    const { document, drafts, create, api } = fixture()
    document.spec.resources.collaboration.agents!.push({
      key: 'unused',
      name: 'Unused',
      runtime: 'codex',
      systemPrompt: '',
      capabilityDescription: '',
    })
    const result = await materializeTemplateAgents(
      api,
      'project',
      document,
      [...drafts, { ...drafts[0], name: 'Second group' }],
      'partial',
      undefined,
      routing
    )
    expect(create).toHaveBeenCalledTimes(6)
    expect(result.drafts[1].leader.id).toBe(result.drafts[0].leader.id)
  })

  it('reports partial persistence when a later Agent fails', async () => {
    const { document, drafts, create, api } = fixture()
    create
      .mockResolvedValueOnce({ id: 'created', name: 'Coordinator' })
      .mockRejectedValueOnce(new Error('offline'))
    await expect(
      materializeTemplateAgents(api, 'project', document, drafts, 'partial', undefined, routing)
    ).rejects.toBeInstanceOf(PartialTemplateApplyError)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('blocks an unsafe retry when Agents exist but the first group fails', async () => {
    const { document, drafts, api } = fixture()
    delete document.spec.resources.collaboration.project.taskAssignment
    delete document.spec.resources.collaboration.project.board
    api.projects = {
      createCollaborationGroup: vi.fn().mockRejectedValue(new Error('offline')),
    } as unknown as SharedWorkspaceApi['projects']
    await expect(
      applyProjectTemplate(api, 'project', document, drafts, 'zh-CN', 'partial', routing)
    ).rejects.toMatchObject({ outcome: 'partial', retryBlocked: true })
  })

  it('preserves confirmed Agent writes without claiming a concurrent group after HTTP 409', async () => {
    const { document, drafts, api, create } = fixture()
    delete document.spec.resources.collaboration.project.taskAssignment
    delete document.spec.resources.collaboration.project.board
    const concurrent = { id: 'concurrent-group', name: drafts[0].name } as CollaborationGroup
    const cause = Object.assign(new Error('duplicate'), { status: 409 })
    api.projects = {
      listCollaborationGroups: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([concurrent]),
      createCollaborationGroup: vi.fn().mockRejectedValue(cause),
    } as unknown as SharedWorkspaceApi['projects']
    const failure = await applyProjectTemplate(
      api,
      'project',
      document,
      drafts,
      'zh-CN',
      'partial',
      routing
    ).catch(error => error)
    expect(failure).toMatchObject({ cause, outcome: 'partial', retryBlocked: true })
    expect(failure.message).toContain('部分智能体或小组已添加')
    expect(failure.message).not.toContain('已创建小组')
    expect(create).toHaveBeenCalledTimes(6)
    expect(api.projects.createCollaborationGroup).toHaveBeenCalledOnce()
  })

  it('keeps newly observed Agents unconfirmed after losing the first creation response', async () => {
    const { document, drafts, api, create } = fixture()
    delete document.spec.resources.collaboration.project.taskAssignment
    delete document.spec.resources.collaboration.project.board
    api.projects = {
      listCollaborationGroups: vi.fn(async () => []),
      createCollaborationGroup: vi.fn(),
    } as unknown as SharedWorkspaceApi['projects']
    create.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.mocked(api.agents.list)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce([
        {
          id: 'persisted-agent',
          name: document.spec.resources.collaboration.agents![0].name,
        },
      ])
    const error = await applyProjectTemplate(
      api,
      'project',
      document,
      drafts,
      'zh-CN',
      'partial',
      routing
    ).catch(cause => cause)
    expect(error).toMatchObject({ outcome: 'unknown', retryBlocked: true })
    const observed = await error.recheck()
    expect(observed).toMatchObject({ outcome: 'unknown', retryBlocked: true })
    expect(observed.message).toContain('尚不能确认是否由本次请求创建')
    expect(create).toHaveBeenCalledOnce()
    expect(api.projects.createCollaborationGroup).not.toHaveBeenCalled()
    expect(api.agents.list).toHaveBeenLastCalledWith('project', { forceRefresh: true })
  })

  it.each([
    new TypeError('Failed to fetch'),
    Object.assign(new Error('Internal server error'), { status: 500 }),
  ])('blocks empty Agent reads until a late commit is detected: %s', async cause => {
    const { document, drafts, api, create } = fixture()
    delete document.spec.resources.collaboration.project.taskAssignment
    delete document.spec.resources.collaboration.project.board
    api.projects = {
      listCollaborationGroups: vi.fn(async () => []),
      createCollaborationGroup: vi.fn(),
    } as unknown as SharedWorkspaceApi['projects']
    const request = deferred<Awaited<ReturnType<typeof create>>>()
    const started = deferred<void>()
    const persisted = deferred<void>()
    const created = {
      id: 'late-agent',
      name: document.spec.resources.collaboration.agents![0].name,
    }
    let agents: (typeof created)[] = []
    const commit = persisted.promise.then(() => {
      agents = [created]
    })
    create.mockImplementationOnce(() => {
      started.resolve()
      return request.promise
    })
    vi.mocked(api.agents.list).mockImplementation(async () => agents)
    const application = applyProjectTemplate(
      api,
      'project',
      document,
      drafts,
      'zh-CN',
      'partial',
      routing
    ).catch(error => error)
    await started.promise
    request.reject(cause)
    const failure = await application
    expect(failure).toMatchObject({ cause, outcome: 'unknown', retryBlocked: true })
    expect(await failure.recheck()).toMatchObject({ outcome: 'unknown', retryBlocked: true })
    expect(await failure.recheck()).toMatchObject({ outcome: 'unknown', retryBlocked: true })
    persisted.resolve()
    await commit
    const observed = await failure.recheck()
    expect(observed).toMatchObject({ cause, outcome: 'unknown', retryBlocked: true })
    expect(observed.message).toContain('尚不能确认是否由本次请求创建')
    expect(create).toHaveBeenCalledOnce()
    expect(api.projects.createCollaborationGroup).not.toHaveBeenCalled()
    expect(api.agents.list).toHaveBeenLastCalledWith('project', { forceRefresh: true })
  })

  it.each([400, 401, 403, 409, 422])(
    'allows retry after an Agent creation request is rejected with HTTP %i',
    async status => {
      const { document, drafts, api, create } = fixture()
      delete document.spec.resources.collaboration.project.taskAssignment
      delete document.spec.resources.collaboration.project.board
      api.projects = {
        listCollaborationGroups: vi.fn(async () => []),
        createCollaborationGroup: vi.fn(),
      } as unknown as SharedWorkspaceApi['projects']
      const cause = Object.assign(new Error('Request rejected'), { status })
      create.mockRejectedValueOnce(cause)
      await expect(
        applyProjectTemplate(api, 'project', document, drafts, 'zh-CN', 'partial', routing)
      ).rejects.toMatchObject({ cause, outcome: 'unchanged', retryBlocked: false })
      expect(create).toHaveBeenCalledOnce()
      expect(api.projects.createCollaborationGroup).not.toHaveBeenCalled()
    }
  )

  it('exports original prompts with portable references and recreates them in another account', async () => {
    const { document, drafts, api } = fixture()
    const result = await materializeTemplateAgents(
      api,
      'first-account',
      document,
      drafts,
      'partial',
      undefined,
      routing
    )
    const agents = document.spec.resources.collaboration.agents!.map(agent => ({
      ...agent,
      id: `new-${agent.name}`,
      executionDeviceId: 'private-device',
      apiKey: 'private-credential',
    }))
    const group = {
      ...result.drafts[0],
      stages: result.drafts[0].stages.map(stage => ({
        ...stage,
        assignee: stage.assignee,
      })),
      execution_requirements: { required_tags: [] },
    } as unknown as CollaborationGroup
    const saved = templateFromProject(
      { name: 'Portable', description: '' },
      [group],
      'portable',
      'en',
      await readTemplateAgents(agents, [group])
    )
    const yaml = exportTemplate(saved)
    expect(yaml).not.toContain('private-device')
    expect(yaml).not.toContain('private-credential')
    expect(yaml).not.toContain('first-account')
    expect(saved.spec.resources.collaboration.agents?.map(agent => agent.systemPrompt)).toEqual(
      document.spec.resources.collaboration.agents!.map(agent => agent.systemPrompt)
    )
    const imported = importTemplate(yaml)
    let secondId = 0
    const create = vi.fn(async () => ({
      id: `second-${++secondId}`,
      name: 'Created',
    }))
    const second = await materializeTemplateAgents(
      { agents: { ...api.agents, create } },
      'second-account',
      imported,
      bindTemplate(imported, templateAgentBindings(imported)),
      'partial',
      undefined,
      routing
    )
    expect(create).toHaveBeenCalledTimes(6)
    expect(second.agentIds.size).toBe(6)
  })

  it('preserves manual approval, workspace and concurrency policies', async () => {
    const { document, drafts, create, api } = fixture()
    Object.assign(document.spec.resources.collaboration.agents![0], {
      executionMode: 'manual_approval',
      workspacePolicy: 'git_worktree',
      maxConcurrentExecutions: 3,
    })
    await materializeTemplateAgents(
      api,
      'target',
      importTemplate(exportTemplate(document)),
      drafts,
      'partial',
      undefined,
      routing
    )
    expect(create).toHaveBeenCalledWith(
      'target',
      expect.objectContaining({
        executionMode: 'manual_approval',
        workspacePolicy: 'git_worktree',
        maxConcurrentExecutions: 3,
      })
    )
  })

  it('rejects credentials, dangling references, duplicate keys and incompatible human roles', () => {
    const { document } = fixture()
    const definitions = document.spec.resources.collaboration
    definitions.agents![0] = {
      ...definitions.agents![0],
      apiKey: 'secret',
    } as (typeof definitions.agents)[0]
    expect(() => validateTemplate(document)).toThrow('agent')
    delete (definitions.agents![0] as unknown as Record<string, unknown>).apiKey
    definitions.groups[0].roles[0].agentKey = 'missing'
    expect(() => validateTemplate(document)).toThrow('role.agentKey')
    definitions.groups[0].roles[0].agentKey = definitions.agents![0].key
    definitions.groups[0].roles[0].defaultKind = 'human'
    expect(() => validateTemplate(document)).toThrow('role.agentKey')
  })
})

it('resolves every referenced runtime before any Agent is created', async () => {
  const { document, drafts, create, api } = fixture()
  document.spec.resources.collaboration.agents![5].runtime = 'claude_code'
  const resolve = vi.fn(async (runtime: 'codex' | 'claude_code') => {
    if (runtime === 'claude_code') throw new Error('Missing Claude default')
    return routing(runtime)
  })
  await expect(
    materializeTemplateAgents(api, 'target', document, drafts, 'partial', undefined, resolve)
  ).rejects.toThrow('Missing Claude default')
  expect(resolve).toHaveBeenCalledTimes(2)
  expect(create).not.toHaveBeenCalled()
})
