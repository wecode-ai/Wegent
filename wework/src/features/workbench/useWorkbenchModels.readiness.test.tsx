import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { UnifiedModel } from '@/types/api'
import { useWorkbenchModels } from './useWorkbenchModels'

test('distinguishes restored default settings from an available model', async () => {
  const replacement: UnifiedModel = { name: 'replacement', type: 'public' }
  const api = { listModels: vi.fn().mockResolvedValue({ data: [] }) }
  const { result } = renderHook(() =>
    useWorkbenchModels({ api, locked: false, persistSelection: false })
  )

  await waitFor(() => expect(api.listModels).toHaveBeenCalledOnce())
  await waitFor(() => expect(result.current.isLoading).toBe(false))
  expect(result.current.selectedModel).toBeNull()
  await waitFor(() => expect(result.current.isSelectionReady).toBe(true))
  expect(result.current.selectedModelAvailable).toBe(false)

  api.listModels.mockResolvedValue({ data: [replacement] })
  act(() => result.current.refreshModels())
  await waitFor(() => expect(result.current.models).toEqual([replacement]))
  act(() => result.current.setSelectedModel(replacement))
  expect(result.current.isSelectionReady).toBe(true)
  expect(result.current.selectedModelAvailable).toBe(true)
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
  expect(api.listModels).not.toHaveBeenCalled()
  hook.rerender({ enabled: true })
  await waitFor(() => expect(api.listModels).toHaveBeenCalledOnce())
  expect(hook.result.current.isSelectionReady).toBe(false)

  await act(async () => finishLoad({ data: [model] }))
  await waitFor(() => expect(hook.result.current.isSelectionReady).toBe(true))
  expect(hook.result.current.selectedModel).toEqual(model)
})
