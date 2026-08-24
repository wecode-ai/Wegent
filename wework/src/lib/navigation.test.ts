import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  buildRuntimeTaskRoute,
  parseRuntimeTaskRoute,
  replaceTo,
  resolveDesktopAppRoute,
} from './navigation'

afterEach(() => {
  window.history.replaceState({}, '', '/')
})

describe('browser navigation', () => {
  test('notifies route subscribers after replacing the current location', () => {
    const onPopState = vi.fn()
    window.addEventListener('popstate', onPopState)

    replaceTo('/sites?app_type=smart_app')

    expect(`${window.location.pathname}${window.location.search}`).toBe('/sites?app_type=smart_app')
    expect(onPopState).toHaveBeenCalledOnce()
    window.removeEventListener('popstate', onPopState)
  })
})

describe('runtime task navigation', () => {
  test('builds runtime task routes without exposing workspace paths', () => {
    const route = buildRuntimeTaskRoute({
      deviceId: 'axb-mac.local',
      workspacePath: '/Users/axb-mac/work/Wegent github',
      taskId: '12345',
    })

    expect(route).toBe('/runtime-tasks?deviceId=axb-mac.local&taskId=12345')
    expect(route).not.toContain('workspacePath')
    expect(route).not.toContain('%2FUsers%2Faxb-mac%2Fwork%2FWegent')
  })

  test('parses runtime task routes from device and task ids only', () => {
    expect(parseRuntimeTaskRoute('/runtime-tasks', '?deviceId=axb-mac.local&taskId=12345')).toEqual(
      {
        deviceId: 'axb-mac.local',
        taskId: '12345',
      }
    )
  })
})

describe('resolveDesktopAppRoute', () => {
  test('resolves supported desktop app keys to their routes', () => {
    expect(resolveDesktopAppRoute('wework')).toBe('/')
    expect(resolveDesktopAppRoute('todo')).toBe('/todo')
    expect(resolveDesktopAppRoute('wegent')).toBe('/app/wegent')
  })

  test('falls back to the workbench for unknown desktop app keys', () => {
    expect(resolveDesktopAppRoute('apps' as never)).toBe('/')
    expect(resolveDesktopAppRoute('unknown' as never)).toBe('/')
  })
})
