import { describe, expect, test } from 'vitest'
import type { LocalTaskSummary, RuntimeDeviceWorkspace, RuntimeWorkListResponse } from '@/types/api'
import { buildTrayMenuTaskGroups } from './trayMenuState'
import { parseTrayTaskMenuId } from './trayTaskMenuId'

function task(overrides: Partial<LocalTaskSummary>): LocalTaskSummary {
  return {
    localTaskId: 'task',
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
    localTasks: [],
    ...overrides,
  }
}

function runtimeWork(overrides: Partial<RuntimeWorkListResponse>): RuntimeWorkListResponse {
  return {
    projects: [],
    chats: [],
    totalLocalTasks: 0,
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
              localTasks: [
                task({
                  localTaskId: 'old',
                  title: 'Older task',
                  updatedAt: '2026-01-01T00:00:00Z',
                }),
                task({
                  localTaskId: 'running',
                  title: 'Running task',
                  updatedAt: '2026-01-04T00:00:00Z',
                  running: true,
                }),
                task({
                  localTaskId: 'pinned',
                  title: 'Pinned task',
                  updatedAt: '2026-01-03T00:00:00Z',
                  pinned: true,
                } as LocalTaskSummary),
              ],
            }),
          ],
          totalLocalTasks: 3,
        },
      ],
      chats: [
        workspace({
          label: 'Chat Project',
          deviceId: 'device-b',
          workspacePath: '/workspace/chats/chat-1',
          workspaceKind: 'chat',
          localTasks: [
            task({
              localTaskId: 'chat',
              workspacePath: '/workspace/chats/chat-1',
              workspaceKind: 'chat',
              title: 'Chat task',
              updatedAt: '2026-01-05T00:00:00Z',
            }),
          ],
        }),
      ],
      totalLocalTasks: 4,
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
        localTaskId: 'running',
      },
    ])
  })

  test('deduplicates tasks that appear in multiple runtime work sections', () => {
    const sharedWorkspace = workspace({
      deviceId: 'device-b',
      workspacePath: '/workspace/chats/chat-1',
      workspaceKind: 'chat',
      localTasks: [
        task({
          localTaskId: 'chat',
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
            totalLocalTasks: 1,
          },
        ],
        chats: [sharedWorkspace],
        totalLocalTasks: 1,
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
                localTasks: [1, 2, 3, 4].map(index =>
                  task({
                    localTaskId: `pinned-${index}`,
                    title: `Pinned ${index}`,
                    updatedAt: `2026-01-0${index}T00:00:00Z`,
                    pinned: true,
                  } as LocalTaskSummary)
                ),
              }),
            ],
            totalLocalTasks: 4,
          },
        ],
        totalLocalTasks: 4,
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
