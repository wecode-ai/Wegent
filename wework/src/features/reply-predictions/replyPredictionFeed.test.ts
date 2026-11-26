import { expect, test, vi } from 'vitest'
import { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle/RuntimeTaskLifecycleStore'
import { createReplyPredictionFeed } from './replyPredictionFeed'
import { replyPredictionKey, ReplyPredictionService } from './replyPredictionService'

test('reuses the canonical model key across turns without changing prediction identity', () => {
  const options = vi.fn(() => ({ z: 'last', a: 'first' }))
  const modelSelection = {
    modelName: 'model',
    get options() {
      return options()
    },
  }
  const source = {
    scope: 'scope',
    revision: 'one',
    busy: false,
    address: { deviceId: 'local', taskId: 'task' },
    modelSelection,
  }
  const prefix = 'scope\u0000'
  const model = { modelName: 'model', options: { a: 'first', z: 'last' } }
  expect(replyPredictionKey(source)).toBe(prefix + JSON.stringify(['one', model]))
  expect(replyPredictionKey({ ...source, latestTurnId: 'two' })).toBe(
    prefix + JSON.stringify(['two', model])
  )
  expect(options).toHaveBeenCalledTimes(1)
  expect(replyPredictionKey({ ...source, modelSelection: { modelName: 'other' } })).toBe(
    prefix + JSON.stringify(['one', { modelName: 'other' }])
  )
  expect(replyPredictionKey({ ...source, modelSelection: undefined })).toBe(
    prefix + JSON.stringify(['one', null])
  )
})

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
