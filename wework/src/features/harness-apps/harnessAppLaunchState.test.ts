import { act, renderHook } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import {
  beginHarnessAppLaunch,
  clearHarnessAppLaunch,
  failHarnessAppLaunch,
  harnessAppInstallationIdFromPath,
  updateHarnessAppLaunchPhase,
  useHarnessAppLaunchState,
} from './harnessAppLaunchState'

describe('harnessAppLaunchState', () => {
  test('publishes starting and failed state for one app tab', () => {
    const retry = vi.fn()
    const { result } = renderHook(() => useHarnessAppLaunchState('app-1'))

    act(() => beginHarnessAppLaunch('app-1', 'Example app', retry))
    expect(result.current).toMatchObject({
      installationId: 'app-1',
      title: 'Example app',
      status: 'starting',
      phase: 'preparingRuntime',
      error: null,
    })

    act(() => updateHarnessAppLaunchPhase('app-1', 'loadingApp'))
    expect(result.current).toMatchObject({
      status: 'starting',
      phase: 'loadingApp',
    })

    act(() => failHarnessAppLaunch('app-1', 'Startup failed'))
    expect(result.current).toMatchObject({
      status: 'failed',
      error: 'Startup failed',
      retry,
    })

    act(() => clearHarnessAppLaunch('app-1'))
    expect(result.current).toBeNull()
  })

  test('extracts installation IDs from Smart app routes', () => {
    expect(harnessAppInstallationIdFromPath('/app/harness-app%20one')).toBe('app one')
    expect(harnessAppInstallationIdFromPath('/app/wegent')).toBeNull()
  })

  test('can begin directly from the loading phase when reopening a running app', () => {
    const { result } = renderHook(() => useHarnessAppLaunchState('app-2'))

    act(() => beginHarnessAppLaunch('app-2', 'Example app', vi.fn(), 'loadingApp'))

    expect(result.current).toMatchObject({
      status: 'starting',
      phase: 'loadingApp',
    })
    act(() => clearHarnessAppLaunch('app-2'))
  })
})
