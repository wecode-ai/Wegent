import { beforeEach, expect, test, vi } from 'vitest'
import { createRuntimeWorkApiFromIpc } from './localServices'
import {
  clearLocalModelConfigs,
  saveLocalModelConfig,
} from '@/features/model-settings/localModelSettings'

beforeEach(() => {
  localStorage.clear()
  clearLocalModelConfigs()
})

test('publishes both runtime profiles and refreshes credentials and deletions', async () => {
  const input = {
    id: 'creation-model',
    displayName: 'Creation model',
    modelId: 'upstream-model',
    baseUrl: 'https://models.example.com/v1',
    apiFormat: 'openai-chat-completions' as const,
    requestPath: '/chat/completions',
    apiKey: 'first-secret',
    catalogReady: true,
  }
  saveLocalModelConfig(input)
  const request = vi.fn().mockResolvedValue({ success: true })
  const api = createRuntimeWorkApiFromIpc(request, async () => 'device-a')
  await api.prepareRuntimeModel({ deviceId: 'device-a' })
  const profiles = request.mock.calls.at(-1)?.[1].profiles
  expect(request.mock.calls.at(-1)?.[0]).toBe('runtime.models.sync_creation_profiles')
  expect(profiles.map((profile: { runtime: string }) => profile.runtime)).toEqual([
    'codex',
    'claude_code',
  ])
  expect(profiles[0].modelConfig.api_key).toBe('first-secret')
  expect(profiles[1].modelConfig.api_key).toBe('first-secret')
  saveLocalModelConfig({ ...input, apiKey: 'updated-secret' })
  await api.prepareRuntimeModel({ deviceId: 'device-a' })
  expect(request.mock.calls.at(-1)?.[1].profiles[0].modelConfig.api_key).toBe('updated-secret')
  clearLocalModelConfigs()
  await api.prepareRuntimeModel({ deviceId: 'device-a' })
  expect(request.mock.calls.at(-1)?.[1].profiles).toEqual([])
})

test('profile publication failure blocks creation preparation', async () => {
  saveLocalModelConfig({
    id: 'creation-model',
    displayName: 'Creation model',
    modelId: 'model',
    baseUrl: 'https://models.example.com/v1',
    apiFormat: 'openai-chat-completions',
    requestPath: '/chat/completions',
    apiKey: 'secret',
    catalogReady: true,
  })
  const request = vi.fn().mockRejectedValue(new Error('device unavailable'))
  const api = createRuntimeWorkApiFromIpc(request, async () => 'device-a')
  await expect(api.prepareRuntimeModel({ deviceId: 'device-a' })).rejects.toThrow(
    'device unavailable'
  )
  expect(request.mock.calls.every(([method]) => method !== 'runtime.tasks.create')).toBe(true)
})
