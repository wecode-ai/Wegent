import assert from 'node:assert/strict'
import test from 'node:test'
import { TranscriptSource } from './transcript-source.js'

test('replays finalized turns and ignores duplicate executor replay', () => {
  const source = new TranscriptSource()
  const turn = {
    transcriptId: 'task-1',
    sequence: 1,
    turnId: 'task-1:1',
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
})
