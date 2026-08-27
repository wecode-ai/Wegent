import { describe, expect, test } from 'vitest'
import type { RuntimeTaskAddress } from '@/types/api'
import { registerRuntimeTaskLifecycleAutomation } from './automation'
import { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'

const address: RuntimeTaskAddress = {
  deviceId: 'remote-device',
  taskId: 'claude-task',
}

describe('runtime task lifecycle automation', () => {
  test('applies authoritative transcript snapshots to the global store', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.executorSettled(address)
    const dispose = registerRuntimeTaskLifecycleAutomation(store)

    window.dispatchEvent(
      new CustomEvent('wework:e2e:runtime-task-lifecycle', {
        detail: {
          address,
          type: 'transcript_received',
          transcript: {
            taskId: address.taskId,
            messages: [],
            running: false,
            turns: [{ id: 'restored-turn', items: [], status: 'streaming' }],
          },
        },
      })
    )

    expect(store.getTask(address)?.turn).toMatchObject({
      id: 'restored-turn',
      phase: 'streaming',
    })
    dispose()
  })

  test('stops applying lifecycle events after disposal', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.executorSettled(address)
    const dispose = registerRuntimeTaskLifecycleAutomation(store)
    dispose()

    window.dispatchEvent(
      new CustomEvent('wework:e2e:runtime-task-lifecycle', {
        detail: {
          address,
          type: 'transcript_received',
          transcript: {
            taskId: address.taskId,
            messages: [],
            running: true,
            turns: [{ id: 'ignored-turn', items: [], status: 'streaming' }],
          },
        },
      })
    )

    expect(store.getTask(address)?.turn.phase).toBe('idle')
  })
})
