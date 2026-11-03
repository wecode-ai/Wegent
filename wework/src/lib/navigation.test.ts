import { afterEach, describe, expect, test } from 'vitest'
import { buildRuntimeTaskRoute, parseRuntimeTaskRoute, resolveDesktopAppRoute } from './navigation'

afterEach(() => {
  window.history.replaceState({}, '', '/')
})

describe('runtime task navigation', () => {
  test('round-trips cloud Issue execution authorization context', () => {
    const route = buildRuntimeTaskRoute({
      deviceId: 'cloud-device',
      taskId: 'runtime-1',
      issueExecution: { projectId: 'cloud-project', issueId: 'issue-1' },
      projectSession: { projectId: 'cloud-project', issueId: 'issue-1' },
    })

    expect(parseRuntimeTaskRoute('/runtime-tasks', route.slice(route.indexOf('?')))).toEqual({
      deviceId: 'cloud-device',
      taskId: 'runtime-1',
      issueExecution: { projectId: 'cloud-project', issueId: 'issue-1' },
      projectSession: { projectId: 'cloud-project', issueId: 'issue-1' },
    })
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
