import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  dshWorkspaceTabIdFromPath,
  dshWorkspaceTabRoute,
  dshWorkspaceTabs,
} from './dshWorkspaceTabs'

describe('dshWorkspaceTabs', () => {
  beforeEach(() => {
    delete window.__WEWORK_DSH_UI__
  })

  test('round-trips DSH workspace routes', () => {
    expect(dshWorkspaceTabRoute('plugin:dashboard')).toBe('/dsh/workspace/plugin%3Adashboard')
    expect(dshWorkspaceTabIdFromPath('/dsh/workspace/plugin%3Adashboard')).toBe('plugin:dashboard')
    expect(dshWorkspaceTabIdFromPath('/dsh/workspace/')).toBeNull()
  })

  test('reads native DSH workspace slot descriptors', () => {
    const listener = vi.fn()
    const descriptor = { id: 'dashboard', label: 'Dashboard', order: 10 }
    const subscribe = vi.fn(() => () => undefined)
    window.__WEWORK_DSH_UI__ = {
      getEntries: () => [descriptor],
      subscribe,
      attach: vi.fn(),
    }

    expect(dshWorkspaceTabs.getTab('dashboard')).toEqual({
      id: 'dashboard',
      title: 'Dashboard',
      order: 10,
    })
    expect(dshWorkspaceTabs.getTabs()).toEqual([{ id: 'dashboard', title: 'Dashboard', order: 10 }])
    dshWorkspaceTabs.subscribe(listener)
    expect(subscribe).toHaveBeenCalledWith('wework.workspace.tab', listener)
  })
})
