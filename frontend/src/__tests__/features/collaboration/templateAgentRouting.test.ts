// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { resolveWebTemplateAgentRouting } from '@/features/collaboration/templateAgentRouting'
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

it('binds the designated default executor and its exact runtime default without carrying catalog metadata', async () => {
  await expect(resolveWebTemplateAgentRouting('codex', 'cloud', 'project/1')).resolves.toEqual({
    executionPolicy: { mode: 'fixed', environment_id: '21' },
    modelPolicy: {
      mode: 'fixed',
      model: { runtime: 'codex', provider: 'openai', model_id: 'model' },
    },
  })
  expect(apiClient.get).toHaveBeenCalledWith(
    '/v1/resources/execution-environments?project_id=project%2F1'
  )
})

it('does not choose an arbitrary executor when no default is designated', async () => {
  jest.mocked(deviceApis.getAllDevices).mockResolvedValue({ items: [], total: 0 })
  await expect(resolveWebTemplateAgentRouting('codex', 'cloud')).rejects.toThrow(
    'template_environment_unavailable'
  )
  expect(apiClient.get).not.toHaveBeenCalled()
})

it('rejects a default device without destination project authorization', async () => {
  jest
    .mocked(apiClient.get)
    .mockResolvedValue([{ id: '21', status: 'online', project_authorized: false, models: [model] }])
  await expect(resolveWebTemplateAgentRouting('codex', 'cloud', 'project')).rejects.toThrow(
    'template_environment_unavailable'
  )
})

it.each([{ models: [] }, { models: [model, model] }])(
  'requires one runtime default instead of choosing a model by order',
  async ({ models }) => {
    jest.mocked(apiClient.get).mockResolvedValue([{ id: '21', status: 'online', models }])
    await expect(resolveWebTemplateAgentRouting('codex', 'cloud')).rejects.toThrow(
      'template_model_default_unavailable'
    )
  }
)

it('rejects a stale catalog when refreshing the default device failed', async () => {
  jest
    .mocked(apiClient.get)
    .mockResolvedValue([
      { id: '21', status: 'online', models: [model], catalog_error: 'runtime_rpc_timeout' },
    ])
  await expect(resolveWebTemplateAgentRouting('codex', 'cloud')).rejects.toThrow(
    'runtime_rpc_timeout'
  )
})
