import type { ModelSelectionConfig, UnifiedModel } from '@/types/api'
import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useWorkbenchModels } from './useWorkbenchModels'
import { LOCAL_MODEL_SETTINGS_CHANGED_EVENT } from '@/features/model-settings/localModelSettings'

test.each(['manual', 'ai', 'automatic'])(
  'restores %s command approval when the saved model is replaced by the default',
  async commandApproval => {
    const model: UnifiedModel = { name: 'default-model', type: 'runtime' }
    const api = { listModels: vi.fn().mockResolvedValue({ data: [model] }) }
    const { result } = renderHook(() =>
      useWorkbenchModels({
        api,
        locked: false,
        selectionConfig: {
          modelName: 'unavailable-model',
          modelType: 'runtime',
          options: { commandApproval },
        },
        defaultSelectionConfig: () => ({ modelName: model.name, modelType: model.type }),
      })
    )

    await waitFor(() => expect(result.current.selectedModel).toEqual(model))
    expect(result.current.selectedModelOptions.commandApproval).toBe(commandApproval)

    act(() => result.current.setSelectedModelAndOptions(model, {}))
    expect(result.current.selectedModelOptions.commandApproval).toBe(commandApproval)
  }
)

test('refreshes the owning catalog after committed local model settings change', async () => {
  const before: UnifiedModel = { name: 'before-edit', type: 'runtime' }
  const after: UnifiedModel = { name: 'after-edit', type: 'runtime' }
  let models = [before]
  const api = {
    listModels: vi.fn(async () => ({ data: models })),
    refresh: vi.fn(() => {
      models = [after]
    }),
  }
  const hook = renderHook(() => useWorkbenchModels({ api, locked: false, persistSelection: false }))
  await waitFor(() => expect(hook.result.current.models).toEqual([before]))
  act(() => window.dispatchEvent(new Event(LOCAL_MODEL_SETTINGS_CHANGED_EVENT)))
  await waitFor(() => expect(hook.result.current.models).toEqual([after]))
  expect(api.refresh).toHaveBeenCalledOnce()
  expect(api.refresh).toHaveBeenCalledWith({ invalidateLocal: true })
  hook.unmount()
  window.dispatchEvent(new Event(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
  expect(api.refresh).toHaveBeenCalledOnce()
})

test('keeps an initialized draft model when another source changes the default', async () => {
  const cloud: UnifiedModel = {
    name: 'cloud-model',
    type: 'public',
    config: { ui: { reasoningEfforts: ['low', 'high'] } },
  }
  const local: UnifiedModel = { name: 'native-model', type: 'runtime' }
  let models = [cloud]
  let notify: (() => void) | undefined
  const onSelectionChange = vi.fn()
  const api = {
    listModels: vi.fn(async () => ({ data: models })),
    subscribe: (listener: () => void) => {
      notify = listener
      return () => {
        notify = undefined
      }
    },
  }
  const hook = renderHook(
    ({ scopeKey, selectionConfig }) =>
      useWorkbenchModels({
        api,
        locked: false,
        scopeKey,
        selectionConfig,
        persistSelection: false,
        defaultSelectionConfig: catalog => {
          const model = catalog[0]
          return model ? { modelName: model.name, modelType: model.type } : null
        },
        onSelectionChange,
      }),
    {
      initialProps: {
        scopeKey: 'draft-one',
        selectionConfig: null as ModelSelectionConfig | null,
      },
    }
  )
  await waitFor(() => expect(hook.result.current.selectedModel).toEqual(cloud))
  act(() => hook.result.current.setSelectedModelOption('reasoning', 'high'))

  act(() => {
    models = [local, cloud]
    notify?.()
  })
  await waitFor(() => expect(hook.result.current.models).toEqual([local, cloud]))
  await waitFor(() => expect(hook.result.current.isSelectionReady).toBe(true))
  expect(hook.result.current.selectedModel).toEqual(cloud)
  expect(hook.result.current.selectedModelOptions.reasoning).toBe('high')
  expect(hook.result.current.isSelectionReady).toBe(true)

  hook.rerender({ scopeKey: 'draft-two', selectionConfig: null })
  await waitFor(() => expect(hook.result.current.selectedModel).toEqual(local))
  hook.rerender({ scopeKey: 'draft-one', selectionConfig: null })
  await waitFor(() => expect(hook.result.current.selectedModel).toEqual(cloud))
  expect(hook.result.current.selectedModelOptions.reasoning).toBe('high')

  hook.rerender({
    scopeKey: 'draft-one',
    selectionConfig: { modelName: local.name, modelType: local.type },
  })
  await waitFor(() => expect(hook.result.current.selectedModel).toEqual(local))
  act(() => {
    models = [cloud]
    notify?.()
  })
  await waitFor(() => expect(hook.result.current.selectedModel).toEqual(cloud))
  expect(onSelectionChange).not.toHaveBeenCalled()
  hook.unmount()
})

test('restores the configured native model when its source arrives after cloud discovery', async () => {
  const cloud: UnifiedModel = { name: 'cloud-model', type: 'public' }
  const local: UnifiedModel = {
    name: 'native-codex',
    type: 'runtime',
    runtime: { family: 'codex', provider: 'native-provider' },
    config: { ui: { reasoningEfforts: ['low', 'high'] } },
  }
  let models = [cloud]
  let notify: (() => void) | undefined
  const onSelectionChange = vi.fn()
  const api = {
    listModels: vi.fn(async () => ({ data: models })),
    subscribe: (listener: () => void) => {
      notify = listener
      return () => {
        notify = undefined
      }
    },
  }
  const hook = renderHook(() =>
    useWorkbenchModels({
      api,
      locked: false,
      persistSelection: false,
      fallbackWhenConfiguredModelUnavailable: false,
      selectionConfig: {
        modelName: local.name,
        modelType: local.type,
        options: { runnerModelProvider: 'native-provider', reasoning: 'high' },
      },
      onSelectionChange,
    })
  )
  await waitFor(() => expect(hook.result.current.models).toEqual([cloud]))
  expect(hook.result.current.selectedModel).toBeNull()
  expect(hook.result.current.isSelectionReady).toBe(false)
  expect(onSelectionChange).not.toHaveBeenCalled()

  act(() => {
    models = [local, cloud]
    notify?.()
  })
  await waitFor(() => expect(hook.result.current.selectedModel).toEqual(local))
  expect(hook.result.current.isSelectionReady).toBe(true)
  expect(hook.result.current.getSelectedModelOptions()).toMatchObject({
    runnerModelProvider: 'native-provider',
    reasoning: 'high',
  })
  expect(onSelectionChange).not.toHaveBeenCalled()
  hook.unmount()
})

test('keeps a restored native provider through catalog refresh and clears it on model change', async () => {
  const model: UnifiedModel = {
    name: 'native-codex',
    type: 'runtime',
    runtime: { family: 'codex', provider: 'native-provider' },
  }
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

test('keeps each conversation selection when switching scopes without sending', async () => {
  const modelA: UnifiedModel = { name: 'model-a', type: 'runtime' }
  const modelB: UnifiedModel = { name: 'model-b', type: 'runtime' }
  const modelC: UnifiedModel = { name: 'model-c', type: 'runtime' }
  const modelD: UnifiedModel = { name: 'model-d', type: 'runtime' }
  const api = {
    listModels: vi.fn().mockResolvedValue({ data: [modelA, modelB, modelC, modelD] }),
  }
  const hook = renderHook(
    ({ scopeKey, selectionConfig }: { scopeKey: string; selectionConfig: ModelSelectionConfig }) =>
      useWorkbenchModels({
        api,
        locked: false,
        persistSelection: false,
        scopeKey,
        selectionConfig,
      }),
    {
      initialProps: {
        scopeKey: 'task-a',
        selectionConfig: { modelName: modelA.name, modelType: modelA.type },
      },
    }
  )

  await waitFor(() => expect(hook.result.current.isSelectionReady).toBe(true))
  act(() => hook.result.current.setSelectedModelForScope('task-a', modelB))
  expect(hook.result.current.getSelectedModelForScope('task-a')).toEqual(modelB)

  hook.rerender({
    scopeKey: 'task-b',
    selectionConfig: { modelName: modelC.name, modelType: modelC.type },
  })
  await waitFor(() =>
    expect(hook.result.current.getSelectedModelForScope('task-b')).toEqual(modelC)
  )
  act(() => hook.result.current.setSelectedModelForScope('task-b', modelD))

  hook.rerender({
    scopeKey: 'task-a',
    selectionConfig: { modelName: modelA.name, modelType: modelA.type },
  })
  await waitFor(() => expect(hook.result.current.selectedModel).toEqual(modelB))
  expect(hook.result.current.getSelectedModelForScope('task-a')).toEqual(modelB)
  expect(hook.result.current.getSelectedModelForScope('task-b')).toEqual(modelD)
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

test('distinguishes a temporary draft default from an explicit choice when native discovery finishes', async () => {
  const cloud: UnifiedModel = { name: 'cloud-anthropic', type: 'public' }
  const native: UnifiedModel = { name: 'native-gpt', type: 'runtime' }
  for (const explicitlySelected of [false, true]) {
    let models = [cloud]
    let notify: (() => void) | undefined
    const api = {
      listModels: vi.fn(async () => ({ data: models })),
      subscribe: (listener: () => void) => {
        notify = listener
        return () => {
          notify = undefined
        }
      },
    }
    const hook = renderHook(() =>
      useWorkbenchModels({
        api,
        locked: false,
        scopeKey: 'new-chat',
        persistSelection: false,
        selectionConfig: { modelName: native.name, modelType: native.type },
        defaultSelectionConfig: () => ({ modelName: cloud.name, modelType: cloud.type }),
      })
    )
    await waitFor(() => expect(hook.result.current.selectedModel).toEqual(cloud))
    if (explicitlySelected) act(() => hook.result.current.setSelectedModel(cloud))
    act(() => {
      models = [native, cloud]
      notify?.()
    })
    await waitFor(() => expect(hook.result.current.models).toEqual([native, cloud]))
    await waitFor(() => expect(hook.result.current.isSelectionReady).toBe(true))
    const expected = explicitlySelected ? cloud : native
    await waitFor(() => expect(hook.result.current.getSelectedModel()).toEqual(expected))
    expect(hook.result.current.selectedModel).toEqual(expected)
    hook.unmount()
  }
})
