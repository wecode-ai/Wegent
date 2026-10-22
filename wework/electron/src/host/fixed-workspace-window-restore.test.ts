import { describe, expect, test } from 'vitest'
import { fixedWorkspaceWindowDescriptors } from './fixed-workspace-window-restore.js'

describe('fixedWorkspaceWindowDescriptors', () => {
  test.each([
    ['task', '/wework/app/'],
    ['board', '/wework/app/todo'],
    ['agent', '/wework/app/app/wegent'],
  ])('restores the default %s route through the Wework app', (kind, pathname) => {
    const [descriptor] = fixedWorkspaceWindowDescriptors({
      fixedWorkspaceTabs: [{ id: kind, kind, windowLabel: `workspace-${kind}` }],
    })
    expect(descriptor).toEqual({
      label: `workspace-${kind}`,
      route: `${pathname}?workspaceTab=${kind}&workspaceTabTitle=${kind}`,
      title: kind,
    })
  })

  test('preserves task identity and fragment when restoring a runtime task', () => {
    const [descriptor] = fixedWorkspaceWindowDescriptors({
      fixedWorkspaceTabs: [
        {
          id: 'task-1',
          kind: 'task',
          title: 'Task',
          contentRoute: '/runtime-tasks?deviceId=local&taskId=task-1#conversation',
          windowLabel: 'workspace-task-1',
        },
      ],
    })
    expect(descriptor.route).toBe(
      '/wework/app/runtime-tasks?deviceId=local&taskId=task-1&workspaceTab=task-1&workspaceTabTitle=Task#conversation'
    )
  })

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
          '/wework/app/todo?projectId=project-1&workspaceTab=board-project-1&workspaceTabTitle=Product+planning',
        title: 'Product planning',
      },
      {
        label: 'workspace-research',
        route:
          '/wework/app/app/harness-research%20desk?workspaceTab=research&workspaceTabTitle=Research',
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

  test('skips malformed routes without blocking other workspace windows', () => {
    expect(
      fixedWorkspaceWindowDescriptors({
        fixedWorkspaceTabs: [
          {
            id: 'broken',
            kind: 'auxiliary',
            title: 'Broken',
            contentRoute: 'http://[',
            windowLabel: 'workspace-broken',
          },
          {
            id: 'plugins',
            kind: 'auxiliary',
            title: 'Plugins',
            contentRoute: '/plugins',
            windowLabel: 'workspace-plugins',
          },
        ],
      })
    ).toEqual([
      {
        label: 'workspace-plugins',
        route: '/wework/app/plugins?workspaceTab=plugins&workspaceTabTitle=Plugins',
        title: 'Plugins',
      },
    ])
  })
})
