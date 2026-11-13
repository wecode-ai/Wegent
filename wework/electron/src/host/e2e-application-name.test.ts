import { describe, expect, test } from 'vitest'
import { desktopE2EApplicationName } from './e2e-application-name.js'

describe('native credential identity for independently signed desktop fixtures', () => {
  const environment = {
    VITE_WEWORK_E2E: 'true',
    WEWORK_E2E_CONTROL_URL: 'http://127.0.0.1:31337',
    WEWORK_APP_IDENTIFIER: 'io.wecode.wework.e2e.run10232',
  }

  test('separates OS credential services even though the product name is shared', () => {
    const first = desktopE2EApplicationName('WeWork', environment, 'darwin')
    const second = desktopE2EApplicationName(
      'WeWork',
      { ...environment, WEWORK_APP_IDENTIFIER: 'io.wecode.wework.e2e.run10231' },
      'darwin'
    )
    expect(`${first} Safe Storage`).not.toBe(`${second} Safe Storage`)
    expect(first).not.toBe('WeWork')
  })

  test('retains the same identity when the isolated app restarts', () => {
    expect(desktopE2EApplicationName('WeWork', { ...environment }, 'darwin')).toBe(
      desktopE2EApplicationName('WeWork', environment, 'darwin')
    )
  })

  test('keeps delivered release identities for exact-package and cross-version verification', () => {
    expect(
      desktopE2EApplicationName(
        'WeWork Beta',
        { ...environment, WEWORK_E2E_REQUIRE_RELEASE_PACKAGE: '1' },
        'darwin'
      )
    ).toBe('WeWork Beta')
  })

  test.each([
    {},
    { ...environment, VITE_WEWORK_E2E: undefined },
    { ...environment, WEWORK_E2E_CONTROL_URL: undefined },
    { ...environment, WEWORK_E2E_CONTROL_URL: ' ' },
    { ...environment, WEWORK_APP_IDENTIFIER: undefined },
    { ...environment, WEWORK_APP_IDENTIFIER: 'io.wecode.wework' },
    { ...environment, WEWORK_APP_IDENTIFIER: 'io.wecode.wework.e2e.run10232.other' },
  ])('preserves the normal product identity outside an isolated clone: %j', value => {
    expect(desktopE2EApplicationName('WeWork', value, 'darwin')).toBe('WeWork')
  })

  test.each(['linux', 'win32'] as const)('preserves native identity on %s', platform => {
    expect(desktopE2EApplicationName('WeWork', environment, platform)).toBe('WeWork')
  })
})
