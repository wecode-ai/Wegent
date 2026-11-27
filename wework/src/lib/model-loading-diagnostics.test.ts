// @vitest-environment node

import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
let diagnostics: typeof import('./model-loading-diagnostics')
const runtime = vi.hoisted(() => ({ electron: true }))

vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: vi.fn() }))
vi.mock('./runtime-environment', () => ({ isElectronRuntime: () => runtime.electron }))

beforeEach(async () => {
  vi.useFakeTimers()
  runtime.electron = true
  vi.resetModules()
  vi.mocked(invokeDesktopHost).mockReset().mockResolvedValue(undefined)
  diagnostics = await import('./model-loading-diagnostics')
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

test('records E2E selection transitions synchronously without depending on host batching', () => {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  runtime.electron = false
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  diagnostics.logModelLoading('trace', 'workbench.selection_restored', {
    scopeFingerprint: 12,
    configuredModelFingerprint: 34,
    restoredModelFingerprint: 56,
    selectedModelFingerprint: 56,
  })

  expect(log).toHaveBeenCalledTimes(1)
  const entry = JSON.parse(log.mock.calls[0][1])
  expect(entry).toMatchObject({
    stage: 'e2e-model-selection',
    modelLoadingStage: 'workbench.selection_restored',
    traceId: 'trace',
    scopeFingerprint: 12,
    configuredModelFingerprint: 34,
    restoredModelFingerprint: 56,
    selectedModelFingerprint: 56,
  })
  expect(invokeDesktopHost).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

test('keeps E2E selection logging out of ordinary builds and unrelated catalog timings', () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  diagnostics.logModelLoading('trace', 'workbench.selection_changed', { persistSelection: true })
  expect(log).not.toHaveBeenCalled()

  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  diagnostics.logModelLoading('trace', 'catalog.models.finished', { elapsedMs: 42 })
  expect(log).not.toHaveBeenCalled()
})
