import { describe, expect, test, vi } from 'vitest'
import { updateAppPreferences } from '@/desktop/appPreferences'
import {
  fixedWorkspaceTabPreference,
  fixedWorkspaceWindowLabel,
  fixedWorkspaceTabsPatch,
  saveFixedWorkspaceTabs,
} from './fixedWorkspaceTabs'

vi.mock('@/desktop/appPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('@/desktop/appPreferences')>()
  return {
    ...actual,
    updateAppPreferences: vi.fn().mockResolvedValue(actual.defaultAppPreferences),
  }
})

describe('fixedWorkspaceTabs', () => {
  test('converts every workspace tab kind into a persistent fixed-tab preference', () => {
    expect(
      fixedWorkspaceTabPreference({
        id: 'task-1',
        kind: 'task',
        title: 'Current task',
        contentRoute: '/runtime-tasks?taskId=1',
        fixed: false,
      })
    ).toEqual({
      id: 'task-1',
      kind: 'task',
      title: 'Current task',
      contentRoute: '/runtime-tasks?taskId=1',
    })

    expect(
      fixedWorkspaceTabPreference({
        id: 'workspace-1',
        kind: 'auxiliary',
        title: 'Plugins',
        contentRoute: '/plugins',
        fixed: false,
      })
    ).toEqual({
      id: 'workspace-1',
      kind: 'auxiliary',
      title: 'Plugins',
      contentRoute: '/plugins',
    })
  })

  test('preserves Smart app launch metadata when pinning its workbench tab', () => {
    expect(
      fixedWorkspaceTabPreference({
        id: 'research-tab',
        kind: 'auxiliary',
        title: 'Research',
        contentRoute: '/app/harness-research%20desk?view=main',
        fixed: false,
      })
    ).toEqual({
      id: 'research-tab',
      kind: 'smart_app',
      installationId: 'research desk',
      title: 'Research',
    })
  })

  test('uses the same startup-tab correction for settings and context-menu updates', async () => {
    const fixedWorkspaceTabs = [
      {
        id: 'workspace-1',
        kind: 'auxiliary' as const,
        title: 'Plugins',
        contentRoute: '/plugins',
      },
    ]

    expect(fixedWorkspaceTabsPatch(fixedWorkspaceTabs, 'removed-tab')).toEqual({
      fixedWorkspaceTabs,
      startupWorkspaceTabId: 'workspace-1',
    })

    await saveFixedWorkspaceTabs(fixedWorkspaceTabs, 'removed-tab')

    expect(updateAppPreferences).toHaveBeenCalledWith({
      fixedWorkspaceTabs,
      startupWorkspaceTabId: 'workspace-1',
    })
    expect(fixedWorkspaceTabsPatch([], 'workspace-1')).toEqual({
      fixedWorkspaceTabs: [],
      startupWorkspaceTabId: '',
    })
  })

  test('creates a host-safe stable workspace window label', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001')

    expect(fixedWorkspaceWindowLabel('smart app:/research')).toBe(
      'workspace-smart-app--research-00000000-0000-4000-8000-000000000001'
    )
  })
})
