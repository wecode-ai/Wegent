import { describe, expect, test } from 'vitest'
import { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'

describe('superseded recovered turn settlement', () => {
  test.each([false, true])('honors preserveActiveTurn=%s', preserveActiveTurn => {
    const store = new RuntimeTaskLifecycleStore('superseded-history')
    const address = { deviceId: 'device', taskId: 'task' }
    store.syncRuntimeTask(address, {
      taskId: address.taskId,
      workspacePath: '/workspace',
      title: 'Recovered Goal',
      runtime: 'codex',
      running: true,
      runtimeHandle: { lastTurnId: 'native-turn' },
    })
    store.turnStarted(address, 'recovered-turn')
    store.syncTranscript(
      address,
      {
        taskId: address.taskId,
        messages: [],
        running: false,
        supersededTurnIds: ['recovered-turn'],
        turns: [{ id: 'native-turn', status: 'completed', completedAt: 2000, items: [] }],
      },
      { preserveActiveTurn }
    )

    expect(store.getTask(address)?.derived.isBusy).toBe(preserveActiveTurn)
    expect(store.getTask(address)?.turn.id).toBe(preserveActiveTurn ? 'recovered-turn' : null)
    expect(store.getTask(address)?.turn.latestId).toBe(
      preserveActiveTurn ? 'recovered-turn' : 'native-turn'
    )
  })
})
