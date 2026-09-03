import { describe, expect, test, vi } from 'vitest'

import type { ExecutorRuntimeClient } from '@/api/executorAccess'
import type { DeviceInfo, RuntimeHistoryCapability } from '@/types/api'
import { loadRuntimeHistoryV2, runtimeHistoryV2Capability } from './runtimeHistoryProtocol'

const capability: RuntimeHistoryCapability = {
  schemaVersions: [1, 2],
  defaultTurnPageSize: 5,
  maxTurnPageSize: 20,
  defaultItemPageSize: 20,
  maxPageBytes: 393216,
}

describe('runtime history protocol', () => {
  test('selects V2 only from the addressed runtime feature report', () => {
    expect(
      runtimeHistoryV2Capability({
        runtime_features: { schemaVersion: 2, runtimeHistory: capability },
      } as DeviceInfo)
    ).toEqual(capability)
    expect(
      runtimeHistoryV2Capability({
        runtime_features: {
          schemaVersion: 2,
          runtimeHistory: { ...capability, schemaVersions: [1] },
        },
      } as DeviceInfo)
    ).toBeNull()
    expect(runtimeHistoryV2Capability(null)).toBeNull()
  })

  test('hydrates item cursors without expanding the turn page beyond five turns', async () => {
    const listRuntimeHistoryTurns = vi.fn().mockResolvedValue({
      schemaVersion: 2,
      taskId: 'task-1',
      workspacePath: '/work',
      runtime: 'codex',
      turns: [{ id: 'turn-1', items: [], itemsView: 'notLoaded' }],
      turnNavigation: [
        {
          id: 'navigation-1',
          turnIndex: 0,
          messageIndex: 0,
          promptPreview: 'hello',
        },
      ],
      hasMoreBefore: true,
      beforeCursor: 'older-turns',
    })
    const listRuntimeHistoryItems = vi
      .fn()
      .mockResolvedValueOnce({
        schemaVersion: 2,
        taskId: 'task-1',
        turnId: 'turn-1',
        items: [{ id: 'text-1', type: 'assistant_text', content: 'hello' }],
        hasMore: true,
        nextCursor: 'items-2',
      })
      .mockResolvedValueOnce({
        schemaVersion: 2,
        taskId: 'task-1',
        turnId: 'turn-1',
        items: [{ id: 'text-2', type: 'assistant_text', content: ' world' }],
        hasMore: false,
        nextCursor: null,
      })
    const runtime = {
      listRuntimeHistoryTurns,
      listRuntimeHistoryItems,
    } as unknown as ExecutorRuntimeClient

    const response = await loadRuntimeHistoryV2(
      runtime,
      { deviceId: 'device-1', taskId: 'task-1' },
      capability,
      { limit: 50 }
    )

    expect(listRuntimeHistoryTurns).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }))
    expect(listRuntimeHistoryItems).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: 'items-2' })
    )
    expect(response.turns[0].items).toEqual([
      { id: 'text-1', type: 'assistant_text', content: 'hello' },
      { id: 'text-2', type: 'assistant_text', content: ' world' },
    ])
    expect(response.messages).toEqual([])
    expect(response.turnNavigation).toEqual([
      {
        id: 'navigation-1',
        turnIndex: 0,
        messageIndex: 0,
        promptPreview: 'hello',
      },
    ])
    expect(response.beforeCursor).toBe('older-turns')
  })
})
