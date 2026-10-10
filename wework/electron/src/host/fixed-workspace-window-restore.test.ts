import { describe, expect, test } from 'vitest'
import { fixedWorkspaceWindowDescriptors } from './fixed-workspace-window-restore.js'

describe('fixedWorkspaceWindowDescriptors', () => {
  test('restores assigned fixed tabs in stable workspace windows', () => {
    expect(
      fixedWorkspaceWindowDescriptors({
        fixedWorkspaceTabs: [
          {
            id: 'board-project-1',
            kind: 'board',
            title: 'Product planning',
            contentRoute: '/todo?projectId=project-1',
            windowLabel: 'workspace-board-project-1',
          },
          {
            id: 'research',
            kind: 'smart_app',
            title: 'Research',
            installationId: 'research desk',
            windowLabel: 'workspace-research',
          },
          {
            id: 'main-task',
            kind: 'task',
            title: 'Tasks',
          },
        ],
      })
    ).toEqual([
      {
        label: 'workspace-board-project-1',
        route:
          '/todo?projectId=project-1&workspaceTab=board-project-1&workspaceTabTitle=Product+planning',
        title: 'Product planning',
      },
      {
        label: 'workspace-research',
        route: '/app/harness-research%20desk?workspaceTab=research&workspaceTabTitle=Research',
        title: 'Research',
      },
    ])
  })

  test('ignores invalid window assignments', () => {
    expect(
      fixedWorkspaceWindowDescriptors({
        fixedWorkspaceTabs: [
          {
            id: 'plugins',
            kind: 'auxiliary',
            title: 'Plugins',
            contentRoute: '/plugins',
            windowLabel: '../invalid',
          },
        ],
      })
    ).toEqual([])
  })
})
