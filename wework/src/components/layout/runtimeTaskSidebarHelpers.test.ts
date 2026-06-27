import { describe, expect, test } from 'vitest'
import type { RuntimeDeviceWorkspace } from '@/types/api'
import { getRuntimeSidebarTaskItems } from './runtimeTaskSidebarHelpers'

describe('runtimeTaskSidebarHelpers', () => {
  test('keeps runtime task items in workspace order', () => {
    const workspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/repo',
      available: true,
      localTasks: [
        {
          localTaskId: 'older-running',
          workspacePath: '/workspace/repo',
          title: 'Older running',
          runtime: 'codex',
          running: true,
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
        {
          localTaskId: 'newer-idle',
          workspacePath: '/workspace/repo',
          title: 'Newer idle',
          runtime: 'codex',
          running: false,
          updatedAt: '2026-06-02T00:00:00.000Z',
        },
      ],
    }

    expect(getRuntimeSidebarTaskItems([workspace]).map(item => item.task.localTaskId)).toEqual([
      'older-running',
      'newer-idle',
    ])
  })
})
