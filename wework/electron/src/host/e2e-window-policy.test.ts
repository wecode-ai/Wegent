import { describe, expect, test } from 'vitest'
import { keepDesktopE2EInBackground } from './e2e-window-policy.js'

describe('keepDesktopE2EInBackground', () => {
  test.each(['1', 'true', 'TRUE', 'yes', 'YES'])(
    'enables the macOS background policy for %s',
    value => {
      expect(keepDesktopE2EInBackground({ WEWORK_E2E_BACKGROUND_WINDOW: value }, 'darwin')).toBe(
        true
      )
    }
  )

  test.each([undefined, '', '0', 'false', 'no'])(
    'keeps ordinary macOS launches interactive for %s',
    value => {
      expect(keepDesktopE2EInBackground({ WEWORK_E2E_BACKGROUND_WINDOW: value }, 'darwin')).toBe(
        false
      )
    }
  )

  test('does not apply the macOS policy on other platforms', () => {
    expect(keepDesktopE2EInBackground({ WEWORK_E2E_BACKGROUND_WINDOW: '1' }, 'linux')).toBe(false)
  })
})
