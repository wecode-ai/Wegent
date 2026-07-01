import { describe, expect, test } from 'vitest'
import { projectTaskAddresses } from './workbenchRuntimeHelpers'
import type { RuntimeWorkListResponse } from '@/types/api'

describe('workbenchRuntimeHelpers', () => {
  test('carries runtime handles into project task addresses', () => {
    const runtimeWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: { key: 'legacy:7', id: 7, name: 'Wegent' },
          totalLocalTasks: 1,
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
              localTasks: [
                {
                  localTaskId: 'local-visible-task',
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
      totalLocalTasks: 1,
    }

    expect(projectTaskAddresses(runtimeWork, ['legacy:7'])).toEqual([
      {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        localTaskId: 'local-visible-task',
        runtimeHandle: {
          threadId: '019ee7f6-456a-78a1-96b1-66451afc310e',
        },
      },
    ])
  })
})
