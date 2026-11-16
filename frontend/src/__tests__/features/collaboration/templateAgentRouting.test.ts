// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  listWebTemplateAgentEnvironments,
  resolveWebTemplateAgentRouting,
} from '@/features/collaboration/templateAgentRouting'
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

it('uses the sole authorized project environment without requiring a personal default', async () => {
  jest.mocked(deviceApis.getAllDevices).mockRejectedValue(new Error('personal devices unavailable'))
  jest.mocked(apiClient.get).mockResolvedValue([
    { id: '21', status: 'online', project_authorized: false, models: [model] },
    { id: '73', status: 'online', project_authorized: true, models: [model] },
    { id: '74', status: 'offline', project_authorized: true, models: [model] },
  ])
  await expect(resolveWebTemplateAgentRouting('codex', 'cloud', 'project')).resolves.toMatchObject({
    executionPolicy: { mode: 'fixed', environment_id: '73' },
  })
  expect(deviceApis.getAllDevices).not.toHaveBeenCalled()
})

it('uses the designated default within a project with multiple authorized environments', async () => {
  jest.mocked(apiClient.get).mockResolvedValue([
    { id: '73', status: 'online', project_authorized: true, models: [model] },
    { id: '21', status: 'online', project_authorized: true, models: [model] },
  ])
  await expect(resolveWebTemplateAgentRouting('codex', 'cloud', 'project')).resolves.toMatchObject({
    executionPolicy: { mode: 'fixed', environment_id: '21' },
  })
})

it.each([
  { items: [] },
  { items: [{ id: 99, is_default: true }] },
  { items: [{ id: 73, is_default: true, status: 'offline' }] },
])(
  'refuses to guess between authorized project devices without an available project default: %j',
  async ({ items }) => {
    jest.mocked(deviceApis.getAllDevices).mockResolvedValue({
      items,
      total: items.length,
    } as Awaited<ReturnType<typeof deviceApis.getAllDevices>>)
    jest.mocked(apiClient.get).mockResolvedValue([
      { id: '73', status: 'online', project_authorized: true, models: [model] },
      { id: '74', status: 'online', project_authorized: true, models: [model] },
    ])
    await expect(resolveWebTemplateAgentRouting('codex', 'cloud', 'project')).rejects.toThrow(
      'template_environment_ambiguous'
    )
  }
)

it('accepts an online APP default whose model catalog the backend exposes', async () => {
  jest.mocked(deviceApis.getAllDevices).mockResolvedValue({
    items: [{ id: 21, device_type: 'app', status: 'online', is_default: true }],
    total: 1,
  } as Awaited<ReturnType<typeof deviceApis.getAllDevices>>)
  await expect(resolveWebTemplateAgentRouting('codex', 'cloud')).resolves.toMatchObject({
    executionPolicy: { mode: 'fixed', environment_id: '21' },
  })
})

it.each([
  { models: [] },
  { models: [model, model] },
  { models: [{ ...model, runtime: 'claude_code' }] },
])('validates the chosen project device runtime default: %j', async ({ models }) => {
  jest
    .mocked(apiClient.get)
    .mockResolvedValue([{ id: '73', status: 'online', project_authorized: true, models }])
  await expect(resolveWebTemplateAgentRouting('codex', 'cloud', 'project')).rejects.toThrow(
    'template_model_default_unavailable'
  )
})

it('propagates project catalog refresh failures without silently using another device', async () => {
  jest.mocked(apiClient.get).mockResolvedValue([
    {
      id: '73',
      status: 'online',
      project_authorized: true,
      models: [model],
      catalog_error: 'runtime_rpc_timeout',
    },
  ])
  await expect(resolveWebTemplateAgentRouting('codex', 'cloud', 'project')).rejects.toThrow(
    'runtime_rpc_timeout'
  )
})

it('uses the device chosen in the dialog without changing the account default', async () => {
  jest.mocked(apiClient.get).mockResolvedValue([
    { id: '21', status: 'online', project_authorized: true, models: [model] },
    { id: '73', status: 'online', project_authorized: true, models: [model] },
  ])
  await expect(
    resolveWebTemplateAgentRouting('codex', 'cloud', 'project', '73')
  ).resolves.toMatchObject({
    executionPolicy: { mode: 'fixed', environment_id: '73' },
  })
  expect(deviceApis.getAllDevices).not.toHaveBeenCalled()
})

it.each([
  { status: 'online', project_authorized: false },
  { status: 'offline', project_authorized: true },
])('revalidates the selected device before creating agents: %j', async state => {
  jest.mocked(apiClient.get).mockResolvedValue([
    { id: '21', status: 'online', project_authorized: true, models: [model] },
    { id: '73', ...state, models: [model] },
  ])
  await expect(resolveWebTemplateAgentRouting('codex', 'cloud', 'project', '73')).rejects.toThrow(
    'template_environment_unavailable'
  )
})
