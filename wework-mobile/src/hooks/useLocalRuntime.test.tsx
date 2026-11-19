import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLocalRuntime } from './useLocalRuntime'
import type { LocalRuntimeStatus } from '@/services/localRuntime'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  select: vi.fn(),
  foreground: (_state: string) => {},
  native: {
    getStatusAsync: vi.fn(),
    startAsync: vi.fn(),
    stopAsync: vi.fn(),
    listProfilesAsync: vi.fn(),
    addListener: vi.fn(() => ({ remove: vi.fn() })),
    getEventsAsync: vi.fn(),
    requestAsync: vi.fn(),
  },
}))
vi.mock('expo', () => ({ requireOptionalNativeModule: () => mocks.native }))
vi.mock('@/services/phoneLocalProfile', () => ({
  loadPhoneLocalProfile: mocks.load,
  selectPhoneLocalProfile: mocks.select,
  LocalProfileSelectionRequired: class extends Error {},
}))
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_name: string, callback: typeof mocks.foreground) => {
      mocks.foreground = callback
      return { remove: vi.fn() }
    },
  },
}))
const scope = 'a'.repeat(64)
const running: LocalRuntimeStatus = {
  supported: true,
  state: 'running',
  generation: 1,
  accountScope: scope,
  deviceId: `mobile-local:phone:${scope}`,
  background: 'notRequested',
}
describe('local capability startup isolation', () => {
  let state: ReturnType<typeof useLocalRuntime>
  let renderer: ReactTestRenderer
  function Harness() {
    state = useLocalRuntime()
    return null
  }
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.load.mockReset().mockResolvedValue(scope)
    mocks.select.mockReset().mockResolvedValue(undefined)
    mocks.native.getStatusAsync.mockReset().mockResolvedValue(running)
    mocks.native.startAsync.mockReset().mockResolvedValue(running)
    mocks.native.stopAsync.mockReset().mockResolvedValue(undefined)
    mocks.native.listProfilesAsync
      .mockReset()
      .mockResolvedValue([{ accountScope: scope, modifiedAt: 1000 }])
    mocks.native.getEventsAsync.mockReset().mockResolvedValue({ events: [], latestSequence: 0 })
  })
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
  })
  it('keeps a failed profile capability recoverable without blocking app rendering', async () => {
    mocks.load.mockRejectedValueOnce(new Error('keychain locked'))
    await act(() => {
      renderer = create(<Harness />)
    })
    expect(state!.runtime).toBeNull()
    expect(state!.error).toEqual(new Error('keychain locked'))
    expect(mocks.native.startAsync).not.toHaveBeenCalled()
    await act(async () => state!.retry())
    expect(state!.status.state).toBe('running')
    expect(state!.error).toBeNull()
  })
  it('subscribes to foreground recovery even when the initial start fails', async () => {
    mocks.native.startAsync.mockRejectedValueOnce(new Error('start failed'))
    await act(() => {
      renderer = create(<Harness />)
    })
    const runtime = state!.runtime
    expect(state!.error).toEqual(new Error('start failed'))
    await act(() => mocks.foreground('active'))
    expect(state!.runtime).toBe(runtime)
    expect(state!.error).toBeNull()
    expect(mocks.native.getEventsAsync).toHaveBeenCalled()
  })
  it('stops the old runtime before persisting an explicit environment switch and surfaces failures', async () => {
    await act(() => {
      renderer = create(<Harness />)
    })
    const runtime = state!.runtime
    mocks.select.mockRejectedValueOnce(new Error('keychain locked'))
    await act(async () => {
      await expect(state!.selectProfile('b'.repeat(64))).rejects.toThrow('keychain locked')
    })
    expect(mocks.native.stopAsync).toHaveBeenCalledWith({ accountScope: scope })
    expect(state!.runtime).toBe(runtime)
    expect(state!.error).toEqual(new Error('keychain locked'))
  })

  it.each(['stopped', 'failed'] as const)(
    'restores a %s executor after unlocking without resubmitting user work',
    async nativeState => {
      await act(() => {
        renderer = create(<Harness />)
      })
      const runtime = state!.runtime
      const recovered = vi.fn()
      runtime!.onRecovery(recovered)
      let current: LocalRuntimeStatus = { ...running, state: nativeState }
      mocks.native.getStatusAsync.mockImplementation(async () => current)
      mocks.native.stopAsync.mockImplementation(async () => {
        current = { ...current, state: 'stopped' }
      })
      mocks.native.startAsync.mockImplementation(async () => {
        current = { ...running, generation: 2 }
        return current
      })
      await act(() => mocks.foreground('active'))
      expect(state!.runtime).toBe(runtime)
      expect(state!.status).toMatchObject({ state: 'running', generation: 2, accountScope: scope })
      expect(mocks.native.startAsync).toHaveBeenCalledTimes(2)
      expect(recovered).toHaveBeenCalledOnce()
      expect(mocks.native.requestAsync).not.toHaveBeenCalled()
    }
  )
})
