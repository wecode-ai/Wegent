import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  cloudRunnerModelIdentity,
  runnerModelKey,
  type RunnerModel,
  type WorkspaceProjectAgent,
  type WorkspaceStandInSettings,
} from '@wegent/collaboration'
import type { UnifiedModel } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useStandInModels } from './useStandInModels'

const native: RunnerModel = {
  runtime: 'codex',
  provider: 'openai',
  model_id: 'kimi-k3',
  label: 'Kimi-K3',
  local_model_id: 'kimi-k3',
  account_label: 'ChatGPT',
  is_default: true,
}
const cloud: UnifiedModel = {
  name: 'kimi-k3(内网)',
  type: 'public',
  displayName: '内网:Kimi-K3',
  modelId: 'kimi-k3',
  provider: 'openai',
  namespace: 'default',
  resourceUserId: 0,
  config: { protocol: 'openai-responses', ui: { reasoningEfforts: ['low', 'high'] } },
}
const settings: WorkspaceStandInSettings = {
  enabled: false,
  prompt: '',
  executionDeviceId: 'mac',
  version: 0,
}

function fixture(models = [cloud], nativeModels = [native]) {
  const catalog = vi.fn<(deviceId: string) => Promise<{ models: RunnerModel[] }>>(async () => ({
    models: nativeModels,
  }))
  const listModels = vi.fn(async () => ({ data: models }))
  return {
    catalog,
    listModels,
    services: { standInApi: { catalog }, modelApi: { listModels } } as unknown as WorkbenchServices,
  }
}

describe('stand-in shared model catalog', () => {
  it('uses original cloud objects and resolves complete resource identities independently of names', async () => {
    const models = [1, 2].map(resourceUserId => ({ ...cloud, resourceUserId }))
    const { services } = fixture(models)
    const identity = cloudRunnerModelIdentity(models[1], 'codex')!
    const { result } = renderHook(() =>
      useStandInModels(services, { ...settings, model: identity })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.models.slice(1)).toEqual(models)
    expect(result.current.models[1]).toBe(models[0])
    expect(result.current.models[2]).toBe(models[1])
    expect(result.current.selectedModel).toBe(models[1])
    expect(result.current.resolve({ ...models[1] })).toEqual(identity)
    expect(result.current.resolve(models[0])?.cloud_model?.resource_user_id).toBe(1)
    expect(result.current.unavailable).toBe(false)
    expect(result.current.getModelOptionId(models[0])).not.toBe(
      result.current.getModelOptionId(models[1])
    )
    expect(result.current.resolve({ ...cloud, namespace: 'other' })).toBeNull()
  })

  it('keeps native accounts separate and preserves option identifiers without changing catalog names', async () => {
    const { services } = fixture([], [native, { ...native, provider: 'custom' }])
    const { result } = renderHook(() => useStandInModels(services, settings))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const [official, custom] = result.current.models
    expect(official.name).toBe(native.model_id)
    expect(custom.name).toBe(native.model_id)
    expect(result.current.resolve(official)).toEqual({
      runtime: 'codex',
      provider: 'openai',
      model_id: native.model_id,
    })
    expect(result.current.resolve(custom)).toEqual({
      runtime: 'codex',
      provider: 'custom',
      model_id: native.model_id,
    })
    expect(result.current.getModelOptionId(official)).toBe(runnerModelKey(native))
    expect(result.current.getModelOptionId(custom)).toBe(
      runnerModelKey({ ...native, provider: 'custom' })
    )
  })

  it('does not treat a same-name resource from another owner as the saved model', async () => {
    const { services } = fixture()
    const identity = cloudRunnerModelIdentity({ ...cloud, resourceUserId: 99 }, 'codex')!
    const { result } = renderHook(() =>
      useStandInModels(services, { ...settings, model: identity })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.unavailable).toBe(true)
    expect(result.current.selectedModel?.name).toBe(identity.model_id)
    expect(result.current.resolve(result.current.selectedModel)).toBeNull()
  })

  it('rejects stale device responses while keeping the cloud display catalog unchanged', async () => {
    const { services, catalog } = fixture()
    let finishOld!: (catalog: { models: RunnerModel[] }) => void
    catalog.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishOld = resolve
        })
    )
    const { result, rerender } = renderHook(
      ({ deviceId }) => useStandInModels(services, { ...settings, executionDeviceId: deviceId }),
      { initialProps: { deviceId: 'mac' } }
    )
    rerender({ deviceId: 'remote' })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(catalog).toHaveBeenCalledWith('remote')
    expect(result.current.models[1]).toBe(cloud)
    await act(async () => finishOld({ models: [{ ...native, model_id: 'stale' }] }))
    expect(result.current.models.map(model => model.name)).toEqual(['kimi-k3', cloud.name])
  })

  it('changes execution runtime without converting or replacing cloud display metadata', async () => {
    const { services } = fixture()
    const { result, rerender } = renderHook(
      ({ agent }: { agent?: WorkspaceProjectAgent }) => useStandInModels(services, settings, agent),
      { initialProps: { agent: undefined } }
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    rerender({ agent: { id: 'claude', name: 'Claude', runtime: 'claude_code' } })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.models).toEqual([cloud])
    expect(result.current.models[0]).toBe(cloud)
    expect(result.current.resolve(cloud)?.runtime).toBe('claude_code')
  })

  it('retains usable cloud catalog entries when the device catalog fails', async () => {
    const { services, catalog } = fixture()
    catalog.mockRejectedValueOnce(new Error('Device offline'))
    const { result } = renderHook(() => useStandInModels(services, settings))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.models[0]).toBe(cloud)
    expect(result.current.error).toBe('执行设备离线，请连接设备后重试。')
    expect(result.current.defaultIdentity).toEqual(cloudRunnerModelIdentity(cloud, 'codex'))
  })
})
