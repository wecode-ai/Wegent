import { describe, expect, test } from 'vitest'
import type { RuntimeTaskSummary, RuntimeDeviceWorkspace, RuntimeWorkListResponse } from '@/types/api'
import { buildTrayMenuTaskGroups } from './trayMenuState'
import { parseTrayTaskMenuId } from './trayTaskMenuId'

function task(overrides: Partial<RuntimeTaskSummary>): RuntimeTaskSummary {
  return {
    taskId: 1,
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
                  taskId: 10,
                  taskId: 'old',
                  title: 'Older task',
                  updatedAt: '2026-01-01T00:00:00Z',
                }),
                task({
                  taskId: 11,
                  taskId: 'running',
                  title: 'Running task',
                  updatedAt: '2026-01-04T00:00:00Z',
                  running: true,
                }),
                task({
                  taskId: 12,
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
              taskId: 13,
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
        taskId: 11,
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
