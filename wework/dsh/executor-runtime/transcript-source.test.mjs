import assert from 'node:assert/strict'
import test from 'node:test'
import { TranscriptSource } from './transcript-source.js'

test('replays finalized turns and ignores duplicate executor replay', async () => {
  const source = new TranscriptSource({ readTurn: turn => ({ ...turn, payload: {} }) })
  const turn = {
    transcriptId: 'task-1',
    taskId: 'task-1',
    title: 'Task',
    sequence: 1,
    turnId: 'task-1:1',
    sessionId: 'session-1',
    executorTurnId: 'executor-turn-1',
    payload: {},
  }
  source.publish(turn)
  source.publish(turn)

  const received = []
  const unsubscribe = source.subscribe(value => received.push(value))
  source.publish({ ...turn, sequence: 2, turnId: 'task-1:2' })
  unsubscribe()
  source.publish({ ...turn, sequence: 3, turnId: 'task-1:3' })

  assert.deepEqual(
    received.map(value => value.sequence),
    [1, 2]
  )
  assert.equal(Object.hasOwn(received[0], 'payload'), false)
  assert.equal(received[0].executorTurnId, 'executor-turn-1')
  assert.deepEqual((await source.read(received[0])).payload, {})
})
