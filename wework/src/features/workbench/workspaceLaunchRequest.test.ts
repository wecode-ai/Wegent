// @vitest-environment node

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
      initialInput:
        '[$Wework Plugin Development](plugin://wework-plugin-developer@wework-personal) Develop this Wework plugin: ',
      rightSidebarTab: { type: 'wework-plugin-developer.debug' },
    }
    queueWorkbenchWorkspaceLaunch('device-1', '/workspace/plugin/', options)

    expect(consumeWorkbenchWorkspaceLaunch('device-1', '/workspace/plugin')).toEqual(options)
    expect(consumeWorkbenchWorkspaceLaunch('device-1', '/workspace/plugin')).toBeNull()
  })

  test('keeps the launch pending until its workspace becomes active', () => {
    queueWorkbenchWorkspaceLaunch('device-1', '/workspace/plugin', {
      initialInput:
        '[$Wework Plugin Development](plugin://wework-plugin-developer@wework-personal) Develop this Wework plugin: ',
    })

    expect(consumeWorkbenchWorkspaceLaunch('device-2', '/workspace/plugin')).toBeNull()
    expect(consumeWorkbenchWorkspaceLaunch('device-1', '/workspace/other')).toBeNull()
    expect(consumeWorkbenchWorkspaceLaunch('device-1', '/workspace/plugin')).not.toBeNull()
  })

  test('keeps a file action bound to its task as well as device and workspace', () => {
    const options = {
      taskId: 'owner-task',
      openFile: { path: 'cart-fixture/cart-review.md', options: { lineStart: 4, lineEnd: 9 } },
    }
    queueWorkbenchWorkspaceLaunch('device-1', '/workspace/fixture', options)
    expect(consumeWorkbenchWorkspaceLaunch('device-1', '/workspace/fixture')).toBeNull()
    expect(consumeWorkbenchWorkspaceLaunch('device-1', '/workspace/fixture', 'other')).toBeNull()
    expect(
      consumeWorkbenchWorkspaceLaunch('device-2', '/workspace/fixture', 'owner-task')
    ).toBeNull()
    expect(consumeWorkbenchWorkspaceLaunch('device-1', '/other', 'owner-task')).toBeNull()
    expect(consumeWorkbenchWorkspaceLaunch('device-1', '/workspace/fixture', 'owner-task')).toEqual(
      options
    )
    expect(
      consumeWorkbenchWorkspaceLaunch('device-1', '/workspace/fixture', 'owner-task')
    ).toBeNull()
  })
})
