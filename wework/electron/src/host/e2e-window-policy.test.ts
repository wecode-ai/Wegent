import { describe, expect, test } from 'vitest'
import { desktopE2EWindowOptions, keepDesktopE2EInBackground } from './e2e-window-policy.js'

describe('desktopE2EWindowOptions', () => {
  const environment = {
    VITE_WEWORK_E2E: 'true',
    WEWORK_E2E_CONTROL_URL: 'http://127.0.0.1:31337',
  }

  test('allows explicit native fixture sizes beyond the macOS display', () => {
    expect(desktopE2EWindowOptions(environment, 'darwin')).toEqual({
      enableLargerThanScreen: true,
    })
  })

  test.each(['linux', 'win32'] as const)('retains native sizing defaults on %s', platform => {
    expect(desktopE2EWindowOptions(environment, platform)).toEqual({})
  })

  test.each([
    {},
    { ...environment, VITE_WEWORK_E2E: undefined },
    { ...environment, VITE_WEWORK_E2E: 'false' },
    { ...environment, WEWORK_E2E_CONTROL_URL: undefined },
    { ...environment, WEWORK_E2E_CONTROL_URL: ' ' },
  ])('retains ordinary macOS sizing without a complete E2E environment: %j', value => {
    expect(desktopE2EWindowOptions(value, 'darwin')).toEqual({})
  })
})

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
