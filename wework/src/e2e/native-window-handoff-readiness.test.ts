import { expect, test, vi } from 'vitest'

import { createDesktopScenario as createChromeScenario } from '../../e2e/desktop/scenarios/native-window-chrome.scenario.mjs'
import { createDesktopScenario as createBackgroundScenario } from '../../e2e/desktop/scenarios/window-background-policy.scenario.mjs'
import { reloadMainWindow } from '../../e2e/desktop/modules/workspace-flows.mjs'
import { createBarrier } from '../test/async-barrier'

test('normal reload waits for the native handoff and the replacement control client', async () => {
  const handoff = createBarrier()
  const reconnect = createBarrier()
  const reconnectRequested = createBarrier()
  const command = vi.fn((action: string) => {
    if (action === 'getStartupSplashSnapshot') {
      return handoff.promise.then(() => JSON.stringify({ state: 'closed' }))
    }
    expect(action).toBe('reloadMainWindow')
    return Promise.resolve('')
  })
  const awaitReadyAfter = vi.fn((readyCount: number) => {
    expect(readyCount).toBe(4)
    reconnectRequested.release()
    return reconnect.promise
  })
  let finished = false
  const reloading = reloadMainWindow(
    { command, readyCount: 4, awaitReadyAfter },
    'The replacement renderer did not reconnect'
  ).then(() => {
    finished = true
  })

  expect(command.mock.calls.map(([action]) => action)).toEqual(['getStartupSplashSnapshot'])
  expect(awaitReadyAfter).not.toHaveBeenCalled()
  handoff.release()
  await reconnectRequested.promise

  expect(command.mock.calls.map(([action]) => action)).toEqual([
    'getStartupSplashSnapshot',
    'reloadMainWindow',
  ])
  expect(awaitReadyAfter).toHaveBeenCalledOnce()
  expect(finished).toBe(false)
  reconnect.release()
  await reloading
  expect(finished).toBe(true)
})

test.each([
  ['native chrome', createChromeScenario, 'getNativeWindowState'],
  ['background policy', createBackgroundScenario, 'getWindowBackgroundPolicy'],
] as const)(
  '%s defers window access until the splash handoff closes',
  async (_name, createScenario, firstWindowAction) => {
    let releaseHandoff!: (snapshot: string) => void
    const handoff = new Promise<string>(resolve => {
      releaseHandoff = resolve
    })
    let closed = false
    const reachedWindow = new Error('Window lifecycle access reached')
    const command = vi.fn((action: string) => {
      if (action === 'getStartupSplashSnapshot') return handoff
      expect(closed).toBe(true)
      throw reachedWindow
    })
    const scenario = await createScenario({ captureScreenshot: vi.fn(), uiTimeoutMs: 10_000 })
    const verification = scenario.verify({ command }).catch((error: unknown) => error)

    expect(command.mock.calls.map(([action]) => action)).toEqual(['getStartupSplashSnapshot'])
    closed = true
    releaseHandoff(JSON.stringify({ state: 'closed' }))

    expect(await verification).toBe(reachedWindow)
    expect(command.mock.calls.map(([action]) => action)).toEqual([
      'getStartupSplashSnapshot',
      firstWindowAction,
    ])
  }
)
