import { afterEach, describe, expect, test } from 'vitest'
import {
  applyRuntimeConversationAction,
  clearRuntimeConversationCacheForTests,
  getRuntimeConversationMessages,
} from '@/features/workbench/runtimeConversationCache'
import { rollbackRejectedRuntimeConversationTurn } from './useWorkbenchPaneSession'

describe('rollbackRejectedRuntimeConversationTurn', () => {
  afterEach(clearRuntimeConversationCacheForTests)

  test('removes the old optimistic turn without overwriting a newly active conversation', () => {
    const submittedTarget = {
      deviceId: 'device-1',
      taskId: 'task-a',
      workspacePath: '/workspace/a',
    }
    const activeTarget = {
      deviceId: 'device-1',
      taskId: 'task-b',
      workspacePath: '/workspace/b',
    }
    applyRuntimeConversationAction(submittedTarget, {
      type: 'user_added',
      message: {
        id: 'rejected-message',
        role: 'user',
        content: 'old conversation draft',
        status: 'done',
        createdAt: '2026-08-09T00:00:00.000Z',
      },
    })
    applyRuntimeConversationAction(activeTarget, {
      type: 'user_added',
      message: {
        id: 'active-message',
        role: 'user',
        content: 'new conversation',
        status: 'done',
        createdAt: '2026-08-09T00:00:01.000Z',
      },
    })

    const visibleMessages = rollbackRejectedRuntimeConversationTurn(
      submittedTarget,
      activeTarget,
      'rejected-message'
    )

    expect(visibleMessages).toBeNull()
    expect(getRuntimeConversationMessages(submittedTarget)).toEqual([])
    expect(getRuntimeConversationMessages(activeTarget)).toMatchObject([
      { id: 'active-message', content: 'new conversation' },
    ])
  })
})
