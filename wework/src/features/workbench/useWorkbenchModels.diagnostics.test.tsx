import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { ApiError } from '@/api/http'
import { logModelLoading } from '@/lib/model-loading-diagnostics'
import type { ModelSelectionConfig, UnifiedModel } from '@/types/api'
import {
  modelSelectionIdentityDiagnostics,
  modelSelectionScopeFingerprint,
} from './modelSelectionDiagnostics'
import { useWorkbenchModels } from './useWorkbenchModels'

vi.mock('@/lib/model-loading-diagnostics', () => ({
  logModelLoading: vi.fn(),
  observeModelLoadingMainThread: () => () => undefined,
  traceModelLoading: (_trace: string, _stage: string, run: () => Promise<unknown>) => run(),
}))

const models: UnifiedModel[] = ['model-a', 'model-b'].map(name => ({
  name,
  type: 'public',
  provider: 'cloud',
  runtime: { family: 'openai.openai-responses' },
}))
const selection = (modelName: string): ModelSelectionConfig => ({
  modelName,
  modelType: 'public',
  options: {},
})
const taskA = selection('model-a')
const taskB = selection('model-b')
const scopeA = 'user:7:runtime:device:task-a'
const scopeB = 'user:7:runtime:device:task-b'
const defaultSelectionConfig = () => taskB
const fingerprint = (value: ModelSelectionConfig | null) =>
  modelSelectionIdentityDiagnostics(value)?.fingerprint ?? 0

beforeEach(() => {
  vi.clearAllMocks()
})

test('records configuration and selection identities even when catalog size and readiness stay equal', async () => {
  const api = { listModels: vi.fn().mockResolvedValue({ data: models }) }
  const hook = renderHook(
    ({ selectionConfig }) =>
      useWorkbenchModels({
        api,
        locked: false,
        scopeKey: scopeA,
        selectionConfig,
        persistSelection: false,
        fallbackWhenConfiguredModelUnavailable: false,
      }),
    { initialProps: { selectionConfig: taskA } }
  )
  await waitFor(() => expect(hook.result.current.isSelectionReady).toBe(true))
  vi.mocked(logModelLoading).mockClear()

  hook.rerender({ selectionConfig: taskB })

  await waitFor(() =>
    expect(logModelLoading).toHaveBeenCalledWith(
      expect.any(String),
      'workbench.selection',
      expect.objectContaining({
        scopeFingerprint: modelSelectionScopeFingerprint(scopeA),
        configuredModelFingerprint: fingerprint(taskB),
        effectiveModelFingerprint: fingerprint(taskB),
        selectedModelFingerprint: fingerprint(taskB),
        modelCount: 2,
        catalogReady: true,
        isSelectionReady: true,
      })
    )
  )
  const events = vi
    .mocked(logModelLoading)
    .mock.calls.filter(([, stage]) => stage === 'workbench.selection')
    .map(([, , details]) => details)
  expect(
    events.every(details =>
      Object.values(details ?? {}).every(
        value => typeof value === 'number' || typeof value === 'boolean'
      )
    )
  ).toBe(true)
  hook.unmount()
})

test('identifies each task restoration after remount without changing saved model choices', async () => {
  const api = { listModels: vi.fn().mockResolvedValue({ data: models }) }
  const mount = () =>
    renderHook(
      ({ scopeKey, selectionConfig }) =>
        useWorkbenchModels({
          api,
          locked: false,
          scopeKey,
          selectionConfig,
          persistSelection: false,
          fallbackWhenConfiguredModelUnavailable: false,
          defaultSelectionConfig,
        }),
      { initialProps: { scopeKey: scopeA, selectionConfig: taskA } }
    )
  const first = mount()
  await waitFor(() => expect(first.result.current.isSelectionReady).toBe(true))
  first.rerender({ scopeKey: scopeB, selectionConfig: taskB })
  await waitFor(() => expect(first.result.current.selectedModel?.name).toBe('model-b'))
  first.unmount()

  const restored = mount()
  await waitFor(() => expect(restored.result.current.isSelectionReady).toBe(true))
  expect(restored.result.current.modelSelectionDiagnostics).toMatchObject({
    scopeFingerprint: modelSelectionScopeFingerprint(scopeA),
    configured: { modelName: 'model-a' },
    effective: { modelName: 'model-a' },
    selected: { modelName: 'model-a' },
    catalogReady: true,
    selectionReady: true,
  })
  expect(logModelLoading).toHaveBeenCalledWith(
    expect.any(String),
    'workbench.selection_restored',
    expect.objectContaining({
      scopeFingerprint: modelSelectionScopeFingerprint(scopeA),
      configuredModelFingerprint: fingerprint(taskA),
      restoredModelFingerprint: fingerprint(taskA),
      selectedModelFingerprint: fingerprint(taskA),
    })
  )
  restored.unmount()
})

test('distinguishes defaulting from an unavailable saved model', async () => {
  const api = { listModels: vi.fn().mockResolvedValue({ data: [models[1]] }) }
  const hook = renderHook(
    ({ selectionConfig }: { selectionConfig: ModelSelectionConfig | null }) =>
      useWorkbenchModels({
        api,
        locked: false,
        scopeKey: scopeA,
        selectionConfig,
        persistSelection: false,
        fallbackWhenConfiguredModelUnavailable: false,
        defaultSelectionConfig,
      }),
    { initialProps: { selectionConfig: null } }
  )
  await waitFor(() => expect(hook.result.current.isSelectionReady).toBe(true))
  expect(hook.result.current.modelSelectionDiagnostics).toMatchObject({
    configured: null,
    effective: { modelName: 'model-b' },
    selected: { modelName: 'model-b' },
  })

  hook.rerender({ selectionConfig: taskA })
  await waitFor(() => expect(hook.result.current.selectedModel).toBeNull())
  expect(hook.result.current.modelSelectionDiagnostics).toMatchObject({
    configured: { modelName: 'model-a' },
    effective: { modelName: 'model-a' },
    selected: null,
    selectionReady: false,
  })
  hook.unmount()
})

test('keeps a hidden cloud task model when the single-model endpoint resolves it', async () => {
  const hiddenTask = selection('hidden-model')
  const hiddenModel: UnifiedModel = {
    name: 'hidden-model',
    type: 'public',
    namespace: 'default',
    resourceUserId: 0,
  }
  const api = {
    listModels: vi.fn().mockResolvedValue({ data: [models[1]] }),
    getModel: vi.fn().mockResolvedValue(hiddenModel),
  }
  const hook = renderHook(() =>
    useWorkbenchModels({
      api,
      locked: false,
      scopeKey: scopeA,
      selectionConfig: hiddenTask,
      persistSelection: false,
      fallbackWhenConfiguredModelUnavailable: false,
    })
  )

  await waitFor(() => expect(hook.result.current.selectedModel).toEqual(hiddenModel))
  expect(hook.result.current.isSelectionReady).toBe(true)
  expect(hook.result.current.isConfiguredModelUnavailable).toBe(false)
  expect(hook.result.current.selectedModelAvailable).toBe(true)
  expect(api.getModel).toHaveBeenCalledWith('hidden-model', 'public', 'wework', 'llm')
})

test('drops a hidden cloud model when a catalog refresh proves it was removed', async () => {
  const hiddenTask = selection('hidden-model')
  const hiddenModel: UnifiedModel = {
    name: 'hidden-model',
    type: 'public',
    namespace: 'default',
    resourceUserId: 0,
  }
  const api = {
    listModels: vi.fn().mockResolvedValue({ data: [models[1]] }),
    getModel: vi.fn().mockResolvedValue(hiddenModel),
  }
  const hook = renderHook(() =>
    useWorkbenchModels({
      api,
      locked: false,
      scopeKey: scopeA,
      selectionConfig: hiddenTask,
      persistSelection: false,
      fallbackWhenConfiguredModelUnavailable: false,
    })
  )
  await waitFor(() => expect(hook.result.current.isSelectionReady).toBe(true))
  const lookupsBeforeRefresh = api.getModel.mock.calls.length

  api.getModel.mockRejectedValue(new ApiError('removed', 404))
  act(() => hook.result.current.refreshModels())

  await waitFor(() => expect(api.getModel).toHaveBeenCalledTimes(lookupsBeforeRefresh + 1))
  await waitFor(() => expect(hook.result.current.selectedModel).toBeNull())
  expect(hook.result.current.selectedModelAvailable).toBe(false)
  expect(hook.result.current.isSelectionReady).toBe(false)
  expect(hook.result.current.isConfiguredModelUnavailable).toBe(true)
})

test('keeps a hidden cloud model selectable when a catalog refresh still resolves it', async () => {
  const hiddenTask = selection('hidden-model')
  const hiddenModel: UnifiedModel = {
    name: 'hidden-model',
    type: 'public',
    namespace: 'default',
    resourceUserId: 0,
  }
  const api = {
    listModels: vi.fn().mockResolvedValue({ data: [models[1]] }),
    getModel: vi.fn().mockResolvedValue(hiddenModel),
  }
  const hook = renderHook(() =>
    useWorkbenchModels({
      api,
      locked: false,
      scopeKey: scopeA,
      selectionConfig: hiddenTask,
      persistSelection: false,
      fallbackWhenConfiguredModelUnavailable: false,
    })
  )
  await waitFor(() => expect(hook.result.current.isSelectionReady).toBe(true))
  const lookupsBeforeRefresh = api.getModel.mock.calls.length

  act(() => hook.result.current.refreshModels())

  await waitFor(() => expect(api.getModel).toHaveBeenCalledTimes(lookupsBeforeRefresh + 1))
  expect(hook.result.current.selectedModel).toEqual(hiddenModel)
  expect(hook.result.current.selectedModelAvailable).toBe(true)
  expect(hook.result.current.isSelectionReady).toBe(true)
})

test('keeps a hidden cloud model through a transient refresh lookup failure', async () => {
  const hiddenTask = selection('hidden-model')
  const hiddenModel: UnifiedModel = {
    name: 'hidden-model',
    type: 'public',
    namespace: 'default',
    resourceUserId: 0,
  }
  const api = {
    listModels: vi.fn().mockResolvedValue({ data: [models[1]] }),
    getModel: vi.fn().mockResolvedValue(hiddenModel),
  }
  const hook = renderHook(() =>
    useWorkbenchModels({
      api,
      locked: false,
      scopeKey: scopeA,
      selectionConfig: hiddenTask,
      persistSelection: false,
      fallbackWhenConfiguredModelUnavailable: false,
    })
  )
  await waitFor(() => expect(hook.result.current.isSelectionReady).toBe(true))
  const lookupsBeforeRefresh = api.getModel.mock.calls.length

  api.getModel.mockRejectedValue(new ApiError('offline', 503))
  act(() => hook.result.current.refreshModels())

  await waitFor(() => expect(api.getModel).toHaveBeenCalledTimes(lookupsBeforeRefresh + 1))
  expect(hook.result.current.selectedModel).toEqual(hiddenModel)
  expect(hook.result.current.selectedModelAvailable).toBe(true)
  expect(hook.result.current.isSelectionReady).toBe(true)
  expect(hook.result.current.isConfiguredModelUnavailable).toBe(false)
})

test('drops a hidden group model when a refresh resolves another group identity', async () => {
  const configuredTask: ModelSelectionConfig = {
    modelName: 'hidden-group-model',
    modelType: 'group',
    options: {
      weworkCloudModelNamespace: 'team-a',
      weworkCloudModelResourceUserId: '2',
    },
  }
  const hiddenModel: UnifiedModel = {
    name: 'hidden-group-model',
    type: 'group',
    namespace: 'team-a',
    resourceUserId: 2,
  }
  const api = {
    listModels: vi.fn().mockResolvedValue({ data: [models[1]] }),
    getModel: vi.fn().mockResolvedValue(hiddenModel),
  }
  const hook = renderHook(() =>
    useWorkbenchModels({
      api,
      locked: false,
      scopeKey: scopeA,
      selectionConfig: configuredTask,
      persistSelection: false,
      fallbackWhenConfiguredModelUnavailable: false,
    })
  )
  await waitFor(() => expect(hook.result.current.isSelectionReady).toBe(true))
  const lookupsBeforeRefresh = api.getModel.mock.calls.length

  api.getModel.mockResolvedValue({ ...hiddenModel, namespace: 'team-b' })
  act(() => hook.result.current.refreshModels())

  await waitFor(() => expect(api.getModel).toHaveBeenCalledTimes(lookupsBeforeRefresh + 1))
  await waitFor(() => expect(hook.result.current.selectedModel).toBeNull())
  expect(hook.result.current.isSelectionReady).toBe(false)
  expect(hook.result.current.isConfiguredModelUnavailable).toBe(true)
})

test('validates a task selection seeded before the catalog is ready', async () => {
  const hiddenTask = selection('hidden-model')
  const placeholder: UnifiedModel = {
    name: 'hidden-model',
    type: 'public',
    namespace: 'default',
    resourceUserId: 0,
  }
  const api = {
    listModels: vi.fn().mockResolvedValue({ data: [models[1]] }),
    getModel: vi.fn().mockRejectedValue(new ApiError('removed', 404)),
  }
  const hook = renderHook(
    ({ enabled }: { enabled: boolean }) =>
      useWorkbenchModels({
        api,
        locked: false,
        enabled,
        scopeKey: scopeA,
        selectionConfig: hiddenTask,
        persistSelection: false,
        fallbackWhenConfiguredModelUnavailable: false,
      }),
    { initialProps: { enabled: false } }
  )

  // A runtime task seeds its recorded selection before the catalog is enabled.
  act(() => hook.result.current.setSelectionForScope(scopeA, placeholder, {}, hiddenTask))
  expect(api.getModel).not.toHaveBeenCalled()

  hook.rerender({ enabled: true })

  await waitFor(() =>
    expect(api.getModel).toHaveBeenCalledWith('hidden-model', 'public', 'wework', 'llm')
  )
  await waitFor(() => expect(hook.result.current.selectedModel).toBeNull())
  expect(hook.result.current.isSelectionReady).toBe(false)
  expect(hook.result.current.isConfiguredModelUnavailable).toBe(true)
})

test('keeps the replacement flow when the persisted cloud model no longer resolves', async () => {
  const deletedTask = selection('deleted-model')
  const api = {
    listModels: vi.fn().mockResolvedValue({ data: [models[1]] }),
    getModel: vi.fn().mockRejectedValue(new ApiError('not found', 404)),
  }
  const hook = renderHook(() =>
    useWorkbenchModels({
      api,
      locked: false,
      scopeKey: scopeA,
      selectionConfig: deletedTask,
      persistSelection: false,
      fallbackWhenConfiguredModelUnavailable: false,
    })
  )

  await waitFor(() => expect(hook.result.current.selectedModelByScope).toHaveProperty(scopeA, null))
  expect(hook.result.current.isConfiguredModelUnavailable).toBe(true)
  expect(hook.result.current.selectedModel).toBeNull()
  expect(hook.result.current.isSelectionReady).toBe(false)
  expect(api.getModel).toHaveBeenCalledWith('deleted-model', 'public', 'wework', 'llm')
})

test('does not replace a persisted cloud model on a transient lookup failure', async () => {
  const transientTask = selection('transient-model')
  const api = {
    listModels: vi.fn().mockResolvedValue({ data: [models[1]] }),
    getModel: vi.fn().mockRejectedValue(new ApiError('offline', 503)),
  }
  const hook = renderHook(() =>
    useWorkbenchModels({
      api,
      locked: false,
      scopeKey: scopeA,
      selectionConfig: transientTask,
      persistSelection: false,
      fallbackWhenConfiguredModelUnavailable: false,
    })
  )

  await waitFor(() => expect(api.getModel).toHaveBeenCalled())
  expect(hook.result.current.isConfiguredModelUnavailable).toBe(false)
  expect(hook.result.current.isSelectionReady).toBe(false)
  expect(hook.result.current.selectedModel).toBeNull()
})

test('does not restore an unrelated selection when the configured model changed transiently', async () => {
  const transientConfig: ModelSelectionConfig = {
    modelName: 'hidden-model',
    modelType: 'public',
    options: {},
  }
  const api = {
    listModels: vi.fn().mockResolvedValue({ data: models }),
    getModel: vi.fn().mockRejectedValue(new ApiError('offline', 503)),
  }
  const hook = renderHook(
    ({ selectionConfig }: { selectionConfig: ModelSelectionConfig }) =>
      useWorkbenchModels({
        api,
        locked: false,
        scopeKey: scopeA,
        selectionConfig,
        persistSelection: false,
        fallbackWhenConfiguredModelUnavailable: false,
      }),
    { initialProps: { selectionConfig: taskA } }
  )
  await waitFor(() => expect(hook.result.current.selectedModel?.name).toBe('model-a'))
  expect(hook.result.current.isSelectionReady).toBe(true)

  hook.rerender({ selectionConfig: transientConfig })
  await waitFor(() =>
    expect(api.getModel).toHaveBeenCalledWith('hidden-model', 'public', 'wework', 'llm')
  )
  await waitFor(() => expect(hook.result.current.selectedModel).toBeNull())
  expect(hook.result.current.isSelectionReady).toBe(false)
  expect(hook.result.current.isConfiguredModelUnavailable).toBe(false)

  const hiddenModel: UnifiedModel = {
    name: 'hidden-model',
    type: 'public',
    namespace: 'default',
    resourceUserId: 0,
  }
  api.getModel.mockResolvedValue(hiddenModel)
  act(() => {
    window.dispatchEvent(new Event('online'))
  })
  await waitFor(() => expect(hook.result.current.selectedModel).toEqual(hiddenModel))
  expect(hook.result.current.isSelectionReady).toBe(true)
})

test('does not clear a newer selection when a cancelled lookup fails', async () => {
  let rejectLookup: (error: unknown) => void = () => undefined
  const pending = new Promise<UnifiedModel>((_, reject) => {
    rejectLookup = reject
  })
  const api = {
    listModels: vi.fn().mockResolvedValue({ data: models }),
    getModel: vi.fn(() => pending),
  }
  const hiddenConfig: ModelSelectionConfig = {
    modelName: 'hidden-model',
    modelType: 'public',
    options: {},
  }
  const hook = renderHook(
    ({ selectionConfig }: { selectionConfig: ModelSelectionConfig }) =>
      useWorkbenchModels({
        api,
        locked: false,
        scopeKey: scopeA,
        selectionConfig,
        persistSelection: false,
        fallbackWhenConfiguredModelUnavailable: false,
      }),
    { initialProps: { selectionConfig: hiddenConfig } }
  )
  await waitFor(() =>
    expect(api.getModel).toHaveBeenCalledWith('hidden-model', 'public', 'wework', 'llm')
  )

  hook.rerender({ selectionConfig: taskA })
  await waitFor(() => expect(hook.result.current.selectedModel?.name).toBe('model-a'))
  expect(hook.result.current.isSelectionReady).toBe(true)

  await act(async () => {
    rejectLookup(new ApiError('offline', 503))
    await pending.catch(() => undefined)
  })

  expect(hook.result.current.selectedModel?.name).toBe('model-a')
  expect(hook.result.current.isSelectionReady).toBe(true)
  expect(hook.result.current.isConfiguredModelUnavailable).toBe(false)
})

test('does not let a pending hidden lookup restore over a newer manual selection', async () => {
  let resolveLookup: (model: UnifiedModel) => void = () => undefined
  const pending = new Promise<UnifiedModel>(resolve => {
    resolveLookup = resolve
  })
  const hiddenModel: UnifiedModel = {
    name: 'hidden-model',
    type: 'public',
    namespace: 'default',
    resourceUserId: 0,
  }
  const api = {
    listModels: vi.fn().mockResolvedValue({ data: models }),
    getModel: vi.fn(() => pending),
  }
  const hook = renderHook(() =>
    useWorkbenchModels({
      api,
      locked: false,
      scopeKey: scopeA,
      selectionConfig: selection('hidden-model'),
      persistSelection: false,
      fallbackWhenConfiguredModelUnavailable: false,
    })
  )
  await waitFor(() => expect(api.getModel).toHaveBeenCalled())

  act(() => hook.result.current.setSelectedModel(models[1]!))
  await waitFor(() => expect(hook.result.current.selectedModel?.name).toBe('model-b'))

  await act(async () => {
    resolveLookup(hiddenModel)
    await pending
  })

  expect(hook.result.current.selectedModel?.name).toBe('model-b')
  expect(hook.result.current.isSelectionReady).toBe(true)
  expect(hook.result.current.isConfiguredModelUnavailable).toBe(false)
})

test('does not let a stale 404 clear a newer manual selection', async () => {
  let rejectLookup: (error: unknown) => void = () => undefined
  const pending = new Promise<UnifiedModel>((_, reject) => {
    rejectLookup = reject
  })
  const api = {
    listModels: vi.fn().mockResolvedValue({ data: models }),
    getModel: vi.fn(() => pending),
  }
  const hook = renderHook(() =>
    useWorkbenchModels({
      api,
      locked: false,
      scopeKey: scopeA,
      selectionConfig: selection('hidden-model'),
      persistSelection: false,
      fallbackWhenConfiguredModelUnavailable: false,
    })
  )
  await waitFor(() => expect(api.getModel).toHaveBeenCalled())

  act(() => hook.result.current.setSelectedModel(models[1]!))
  await waitFor(() => expect(hook.result.current.selectedModel?.name).toBe('model-b'))

  await act(async () => {
    rejectLookup(new ApiError('removed', 404))
    await pending.catch(() => undefined)
  })

  expect(hook.result.current.selectedModel?.name).toBe('model-b')
  expect(hook.result.current.isSelectionReady).toBe(true)
  expect(hook.result.current.isConfiguredModelUnavailable).toBe(false)
})

test('does not let a stale transient failure clear a newer manual selection', async () => {
  let rejectLookup: (error: unknown) => void = () => undefined
  const pending = new Promise<UnifiedModel>((_, reject) => {
    rejectLookup = reject
  })
  const api = {
    listModels: vi.fn().mockResolvedValue({ data: models }),
    getModel: vi.fn(() => pending),
  }
  const hook = renderHook(() =>
    useWorkbenchModels({
      api,
      locked: false,
      scopeKey: scopeA,
      selectionConfig: selection('hidden-model'),
      persistSelection: false,
      fallbackWhenConfiguredModelUnavailable: false,
    })
  )
  await waitFor(() => expect(api.getModel).toHaveBeenCalled())

  act(() => hook.result.current.setSelectedModel(models[1]!))
  await waitFor(() => expect(hook.result.current.selectedModel?.name).toBe('model-b'))

  await act(async () => {
    rejectLookup(new ApiError('offline', 503))
    await pending.catch(() => undefined)
  })

  expect(hook.result.current.selectedModel?.name).toBe('model-b')
  expect(hook.result.current.isSelectionReady).toBe(true)
  expect(hook.result.current.isConfiguredModelUnavailable).toBe(false)
})

test('stays ready when a manual replacement follows a task model update', async () => {
  const api = {
    listModels: vi.fn().mockResolvedValue({ data: models }),
    getModel: vi.fn().mockRejectedValue(new ApiError('removed', 404)),
  }
  const hook = renderHook(
    ({ selectionConfig }: { selectionConfig: ModelSelectionConfig }) =>
      useWorkbenchModels({
        api,
        locked: false,
        scopeKey: scopeA,
        selectionConfig,
        persistSelection: false,
        fallbackWhenConfiguredModelUnavailable: false,
      }),
    { initialProps: { selectionConfig: selection('deleted-model') } }
  )
  await waitFor(() => expect(hook.result.current.isSelectionReady).toBe(false))

  // The replacement is sent and becomes the task's recorded model.
  act(() => hook.result.current.setSelectedModel(models[0]!))
  await waitFor(() => expect(hook.result.current.isSelectionReady).toBe(true))
  hook.rerender({ selectionConfig: selection('model-a') })
  await act(async () => undefined)

  // Choosing another available model must not leave readiness stuck on the
  // task model change that happened while the replacement was active.
  act(() => hook.result.current.setSelectedModel(models[1]!))

  await waitFor(() => expect(hook.result.current.selectedModel?.name).toBe('model-b'))
  expect(hook.result.current.isSelectionReady).toBe(true)
  expect(hook.result.current.isConfiguredModelUnavailable).toBe(false)
})

test('rejects a same-named model from another group identity', async () => {
  const configuredTask: ModelSelectionConfig = {
    modelName: 'hidden-group-model',
    modelType: 'group',
    options: {
      weworkCloudModelNamespace: 'team-a',
      weworkCloudModelResourceUserId: '2',
    },
  }
  const api = {
    listModels: vi.fn().mockResolvedValue({ data: [models[1]] }),
    getModel: vi.fn().mockResolvedValue({
      name: 'hidden-group-model',
      type: 'group',
      namespace: 'team-b',
      resourceUserId: 2,
    }),
  }
  const hook = renderHook(() =>
    useWorkbenchModels({
      api,
      locked: false,
      scopeKey: scopeA,
      selectionConfig: configuredTask,
      persistSelection: false,
      fallbackWhenConfiguredModelUnavailable: false,
    })
  )

  await waitFor(() => expect(hook.result.current.selectedModelByScope).toHaveProperty(scopeA, null))
  expect(hook.result.current.isConfiguredModelUnavailable).toBe(true)
  expect(hook.result.current.selectedModel).toBeNull()
})

test('correlates composer changes and background seeds without logging private options', async () => {
  const api = { listModels: vi.fn().mockResolvedValue({ data: models }) }
  const onSelectionChange = vi.fn()
  const hook = renderHook(() =>
    useWorkbenchModels({
      api,
      locked: false,
      scopeKey: scopeA,
      selectionConfig: taskA,
      persistSelection: false,
      onSelectionChange,
    })
  )
  await waitFor(() => expect(hook.result.current.isSelectionReady).toBe(true))
  act(() =>
    hook.result.current.setSelectedModelAndOptions(models[1]!, { api_key: 'SYNTHETIC_SECRET' })
  )
  expect(logModelLoading).toHaveBeenCalledWith(expect.any(String), 'workbench.selection_changed', {
    scopeFingerprint: modelSelectionScopeFingerprint(scopeA),
    previousModelFingerprint: fingerprint(taskA),
    selectedModelFingerprint: fingerprint(taskB),
    persist: false,
  })
  act(() => hook.result.current.setSelectionForScope(scopeB, models[1]!, {}, taskB))
  expect(logModelLoading).toHaveBeenCalledWith(expect.any(String), 'workbench.selection_seeded', {
    scopeFingerprint: modelSelectionScopeFingerprint(scopeB),
    selectedModelFingerprint: fingerprint(taskB),
    persist: false,
  })
  expect(onSelectionChange).not.toHaveBeenCalled()
  expect(JSON.stringify(hook.result.current.modelSelectionDiagnostics)).not.toContain(
    'SYNTHETIC_SECRET'
  )
  for (const [, stage, details] of vi.mocked(logModelLoading).mock.calls) {
    if (!stage.startsWith('workbench.selection_')) continue
    expect(
      Object.values(details ?? {}).every(value => ['number', 'boolean'].includes(typeof value))
    ).toBe(true)
  }
  hook.unmount()
})
