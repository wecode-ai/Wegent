import { expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { ProjectAgentConfigurationHost } from '../project-agent-config/types'
import type { CollaborationGroup } from '../types'
import { builtinCollaborationTemplates } from './builtins'
import { bindTemplate } from './document'
import { templateAgentBindings } from './agents'
import { applyWorkspaceTemplate } from './workspaceConfiguration'
import { PartialTemplateApplyError } from './apply'

function fixture() {
  const document = builtinCollaborationTemplates()[0].document
  const drafts = bindTemplate(document, templateAgentBindings(document))
  const create = vi.fn(async (_id, input) => ({ id: 'group', ...input }) as CollaborationGroup)
  const addAgent = vi.fn(async () => undefined)
  const api = {
    workspaces: { createCollaborationGroup: create, addAgent },
  } as unknown as SharedWorkspaceApi
  let id = 100
  const host = {
    resolveTemplateAgentRouting: vi.fn(async () => ({
      executionPolicy: { mode: 'fixed', environment_id: 'destination-device' },
      modelPolicy: {
        mode: 'fixed',
        model: { runtime: 'codex', provider: 'openai', model_id: 'destination-model' },
      },
    })),
    createTemplateAgent: vi.fn(async () => ({ id: String(++id), name: 'Agent' })),
  } as unknown as ProjectAgentConfigurationHost
  return { document, drafts, create, addAgent, api, host }
}

it('creates cloud resources in the destination namespace and binds them before the group', async () => {
  const { document, drafts, api, host, addAgent, create } = fixture()
  await applyWorkspaceTemplate(
    api,
    { id: 'space', location: 'cloud', namespace: 'design' },
    document,
    drafts,
    host,
    'partial',
    vi.fn()
  )
  expect(host.createTemplateAgent).toHaveBeenCalledTimes(6)
  expect(host.createTemplateAgent).toHaveBeenCalledWith(
    document.spec.resources.collaboration.agents![0],
    'design',
    expect.objectContaining({
      executionPolicy: { mode: 'fixed', environment_id: 'destination-device' },
    })
  )
  expect(addAgent).toHaveBeenCalledWith('space', { teamId: 101 })
  expect(create).toHaveBeenCalledWith(
    'space',
    expect.objectContaining({
      leader: expect.objectContaining({ id: '101' }),
      stages: expect.arrayContaining([
        expect.objectContaining({ assignee: expect.objectContaining({ id: '102' }) }),
      ]),
    })
  )
})

it('uses the local workspace storage owner instead of creating cloud resources', async () => {
  const { document, drafts, api, host } = fixture()
  let id = 0
  api.workspaces!.createTemplateAgent = vi.fn(async (_space, agent) => ({
    id: `local-${++id}`,
    name: agent.name,
  }))
  await applyWorkspaceTemplate(
    api,
    { id: 'local', location: 'local', namespace: 'default' },
    document,
    drafts,
    host,
    'partial',
    vi.fn()
  )
  expect(api.workspaces!.createTemplateAgent).toHaveBeenCalledTimes(6)
  expect(host.createTemplateAgent).not.toHaveBeenCalled()
})

it('does not retry resource creation when workspace binding fails after creation', async () => {
  const { document, drafts, api, host, addAgent } = fixture()
  addAgent.mockRejectedValue(new Error('offline'))
  await expect(
    applyWorkspaceTemplate(
      api,
      { id: 'space', location: 'cloud', namespace: 'default' },
      document,
      drafts,
      host,
      'partial',
      vi.fn()
    )
  ).rejects.toBeInstanceOf(PartialTemplateApplyError)
  expect(host.createTemplateAgent).toHaveBeenCalledTimes(1)
})

it('reports each persisted group before a later failure so closing can refresh the parent', async () => {
  const { document, drafts, api, host, create } = fixture()
  create
    .mockResolvedValueOnce({ id: 'first' } as CollaborationGroup)
    .mockRejectedValueOnce(new Error('offline'))
  const persisted = vi.fn()
  await expect(
    applyWorkspaceTemplate(
      api,
      { id: 'space', location: 'cloud', namespace: 'default' },
      document,
      [...drafts, { ...drafts[0], name: 'Other' }],
      host,
      'partial',
      persisted
    )
  ).rejects.toBeInstanceOf(PartialTemplateApplyError)
  expect(persisted).toHaveBeenCalledTimes(1)
})

it('rejects unsupported cloud approval policies before creating any resource', async () => {
  const { document: source, drafts, api, host } = fixture()
  const document = structuredClone(source)
  document.spec.resources.collaboration.agents![5].executionMode = 'manual_approval'
  await expect(
    applyWorkspaceTemplate(
      api,
      { id: 'space', location: 'cloud', namespace: 'default' },
      document,
      drafts,
      host,
      'partial',
      vi.fn(),
      'Approval policy cannot be preserved'
    )
  ).rejects.toThrow('Approval policy cannot be preserved')
  expect(host.createTemplateAgent).not.toHaveBeenCalled()
})
