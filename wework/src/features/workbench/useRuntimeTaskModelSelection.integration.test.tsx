import { renderHook, waitFor } from '@testing-library/react'
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
  traceModelLoading: (_trace: string, stage: () => Promise<unknown>) => stage(),
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
