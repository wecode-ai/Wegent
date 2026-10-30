import { describe, expect, test, vi } from 'vitest'
import {
  BACKGROUND_TIMER_THROTTLING_SWITCH,
  applyWorkbenchBackgroundPolicy,
  workbenchBackgroundThrottling,
} from './window-background-policy.js'

function commandLine() {
  return { appendSwitch: vi.fn() }
}

describe('workbench background policy', () => {
  test('keeps per-window throttling on platforms without the Windows input-window defect', () => {
    expect(workbenchBackgroundThrottling('darwin')).toBe(false)
    expect(workbenchBackgroundThrottling('linux')).toBe(false)
  })

  test('keeps the default visibility lifecycle on Windows', () => {
    expect(workbenchBackgroundThrottling('win32')).toBe(true)
  })

  test('disables only background timer throttling on Windows', () => {
    const switches = commandLine()
    applyWorkbenchBackgroundPolicy('win32', switches)
    expect(switches.appendSwitch).toHaveBeenCalledExactlyOnceWith(
      BACKGROUND_TIMER_THROTTLING_SWITCH
    )
  })

  test('leaves Chromium command-line switches untouched elsewhere', () => {
    const switches = commandLine()
    applyWorkbenchBackgroundPolicy('darwin', switches)
    expect(switches.appendSwitch).not.toHaveBeenCalled()
  })
})
