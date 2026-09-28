import { beforeEach, describe, expect, test } from 'vitest'
import {
  cacheConversationScrollSnapshot,
  cacheConversationVirtualMeasurements,
  clearConversationViewportCache,
  evictConversationViewport,
  getConversationScrollSnapshot,
  getConversationVirtualMeasurements,
  getConversationViewportCacheStats,
} from '@wegent/collaboration/conversation/conversationViewportCache'
import {
  getConversationScrollSnapshot as getDesktopSnapshot,
  clearRuntimeConversationCacheForTests,
} from '@/features/workbench/runtimeConversationCache'

beforeEach(clearRuntimeConversationCacheForTests)

describe('shared conversation viewport cache', () => {
  test('shares the desktop cache and retains recently read positions at the 50 entry limit', () => {
    for (let index = 0; index < 50; index += 1) {
      cacheConversationScrollSnapshot(`task-${index}`, {
        distanceFromBottomPx: index,
        pinnedToBottom: false,
      })
    }
    expect(getDesktopSnapshot('task-0')?.distanceFromBottomPx).toBe(0)
    cacheConversationScrollSnapshot('new-task', {
      distanceFromBottomPx: 100,
      pinnedToBottom: false,
    })
    expect(getConversationScrollSnapshot('task-0')).toBeDefined()
    expect(getConversationScrollSnapshot('task-1')).toBeUndefined()
    expect(getConversationViewportCacheStats().scrollSnapshotEntries).toBe(50)
  })

  test('drops obsolete measurements and evicts only the requested conversation', () => {
    const measurement = { index: 0, key: 'message-1', start: 0, end: 100, size: 100, lane: 0 }
    cacheConversationVirtualMeasurements('task-1', [measurement])
    cacheConversationScrollSnapshot('task-1', { distanceFromBottomPx: 42, pinnedToBottom: false })
    cacheConversationScrollSnapshot('task-2', { distanceFromBottomPx: 0, pinnedToBottom: true })
    expect(getConversationVirtualMeasurements('task-1')).toEqual([measurement])
    cacheConversationVirtualMeasurements('task-1', [])
    expect(getConversationVirtualMeasurements('task-1')).toBeUndefined()
    evictConversationViewport('task-1')
    expect(getConversationScrollSnapshot('task-1')).toBeUndefined()
    expect(getConversationScrollSnapshot('task-2')?.pinnedToBottom).toBe(true)
    clearConversationViewportCache()
    expect(getDesktopSnapshot('task-2')).toBeUndefined()
  })
})
