import { beforeEach, describe, expect, test } from 'vitest'
import {
  clearWorkbenchWorkspaceLaunch,
  consumeWorkbenchWorkspaceLaunch,
  queueWorkbenchWorkspaceLaunch,
} from './workspaceLaunchRequest'

describe('workspaceLaunchRequest', () => {
  beforeEach(() => {
    clearWorkbenchWorkspaceLaunch()
  })

  test('consumes a matching workspace launch once', () => {
    const options = {
      initialInput: 'Develop this Wework plugin: ',
      rightSidebarTab: { type: 'wework-plugin-developer.debug' },
    }
    queueWorkbenchWorkspaceLaunch('device-1', '/workspace/plugin/', options)

    expect(consumeWorkbenchWorkspaceLaunch('device-1', '/workspace/plugin')).toEqual(options)
    expect(consumeWorkbenchWorkspaceLaunch('device-1', '/workspace/plugin')).toBeNull()
  })

  test('keeps the launch pending until its workspace becomes active', () => {
    queueWorkbenchWorkspaceLaunch('device-1', '/workspace/plugin', {
      initialInput: 'Develop this Wework plugin: ',
    })

    expect(consumeWorkbenchWorkspaceLaunch('device-2', '/workspace/plugin')).toBeNull()
    expect(consumeWorkbenchWorkspaceLaunch('device-1', '/workspace/other')).toBeNull()
    expect(consumeWorkbenchWorkspaceLaunch('device-1', '/workspace/plugin')).not.toBeNull()
  })
})
