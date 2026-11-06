import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
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
