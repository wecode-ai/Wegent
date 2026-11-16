import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import * as runtimeEnvironment from '@/lib/runtime-environment'
import { installWeworkAutomationBridge } from './automation'
import * as clipboard from './clipboard'
import * as harnessDiagnostics from './local-harness-diagnostics'
import * as runtimeConfig from './runtime-config'

const originalBufferSizeDescriptor = Object.getOwnPropertyDescriptor(
  performance,
  'setResourceTimingBufferSize'
)
const setResourceTimingBufferSize = vi.fn()
const fetch = vi.fn()

beforeEach(() => {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  vi.stubEnv('VITE_WEWORK_E2E_CLOUD_BACKEND_URL', '')
  vi.stubEnv('VITE_WEWORK_E2E_MODEL_SERVER_URL', '')
  vi.stubGlobal('fetch', fetch.mockReset())
  Object.defineProperty(performance, 'setResourceTimingBufferSize', {
    configurable: true,
    value: setResourceTimingBufferSize.mockReset(),
  })
  vi.spyOn(runtimeEnvironment, 'isDesktopRuntime').mockReturnValue(true)
  vi.spyOn(runtimeConfig, 'getDesktopE2ERuntimeConfig').mockReturnValue({})
  vi.spyOn(runtimeConfig, 'loadDesktopE2ERuntimeConfig').mockResolvedValue(undefined)
  vi.spyOn(clipboard, 'installDesktopE2EClipboard').mockImplementation(() => {})
  vi.spyOn(harnessDiagnostics, 'installLocalHarnessDiagnostics').mockImplementation(() => {})
})

afterEach(() => {
  delete window.__WEWORK_E2E__
  if (originalBufferSizeDescriptor) {
    Object.defineProperty(performance, 'setResourceTimingBufferSize', originalBufferSizeDescriptor)
  } else {
    Reflect.deleteProperty(performance, 'setResourceTimingBufferSize')
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

test('retains resource timings before runtime initialization and a blocked seed', async () => {
  const runtimeReady = Promise.withResolvers<void>()
  const beforeSeed = Promise.withResolvers<void>()
  const bridgeReady = Promise.withResolvers<void>()
  const loadRuntime = vi
    .mocked(runtimeConfig.loadDesktopE2ERuntimeConfig)
    .mockReturnValue(runtimeReady.promise)
  vi.mocked(clipboard.installDesktopE2EClipboard).mockImplementation(() => {
    bridgeReady.resolve()
  })
  let completed = false
  const installation = installWeworkAutomationBridge(beforeSeed.promise).then(() => {
    completed = true
  })

  try {
    expect(setResourceTimingBufferSize).toHaveBeenCalledExactlyOnceWith(10_000)
    expect(loadRuntime).toHaveBeenCalledOnce()
    expect(setResourceTimingBufferSize.mock.invocationCallOrder[0]).toBeLessThan(
      loadRuntime.mock.invocationCallOrder[0]
    )
    expect(clipboard.installDesktopE2EClipboard).not.toHaveBeenCalled()

    runtimeReady.resolve()
    await Promise.race([bridgeReady.promise, installation])
    expect(window.__WEWORK_E2E__).toBeDefined()
    expect(completed).toBe(false)
    expect(setResourceTimingBufferSize).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()

    beforeSeed.resolve()
    await installation
    expect(completed).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    runtimeReady.resolve()
    beforeSeed.resolve()
    await installation
  }
})

test('does not change resource timing capacity or initialize disabled automation', async () => {
  vi.mocked(runtimeConfig.getDesktopE2ERuntimeConfig).mockReturnValue({ disabled: true })

  await installWeworkAutomationBridge()

  expect(setResourceTimingBufferSize).not.toHaveBeenCalled()
  expect(runtimeConfig.loadDesktopE2ERuntimeConfig).not.toHaveBeenCalled()
  expect(clipboard.installDesktopE2EClipboard).not.toHaveBeenCalled()
  expect(harnessDiagnostics.installLocalHarnessDiagnostics).not.toHaveBeenCalled()
  expect(window.__WEWORK_E2E__).toBeUndefined()
  expect(fetch).not.toHaveBeenCalled()
})
