import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { RunnerEnvironment, RunnerModel } from '@wegent/collaboration'
import { useAgentRouting } from './useAgentRouting'

const model: RunnerModel = {
  runtime: 'codex',
  provider: 'openai',
  model_id: 'a',
  label: 'A',
  local_model_id: 'a',
  account_label: 'Personal account',
  is_default: true,
}
const cloudModel = {
  name: 'cloud-model',
  type: 'public' as const,
  namespace: 'default',
  resourceUserId: 1,
  config: { protocol: 'openai-responses' },
}
const environment = (id: string, models: RunnerModel[] = []): RunnerEnvironment => ({
  id,
  name: id,
  device_key: id,
  owner_type: 'user',
  owner_id: '1',
  status: 'online',
  project_authorized: true,
  runtimes: ['codex'],
  models,
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
function catalog(environments = [environment('1', [model])]) {
  return {
    listEnvironments: vi.fn(async () => environments),
    listModels: vi.fn(async () => []),
    listNativeModels: vi.fn(async (device: RunnerEnvironment) => device),
  }
}

describe('agent routing editor', () => {
  test('defaults new agents to automatic allocation without binding even the only native device', async () => {
    const api = { ...catalog(), listModels: vi.fn(async () => [cloudModel]) }
    const { result } = renderHook(() =>
      useAgentRouting(api, 'codex', 'project', { creation: true })
    )
    expect(result.current.executionPolicy).toEqual({ mode: 'project_pool' })
    await waitFor(() => expect(result.current.valid).toBe(true))
    expect(result.current.model?.source).toBe('cloud')
    expect(api.listNativeModels).not.toHaveBeenCalled()
  })

  test.each(['environment-first', 'cloud-first'])(
    'keeps automatic allocation when catalogs resolve %s',
    async order => {
      const runners = deferred<RunnerEnvironment[]>()
      const cloud = deferred<(typeof cloudModel)[]>()
      const api = {
        ...catalog(),
        listModels: () => cloud.promise,
        listEnvironments: () => runners.promise,
      }
      const { result } = renderHook(
        () => useAgentRouting(api, 'codex', 'project', { creation: true }),
        { reactStrictMode: true }
      )
      if (order === 'environment-first') {
        await act(async () => runners.resolve([environment('1', [model])]))
        await act(async () => cloud.resolve([cloudModel]))
      } else {
        await act(async () => cloud.resolve([cloudModel]))
        expect(result.current.model?.model_id).toBe(cloudModel.name)
        expect(result.current.valid).toBe(true)
        await act(async () => runners.resolve([environment('1', [model])]))
      }
      expect(result.current.executionPolicy).toEqual({ mode: 'project_pool' })
      expect(result.current.model?.source).toBe('cloud')
      expect(result.current.valid).toBe(true)
      expect(api.listNativeModels).not.toHaveBeenCalled()
    }
  )

  test('reads and initializes a native default only after a device is explicitly selected', async () => {
    const api = catalog()
    const { result } = renderHook(() =>
      useAgentRouting(api, 'codex', 'project', { creation: true })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.model).toBeNull()
    expect(api.listNativeModels).not.toHaveBeenCalled()
    act(() => result.current.setExecutionPolicy({ mode: 'fixed', environment_id: '1' }))
    await waitFor(() => expect(result.current.valid).toBe(true))
    expect(result.current.modelPolicy).toEqual({
      mode: 'fixed',
      model: {
        runtime: 'codex',
        provider: 'openai',
        model_id: 'a',
        source: 'native',
      },
    })
    expect(api.listNativeModels).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: '1' }),
      'project'
    )
  })

  test('leaves native options selectable without racing a pending cloud default', async () => {
    const cloud = deferred<[]>()
    const api = {
      ...catalog([environment('1', [model, { ...model, model_id: 'b', is_default: false }])]),
      listModels: () => cloud.promise,
    }
    const { result } = renderHook(() =>
      useAgentRouting(api, 'codex', 'project', { creation: true })
    )
    await waitFor(() => expect(result.current.environmentLoading).toBe(false))
    act(() => result.current.setExecutionPolicy({ mode: 'fixed', environment_id: '1' }))
    await waitFor(() => expect(result.current.models).toHaveLength(2))
    expect(result.current.loading).toBe(false)
    expect(result.current.model).toBeNull()
    act(() => result.current.setModel({ ...model, model_id: 'b' }))
    await act(async () => cloud.resolve([]))
    expect(result.current.model?.model_id).toBe('b')
    expect(result.current.valid).toBe(true)
  })

  test('defaults to the first native model in list order rather than a later preferred model', async () => {
    const api = catalog([
      environment('1', [
        { ...model, is_default: false },
        { ...model, model_id: 'b', is_default: true },
      ]),
    ])
    const { result } = renderHook(() =>
      useAgentRouting(api, 'codex', 'project', { creation: true })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.setExecutionPolicy({ mode: 'fixed', environment_id: '1' }))
    await waitFor(() => expect(result.current.nativeLoading).toBe(false))
    expect(result.current.model?.model_id).toBe('a')
    expect(result.current.valid).toBe(true)
  })

  test('respects manual device and runtime-model choices made before catalogs load', async () => {
    const runners = deferred<RunnerEnvironment[]>()
    const api = { ...catalog(), listEnvironments: () => runners.promise }
    const { result } = renderHook(() =>
      useAgentRouting(api, 'codex', 'project', { creation: true })
    )
    act(() => {
      result.current.setExecutionPolicy({ mode: 'fixed', environment_id: '2' })
      result.current.setModelMode('user_select')
    })
    await act(async () => runners.resolve([environment('1', [model]), environment('2', [model])]))
    expect(result.current.executionPolicy).toEqual({ mode: 'fixed', environment_id: '2' })
    expect(result.current.modelPolicy).toEqual({ mode: 'user_select' })
    expect(result.current.model).toBeNull()
    expect(result.current.valid).toBe(true)
  })

  test('does not replace historical policies when editing or when catalogs arrive late', async () => {
    const runners = deferred<RunnerEnvironment[]>()
    const api = { ...catalog(), listEnvironments: () => runners.promise }
    const { result } = renderHook(() => useAgentRouting(api, 'codex', 'project'))
    act(() => result.current.load({ mode: 'user_select' }, { mode: 'user_select' }))
    await act(async () => runners.resolve([environment('1', [model])]))
    expect(result.current.executionPolicy).toEqual({ mode: 'user_select' })
    expect(result.current.modelPolicy).toEqual({ mode: 'user_select' })
    act(() => result.current.load(undefined, undefined))
    expect(result.current.executionPolicy).toBeNull()
    expect(result.current.valid).toBe(false)
  })

  test('clears a native model when changing device until explicitly replaced', async () => {
    const api = catalog([
      environment('1', [model]),
      environment('2', [{ ...model, model_id: 'b' }]),
    ])
    const { result } = renderHook(() => useAgentRouting(api, 'codex', 'project'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.load({ mode: 'fixed', environment_id: '1' }, { mode: 'fixed', model }))
    expect(result.current.valid).toBe(true)
    act(() => result.current.setExecutionPolicy({ mode: 'fixed', environment_id: '2' }))
    expect(result.current.model).toBeNull()
    expect(result.current.valid).toBe(false)
    act(() => result.current.setModel({ ...model, model_id: 'b' }))
    expect(result.current.valid).toBe(true)
  })
})

describe('on-demand model discovery', () => {
  test('defaults to the first cloud model before runtime settings open and defers device discovery', async () => {
    let failNative!: (cause: Error) => void
    const native = new Promise<Pick<RunnerEnvironment, 'models'>>((_resolve, reject) => {
      failNative = reject
    })
    const api = {
      ...catalog([environment('1')]),
      listModels: vi.fn(async () => [cloudModel, { ...cloudModel, name: 'second-cloud-model' }]),
      listNativeModels: vi.fn(() => native),
    }
    const { result } = renderHook(() =>
      useAgentRouting(api, 'codex', 'project', { defer: true, creation: true })
    )
    expect(api.listEnvironments).not.toHaveBeenCalled()
    expect(api.listModels).toHaveBeenCalledOnce()
    expect(api.listNativeModels).not.toHaveBeenCalled()
    await waitFor(() => expect(result.current.valid).toBe(true))
    expect(result.current.model?.model_id).toBe(cloudModel.name)
    expect(result.current.activated).toBe(false)
    expect(api.listEnvironments).not.toHaveBeenCalled()
    act(() => result.current.activate())
    await waitFor(() => expect(result.current.environmentLoading).toBe(false))
    expect(api.listModels).toHaveBeenCalledOnce()
    expect(result.current.executionPolicy).toEqual({ mode: 'project_pool' })
    expect(api.listNativeModels).not.toHaveBeenCalled()
    act(() => result.current.setExecutionPolicy({ mode: 'fixed', environment_id: '1' }))
    await waitFor(() => expect(api.listNativeModels).toHaveBeenCalledOnce())
    expect(result.current.model?.source).toBe('cloud')
    expect(result.current.nativeLoading).toBe(true)
    expect(result.current.loading).toBe(false)
    await act(async () => failNative(new Error('native unavailable')))
    expect(result.current.valid).toBe(true)
    expect(result.current.candidates[0].catalog_error).toBe('native unavailable')
  })

  test('preserves an explicit model choice when the initial cloud list arrives later', async () => {
    const cloud = deferred<(typeof cloudModel)[]>()
    const api = { ...catalog(), listModels: () => cloud.promise }
    const { result } = renderHook(() =>
      useAgentRouting(api, 'codex', 'project', { defer: true, creation: true })
    )
    const chosen = {
      runtime: 'codex' as const,
      source: 'cloud' as const,
      provider: 'openai-responses',
      model_id: 'second-cloud-model',
      cloud_model: {
        name: 'second-cloud-model',
        type: 'public' as const,
        namespace: 'default',
        resource_user_id: 1,
      },
    }
    act(() => result.current.setModel(chosen))
    await act(async () => cloud.resolve([cloudModel, { ...cloudModel, name: chosen.model_id }]))
    expect(result.current.model).toEqual(chosen)
    expect(result.current.valid).toBe(true)
    expect(api.listEnvironments).not.toHaveBeenCalled()
    expect(api.listNativeModels).not.toHaveBeenCalled()
  })

  test('leaves the model unset when no cloud models are available on the basic tab', async () => {
    const api = catalog()
    const { result } = renderHook(() =>
      useAgentRouting(api, 'codex', 'project', { defer: true, creation: true })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.model).toBeNull()
    expect(result.current.valid).toBe(false)
    expect(api.listEnvironments).not.toHaveBeenCalled()
    expect(api.listNativeModels).not.toHaveBeenCalled()
  })

  test('waits for a device and discards native responses from the previous selection', async () => {
    const old = deferred<Pick<RunnerEnvironment, 'models'>>()
    const api = {
      ...catalog([environment('1'), environment('2')]),
      listModels: vi.fn(async () => [cloudModel]),
      listNativeModels: vi.fn((device: RunnerEnvironment) =>
        device.id === '1'
          ? old.promise
          : Promise.resolve({ models: [{ ...model, model_id: 'device-2' }] })
      ),
    }
    const { result } = renderHook(() => useAgentRouting(api, 'codex'))
    await waitFor(() => expect(result.current.environmentLoading).toBe(false))
    expect(api.listModels).not.toHaveBeenCalled()
    expect(api.listNativeModels).not.toHaveBeenCalled()
    act(() => result.current.setExecutionPolicy({ mode: 'fixed', environment_id: '1' }))
    await waitFor(() =>
      expect(result.current.models.some(item => item.source === 'cloud')).toBe(true)
    )
    act(() => result.current.setModel(result.current.models[0]))
    act(() => result.current.setExecutionPolicy({ mode: 'fixed', environment_id: '2' }))
    await waitFor(() =>
      expect(result.current.models.some(item => item.model_id === 'device-2')).toBe(true)
    )
    await act(async () => old.resolve({ models: [{ ...model, model_id: 'device-1' }] }))
    expect(result.current.models.some(item => item.model_id === 'device-1')).toBe(false)
    expect(result.current.model?.source).toBe('cloud')
    expect(result.current.valid).toBe(true)
    expect(api.listModels).toHaveBeenCalledOnce()
  })

  test('preserves saved routing without fetching catalogs for an identity-only edit', () => {
    const api = { listEnvironments: vi.fn(), listModels: vi.fn(), listNativeModels: vi.fn() }
    const { result } = renderHook(() => useAgentRouting(api, 'codex', undefined, { defer: true }))
    act(() =>
      result.current.load({ mode: 'fixed', environment_id: 'saved' }, { mode: 'fixed', model })
    )
    expect(result.current.valid).toBe(true)
    expect(api.listEnvironments).not.toHaveBeenCalled()
    expect(api.listModels).not.toHaveBeenCalled()
    expect(api.listNativeModels).not.toHaveBeenCalled()
  })
})
