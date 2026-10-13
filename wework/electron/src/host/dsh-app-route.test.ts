import { describe, expect, test } from 'vitest'
import { resolveDshAppRoute } from './dsh-app-route.js'

describe('resolveDshAppRoute', () => {
  test.each([
    ['http://127.0.0.1:8000', 'popout'],
    ['http://127.0.0.1:8000/', '/popout'],
  ])('routes auxiliary windows through the Wework DSH app', (baseUrl, route) => {
    expect(resolveDshAppRoute(baseUrl, route).toString()).toBe(
      'http://127.0.0.1:8000/wework/app/popout'
    )
  })

  test('removes stale query and hash values from the base URL', () => {
    expect(
      resolveDshAppRoute('http://127.0.0.1:8000/?old=value#section', 'system-drag').toString()
    ).toBe('http://127.0.0.1:8000/wework/app/system-drag')
  })

  test('preserves content query and hash when routing through the Wework app', () => {
    expect(
      resolveDshAppRoute(
        'http://127.0.0.1:8000/?old=value#stale',
        '/todo?projectId=project-1&workspaceTab=board-1#activity'
      ).toString()
    ).toBe(
      'http://127.0.0.1:8000/wework/app/todo?projectId=project-1&workspaceTab=board-1#activity'
    )
  })
})
