import { expect, test, vi } from 'vitest'

import { createDesktopScenario as createChromeScenario } from '../../e2e/desktop/scenarios/native-window-chrome.scenario.mjs'
import { createDesktopScenario as createBackgroundScenario } from '../../e2e/desktop/scenarios/window-background-policy.scenario.mjs'

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
