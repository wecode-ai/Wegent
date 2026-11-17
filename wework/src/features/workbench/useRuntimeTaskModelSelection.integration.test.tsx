import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ModelApi } from '@/api/models'
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

function renderTaskModelSelection(api: ModelApi, taskSelection: ModelSelectionConfig) {
  const task = { modelSelection: taskSelection } as RuntimeTaskSummary
  return renderHook(
    ({ activeAddress }) => {
      const modelStore = useWorkbenchModels({
        api,
        locked: false,
        scopeKey: `user:7:runtime:${activeAddress.deviceId}:${activeAddress.taskId}`,
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
          resolveActiveTaskSelectionReady: current =>
            current.taskId === activeAddress.taskId ? modelStore.isSelectionReady : null,
        }),
      }
    },
    { initialProps: { activeAddress: address } }
  )
}

describe('task model selection over the workbench model store', () => {
  it.each(['active', 'background'])(
    'keeps an unsent deleted model choice invalid for the %s task instead of restoring its sent model',
    async target => {
      const sentModel: UnifiedModel = { name: 'local-model:sent-b', type: 'runtime' }
      const pickedModel: UnifiedModel = { name: 'local-model:unsent-c', type: 'runtime' }
      const taskSelection: ModelSelectionConfig = {
        modelName: sentModel.name,
        modelType: sentModel.type,
      }
      const targetAddress = target === 'active' ? address : { ...address, taskId: 'task-b' }
      const api = { listModels: vi.fn().mockResolvedValue({ data: [sentModel, pickedModel] }) }
      const { result, rerender } = renderTaskModelSelection(api, taskSelection)
      await waitFor(() => expect(result.current.modelStore.isSelectionReady).toBe(true))
      act(() =>
        result.current.selection.setRuntimeTaskSelectedModelAndOptions(targetAddress, pickedModel, {
          permissionMode: 'read-only',
        })
      )
      expect(
        result.current.selection.resolveRuntimeTaskModelSelection(targetAddress)
      ).toMatchObject({
        selectionReady: true,
        selectedModel: pickedModel,
        selectedModelOptions: { permissionMode: 'read-only' },
      })

      api.listModels.mockResolvedValue({ data: [sentModel] })
      act(() => result.current.modelStore.refreshModels())
      await waitFor(() => expect(result.current.modelStore.isLoading).toBe(false))

      expect(
        result.current.selection.resolveRuntimeTaskModelSelection(targetAddress)
      ).toMatchObject({
        selectionResolved: true,
        selectionReady: false,
        selectedModel: { name: pickedModel.name },
        selectedModelOptions: { permissionMode: 'read-only' },
      })
      if (target === 'active') {
        expect(result.current.modelStore.isSelectionReady).toBe(false)
      }
      act(() => result.current.modelStore.refreshModels())
      await waitFor(() => expect(result.current.modelStore.isLoading).toBe(false))
      act(() =>
        result.current.selection.setRuntimeTaskSelectedModelOption(
          targetAddress,
          'permissionMode',
          'workspace-write'
        )
      )
      rerender({ activeAddress: { ...address, taskId: 'task-other' } })
      rerender({ activeAddress: targetAddress })
      await act(async () => undefined)
      expect(result.current.modelStore.selectedModel).toMatchObject({ name: pickedModel.name })
      expect(result.current.modelStore.selectedModelAvailable).toBe(false)
      expect(result.current.modelStore.isSelectionReady).toBe(false)
      expect(
        result.current.selection.resolveRuntimeTaskModelSelection(targetAddress)
      ).toMatchObject({
        selectionReady: false,
        selectedModel: { name: pickedModel.name },
        selectedModelOptions: { permissionMode: 'workspace-write' },
      })
      act(() => result.current.selection.setRuntimeTaskSelectedModel(targetAddress, sentModel))
      expect(
        result.current.selection.resolveRuntimeTaskModelSelection(targetAddress)
      ).toMatchObject({
        selectionReady: true,
        selectedModel: sentModel,
      })
    }
  )

  it('keeps choices through failed refreshes and recovers when the chosen model returns', async () => {
    const sentModel: UnifiedModel = { name: 'local-model:sent', type: 'runtime' }
    const pickedModel: UnifiedModel = { name: 'local-model:picked', type: 'runtime' }
    const api = { listModels: vi.fn().mockResolvedValue({ data: [sentModel, pickedModel] }) }
    const { result } = renderTaskModelSelection(api, {
      modelName: sentModel.name,
      modelType: sentModel.type,
    })
    await waitFor(() => expect(result.current.modelStore.isSelectionReady).toBe(true))
    act(() => result.current.selection.setRuntimeTaskSelectedModel(address, pickedModel))
    const error = new Error('catalog offline')
    api.listModels.mockRejectedValueOnce(error)
    act(() => result.current.modelStore.refreshModels())
    await waitFor(() => expect(result.current.modelStore.isLoading).toBe(false))
    expect(result.current.modelStore.error).toBe(error)
    expect(result.current.selection.resolveRuntimeTaskModelSelection(address)).toMatchObject({
      selectionReady: true,
      selectedModel: pickedModel,
    })

    api.listModels.mockResolvedValue({ data: [sentModel] })
    act(() => result.current.modelStore.refreshModels())
    await waitFor(() => expect(result.current.modelStore.isLoading).toBe(false))
    expect(result.current.selection.resolveRuntimeTaskModelSelection(address)).toMatchObject({
      selectionReady: false,
      selectedModel: pickedModel,
    })

    api.listModels.mockResolvedValue({ data: [sentModel, { ...pickedModel }] })
    act(() => result.current.modelStore.refreshModels())
    await waitFor(() => expect(result.current.modelStore.isSelectionReady).toBe(true))
    expect(result.current.selection.resolveRuntimeTaskModelSelection(address)).toMatchObject({
      selectionReady: true,
      selectedModel: pickedModel,
    })
    expect(result.current.modelStore.error).toBeNull()
  })

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
    expect(result.current.modelStore.getSelectedModelForScope(scopeKey)).toEqual(localModel)
    expect(result.current.modelStore.getSelectedModelAvailabilityForScope(scopeKey)).toBe(false)
    expect(result.current.modelStore.getSelectedModelForScope(backgroundScope)).toEqual(localModel)
    expect(result.current.modelStore.getSelectedModelAvailabilityForScope(backgroundScope)).toBe(
      false
    )
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
    expect(result.current.modelStore.getSelectedModelForScope(backgroundScope)).toEqual(localModel)
    expect(result.current.modelStore.getSelectedModelAvailabilityForScope(backgroundScope)).toBe(
      false
    )

    act(() => result.current.selection.setRuntimeTaskSelectedModel(backgroundAddress, visibleModel))
    expect(
      result.current.selection.resolveRuntimeTaskModelSelection(backgroundAddress)
    ).toMatchObject({
      selectionReady: true,
      selectedModel: visibleModel,
    })
  })

  it.each(['active', 'background'])(
    'keeps a model picked for the %s task while an older catalog request is in flight',
    async target => {
      const localModel: UnifiedModel = { name: 'local-model:original', type: 'runtime' }
      const pickedModel: UnifiedModel = { name: 'local-model:new', type: 'runtime' }
      const api = { listModels: vi.fn().mockResolvedValue({ data: [localModel] }) }
      const { result } = renderTaskModelSelection(api, {
        modelName: localModel.name,
        modelType: localModel.type,
      })
      const targetAddress = target === 'active' ? address : { ...address, taskId: 'task-b' }
      await waitFor(() => expect(result.current.modelStore.isSelectionReady).toBe(true))
      let finishLoad!: (response: { data: UnifiedModel[] }) => void
      api.listModels.mockReturnValueOnce(
        new Promise(resolve => {
          finishLoad = resolve
        })
      )
      act(() => result.current.modelStore.refreshModels())
      act(() => result.current.selection.setRuntimeTaskSelectedModel(targetAddress, pickedModel))

      await act(async () => finishLoad({ data: [localModel] }))

      expect(
        result.current.selection.resolveRuntimeTaskModelSelection(targetAddress)
      ).toMatchObject({
        selectionReady: true,
        selectedModel: pickedModel,
      })
      if (target === 'active') {
        expect(result.current.modelStore.selectedModel).toEqual(pickedModel)
        expect(result.current.modelStore.selectedModelAvailable).toBe(true)
        expect(result.current.modelStore.isSelectionReady).toBe(true)
      }

      act(() => result.current.modelStore.refreshModels())
      await waitFor(() => expect(result.current.modelStore.isLoading).toBe(false))
      expect(
        result.current.selection.resolveRuntimeTaskModelSelection(targetAddress)
      ).toMatchObject({
        selectionReady: false,
        selectedModel: pickedModel,
      })
    }
  )

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
