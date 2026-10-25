import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  buildRuntimeTaskRoute,
  navigateTo,
  parseRuntimeTaskRoute,
  replaceTo,
  resolveDesktopAppRoute,
  WORKSPACE_NAVIGATION_EVENT,
} from './navigation'

afterEach(() => {
  window.history.replaceState({}, '', '/')
})

describe('browser navigation', () => {
  test.each([
    ['/', 'task'],
    ['/runtime-tasks?deviceId=device&taskId=completed', 'task'],
    ['/todo?projectId=one', 'board'],
    ['/app/wegent', 'agent'],
  ])('delegates %s to workspace navigation', (route, kind) => {
    const navigate = vi.fn((event: Event) => event.preventDefault())
    window.addEventListener(WORKSPACE_NAVIGATION_EVENT, navigate)
    const before = window.location.href

    navigateTo(route)

    expect(navigate).toHaveBeenCalledOnce()
    expect((navigate.mock.calls[0][0] as CustomEvent).detail).toEqual({ kind, contentRoute: route })
    expect(window.location.href).toBe(before)
    window.removeEventListener(WORKSPACE_NAVIGATION_EVENT, navigate)
  })

  test.each(['/settings/connections', '/login', '/todo?workspaceTab=explicit'])(
    'keeps direct location navigation for %s',
    route => {
      const navigate = vi.fn()
      window.addEventListener(WORKSPACE_NAVIGATION_EVENT, navigate)
      navigateTo(route)
      expect(navigate).not.toHaveBeenCalled()
      expect(`${window.location.pathname}${window.location.search}`).toBe(route)
      window.removeEventListener(WORKSPACE_NAVIGATION_EVENT, navigate)
    }
  )

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

  test('round-trips local Issue execution context without cloud session routing', () => {
    const route = buildRuntimeTaskRoute({
      deviceId: 'local-device',
      taskId: 'runtime-1',
      issueExecution: { projectId: 'local-project', issueId: 'issue-1' },
    })

    expect(route).toBe(
      '/runtime-tasks?deviceId=local-device&taskId=runtime-1&issueProjectId=local-project&issueId=issue-1'
    )
    expect(parseRuntimeTaskRoute('/runtime-tasks', route.slice(route.indexOf('?')))).toEqual({
      deviceId: 'local-device',
      taskId: 'runtime-1',
      issueExecution: { projectId: 'local-project', issueId: 'issue-1' },
    })
  })

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
