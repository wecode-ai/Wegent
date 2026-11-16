import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  cloudRunnerModelIdentity,
  runnerModelKey,
  type RunnerModel,
  type WorkspaceStandInSettings,
} from '@wegent/collaboration'
import type { UnifiedModel } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { LOCAL_MODEL_SETTINGS_CHANGED_EVENT } from '@/features/model-settings/localModelSettings'
import { createModelApi } from '@/api/models'
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
  const catalog = vi.fn<
    (deviceId: string) => Promise<{ models: RunnerModel[]; errors?: string[] }>
  >(async () => ({
    models: nativeModels,
  }))
  const listModels = vi.fn(async () => ({ data: models }))
  const listeners = new Set<() => void>()
  const subscribe = vi.fn((listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  })
  const refresh = vi.fn()
  return {
    catalog,
    listModels,
    subscribe,
    listeners,
    notify: () => listeners.forEach(listener => listener()),
    refresh,
    services: {
      standInApi: { catalog },
      modelApi: { listModels, subscribe, refresh },
    } as unknown as WorkbenchServices,
  }
}

describe('stand-in shared model catalog', () => {
  it('treats native DTO errors as failures and never restores an invalidated account', async () => {
    const { services, catalog } = fixture()
    const { result } = renderHook(() => useStandInModels(services, { ...settings, model: native }))
    await waitFor(() => expect(result.current.resolve(result.current.selectedModel)).not.toBeNull())
    catalog.mockResolvedValue({ models: [], errors: ['codex_catalog_unavailable'] })
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.errors.native).toBeTruthy())
    expect(result.current.resolve(result.current.selectedModel)).not.toBeNull()
    expect(result.current.unavailable).toBe(false)
    act(() => window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT)))
    expect(result.current.resolve(result.current.selectedModel)).toBeNull()
    await waitFor(() => expect(result.current.errors.native).toBeTruthy())
    expect(result.current.unavailable).toBe(true)
    expect(result.current.defaultIdentity).toBeNull()
  })

  it.each(['codex', 'claude_code'] as const)(
    'isolates another runtime DTO error from valid %s models',
    async runtime => {
      const selected = { ...native, runtime }
      const { services, catalog } = fixture([], [selected])
      catalog.mockResolvedValue({
        models: [selected],
        errors: [runtime === 'codex' ? 'claude_catalog_invalid' : 'codex_catalog_unavailable'],
      })
      const { result } = renderHook(() =>
        useStandInModels(services, { ...settings, model: selected })
      )
      await waitFor(() =>
        expect(result.current.resolve(result.current.selectedModel)).not.toBeNull()
      )
      expect(result.current.errors.native).toBeNull()
      expect(result.current.unavailable).toBe(false)
    }
  )

  it('publishes valid partial native models even when the runtime catalog reports a failure', async () => {
    const selected = {
      ...native,
      provider: 'local-provider',
      model_id: 'local-model:custom',
      local_model_id: 'local-model:custom',
      is_default: false,
    }
    const { services, catalog } = fixture([], [selected])
    catalog.mockResolvedValue({ models: [selected], errors: ['codex_catalog_unavailable'] })
    const { result } = renderHook(() =>
      useStandInModels(services, { ...settings, model: selected })
    )
    await waitFor(() => expect(result.current.resolve(result.current.selectedModel)).not.toBeNull())
    expect(result.current.unavailable).toBe(false)
    expect(result.current.errors.native).toBeTruthy()
    expect(result.current.defaultIdentity).toBeNull()
  })

  it('suspends inactive requests and revalidates cached identities when activated again', async () => {
    const { services, catalog, listModels, listeners, notify } = fixture()
    const { result, rerender, unmount } = renderHook(
      ({ active }) => useStandInModels(services, { ...settings, model: native }, 'codex', active),
      { initialProps: { active: false } }
    )
    let finish!: (value: { models: RunnerModel[] }) => void
    try {
      result.current.refresh()
      expect(catalog).not.toHaveBeenCalled()
      expect(listModels).not.toHaveBeenCalled()
      expect(listeners.size).toBe(0)
      rerender({ active: true })
      await waitFor(() =>
        expect(result.current.resolve(result.current.selectedModel)).toEqual({
          runtime: native.runtime,
          provider: native.provider,
          model_id: native.model_id,
        })
      )
      const cached = result.current.models[0]
      rerender({ active: false })
      expect(listeners.size).toBe(0)
      expect(result.current.models[0]).toBe(cached)
      expect(result.current.resolve(result.current.selectedModel)).toBeNull()
      notify()
      window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
      result.current.refresh()
      expect(catalog).toHaveBeenCalledOnce()
      catalog.mockImplementationOnce(() => new Promise(resolve => (finish = resolve)))
      rerender({ active: true })
      expect(result.current.loading).toBe(true)
      expect(result.current.models[0]).toBe(cached)
      expect(result.current.resolve(result.current.selectedModel)).toBeNull()
      await waitFor(() => expect(catalog).toHaveBeenCalledTimes(2))
      await act(async () => finish({ models: [{ ...native, label: 'Revalidated model' }] }))
      await waitFor(() => expect(result.current.unavailable).toBe(false))
      expect(result.current.selectedModel?.displayName).toBe('Revalidated model')
      expect(catalog).toHaveBeenCalledTimes(2)
    } finally {
      finish?.({ models: [] })
      unmount()
    }
  })

  it('forces a real Backend catalog refresh through listModels when refresh is not implemented', async () => {
    const { services } = fixture()
    const updated = { ...cloud, displayName: 'Updated cloud catalog' }
    const get = vi.fn().mockResolvedValue({ data: [cloud] })
    services.modelApi = createModelApi({ get })
    const identity = cloudRunnerModelIdentity(cloud, 'codex')!
    const { result } = renderHook(() =>
      useStandInModels(services, { ...settings, model: identity })
    )
    await waitFor(() =>
      expect(result.current.resolve(result.current.selectedModel)).toEqual(identity)
    )
    get.mockResolvedValue({ data: [updated] })
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.selectedModel).toBe(updated))
    expect(get).toHaveBeenCalledTimes(2)
    expect(result.current.resolve(result.current.selectedModel)).toEqual(identity)
  })

  it.each(['native', 'cloud'] as const)(
    'retains the %s identity after an ordinary refresh failure and clears it on a successful empty result',
    async source => {
      const { services, catalog, listModels } = fixture()
      const identity =
        source === 'native'
          ? { runtime: native.runtime, provider: native.provider, model_id: native.model_id }
          : cloudRunnerModelIdentity(cloud, 'codex')!
      const { result } = renderHook(() =>
        useStandInModels(services, { ...settings, model: identity })
      )
      await waitFor(() =>
        expect(result.current.resolve(result.current.selectedModel)).toEqual(identity)
      )
      const selected = result.current.selectedModel
      if (source === 'native') catalog.mockRejectedValueOnce(new Error('Device offline'))
      else listModels.mockRejectedValueOnce({ status: 503 })
      act(() => result.current.refresh())
      await waitFor(() => expect(result.current.errors[source]).toBeTruthy())
      expect(result.current.resolve(result.current.selectedModel)).toEqual(identity)
      expect(result.current.selectedModel).toBe(selected)
      expect(result.current.unavailable).toBe(false)
      expect(result.current.error).toBe(result.current.errors[source])
      expect(result.current.errors[source === 'native' ? 'cloud' : 'native']).toBeNull()
      if (source === 'native') catalog.mockResolvedValueOnce({ models: [] })
      else listModels.mockResolvedValueOnce({ data: [] })
      act(() => result.current.refresh())
      await waitFor(() => expect(result.current.unavailable).toBe(true))
      expect(result.current.errors[source]).toBeNull()
      expect(result.current.resolve(result.current.selectedModel)).toBeNull()
      expect(result.current.models).toHaveLength(1)
    }
  )

  it.each(['native', 'cloud'] as const)(
    'discards the %s identity after an explicit authorization failure',
    async source => {
      const { services, catalog, listModels } = fixture()
      const identity =
        source === 'native'
          ? { runtime: native.runtime, provider: native.provider, model_id: native.model_id }
          : cloudRunnerModelIdentity(cloud, 'codex')!
      const { result } = renderHook(() =>
        useStandInModels(services, { ...settings, model: identity })
      )
      await waitFor(() =>
        expect(result.current.resolve(result.current.selectedModel)).toEqual(identity)
      )
      if (source === 'native') catalog.mockRejectedValueOnce({ status: 403 })
      else listModels.mockRejectedValueOnce({ code: 'permission_denied' })
      act(() => result.current.refresh())
      await waitFor(() => expect(result.current.errors[source]).toBeTruthy())
      expect(result.current.unavailable).toBe(true)
      expect(result.current.resolve(result.current.selectedModel)).toBeNull()
      expect(result.current.models).toHaveLength(1)
    }
  )

  it('does not restore an invalidated native account after the local settings refresh fails', async () => {
    const { services, catalog } = fixture()
    const { result } = renderHook(() => useStandInModels(services, { ...settings, model: native }))
    await waitFor(() => expect(result.current.resolve(result.current.selectedModel)).not.toBeNull())
    catalog.mockRejectedValueOnce(new Error('Device offline'))
    act(() => window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT)))
    expect(result.current.resolve(result.current.selectedModel)).toBeNull()
    await waitFor(() => expect(result.current.errors.native).toBeTruthy())
    expect(result.current.unavailable).toBe(true)
    expect(result.current.resolve(result.current.selectedModel)).toBeNull()
    await waitFor(() => expect(result.current.models).toEqual([cloud]))
    expect(result.current.defaultIdentity).toBeNull()
  })

  it.each([
    ['missing', [{ ...native, is_default: false }]],
    ['empty', []],
    ['ambiguous', [native, { ...native, provider: 'custom' }]],
    ['another runtime', [{ ...native, runtime: 'claude_code' as const }]],
  ] as const)(
    'keeps the model unset when the native default is %s and permits explicit cloud recovery',
    async (_reason, nativeModels) => {
      const { services } = fixture([cloud], [...nativeModels])
      const { result, rerender } = renderHook(
        ({ model }: { model?: WorkspaceStandInSettings['model'] }) =>
          useStandInModels(services, { ...settings, model }),
        { initialProps: { model: undefined } }
      )
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(result.current.defaultIdentity).toBeNull()
      expect(result.current.selectedModel).toBeNull()
      expect(result.current.models).toContain(cloud)
      const identity = cloudRunnerModelIdentity(cloud, 'codex')!
      expect(result.current.resolve(cloud)).toEqual(identity)
      rerender({ model: identity })
      expect(result.current.selectedModel).toBe(cloud)
      expect(result.current.unavailable).toBe(false)
    }
  )

  it('uses only the unique native default of the requested runtime, regardless of catalog order', async () => {
    const { services } = fixture(
      [cloud],
      [
        { ...native, model_id: 'first-not-default', is_default: false },
        { ...native, runtime: 'claude_code' },
        native,
      ]
    )
    const { result } = renderHook(() => useStandInModels(services, settings))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.models[0].name).toBe('first-not-default')
    expect(result.current.defaultIdentity).toEqual({
      runtime: native.runtime,
      provider: native.provider,
      model_id: native.model_id,
    })
    expect(result.current.resolve(result.current.selectedModel)).toEqual(
      result.current.defaultIdentity
    )
  })

  it.each(['cloud', 'local'])(
    'reconciles %s notifications without letting an older empty response replace the new catalog',
    async source => {
      const { services, listModels, notify, listeners } = fixture()
      const changed =
        source === 'cloud'
          ? notify
          : () => window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
      let finishOld!: (value: { data: UnifiedModel[] }) => void
      listModels.mockImplementationOnce(() => new Promise(resolve => (finishOld = resolve)))
      const identity = cloudRunnerModelIdentity(cloud, 'codex')!
      const { result, unmount } = renderHook(() =>
        useStandInModels(services, { ...settings, model: identity })
      )
      try {
        expect(result.current.loading).toBe(true)
        await waitFor(() => expect(listModels).toHaveBeenCalledOnce())
        act(changed)
        await waitFor(() => expect(result.current.selectedModel).toBe(cloud))
        await act(async () => finishOld({ data: [] }))
        expect(result.current.selectedModel).toBe(cloud)
        expect(result.current.unavailable).toBe(false)
      } finally {
        finishOld({ data: [] })
        unmount()
      }
      expect(listeners.size).toBe(0)
      notify()
      window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
      expect(listModels).toHaveBeenCalledTimes(2)
    }
  )

  it('updates native provider availability on local settings changes without forcing a cloud refresh', async () => {
    const { services, catalog, refresh } = fixture()
    const { result, unmount } = renderHook(() =>
      useStandInModels(services, { ...settings, model: native })
    )
    try {
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(result.current.unavailable).toBe(false)
      catalog.mockResolvedValue({ models: [{ ...native, provider: 'replacement-provider' }] })
      act(() => window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT)))
      await waitFor(() => expect(result.current.unavailable).toBe(true))
      expect(result.current.resolve(result.current.selectedModel)).toBeNull()
      expect(result.current.models).toContain(cloud)

      catalog.mockResolvedValue({ models: [{ ...native, label: 'Updated native catalog' }] })
      act(() => window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT)))
      await waitFor(() => expect(result.current.unavailable).toBe(false))
      expect(result.current.selectedModel?.displayName).toBe('Updated native catalog')
      expect(result.current.resolve(result.current.selectedModel)).toEqual({
        runtime: native.runtime,
        provider: native.provider,
        model_id: native.model_id,
      })
      expect(refresh).not.toHaveBeenCalled()
      expect(catalog).toHaveBeenCalledTimes(3)
    } finally {
      unmount()
    }
    window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
    expect(catalog).toHaveBeenCalledTimes(3)
  })

  it('discards a previous service catalog immediately when the account services change', async () => {
    const old = fixture()
    const next = fixture([])
    let finish!: (value: { data: UnifiedModel[] }) => void
    next.listModels.mockImplementationOnce(() => new Promise(resolve => (finish = resolve)))
    const { result, rerender } = renderHook(
      ({ services }) => useStandInModels(services, settings),
      { initialProps: { services: old.services } }
    )
    await waitFor(() => expect(result.current.models).toContain(cloud))
    rerender({ services: next.services })
    try {
      expect(result.current.loading).toBe(true)
      expect(result.current.models).toEqual([])
      expect(old.listeners.size).toBe(0)
      await waitFor(() => expect(next.listModels).toHaveBeenCalledOnce())
      await act(async () => finish({ data: [] }))
      expect(result.current.models).not.toContain(cloud)
      expect(result.current.loading).toBe(false)
    } finally {
      finish({ data: [] })
    }
  })

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
    await waitFor(() => expect(catalog).toHaveBeenCalledWith('mac'))
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
      ({ model }: { model?: WorkspaceStandInSettings['model'] }) =>
        useStandInModels(services, { ...settings, model }),
      { initialProps: { model: undefined } }
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    rerender({ model: cloudRunnerModelIdentity(cloud, 'claude_code') })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.models).toEqual([cloud])
    expect(result.current.models[0]).toBe(cloud)
    expect(result.current.resolve(cloud)?.runtime).toBe('claude_code')
  })

  it('keeps saved Claude models available to profile settings without a conversation runtime restriction', async () => {
    const claude: RunnerModel = { ...native, runtime: 'claude_code', provider: 'claude' }
    const { services } = fixture([], [native, claude])
    const { result } = renderHook(() => useStandInModels(services, { ...settings, model: claude }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.models).toHaveLength(1)
    expect(result.current.selectedModel?.runtime?.family).toBe('claude_code')
    expect(result.current.resolve(result.current.selectedModel)?.runtime).toBe('claude_code')
    expect(result.current.unavailable).toBe(false)
  })

  it('retains usable cloud catalog entries when the device catalog fails', async () => {
    const { services, catalog } = fixture()
    catalog.mockRejectedValueOnce(new Error('Device offline'))
    const { result } = renderHook(() => useStandInModels(services, settings))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.models[0]).toBe(cloud)
    expect(result.current.error).toBe('执行设备离线，请连接设备后重试。')
    expect(result.current.defaultIdentity).toBeNull()
    expect(result.current.selectedModel).toBeNull()
    expect(result.current.resolve(cloud)).toEqual(cloudRunnerModelIdentity(cloud, 'codex'))
  })
})
