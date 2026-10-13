import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
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
const environment = (id: string, models: RunnerModel[]): RunnerEnvironment => ({
  id,
  name: id,
  device_key: id,
  owner_type: 'user',
  owner_id: '1',
  status: 'online',
  project_authorized: true,
  models,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolved => {
    resolve = resolved
  })
  return { promise, resolve }
}

describe('agent routing editor', () => {
  test('initializes the only environment and its runtime default without copying catalog details', async () => {
    const api = {
      listModels: async () => [],
      listRunnerEnvironments: async () => [environment('1', [model])],
    }
    const { result } = renderHook(() =>
      useAgentRouting(api, 'codex', 'project', {
        creationDefaults: { preferredDeviceIds: [] },
      })
    )
    await waitFor(() => expect(result.current.valid).toBe(true))
    expect(result.current.executionPolicy).toEqual({ mode: 'fixed', environment_id: '1' })
    expect(result.current.modelPolicy).toEqual({
      mode: 'fixed',
      model: {
        runtime: 'codex',
        provider: 'openai',
        model_id: 'a',
        source: 'native',
      },
    })
    act(() => result.current.load({ mode: 'project_pool' }, { mode: 'user_select' }))
    expect(result.current.executionPolicy).toEqual({ mode: 'project_pool' })
    expect(result.current.modelPolicy).toEqual({ mode: 'user_select' })
    act(() => result.current.load(undefined, undefined))
    expect(result.current.executionPolicy).toBeNull()
    expect(result.current.valid).toBe(false)
  })
  test('matches personal-default and current-device priorities against environment device keys', async () => {
    const other = { ...model, model_id: 'b' }
    const api = {
      listModels: async () => [],
      listRunnerEnvironments: async () => [
        { ...environment('1', [model]), device_key: 'current-device' },
        { ...environment('2', [other]), device_key: 'personal-default' },
      ],
    }
    const { result } = renderHook(() =>
      useAgentRouting(api, 'codex', 'project', {
        creationDefaults: {
          preferredDeviceIds: ['revoked-device', 'personal-default', 'current-device'],
        },
      })
    )
    await waitFor(() => expect(result.current.valid).toBe(true))
    expect(result.current.executionPolicy).toEqual({ mode: 'fixed', environment_id: '2' })
    expect(result.current.model?.model_id).toBe('b')
    act(() => result.current.setExecutionPolicy({ mode: 'fixed', environment_id: '1' }))
    expect(result.current.model?.model_id).toBe('b')
    expect(result.current.valid).toBe(false)
  })
  test('does not invent defaults for ambiguous environments or models', async () => {
    const api = {
      listModels: async () => [],
      listRunnerEnvironments: async () => [
        environment('1', [
          { ...model, is_default: false },
          { ...model, model_id: 'b', is_default: false },
        ]),
        environment('2', [model]),
      ],
    }
    const { result } = renderHook(() =>
      useAgentRouting(api, 'codex', 'project', {
        creationDefaults: { preferredDeviceIds: [] },
      })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.executionPolicy).toEqual({ mode: 'fixed', environment_id: '' })
    act(() => result.current.setExecutionPolicy({ mode: 'fixed', environment_id: '1' }))
    expect(result.current.model).toBeNull()
    expect(result.current.valid).toBe(false)
  })
  test('respects manual environment and deferred-model choices made before catalogs load', async () => {
    const catalog = deferred<RunnerEnvironment[]>()
    const api = { listModels: async () => [], listRunnerEnvironments: () => catalog.promise }
    const { result } = renderHook(() =>
      useAgentRouting(api, 'codex', 'project', {
        creationDefaults: { preferredDeviceIds: ['1'] },
      })
    )
    act(() => {
      result.current.setExecutionPolicy({ mode: 'fixed', environment_id: '2' })
      result.current.setModelMode('user_select')
    })
    await act(async () => catalog.resolve([environment('1', [model]), environment('2', [model])]))
    expect(result.current.executionPolicy).toEqual({ mode: 'fixed', environment_id: '2' })
    expect(result.current.modelPolicy).toEqual({ mode: 'user_select' })
    expect(result.current.model).toBeNull()
    expect(result.current.valid).toBe(true)
  })
  test('fills the manual environment default when no model has been chosen during loading', async () => {
    const catalog = deferred<RunnerEnvironment[]>()
    const api = { listModels: async () => [], listRunnerEnvironments: () => catalog.promise }
    const { result } = renderHook(() =>
      useAgentRouting(api, 'codex', 'project', {
        creationDefaults: { preferredDeviceIds: ['1'] },
      })
    )
    act(() => result.current.setExecutionPolicy({ mode: 'fixed', environment_id: '2' }))
    await act(async () =>
      catalog.resolve([environment('1', [model]), environment('2', [{ ...model, model_id: 'b' }])])
    )
    expect(result.current.executionPolicy).toEqual({ mode: 'fixed', environment_id: '2' })
    expect(result.current.model?.model_id).toBe('b')
  })
  test('leaves editing and execution selection empty unless explicitly loaded', async () => {
    const api = {
      listModels: async () => [],
      listRunnerEnvironments: async () => [environment('1', [model])],
    }
    const { result } = renderHook(() => useAgentRouting(api, 'codex', 'project'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.executionPolicy).toBeNull()
    expect(result.current.model).toBeNull()
    act(() => result.current.load(undefined, undefined))
    expect(result.current.executionPolicy).toBeNull()
  })
  test('retains loaded incomplete historical rules when catalogs arrive late', async () => {
    const catalog = deferred<RunnerEnvironment[]>()
    const api = { listModels: async () => [], listRunnerEnvironments: () => catalog.promise }
    const { result } = renderHook(() =>
      useAgentRouting(api, 'codex', 'project', {
        creationDefaults: { preferredDeviceIds: ['1'] },
      })
    )
    act(() => result.current.load(undefined, undefined))
    await act(async () => catalog.resolve([environment('1', [model])]))
    expect(result.current.executionPolicy).toBeNull()
    expect(result.current.model).toBeNull()
  })
  test('keeps an invalid model visible after changing environment until explicitly replaced', async () => {
    const api = {
      listModels: async () => [],
      listRunnerEnvironments: async () => [
        environment('1', [model]),
        environment('2', [{ ...model, model_id: 'b' }]),
      ],
    }
    const { result } = renderHook(() => useAgentRouting(api, 'codex', 'project'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.models).toEqual([])
    act(() => result.current.load({ mode: 'fixed', environment_id: '1' }, { mode: 'fixed', model }))
    expect(result.current.valid).toBe(true)
    act(() => result.current.setExecutionPolicy({ mode: 'fixed', environment_id: '2' }))
    expect(result.current.model?.model_id).toBe('a')
    expect(result.current.modelAvailable).toBe(false)
    expect(result.current.valid).toBe(false)
    act(() => result.current.setModel({ runtime: 'codex', provider: 'openai', model_id: 'b' }))
    expect(result.current.valid).toBe(true)
  })
})
