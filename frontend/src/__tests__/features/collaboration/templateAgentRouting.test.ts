import {
  agentDefinitionRouting,
  resolveRunnerSelection,
  type RunnerEnvironment,
} from '@wegent/collaboration'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { listWebTemplateAgentEnvironments } from '@/features/collaboration/templateAgentRouting'
import { apiClient } from '@/apis/client'
import { deviceApis } from '@/apis/devices'

jest.mock('@/apis/client', () => ({ apiClient: { get: jest.fn() } }))
jest.mock('@/apis/devices', () => ({ deviceApis: { getAllDevices: jest.fn() } }))

const model = { runtime: 'codex', provider: 'openai', model_id: 'model', is_default: true }
beforeEach(() => {
  jest.resetAllMocks()
  jest.mocked(deviceApis.getAllDevices).mockResolvedValue({
    items: [
      { id: 21, device_id: 'runner', device_type: 'cloud', status: 'online', is_default: true },
    ],
    total: 1,
  } as Awaited<ReturnType<typeof deviceApis.getAllDevices>>)
  jest
    .mocked(apiClient.get)
    .mockResolvedValue([{ id: '21', status: 'online', project_authorized: true, models: [model] }])
})

it('loads only the project device inventory before the user applies the template', async () => {
  jest.mocked(apiClient.get).mockResolvedValue({
    items: [{ device_id: 73, name: 'Project runner', status: 'online', can_use: true }],
  })
  await expect(listWebTemplateAgentEnvironments('project/1')).resolves.toEqual([
    expect.objectContaining({ id: '73', name: 'Project runner', can_use: true }),
  ])
  expect(apiClient.get).toHaveBeenCalledTimes(1)
  expect(apiClient.get).toHaveBeenCalledWith(
    '/v1/cloud-projects/project%2F1/execution-environments'
  )
  expect(deviceApis.getAllDevices).not.toHaveBeenCalled()
})

it('does not retain stale authorization after the project device pool changes', async () => {
  jest
    .mocked(apiClient.get)
    .mockResolvedValueOnce({
      items: [{ device_id: 73, name: 'Runner', status: 'online', can_use: true }],
    })
    .mockResolvedValueOnce({ items: [] })
  expect(await listWebTemplateAgentEnvironments('project')).toHaveLength(1)
  expect(await listWebTemplateAgentEnvironments('project')).toEqual([])
  expect(deviceApis.getAllDevices).not.toHaveBeenCalled()
})

it('does not make template definition persistence depend on a personal default', () => {
  expect(agentDefinitionRouting()).toEqual({
    executionPolicy: { mode: 'user_select' },
    modelPolicy: { mode: 'user_select' },
  })
  expect(apiClient.get).not.toHaveBeenCalled()
  expect(deviceApis.getAllDevices).not.toHaveBeenCalled()
})

it('still enforces project authorization and native model availability at task launch', () => {
  const runner = {
    id: '73',
    device_key: 'runner',
    name: 'Runner',
    owner_type: 'user',
    owner_id: '7',
    status: 'online',
    project_authorized: false,
    models: [{ ...model, label: 'Model', local_model_id: 'model', account_label: 'Account' }],
  } as RunnerEnvironment
  const input = {
    environments: [runner],
    runtime: 'codex' as const,
    executionPolicy: { mode: 'project_pool' as const },
    modelPolicy: { mode: 'fixed' as const, model: { ...model, runtime: 'codex' as const } },
  }
  expect(() => resolveRunnerSelection(input)).toThrow('RUNNER_ENVIRONMENT_UNAVAILABLE')
  expect(() =>
    resolveRunnerSelection({
      ...input,
      environments: [{ ...runner, project_authorized: true, models: [] }],
    })
  ).toThrow('RUNNER_MODEL_UNAVAILABLE')
})
