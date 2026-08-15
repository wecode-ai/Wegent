import { describe, expect, test } from 'vitest'
import type { RuntimeTaskReminderItem } from './runtimeTaskReminders'
import { getVisibleRuntimeTaskUnreadKeys } from './runtimeTaskReminders'

function reminderItem(key: string): RuntimeTaskReminderItem {
  return {
    key,
    address: { deviceId: 'device-1', taskId: key },
    task: {
      taskId: key,
      workspacePath: '/workspace/repo',
      title: key,
      runtime: 'codex',
    },
    workspace: {
      deviceId: 'device-1',
      available: true,
      workspacePath: '/workspace/repo',
      tasks: [],
    },
    projectName: 'Project',
  }
}

describe('getVisibleRuntimeTaskUnreadKeys', () => {
  test('excludes unread lifecycle entries that no longer exist in runtime work', () => {
    expect(
      getVisibleRuntimeTaskUnreadKeys([reminderItem('visible')], new Set(['visible', 'removed']))
    ).toEqual(new Set(['visible']))
  })
})
