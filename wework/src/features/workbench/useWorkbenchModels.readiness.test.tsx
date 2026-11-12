import type { ModelSelectionConfig, UnifiedModel } from '@/types/api'
import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useWorkbenchModels } from './useWorkbenchModels'

test('keeps a restored native provider through catalog refresh and clears it on model change', async () => {
  const model: UnifiedModel = { name: 'native-codex', type: 'runtime' }
  const replacement: UnifiedModel = { name: 'other-codex', type: 'runtime' }
  const api = { listModels: vi.fn().mockResolvedValue({ data: [model, replacement] }) }
  const { result } = renderHook(() =>
    useWorkbenchModels({
      api,
      locked: false,
      persistSelection: false,
      selectionConfig: {
        modelName: model.name,
        modelType: model.type,
        options: { runnerModelProvider: 'native-provider' },
      },
    })
  )

  await waitFor(() => expect(result.current.isSelectionReady).toBe(true))
  expect(result.current.getSelectedModelOptions()).toMatchObject({
    runnerModelProvider: 'native-provider',
  })
  api.listModels.mockResolvedValue({ data: [{ ...model }, { ...replacement }] })
  act(() => result.current.refreshModels())
  await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(result.current.isLoading).toBe(false))
  expect(result.current.getSelectedModelOptions()).toMatchObject({
    runnerModelProvider: 'native-provider',
  })
  act(() => result.current.setSelectedModelAndOptions(model, { reasoning: 'medium' }))
  expect(result.current.getSelectedModelOptions()).toMatchObject({
    runnerModelProvider: 'native-provider',
  })
  act(() =>
    result.current.setSelectedModelAndOptions(replacement, result.current.getSelectedModelOptions())
  )
  expect(result.current.getSelectedModelOptions()).not.toHaveProperty('runnerModelProvider')
  act(() =>
    result.current.setSelectedModelAndOptions(model, { runnerModelProvider: 'native-provider' })
  )
  expect(result.current.getSelectedModelOptions()).not.toHaveProperty('runnerModelProvider')
  act(() =>
    result.current.setSelectionForScope('default', model, {
      runnerModelProvider: 'native-provider',
    })
  )
  act(() => result.current.setSelectedModel(replacement))
  expect(result.current.getSelectedModelOptions()).not.toHaveProperty('runnerModelProvider')
})

test('does not advertise send readiness before a deferred catalog has loaded', async () => {
  const model: UnifiedModel = { name: 'conversation-model', type: 'runtime' }
  let finishLoad!: (response: { data: UnifiedModel[] }) => void
  const response = new Promise<{ data: UnifiedModel[] }>(resolve => {
    finishLoad = resolve
  })
  const api = { listModels: vi.fn(() => response) }
  const hook = renderHook(
    ({ enabled }) =>
      useWorkbenchModels({
        api,
        locked: false,
        enabled,
        selectionConfig: { modelName: model.name, modelType: model.type },
      }),
    { initialProps: { enabled: false } }
  )

  expect(hook.result.current.isSelectionReady).toBe(false)
  expect(hook.result.current.isCatalogReady).toBe(false)
  expect(api.listModels).not.toHaveBeenCalled()
  hook.rerender({ enabled: true })
  await waitFor(() => expect(api.listModels).toHaveBeenCalledOnce())
  expect(hook.result.current.isSelectionReady).toBe(false)
  expect(hook.result.current.isCatalogReady).toBe(false)

  await act(async () => finishLoad({ data: [model] }))
  await waitFor(() => expect(hook.result.current.isSelectionReady).toBe(true))
  expect(hook.result.current.selectedModel).toEqual(model)
  expect(hook.result.current.isCatalogReady).toBe(true)
})

test('finishes catalog loading even when the configured model is unavailable', async () => {
  const api = { listModels: vi.fn().mockResolvedValue({ data: [] }) }
  const hook = renderHook(() =>
    useWorkbenchModels({
      api,
      locked: false,
      selectionConfig: { modelName: 'deleted-model', modelType: 'runtime' },
      fallbackWhenConfiguredModelUnavailable: false,
    })
  )

  await waitFor(() => expect(hook.result.current.isCatalogReady).toBe(true))
  expect(hook.result.current.isSelectionReady).toBe(false)
  expect(hook.result.current.isConfiguredModelUnavailable).toBe(true)
})

test('finishes a failed catalog attempt so the launcher can report an unavailable model', async () => {
  const error = new Error('catalog unavailable')
  const api = { listModels: vi.fn().mockRejectedValue(error) }
  const hook = renderHook(() => useWorkbenchModels({ api, locked: false }))

  await waitFor(() => expect(hook.result.current.isCatalogReady).toBe(true))
  expect(hook.result.current.models).toEqual([])
  expect(hook.result.current.error).toBe(error)
})

test('keeps a user-selected model through a task summary refresh', async () => {
  const local: UnifiedModel = { name: 'local-model', type: 'runtime' }
  const cloud: UnifiedModel = { name: 'cloud-model', type: 'public', provider: 'openai' }
  const api = { listModels: vi.fn().mockResolvedValue({ data: [local, cloud] }) }
  const hook = renderHook(
    ({ selectionConfig }: { selectionConfig: ModelSelectionConfig }) =>
      useWorkbenchModels({
        api,
        locked: false,
        persistSelection: false,
        scopeKey: 'task-scope',
        selectionConfig,
      }),
    {
      initialProps: {
        selectionConfig: { modelName: local.name, modelType: local.type } as ModelSelectionConfig,
      },
    }
  )

  await waitFor(() => expect(hook.result.current.isSelectionReady).toBe(true))
  act(() => hook.result.current.setSelectedModelForScope('task-scope', cloud))
  expect(hook.result.current.getSelectedModelForScope('task-scope')).toEqual(cloud)

  hook.rerender({
    selectionConfig: { modelName: local.name, modelType: local.type } as ModelSelectionConfig,
  })
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false))
  expect(hook.result.current.getSelectedModelForScope('task-scope')).toEqual(cloud)
})

test('bumps selectionRevision for a scoped model option change', async () => {
  const model: UnifiedModel = { name: 'scoped-model', type: 'runtime' }
  const api = { listModels: vi.fn().mockResolvedValue({ data: [model] }) }
  const { result } = renderHook(() =>
    useWorkbenchModels({
      api,
      locked: false,
      persistSelection: false,
      scopeKey: 'active-scope',
    })
  )

  await waitFor(() => expect(result.current.isSelectionReady).toBe(true))
  const before = result.current.selectionRevision
  act(() => result.current.setSelectedModelOptionForScope('background-scope', 'reasoning', 'high'))
  await waitFor(() => expect(result.current.selectionRevision).toBeGreaterThan(before))
})

test('keeps a user-selected model through a catalog refresh for a bound task', async () => {
  const local: UnifiedModel = { name: 'local-model', type: 'runtime' }
  const cloud: UnifiedModel = { name: 'cloud-model', type: 'public', provider: 'openai' }
  const api = { listModels: vi.fn().mockResolvedValue({ data: [local, cloud] }) }
  const { result } = renderHook(() =>
    useWorkbenchModels({
      api,
      locked: false,
      persistSelection: false,
      scopeKey: 'task-scope',
      selectionConfig: { modelName: local.name, modelType: local.type },
    })
  )

  await waitFor(() => expect(result.current.isSelectionReady).toBe(true))
  expect(result.current.getSelectedModelForScope('task-scope')).toEqual(local)

  act(() => result.current.setSelectedModelForScope('task-scope', cloud))
  expect(result.current.getSelectedModelForScope('task-scope')).toEqual(cloud)

  api.listModels.mockResolvedValue({ data: [{ ...local }, { ...cloud }] })
  act(() => result.current.refreshModels())
  await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(result.current.isLoading).toBe(false))
  expect(result.current.getSelectedModelForScope('task-scope')).toEqual(cloud)
})
