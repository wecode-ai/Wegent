import { expect, it, vi } from 'vitest'
import type { DeliveryApi } from '@/api/deliveries'
import type { ProjectSpaceDetailServices } from '@/features/workbench/workbenchServices'
import { createLocalWorkspaceApi } from './localWorkspaceApi'

it('saves native-model automation without requesting an unavailable cloud catalog', async () => {
  const model = { runtime: 'codex', provider: 'local', model_id: 'native', source: 'native' }
  const agent = {
    id: 'local-agent',
    name: 'Worker',
    runtime: 'codex',
    executionPolicy: { mode: 'fixed', environment_id: 'device' },
    modelPolicy: { mode: 'fixed', model },
  }
  const project = {
    id: 'local-project',
    name: 'Offline project',
    project_store: 'local',
    version: 1,
    automatic_processing_rules: [],
    collaboration_groups: [],
  }
  const delivery = {
    listCloudProjects: vi.fn(async () => ({ items: [project] })),
    updateCloudProject: vi.fn(async () => ({ ...project, version: 2 })),
  } as unknown as DeliveryApi
  const listModels = vi.fn(async () => {
    throw new Error('Cloud is unavailable')
  })
  const services = {
    localProjectChatAgentApi: {
      list: vi.fn(async () => [agent]),
      listModels,
      listRunnerEnvironments: vi.fn(async () => [
        {
          id: 'device',
          device_key: 'device',
          name: 'Local',
          owner_type: 'user',
          owner_id: '1',
          status: 'online',
          project_authorized: true,
          models: [
            {
              ...model,
              label: 'Native',
              local_model_id: 'native',
              is_default: true,
              account_label: 'Local',
            },
          ],
        },
      ]),
    },
  } as unknown as ProjectSpaceDetailServices
  const api = createLocalWorkspaceApi(delivery, 1, 'User', null, services)!
  await expect(
    api.automations!.create(project.id, {
      name: 'New tasks',
      prompt: 'Handle issue',
      enabled: true,
      triggerType: 'event',
      eventType: 'task.created',
      eventConfig: { executionTarget: 'existing_issue' },
      cronExpression: null,
      timezone: 'Asia/Shanghai',
      executionDeviceId: null,
      targetKind: 'agent',
      targetId: agent.id,
    })
  ).resolves.toMatchObject({ enabled: true, targetId: agent.id })
  expect(listModels).not.toHaveBeenCalled()
  expect(delivery.updateCloudProject).toHaveBeenCalledTimes(1)
})
