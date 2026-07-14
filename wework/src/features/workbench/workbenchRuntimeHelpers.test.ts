import { describe, expect, test } from 'vitest'
import {
  buildRuntimeTaskTitle,
  MAX_RUNTIME_TASK_TITLE_LENGTH,
  projectTaskAddresses,
  truncateRuntimeTaskTitle,
} from './workbenchRuntimeHelpers'
import type { RuntimeWorkListResponse } from '@/types/api'

describe('workbenchRuntimeHelpers', () => {
  test('builds readable titles from structured plugin mentions', () => {
    expect(buildRuntimeTaskTitle('[$linear](/tmp/linear/SKILL.md) ')).toBe('$linear')
    expect(buildRuntimeTaskTitle('Use [$calendar](app://calendar) today')).toBe(
      'Use $calendar today'
    )
    expect(buildRuntimeTaskTitle('Ask [@sample](plugin://sample@local) to help')).toBe(
      'Ask @sample to help'
    )
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
        runtimeHandle: {
          threadId: '019ee7f6-456a-78a1-96b1-66451afc310e',
        },
      },
    ])
  })
})
