import { beforeEach, describe, expect, test } from 'vitest'
import {
  buildRuntimeTaskTitle,
  MAX_RUNTIME_TASK_TITLE_LENGTH,
  projectTaskAddresses,
  readLastProjectId,
  removeRuntimeTasks,
  truncateRuntimeTaskTitle,
  writeLastProjectId,
} from './workbenchRuntimeHelpers'
import type { RuntimeWorkListResponse } from '@/types/api'

describe('workbenchRuntimeHelpers', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  test('builds readable titles from structured plugin mentions', () => {
    expect(buildRuntimeTaskTitle('[$linear](/tmp/linear/SKILL.md) ')).toBe('$linear')
    expect(buildRuntimeTaskTitle('Use [$calendar](app://calendar) today')).toBe(
      'Use $calendar today'
    )
    expect(buildRuntimeTaskTitle('Ask [@sample](plugin://sample@local) to help')).toBe(
      'Ask @sample to help'
    )
  })

  test('removes leading plugin mentions from task titles', () => {
    expect(buildRuntimeTaskTitle('[$Sites](plugin://sites) 创建一个 OKR 网站')).toBe(
      '创建一个 OKR 网站'
    )
    expect(
      buildRuntimeTaskTitle(
        '[$Sites](plugin://sites) [@designer](plugin://designer) Build a portal'
      )
    ).toBe('Build a portal')
  })

  test('limits runtime task titles for compact display and terminal context', () => {
    const title = 'a'.repeat(MAX_RUNTIME_TASK_TITLE_LENGTH + 1)

    expect(truncateRuntimeTaskTitle(title)).toBe(
      `${'a'.repeat(MAX_RUNTIME_TASK_TITLE_LENGTH - 1)}…`
    )
    expect(buildRuntimeTaskTitle(title)).toBe(`${'a'.repeat(MAX_RUNTIME_TASK_TITLE_LENGTH - 1)}…`)
  })

  test('carries runtime handles into project task addresses', () => {
    const runtimeWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: { key: 'legacy:7', id: 7, name: 'Wegent' },
          totalTasks: 1,
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'device-1',
              deviceName: 'Project Device',
              deviceStatus: 'online',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: true,
              tasks: [
                {
                  taskId: 'local-visible-task',
                  threadId: 'direct-thread-id',
                  workspacePath: '/workspace/project-alpha',
                  title: 'Fix guidance',
                  runtime: 'codex',
                  runtimeHandle: {
                    threadId: '019ee7f6-456a-78a1-96b1-66451afc310e',
                  },
                },
              ],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 1,
    }

    expect(projectTaskAddresses(runtimeWork, ['legacy:7'])).toEqual([
      {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'local-visible-task',
        threadId: 'direct-thread-id',
        runtimeHandle: {
          threadId: '019ee7f6-456a-78a1-96b1-66451afc310e',
        },
      },
    ])
  })

  test('removes an archived device task even when its workspace path was normalized', () => {
    const runtimeWork: RuntimeWorkListResponse = {
      projects: [],
      chats: [
        {
          deviceId: 'device-1',
          workspacePath: '/home/user/Documents/Codex/task',
          available: true,
          tasks: [
            {
              taskId: 'standalone-chat',
              workspacePath: '/home/user/Documents/Codex/task',
              title: 'Standalone chat',
              runtime: 'codex',
            },
          ],
        },
      ],
      totalTasks: 1,
    }

    expect(
      removeRuntimeTasks(runtimeWork, [
        {
          deviceId: 'device-1',
          taskId: 'standalone-chat',
          workspacePath: '/workspace/repository',
        },
      ]).totalTasks
    ).toBe(0)
  })

  test('stores the last project per user and ignores invalid values', () => {
    writeLastProjectId(7, 42)

    expect(readLastProjectId(7)).toBe(42)
    expect(readLastProjectId(8)).toBeUndefined()

    writeLastProjectId(7, null)
    expect(readLastProjectId(7)).toBeNull()

    localStorage.setItem('wework.lastProjectId.7', 'not-a-project')
    expect(readLastProjectId(7)).toBeUndefined()
  })
})
