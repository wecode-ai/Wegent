import { describe, expect, test } from 'vitest'
import type {
  RuntimeTaskSummary,
  RuntimeDeviceWorkspace,
  RuntimeWorkListResponse,
} from '@/types/api'
import { buildTrayMenuTaskGroups } from './trayMenuState'
import { parseTrayTaskMenuId } from './trayTaskMenuId'

function task(overrides: Partial<RuntimeTaskSummary>): RuntimeTaskSummary {
  return {
    taskId: 'task',
    workspacePath: '/workspace/project',
    title: 'Task',
    runtime: 'codex',
    ...overrides,
  }
}

function workspace(overrides: Partial<RuntimeDeviceWorkspace>): RuntimeDeviceWorkspace {
  return {
    deviceId: 'device-a',
    available: true,
    workspacePath: '/workspace/project',
    tasks: [],
    ...overrides,
  }
}

function runtimeWork(overrides: Partial<RuntimeWorkListResponse>): RuntimeWorkListResponse {
  return {
    projects: [],
    chats: [],
    totalTasks: 0,
    ...overrides,
  }
}

describe('buildTrayMenuTaskGroups', () => {
  test('builds running, pinned, and recent task groups from runtime work', () => {
    const work = runtimeWork({
      projects: [
        {
          project: {
            key: 'project-1',
            id: 1,
            name: 'Project 1',
          },
          deviceWorkspaces: [
            workspace({
              tasks: [
                task({
                  taskId: 'old',
                  title: 'Older task',
                  updatedAt: '2026-01-01T00:00:00Z',
                }),
                task({
                  taskId: 'running',
                  title: 'Running task',
                  updatedAt: '2026-01-04T00:00:00Z',
                  running: true,
                }),
                task({
                  taskId: 'pinned',
                  title: 'Pinned task',
                  updatedAt: '2026-01-03T00:00:00Z',
                  pinned: true,
                } as RuntimeTaskSummary),
              ],
            }),
          ],
          totalTasks: 3,
        },
      ],
      chats: [
        workspace({
          label: 'Chat Project',
          deviceId: 'device-b',
          workspacePath: '/workspace/chats/chat-1',
          workspaceKind: 'chat',
          tasks: [
            task({
              taskId: 'chat',
              workspacePath: '/workspace/chats/chat-1',
              workspaceKind: 'chat',
              title: 'Chat task',
              updatedAt: '2026-01-05T00:00:00Z',
            }),
          ],
        }),
      ],
      totalTasks: 4,
    })

    const groups = buildTrayMenuTaskGroups(work)

    expect(groups.running.map(item => item.title)).toEqual(['Running task'])
    expect(groups.running.map(item => item.projectName)).toEqual(['Project 1'])
    expect(groups.runningMore).toEqual([])
    expect(groups.pinned.map(item => item.title)).toEqual(['Pinned task'])
    expect(groups.pinned.map(item => item.projectName)).toEqual(['Project 1'])
    expect(groups.pinnedMore).toEqual([])
    expect(groups.recent.map(item => item.title)).toEqual([
      'Chat task',
      'Running task',
      'Pinned task',
    ])
    expect(groups.recent.map(item => item.projectName)).toEqual([
      'Chat Project',
      'Project 1',
      'Project 1',
    ])
    expect(groups.recentMore.map(item => item.title)).toEqual(['Older task'])
    expect(groups.running.map(item => parseTrayTaskMenuId(item.id))).toEqual([
      {
        deviceId: 'device-a',
        taskId: 'running',
      },
    ])
  })

  test('deduplicates tasks that appear in multiple runtime work sections', () => {
    const sharedWorkspace = workspace({
      deviceId: 'device-b',
      workspacePath: '/workspace/chats/chat-1',
      workspaceKind: 'chat',
      tasks: [
        task({
          taskId: 'chat',
          workspacePath: '/workspace/chats/chat-1',
          workspaceKind: 'chat',
          title: 'Chat task',
          updatedAt: '2026-01-05T00:00:00Z',
        }),
      ],
    })

    const groups = buildTrayMenuTaskGroups(
      runtimeWork({
        projects: [
          {
            project: {
              key: 'project-1',
              id: 1,
              name: 'Project 1',
            },
            deviceWorkspaces: [sharedWorkspace],
            totalTasks: 1,
          },
        ],
        chats: [sharedWorkspace],
        totalTasks: 1,
      })
    )

    expect(groups.recent).toHaveLength(1)
  })

  test('builds unread task group and status counts from reminders', () => {
    const work = runtimeWork({
      projects: [
        {
          project: {
            key: 'project-1',
            id: 1,
            name: 'Project 1',
          },
          deviceWorkspaces: [
            workspace({
              tasks: [
                task({
                  taskId: 'unread',
                  title: 'Unread task',
                  updatedAt: '2026-01-04T00:00:00Z',
                }),
                task({
                  taskId: 'running',
                  title: 'Running task',
                  updatedAt: '2026-01-05T00:00:00Z',
                  running: true,
                }),
              ],
            }),
          ],
          totalTasks: 2,
        },
      ],
      totalTasks: 2,
    })

    const groups = buildTrayMenuTaskGroups(work, {
      reminders: {
        unreadTaskKeys: new Set(['device-a\0unread']),
        unreadCount: 1,
        hasRunningTasks: true,
      },
    })

    expect(groups.unread.map(item => item.title)).toEqual(['Unread task'])
    expect(groups.unreadCount).toBe(1)
    expect(groups.hasRunningTasks).toBe(true)
    expect(groups.showRunningStatus).toBe(true)
    expect(groups.runningCount).toBe(1)
    expect(groups.activeTaskIds).toEqual(['running'])
  })

  test('hides unread and running task groups when tray status switches are off', () => {
    const work = runtimeWork({
      projects: [
        {
          project: {
            key: 'project-1',
            id: 1,
            name: 'Project 1',
          },
          deviceWorkspaces: [
            workspace({
              tasks: [
                task({
                  taskId: 'unread',
                  title: 'Unread task',
                  updatedAt: '2026-01-04T00:00:00Z',
                }),
                task({
                  taskId: 'running',
                  title: 'Running task',
                  updatedAt: '2026-01-05T00:00:00Z',
                  running: true,
                }),
              ],
            }),
          ],
          totalTasks: 2,
        },
      ],
      totalTasks: 2,
    })

    const groups = buildTrayMenuTaskGroups(work, {
      reminders: {
        unreadTaskKeys: new Set(['device-a\0unread']),
        unreadCount: 1,
        hasRunningTasks: true,
      },
      showUnread: false,
      showRunning: false,
    })

    expect(groups.unread).toEqual([])
    expect(groups.unreadCount).toBe(0)
    expect(groups.running).toEqual([])
    expect(groups.runningCount).toBe(0)
    expect(groups.activeTaskIds).toEqual(['running'])
    expect(groups.hasRunningTasks).toBe(false)
    expect(groups.showRunningStatus).toBe(false)
    expect(groups.recent.map(item => item.title)).toEqual(['Running task', 'Unread task'])
  })

  test('ignores stale reminder running state when executor tasks are idle', () => {
    const groups = buildTrayMenuTaskGroups(runtimeWork(), {
      reminders: {
        unreadTaskKeys: new Set(),
        unreadCount: 0,
        hasRunningTasks: true,
      },
    })

    expect(groups.hasRunningTasks).toBe(false)
    expect(groups.runningCount).toBe(0)
    expect(groups.activeTaskIds).toEqual([])
  })

  test('limits pinned tasks to three and reports more pinned tasks', () => {
    const groups = buildTrayMenuTaskGroups(
      runtimeWork({
        projects: [
          {
            project: {
              key: 'project-1',
              id: 1,
              name: 'Project 1',
            },
            deviceWorkspaces: [
              workspace({
                tasks: [1, 2, 3, 4].map(index =>
                  task({
                    taskId: `pinned-${index}`,
                    title: `Pinned ${index}`,
                    updatedAt: `2026-01-0${index}T00:00:00Z`,
                    pinned: true,
                  } as RuntimeTaskSummary)
                ),
              }),
            ],
            totalTasks: 4,
          },
        ],
        totalTasks: 4,
      })
    )

    expect(groups.pinned.map(item => item.title)).toEqual(['Pinned 4', 'Pinned 3', 'Pinned 2'])
    expect(groups.pinned.map(item => item.projectName)).toEqual([
      'Project 1',
      'Project 1',
      'Project 1',
    ])
    expect(groups.pinnedMore.map(item => item.title)).toEqual(['Pinned 1'])
  })
})
