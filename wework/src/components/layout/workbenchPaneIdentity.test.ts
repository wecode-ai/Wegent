import { describe, expect, test } from 'vitest'
import { getWorkbenchPaneKey } from './workbenchPaneIdentity'

describe('getWorkbenchPaneKey', () => {
  test('keys runtime panes by stable task identity', () => {
    expect(
      getWorkbenchPaneKey({
        currentRuntimeTask: {
          deviceId: 'device-1',
          taskId: 'task-1',
          workspacePath: '/workspace/one',
        },
        currentProject: null,
      })
    ).toBe('runtime:device-1:task-1')
  })

  test('gives each blank conversation its own mount identity', () => {
    expect(
      getWorkbenchPaneKey({
        currentRuntimeTask: null,
        currentProject: null,
        standaloneChatKey: 7,
      })
    ).toBe('blank:7')
  })
})
