import { describe, expect, test, vi } from 'vitest'
import {
  verifySmartAppPage,
  type SmartAppVerificationViewHandle,
} from './smart-app-verification-view.js'

describe('verifySmartAppPage', () => {
  test('loads the declared same-origin path and waits for its selector', async () => {
    const executeJavaScript = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const fixture = view({ executeJavaScript })

    const result = await verifySmartAppPage({
      baseUrl: 'http://127.0.0.1:4567/',
      path: '/ready?mode=test',
      readySelector: '[data-testid="smart-app-ready"]',
      timeoutMs: 1_000,
      pollIntervalMs: 0,
      createView: fixture.createView,
    })

    expect(result).toEqual({ issues: [] })
    expect(fixture.handle.contents.loadURL).toHaveBeenCalledWith(
      'http://127.0.0.1:4567/ready?mode=test'
    )
    expect(executeJavaScript).toHaveBeenCalledWith(
      'Boolean(document.querySelector("[data-testid=\\"smart-app-ready\\"]"))'
    )
    expect(fixture.handle.dispose).toHaveBeenCalledOnce()
  })

  test('returns stable issues for navigation, selector, and timeout failures', async () => {
    const navigation = view({ loadURL: vi.fn().mockRejectedValue(new Error('navigation failed')) })
    const invalidSelector = view({
      executeJavaScript: vi.fn().mockRejectedValue(new SyntaxError('invalid selector')),
    })
    const timeout = view({ executeJavaScript: vi.fn().mockResolvedValue(false) })

    await expect(
      verifySmartAppPage({
        ...input(),
        createView: navigation.createView,
      })
    ).resolves.toEqual({
      issues: [expect.objectContaining({ code: 'SA-RUNTIME-NAVIGATION', stage: 'runtime' })],
    })
    await expect(
      verifySmartAppPage({
        ...input(),
        createView: invalidSelector.createView,
      })
    ).resolves.toEqual({
      issues: [expect.objectContaining({ code: 'SA-RUNTIME-SELECTOR', stage: 'runtime' })],
    })
    await expect(
      verifySmartAppPage({
        ...input(),
        timeoutMs: 1,
        createView: timeout.createView,
      })
    ).resolves.toEqual({
      issues: [expect.objectContaining({ code: 'SA-RUNTIME-READY-TIMEOUT', stage: 'runtime' })],
    })
    expect(navigation.handle.dispose).toHaveBeenCalledOnce()
    expect(invalidSelector.handle.dispose).toHaveBeenCalledOnce()
    expect(timeout.handle.dispose).toHaveBeenCalledOnce()
  })

  test('rejects a runtime path that changes origin without creating a view', async () => {
    const createView = vi.fn()

    await expect(
      verifySmartAppPage({
        ...input(),
        path: '//example.test/escape',
        createView,
      })
    ).resolves.toEqual({
      issues: [expect.objectContaining({ code: 'SA-RUNTIME-PATH', stage: 'runtime' })],
    })
    expect(createView).not.toHaveBeenCalled()
  })
})

function input() {
  return {
    baseUrl: 'http://127.0.0.1:4567/',
    path: '/',
    readySelector: '[data-testid="smart-app-ready"]',
    timeoutMs: 100,
    pollIntervalMs: 0,
  }
}

function view(overrides: Partial<SmartAppVerificationViewHandle['contents']> = {}): {
  handle: SmartAppVerificationViewHandle
  createView: () => Promise<SmartAppVerificationViewHandle>
} {
  const handle: SmartAppVerificationViewHandle = {
    contents: {
      loadURL: vi.fn().mockResolvedValue(undefined),
      executeJavaScript: vi.fn().mockResolvedValue(true),
      isDestroyed: vi.fn(() => false),
      ...overrides,
    },
    dispose: vi.fn().mockResolvedValue(undefined),
  }
  return { handle, createView: async () => handle }
}
