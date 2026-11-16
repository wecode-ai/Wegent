// @vitest-environment node

import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  waitForRestoredTranscript,
  waitForTranscriptState,
} from '../e2e/desktop/modules/transcript-restoration.mjs'

test('awaits asynchronous transcript evidence before accepting a matched state', async () => {
  let reads = 0
  const samples = []
  const restored = await waitForTranscriptState(
    {
      command: async () => JSON.stringify({ sequence: ++reads }),
    },
    async snapshot => snapshot.sequence === 2,
    'The async transcript evidence did not match',
    2_000,
    sample => samples.push(sample.matched)
  )
  assert.equal(restored.sequence, 2)
  assert.deepEqual(samples, [false, true])
})

test('restoration waits for the selected pane and its transcript, not just the task index', async () => {
  const snapshots = [
    { workbench: { currentRuntimeTask: { taskId: 'target' } }, pane: {} },
    {
      workbench: { currentRuntimeTask: { taskId: 'target' } },
      pane: { currentRuntimeTask: { taskId: 'previous' }, transcript: { loading: false } },
    },
    {
      workbench: { currentRuntimeTask: { taskId: 'target' } },
      pane: { currentRuntimeTask: { taskId: 'target' }, transcript: { loading: true } },
    },
    {
      workbench: { currentRuntimeTask: { taskId: 'target' } },
      pane: { currentRuntimeTask: { taskId: 'target' }, transcript: { loading: false } },
    },
  ]
  let reads = 0
  const control = {
    async command(action, selector) {
      assert.equal(action, 'getWorkbenchDebugSnapshot')
      assert.equal(selector, 'body')
      return JSON.stringify(snapshots[reads++])
    },
  }
  assert.deepEqual(await waitForRestoredTranscript(control, 'target', 2_000), snapshots[3])
  assert.equal(reads, 4)
})

test('restoration propagates control failures rather than retrying them', async () => {
  const failure = new Error('Disconnected')
  await assert.rejects(
    waitForRestoredTranscript(
      {
        command: async () => {
          throw failure
        },
      },
      'target',
      2_000
    ),
    error => error === failure
  )
})
