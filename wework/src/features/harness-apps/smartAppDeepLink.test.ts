import { describe, expect, test } from 'vitest'
import { parseSmartAppOpenRoute, smartAppDeepLink, smartAppOpenRoute } from './smartAppDeepLink'

describe('Smart app deep links', () => {
  test('builds the external link and internal open route', () => {
    expect(smartAppDeepLink(42)).toBe('wework://smart-app/42')
    expect(smartAppOpenRoute(42)).toBe('/sites?app_type=smart_app&action=open&smartAppId=42')
    expect(parseSmartAppOpenRoute('?app_type=smart_app&action=open&smartAppId=42')).toEqual({
      smartAppId: 42,
    })
    expect(parseSmartAppOpenRoute('?app_type=smart_app&smartAppId=42')).toBeNull()
  })
})
