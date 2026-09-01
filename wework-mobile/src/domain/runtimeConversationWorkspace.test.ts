import { describe, expect, it, vi } from 'vitest'

import {
  buildConversationWorkspacePath,
  createConversationWorkspace,
} from './runtimeConversationWorkspace'

describe('runtime conversation workspace', () => {
  it('builds the same dated standalone workspace path as Wework', () => {
    expect(
      buildConversationWorkspacePath(
        '/Users/hongyu9',
        'Fix Mobile Chat',
        'task-123456789',
        new Date(2026, 7, 31)
      )
    ).toBe('/Users/hongyu9/Documents/Codex/2026-08-31/fix-mobile-chat-23456789')
  })

  it('uses the Wework default name for messages without ASCII words', () => {
    expect(
      buildConversationWorkspacePath(
        '/Users/hongyu9',
        '你好',
        'task-abcdef12',
        new Date(2026, 7, 31)
      )
    ).toBe('/Users/hongyu9/Documents/Codex/2026-08-31/new-chat-abcdef12')
  })

  it('resolves the device home and creates the directory before returning it', async () => {
    const deviceApi = {
      getHomeDirectory: vi.fn().mockResolvedValue('/Users/hongyu9'),
      createDirectory: vi.fn().mockResolvedValue(undefined),
    }

    const workspacePath = await createConversationWorkspace(
      deviceApi,
      'cloud-1',
      '你好',
      'task-abcdef12'
    )

    expect(deviceApi.getHomeDirectory).toHaveBeenCalledWith('cloud-1')
    expect(deviceApi.createDirectory).toHaveBeenCalledWith('cloud-1', workspacePath)
  })
})
