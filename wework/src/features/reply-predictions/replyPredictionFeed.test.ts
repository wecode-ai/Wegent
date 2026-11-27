import { expect, test, vi } from 'vitest'
import { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle/RuntimeTaskLifecycleStore'
import { createReplyPredictionFeed } from './replyPredictionFeed'
import { ReplyPredictionService } from './replyPredictionService'

test('task updates and cache events revalidate only the affected prediction', async () => {
  const store = new RuntimeTaskLifecycleStore('reply-prediction-feed')
  const service = new ReplyPredictionService({ predict: vi.fn() })
  const current = vi.fn(() => true)
  const request = vi.spyOn(service, 'request').mockResolvedValue({
    text: 'Continue',
    onAccept: vi.fn(),
    isCurrent: current,
  })
  const first = { deviceId: 'local', taskId: 'first', workspaceKind: 'chat' as const }
  const second = { ...first, taskId: 'second' }
  const firstScope = JSON.stringify(['local', 'first', null])
  const secondScope = JSON.stringify(['local', 'second', null])
  const feed = createReplyPredictionFeed(service, store)
  const unsubscribe = feed.subscribe(() => {})
  try {
    const running = {
      title: 'Reply prediction',
      workspaceKind: 'chat' as const,
      runtime: 'codex' as const,
      continuable: true,
      running: true,
      status: 'running' as const,
      completedAt: null,
      updatedAt: 1,
    }
    const firstTask = {
      ...running,
      taskId: first.taskId,
      runtimeHandle: { lastTurnId: 'first-turn' },
    }
    store.syncRuntimeTask(first, firstTask)
    expect(feed.getSnapshot().entries.get(firstScope)?.busy).toBe(true)
    store.syncRuntimeTask(first, {
      ...firstTask,
      running: false,
      status: 'done',
      turnStatus: 'completed',
      completedAt: 2,
      updatedAt: 2,
    })
    await Promise.resolve()
    const firstEntry = feed.getSnapshot().entries.get(firstScope)
    expect(request).toHaveBeenCalledTimes(1)
    expect(firstEntry?.prediction?.text).toBe('Continue')

    current.mockClear()
    store.syncRuntimeTask(second, {
      ...running,
      taskId: second.taskId,
      runtimeHandle: { lastTurnId: 'second-turn' },
    })
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'wework.replyPrediction.v1.' + secondScope })
    )
    expect(feed.getSnapshot().entries.get(secondScope)?.busy).toBe(true)
    expect(feed.getSnapshot().entries.get(firstScope)).toBe(firstEntry)
    expect(current).not.toHaveBeenCalled()

    current.mockReturnValue(false)
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'wework.replyPrediction.v1.' + firstScope })
    )
    expect(feed.getSnapshot().entries.get(firstScope)?.prediction).toBeNull()
  } finally {
    unsubscribe()
  }
})
