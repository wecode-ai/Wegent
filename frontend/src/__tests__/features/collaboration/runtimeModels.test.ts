import { listRuntimeModels } from '@/features/collaboration/runtimeModels'
import { apiClient } from '@/apis/client'
import { deviceApis } from '@/apis/devices'
import type { CloudRuntimeIpcClient } from '@wegent/chat-core'

jest.mock('@/apis/client', () => ({ apiClient: { get: jest.fn() } }))
jest.mock('@/apis/devices', () => ({ deviceApis: { executeCommand: jest.fn() } }))

const provider = {
  id: 'openai',
  type: 'official',
  available: true,
  data: [
    {
      id: 'gpt-5.6-sol',
      supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
      defaultReasoningEffort: 'high',
    },
  ],
}
describe('browser device model catalog', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.mocked(apiClient.get).mockResolvedValue({ data: [{ name: 'cloud-model', type: 'user' }] })
    jest
      .mocked(deviceApis.executeCommand)
      .mockResolvedValue({ success: true, stdout: { exists: true }, stderr: '', duration: 0 })
  })
  it('uses the owning device and native model presentation including reasoning options', async () => {
    const ipc = {
      request: jest.fn().mockResolvedValue({ providers: [provider] }),
    } as unknown as CloudRuntimeIpcClient
    const models = await listRuntimeModels(ipc, 'device-1')
    expect(ipc.request).toHaveBeenCalledWith(
      'runtime.codex.models.list',
      { includeHidden: true },
      'device-1'
    )
    expect(deviceApis.executeCommand).toHaveBeenCalledWith(
      'device-1',
      expect.objectContaining({ command_key: 'runtime_auth_status' })
    )
    expect(models).toEqual([
      expect.objectContaining({
        name: 'gpt-5.6-sol',
        displayName: 'GPT 5.6 Sol',
        type: 'runtime',
        config: expect.objectContaining({
          codexAuthConfigured: true,
          ui: expect.objectContaining({ reasoningEfforts: ['high'] }),
        }),
      }),
      { name: 'cloud-model', type: 'user' },
    ])
  })
  it('does not offer account-backed runtime models when that device is not configured', async () => {
    jest
      .mocked(deviceApis.executeCommand)
      .mockResolvedValue({ success: true, stdout: { exists: false }, stderr: '', duration: 0 })
    const ipc = {
      request: jest.fn().mockResolvedValue({ providers: [provider] }),
    } as unknown as CloudRuntimeIpcClient
    expect(await listRuntimeModels(ipc, 'device-1')).toEqual([
      { name: 'cloud-model', type: 'user' },
    ])
  })
  it('reports catalog failures instead of silently selecting a cloud model', async () => {
    const ipc = {
      request: jest.fn().mockResolvedValue({
        providers: [{ ...provider, available: false, error: 'Device unavailable' }],
      }),
    } as unknown as CloudRuntimeIpcClient
    await expect(listRuntimeModels(ipc, 'device-1')).rejects.toThrow('Device unavailable')
  })
})
