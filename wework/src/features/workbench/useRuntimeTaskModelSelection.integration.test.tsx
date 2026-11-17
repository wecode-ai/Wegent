import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type {
  ModelSelectionConfig,
  RuntimeTaskAddress,
  RuntimeTaskSummary,
  UnifiedModel,
} from '@/types/api'
import { useRuntimeTaskModelSelection } from './useRuntimeTaskModelSelection'
import { useWorkbenchModels } from './useWorkbenchModels'

vi.mock('@/lib/model-loading-diagnostics', () => ({
  logModelLoading: vi.fn(),
  observeModelLoadingMainThread: () => () => undefined,
  traceModelLoading: (_trace: string, _event: string, stage: () => Promise<unknown>) => stage(),
}))

const hiddenSelection: ModelSelectionConfig = {
  modelName: 'hidden-public-model',
  modelType: 'public',
  options: {
    weworkCloudModelNamespace: 'default',
    weworkCloudModelResourceUserId: '0',
  },
}
const hiddenModel: UnifiedModel = {
  name: 'hidden-public-model',
  type: 'public',
  provider: 'cloud',
  namespace: 'default',
  resourceUserId: 0,
}
const visibleModel: UnifiedModel = {
  name: 'visible-public-model',
  type: 'public',
  provider: 'cloud',
  namespace: 'default',
  resourceUserId: 0,
}
const address: RuntimeTaskAddress = { deviceId: 'device', taskId: 'task-a' }
const scopeKey = 'user:7:runtime:device:task-a'

describe('task model selection over the workbench model store', () => {
  it('blocks a cached local task model after catalog deletion and allows a replacement', async () => {
    const localModel: UnifiedModel = {
      name: 'local-model:deleted',
      type: 'runtime',
      provider: 'local',
    }
    const taskSelection: ModelSelectionConfig = {
      modelName: localModel.name,
      modelType: localModel.type,
    }
    const task = { modelSelection: taskSelection } as RuntimeTaskSummary
    const api = {
      listModels: vi.fn().mockResolvedValue({ data: [localModel, visibleModel] }),
    }
    const { result } = renderHook(() => {
      const modelStore = useWorkbenchModels({
        api,
        locked: false,
        scopeKey,
        selectionConfig: taskSelection,
        persistSelection: false,
        fallbackWhenConfiguredModelUnavailable: false,
      })
      const selection = useRuntimeTaskModelSelection({
        userId: 7,
        resolveTask: () => task,
        modelStore,
        resolveActiveTaskSelectionReady: target =>
          target.taskId === address.taskId ? modelStore.isSelectionReady : null,
      })
      return { modelStore, selection }
    })

    await waitFor(() => expect(result.current.modelStore.isSelectionReady).toBe(true))
    expect(result.current.modelStore.getSelectedModelForScope(scopeKey)).toEqual(localModel)
    expect(result.current.selection.resolveRuntimeTaskModelSelection(address).selectionReady).toBe(
      true
    )
    const backgroundAddress = { ...address, taskId: 'task-b' }
    const backgroundScope = 'user:7:runtime:device:task-b'
    act(() => result.current.modelStore.setSelectionForScope(backgroundScope, localModel))

    api.listModels.mockResolvedValue({ data: [visibleModel] })
    act(() => result.current.modelStore.refreshModels())

    await waitFor(() => expect(result.current.modelStore.models).toEqual([visibleModel]))
    expect(result.current.modelStore.isSelectionReady).toBe(false)
    expect(result.current.modelStore.getSelectedModelForScope(scopeKey)).toBeNull()
    expect(result.current.modelStore.getSelectedModelForScope(backgroundScope)).toBeNull()
    expect(result.current.selection.resolveRuntimeTaskModelSelection(address)).toMatchObject({
      selectionResolved: true,
      selectionReady: false,
      selectedModel: { name: localModel.name },
    })
    expect(
      result.current.selection.resolveRuntimeTaskModelSelection(backgroundAddress).selectionReady
    ).toBe(false)

    act(() => result.current.selection.setRuntimeTaskSelectedModel(address, visibleModel))
    expect(result.current.selection.resolveRuntimeTaskModelSelection(address)).toMatchObject({
      selectionReady: true,
      selectedModel: visibleModel,
    })
  })

  it('blocks a background task model seeded by an option edit during catalog refresh', async () => {
    const localModel: UnifiedModel = { name: 'local-model:deleted', type: 'runtime' }
    const taskSelection: ModelSelectionConfig = {
      modelName: localModel.name,
      modelType: localModel.type,
    }
    const task = { modelSelection: taskSelection } as RuntimeTaskSummary
    const backgroundAddress = { ...address, taskId: 'task-b' }
    const backgroundScope = 'user:7:runtime:device:task-b'
    const api = { listModels: vi.fn().mockResolvedValue({ data: [localModel, visibleModel] }) }
    const { result } = renderHook(() => {
      const modelStore = useWorkbenchModels({
        api,
        locked: false,
        scopeKey,
        selectionConfig: taskSelection,
        persistSelection: false,
        fallbackWhenConfiguredModelUnavailable: false,
      })
      return {
        modelStore,
        selection: useRuntimeTaskModelSelection({
          userId: 7,
          resolveTask: () => task,
          modelStore,
          resolveActiveTaskSelectionReady: target =>
            target.taskId === address.taskId ? modelStore.isSelectionReady : null,
        }),
      }
    })
    await waitFor(() => expect(result.current.modelStore.isSelectionReady).toBe(true))
    expect(result.current.modelStore.hasSelectionForScope(backgroundScope)).toBe(false)
    let finishLoad!: (response: { data: UnifiedModel[] }) => void
    api.listModels.mockReturnValueOnce(
      new Promise(resolve => {
        finishLoad = resolve
      })
    )
    act(() => result.current.modelStore.refreshModels())
    expect(result.current.modelStore.isLoading).toBe(true)
    act(() =>
      result.current.selection.setRuntimeTaskSelectedModelOption(
        backgroundAddress,
        'collaborationMode',
        'plan'
      )
    )
    expect(result.current.modelStore.getSelectedModelForScope(backgroundScope)).toEqual(localModel)

    await act(async () => finishLoad({ data: [visibleModel] }))

    expect(result.current.modelStore.models).toEqual([visibleModel])
    expect(
      result.current.selection.resolveRuntimeTaskModelSelection(backgroundAddress)
    ).toMatchObject({
      selectionResolved: true,
      selectionReady: false,
      selectedModel: { name: localModel.name },
      selectedModelOptions: { collaborationMode: 'plan' },
    })
    expect(result.current.modelStore.getSelectedModelForScope(backgroundScope)).toBeNull()

    act(() => result.current.selection.setRuntimeTaskSelectedModel(backgroundAddress, visibleModel))
    expect(
      result.current.selection.resolveRuntimeTaskModelSelection(backgroundAddress)
    ).toMatchObject({
      selectionReady: true,
      selectedModel: visibleModel,
    })
  })

  it('keeps a model picked while an older catalog request is in flight', async () => {
    const localModel: UnifiedModel = { name: 'local-model:original', type: 'runtime' }
    const pickedModel: UnifiedModel = { name: 'local-model:new', type: 'runtime' }
    const taskSelection: ModelSelectionConfig = {
      modelName: localModel.name,
      modelType: localModel.type,
    }
    const task = { modelSelection: taskSelection } as RuntimeTaskSummary
    const api = { listModels: vi.fn().mockResolvedValue({ data: [localModel] }) }
    const { result } = renderHook(() => {
      const modelStore = useWorkbenchModels({
        api,
        locked: false,
        scopeKey,
        selectionConfig: taskSelection,
        persistSelection: false,
        fallbackWhenConfiguredModelUnavailable: false,
      })
      return {
        modelStore,
        selection: useRuntimeTaskModelSelection({
          userId: 7,
          resolveTask: () => task,
          modelStore,
          resolveActiveTaskSelectionReady: () => modelStore.isSelectionReady,
        }),
      }
    })
    await waitFor(() => expect(result.current.modelStore.isSelectionReady).toBe(true))
    let finishLoad!: (response: { data: UnifiedModel[] }) => void
    api.listModels.mockReturnValueOnce(
      new Promise(resolve => {
        finishLoad = resolve
      })
    )
    act(() => result.current.modelStore.refreshModels())
    act(() => result.current.selection.setRuntimeTaskSelectedModel(address, pickedModel))

    await act(async () => finishLoad({ data: [localModel] }))

    expect(result.current.modelStore.getSelectedModelForScope(scopeKey)).toEqual(pickedModel)
    expect(result.current.selection.resolveRuntimeTaskModelSelection(address)).toMatchObject({
      selectionReady: true,
      selectedModel: pickedModel,
    })
  })

  it('stays sendable when the provider restores a hidden persisted cloud model', async () => {
    const api = {
      listModels: vi.fn().mockResolvedValue({ data: [visibleModel] }),
      getModel: vi.fn().mockResolvedValue(hiddenModel),
    }
    const task = { modelSelection: hiddenSelection } as RuntimeTaskSummary
    const { result } = renderHook(() => {
      const modelStore = useWorkbenchModels({
        api,
        locked: false,
        scopeKey,
        selectionConfig: hiddenSelection,
        persistSelection: false,
        fallbackWhenConfiguredModelUnavailable: false,
      })
      const selection = useRuntimeTaskModelSelection({
        userId: 7,
        resolveTask: () => task,
        modelStore,
      })
      return { modelStore, selection }
    })

    await waitFor(() => expect(result.current.modelStore.selectedModel).toEqual(hiddenModel))
    await waitFor(() =>
      expect(
        result.current.selection.resolveRuntimeTaskModelSelection(address).selectionReady
      ).toBe(true)
    )
    expect(api.getModel).toHaveBeenCalledWith('hidden-public-model', 'public', 'wework', 'llm')
  })
})
