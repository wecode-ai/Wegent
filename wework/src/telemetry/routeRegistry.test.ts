import { describe, expect, test } from 'vitest'
import { resolveTelemetryRoute } from './routeRegistry'

describe('resolveTelemetryRoute', () => {
  test.each([
    ['/sites', '?app_type=smart_app', 'smart_app_marketplace_opened'],
    ['/sites', '?view=owned&app_type=smart_app', 'smart_app_owned_opened'],
    ['/app/harness-research-desk', '', 'smart_app_opened'],
    ['/sites', '?app_type=web', null],
    ['/app/native-task', '', null],
  ])('resolves %s%s', (pathname, search, eventName) => {
    expect(resolveTelemetryRoute(pathname, search)?.name ?? null).toBe(eventName)
  })

  test('ignores unrelated query values', () => {
    expect(resolveTelemetryRoute('/sites', '?app_type=smart_app&source=sidebar')?.name).toBe(
      'smart_app_marketplace_opened'
    )
  })
})
