import { describe, expect, it, vi } from 'vitest'
import { createSharedIssueDetailPort } from '@wegent/collaboration'
import { DEFAULT_WORK_ITEM_PROJECT_ID } from '@/api/deliveries'
import { createLocalProjectChatAgentApi } from '@/api/local/localDelivery'
import type {
  LocalProjectSpaceApi,
  ProjectSpaceDetailServices,
} from '@/features/workbench/workbenchServices'
import { createLocalWorkspaceApi, LOCAL_WORKSPACE_ID } from './localWorkspaceApi'

describe('local workspace Agent reuse', () => {
  it.each(['本地代码助手', 'Local coding Agent'])(
    'preserves identity and configuration and refreshes the Issue catalog for %s',
    async displayName => {
      const source = {
        id: 'LA-source',
        project_id: DEFAULT_WORK_ITEM_PROJECT_ID,
        name: 'agent-resource-123',
        display_name: displayName,
        runtime: 'codex',
        system_prompt: 'Review the assigned code.',
        execution_policy: { mode: 'project_pool' },
        model_policy: { mode: 'user_select' },
        capability_mode: 'manual',
        additional_skills: [{ name: 'code-review', namespace: 'default' }],
        mcp_servers: { review: { command: 'review-server' } },
        status: 'active',
      }
      const records = [source, { ...source, id: 'LA-default', name: 'current-device-agent' }]
      const sourceBefore = structuredClone(source)
      const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
        if (method === 'chat_agents.list') {
          return records.filter(record => record.project_id === params?.project_id)
        }
        if (method === 'chat_agents.create') {
          const created = {
            ...(params?.agent as typeof source),
            id: 'LA-project',
            project_id: String(params?.project_id),
          }
          records.push(created)
          return created
        }
        throw new Error(`Unexpected method: ${method}`)
      })
      const api = createLocalWorkspaceApi({} as LocalProjectSpaceApi, 1, 'User', null, {
        localProjectChatAgentApi: createLocalProjectChatAgentApi(request, 1),
      } as ProjectSpaceDetailServices)!

      const catalog = await api.workspaces!.listAgents(LOCAL_WORKSPACE_ID)
      const selected = catalog.find(agent => agent.name === displayName && agent.id === source.id)!
      expect(selected).toMatchObject({
        agent_id: source.name,
        location: 'local',
        status: 'available',
      })
      const port = createSharedIssueDetailPort(api, async () => undefined)
      const project = {
        id: 'local-project',
        workspace_id: LOCAL_WORKSPACE_ID,
        project_store: 'local' as const,
      }
      expect(await port.agentResources!.list(project)).toContainEqual(selected)
      expect(await port.agentResources!.bind(project, selected.id)).toBe('LA-project')
      expect(await port.agentResources!.bind(project, selected.id)).toBe('LA-project')
      expect(request.mock.calls.filter(([method]) => method === 'chat_agents.create')).toHaveLength(
        1
      )

      expect(request).toHaveBeenCalledWith('chat_agents.create', {
        project_id: 'local-project',
        agent: expect.objectContaining({
          name: source.name,
          display_name: displayName,
          system_prompt: source.system_prompt,
          execution_policy: source.execution_policy,
          model_policy: source.model_policy,
          additional_skills: source.additional_skills,
          mcp_servers: source.mcp_servers,
        }),
      })
      await expect(api.agents.list('local-project')).resolves.toMatchObject([
        { id: 'LA-project', agent_id: source.name, name: displayName, displayName },
      ])
      expect(records.find(record => record.id === source.id)).toEqual(sourceBefore)

      // Another Runtime client can create a resource while this project stays open.
      records.push({ ...source, id: 'LA-added', name: 'agent-added-after-first-open' })
      expect(await port.agentResources!.list(project)).toContainEqual(
        expect.objectContaining({ id: 'LA-added' })
      )
    }
  )
})
