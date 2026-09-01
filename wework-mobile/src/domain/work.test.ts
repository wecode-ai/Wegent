import { describe, expect, it } from 'vitest'

import type { RuntimeWorkListResponse } from '@/types/runtime'
import { runtimeTaskKey } from './runtimeTaskLifecycle'
import { flattenConversations, runtimeWorkContainsTask } from './work'

describe('flattenConversations', () => {
  it('combines project and standalone chats in update order', () => {
    const work: RuntimeWorkListResponse = {
      totalTasks: 2,
      projects: [
        {
          project: { key: 'p1', name: 'Wegent' },
          deviceWorkspaces: [
            {
              deviceId: 'cloud-1',
              deviceName: 'Cloud Mac',
              deviceStatus: 'online',
              available: true,
              workspacePath: '/work/wegent',
              tasks: [
                {
                  taskId: 'old',
                  title: '旧会话',
                  runtime: 'codex',
                  workspacePath: '/work/wegent',
                  updatedAt: '2026-08-29T10:00:00Z',
                },
              ],
            },
          ],
        },
      ],
      chats: [
        {
          deviceId: 'cloud-1',
          deviceName: 'Cloud Mac',
          deviceStatus: 'online',
          available: true,
          workspacePath: 'chat://cloud-1',
          workspaceKind: 'chat',
          tasks: [
            {
              taskId: 'new',
              title: '新会话',
              runtime: 'codex',
              workspacePath: 'chat://cloud-1',
              updatedAt: '2026-08-30T10:00:00Z',
            },
          ],
        },
      ],
    }

    const result = flattenConversations(work)

    expect(result.map(item => item.address.taskId)).toEqual(['new', 'old'])
    expect(result[1]?.projectName).toBe('Wegent')
  })

  it('uses the lifecycle projection instead of a stale work running flag', () => {
    const work: RuntimeWorkListResponse = {
      totalTasks: 1,
      projects: [],
      chats: [
        {
          deviceId: 'cloud-1',
          deviceName: 'Cloud Mac',
          deviceStatus: 'online',
          available: true,
          workspacePath: 'chat://cloud-1',
          tasks: [
            {
              taskId: 'task-1',
              title: '已完成会话',
              runtime: 'codex',
              workspacePath: 'chat://cloud-1',
              running: true,
            },
          ],
        },
      ],
    }
    const address = { deviceId: 'cloud-1', taskId: 'task-1' }

    const result = flattenConversations(work, new Map([[runtimeTaskKey(address), false]]))

    expect(result[0]?.running).toBe(false)
  })

  it('matches task identity by both device and task id', () => {
    const work: RuntimeWorkListResponse = {
      totalTasks: 1,
      projects: [],
      chats: [
        {
          deviceId: 'cloud-1',
          deviceName: 'Cloud Mac',
          deviceStatus: 'online',
          available: true,
          workspacePath: 'chat://cloud-1',
          tasks: [
            {
              taskId: 'task-1',
              title: '会话',
              runtime: 'codex',
              workspacePath: 'chat://cloud-1',
            },
          ],
        },
      ],
    }

    expect(runtimeWorkContainsTask(work, { deviceId: 'cloud-1', taskId: 'task-1' })).toBe(true)
    expect(runtimeWorkContainsTask(work, { deviceId: 'cloud-2', taskId: 'task-1' })).toBe(false)
  })
})
