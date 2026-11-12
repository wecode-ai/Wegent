import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ModelSelectionConfig, RuntimeTaskSummary, UnifiedModel } from '@/types/api'
import { runtimeTaskBindingAddress } from '@/features/todo/runtimeTaskBindingAddress'
import { useRuntimeTaskModelSelection } from './useRuntimeTaskModelSelection'

const selection: ModelSelectionConfig = {
  modelName: 'deepseek-v4-pro-responses(公网)',
  modelType: 'public',
  options: {
    weworkCloudModelNamespace: 'default',
    weworkCloudModelResourceUserId: '0',
    weworkCloudModelCodexCatalogModelId: 'wework-deepseek-v4-pro',
  },
}
const address = runtimeTaskBindingAddress({
  device_id: 'remote-device',
  task_id: 'codex-queue-85',
  modelSelection: selection,
})

function modelStore(models: UnifiedModel[]) {
  return {
    models,
    selectedModelByScope: {} as Record<string, UnifiedModel | null>,
    selectedModelOptionsByScope: {},
    hasSelectionForScope: vi.fn().mockReturnValue(false),
    getSelectedModelForScope: vi.fn().mockReturnValue(null),
    getSelectedModelOptionsForScope: vi.fn().mockReturnValue({}),
    setSelectionForScope: vi.fn(),
    setSelectedModelForScope: vi.fn(),
    setSelectedModelAndOptionsForScope: vi.fn(),
    setSelectedModelOptionForScope: vi.fn(),
  }
}

describe('bound remote task model selection', () => {
  it('reads provider switch capability from the owning runtime task without inheriting another task', () => {
    const task = {
      modelSelection: selection,
      runtimeHandle: { modelProviderRouting: 'thread' },
    } as RuntimeTaskSummary
    const { result } = renderHook(() =>
      useRuntimeTaskModelSelection({
        userId: 7,
        resolveTask: current => (current.taskId === address.taskId ? task : null),
        modelStore: modelStore([]),
      })
    )
    expect(
      result.current.resolveRuntimeTaskModelSelection(address).supportsModelProviderSwitch
    ).toBe(true)
    expect(
      result.current.resolveRuntimeTaskModelSelection({ ...address, taskId: 'legacy' })
        .supportsModelProviderSwitch
    ).toBeUndefined()
  })

  it('uses the persisted model before the remote task list and model catalog are available', () => {
    const store = modelStore([])
    const { result } = renderHook(() =>
      useRuntimeTaskModelSelection({ userId: 7, resolveTask: () => null, modelStore: store })
    )

    expect(result.current.resolveRuntimeTaskModelSelection(address)).toMatchObject({
      selectionResolved: true,
      selectionReady: false,
      taskSelection: selection,
      selectedModelOptions: selection.options,
      activeModel: {
        name: selection.modelName,
        type: 'public',
        namespace: 'default',
        resourceUserId: 0,
      },
      selectedModel: { name: selection.modelName, type: 'public' },
    })
  })

  it('keeps a loaded task without a model selection authoritative over a stale handle', () => {
    const store = modelStore([])
    const { result } = renderHook(() =>
      useRuntimeTaskModelSelection({
        userId: 7,
        resolveTask: target =>
          target.taskId === address.taskId
            ? {
                taskId: target.taskId,
                workspacePath: '/workspace',
                title: 'Native task',
                runtime: 'codex',
                running: false,
                modelSelection: null,
              }
            : null,
        modelStore: store,
      })
    )

    expect(result.current.resolveRuntimeTaskModelSelection(address)).toMatchObject({
      selectionResolved: true,
      taskSelection: null,
      selectedModel: null,
    })
  })

  it('reports an unresolved conversation instead of inventing a model', () => {
    const store = modelStore([])
    const { result } = renderHook(() =>
      useRuntimeTaskModelSelection({ userId: 7, resolveTask: () => null, modelStore: store })
    )

    expect(
      result.current.resolveRuntimeTaskModelSelection({
        deviceId: 'remote-device',
        taskId: 'runtime-1',
      })
    ).toMatchObject({
      selectionResolved: false,
      selectionReady: false,
      taskSelection: null,
      selectedModel: null,
      selectedModelOptions: {},
    })
  })

  it('treats a model chosen in the pane as resolved before the task summary arrives', () => {
    const store = modelStore([{ name: 'picked-model', type: 'runtime', provider: 'local' }])
    store.hasSelectionForScope.mockReturnValue(true)
    store.getSelectedModelForScope.mockReturnValue({
      name: 'picked-model',
      type: 'runtime',
      provider: 'local',
    })
    const { result } = renderHook(() =>
      useRuntimeTaskModelSelection({ userId: 7, resolveTask: () => null, modelStore: store })
    )

    expect(
      result.current.resolveRuntimeTaskModelSelection({
        deviceId: 'remote-device',
        taskId: 'runtime-3',
      })
    ).toMatchObject({
      selectionResolved: true,
      selectionReady: true,
      selectedModel: { name: 'picked-model' },
    })
  })

  it('reads a picked model from the synchronous store before React commits the state update', () => {
    const store = modelStore([{ name: 'picked-model', type: 'runtime', provider: 'local' }])
    store.selectedModelByScope['user:7:runtime:remote-device:runtime-4'] = {
      name: 'previous-model',
      type: 'runtime',
      provider: 'local',
    }
    store.hasSelectionForScope.mockReturnValue(true)
    store.getSelectedModelForScope.mockReturnValue({
      name: 'picked-model',
      type: 'runtime',
      provider: 'local',
    })
    const { result } = renderHook(() =>
      useRuntimeTaskModelSelection({ userId: 7, resolveTask: () => null, modelStore: store })
    )

    expect(
      result.current.resolveRuntimeTaskModelSelection({
        deviceId: 'remote-device',
        taskId: 'runtime-4',
      }).selectedModel
    ).toMatchObject({ name: 'picked-model' })
  })

  it('falls back to the saved task model when the pane selection has no model', () => {
    const savedSelection: ModelSelectionConfig = {
      modelName: 'saved-model',
      modelType: 'runtime',
      options: { collaborationMode: 'default' },
    }
    const savedAddress = { deviceId: 'remote-device', taskId: 'runtime-7' }
    const store = modelStore([{ name: 'saved-model', type: 'runtime', provider: 'local' }])
    store.hasSelectionForScope.mockReturnValue(true)
    store.getSelectedModelForScope.mockReturnValue(null)
    store.getSelectedModelOptionsForScope.mockReturnValue({ collaborationMode: 'plan' })
    const { result } = renderHook(() =>
      useRuntimeTaskModelSelection({
        userId: 7,
        resolveTask: target =>
          target.taskId === savedAddress.taskId
            ? {
                taskId: target.taskId,
                workspacePath: '/workspace',
                title: 'Saved model',
                runtime: 'codex',
                running: false,
                modelSelection: savedSelection,
              }
            : null,
        modelStore: store,
      })
    )

    expect(result.current.resolveRuntimeTaskModelSelection(savedAddress)).toMatchObject({
      selectionResolved: true,
      selectionReady: true,
      selectedModel: { name: 'saved-model' },
      selectedModelOptions: { collaborationMode: 'plan' },
    })
  })

  it('does not report a compatibility-disabled scoped model as sendable', () => {
    const store = modelStore([
      {
        name: 'disabled-model',
        type: 'runtime',
        provider: 'local',
        compatibilityDisabled: true,
      },
    ])
    store.hasSelectionForScope.mockReturnValue(true)
    store.getSelectedModelForScope.mockReturnValue({
      name: 'disabled-model',
      type: 'runtime',
      provider: 'local',
    })
    const { result } = renderHook(() =>
      useRuntimeTaskModelSelection({ userId: 7, resolveTask: () => null, modelStore: store })
    )

    expect(
      result.current.resolveRuntimeTaskModelSelection({
        deviceId: 'remote-device',
        taskId: 'runtime-8',
      })
    ).toMatchObject({
      selectionResolved: true,
      selectionReady: false,
      selectedModel: { name: 'disabled-model' },
    })
  })

  it('does not report a compatibility-disabled saved task model as sendable', () => {
    const disabledAddress = { deviceId: 'remote-device', taskId: 'runtime-9' }
    const store = modelStore([
      {
        name: 'disabled-model',
        type: 'runtime',
        provider: 'local',
        compatibilityDisabled: true,
      },
    ])
    const { result } = renderHook(() =>
      useRuntimeTaskModelSelection({
        userId: 7,
        resolveTask: target =>
          target.taskId === disabledAddress.taskId
            ? {
                taskId: target.taskId,
                workspacePath: '/workspace',
                title: 'Disabled model',
                runtime: 'codex',
                running: false,
                modelSelection: { modelName: 'disabled-model', modelType: 'runtime' },
              }
            : null,
        modelStore: store,
      })
    )

    expect(result.current.resolveRuntimeTaskModelSelection(disabledAddress)).toMatchObject({
      selectionResolved: true,
      selectionReady: false,
      selectedModel: { name: 'disabled-model' },
    })
  })

  it('treats a loaded task without a Wework model as resolved to the native default', () => {
    const store = modelStore([])
    const unresolvedAddress = { deviceId: 'remote-device', taskId: 'runtime-2' }
    const { result } = renderHook(() =>
      useRuntimeTaskModelSelection({
        userId: 7,
        resolveTask: target =>
          target.taskId === unresolvedAddress.taskId
            ? {
                taskId: target.taskId,
                workspacePath: '/workspace',
                title: 'Legacy task',
                runtime: 'codex',
                running: false,
              }
            : null,
        modelStore: store,
      })
    )

    expect(result.current.resolveRuntimeTaskModelSelection(unresolvedAddress)).toMatchObject({
      selectionResolved: true,
      selectionReady: false,
      taskSelection: null,
      selectedModel: null,
    })
  })

  it('uses a shared catalog model for a selectionless conversation without borrowing another pane', () => {
    const store = modelStore([
      { name: 'catalog-default-model', type: 'runtime', provider: 'local' },
    ])
    const selectionlessAddress = { deviceId: 'remote-device', taskId: 'runtime-6' }
    const { result } = renderHook(() =>
      useRuntimeTaskModelSelection({
        userId: 7,
        resolveTask: target =>
          target.taskId === selectionlessAddress.taskId
            ? {
                taskId: target.taskId,
                workspacePath: '/workspace',
                title: 'Restored task',
                runtime: 'codex',
                running: false,
              }
            : null,
        modelStore: store,
      })
    )

    expect(result.current.resolveRuntimeTaskModelSelection(selectionlessAddress)).toMatchObject({
      selectionResolved: true,
      selectionReady: true,
      taskSelection: null,
      selectedModel: { name: 'catalog-default-model' },
    })
  })

  it('keeps a deleted task model recoverable without allowing a send', () => {
    const store = modelStore([])
    const deletedAddress = { deviceId: 'remote-device', taskId: 'runtime-5' }
    const { result } = renderHook(() =>
      useRuntimeTaskModelSelection({
        userId: 7,
        resolveTask: target =>
          target.taskId === deletedAddress.taskId
            ? {
                taskId: target.taskId,
                workspacePath: '/workspace',
                title: 'Deleted model',
                runtime: 'codex',
                running: false,
                modelSelection: { modelName: 'local-model:deleted', modelType: 'runtime' },
              }
            : null,
        modelStore: store,
      })
    )

    expect(result.current.resolveRuntimeTaskModelSelection(deletedAddress)).toMatchObject({
      selectionResolved: true,
      selectionReady: false,
      selectedModel: { name: 'local-model:deleted' },
    })
  })

  it('does not substitute another catalog model and retains the task model when editing an option', () => {
    const store = modelStore([
      { name: 'gpt-6-astra', displayName: 'GPT-6 Astra', type: 'runtime', provider: 'local' },
    ])
    const { result } = renderHook(() =>
      useRuntimeTaskModelSelection({ userId: 7, resolveTask: () => null, modelStore: store })
    )

    result.current.setRuntimeTaskSelectedModelOption(address, 'reasoning', 'high')

    expect(store.setSelectionForScope).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ name: selection.modelName, type: 'public' }),
      selection.options,
      selection
    )
    expect(store.setSelectedModelOptionForScope).toHaveBeenCalledWith(
      expect.any(String),
      'reasoning',
      'high'
    )
  })
})
