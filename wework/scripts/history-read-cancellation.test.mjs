// @vitest-environment node

import assert from 'node:assert/strict'
import { test } from 'vitest'

import { transcriptRequestState } from '../e2e/desktop/modules/history-read-cancellation.mjs'

test('requires cancellation evidence from the exact transcript IPC request', () => {
  const unrelated = [
    'app IPC request failed request_id=other method=runtime.tasks.transcript elapsed_ms=1 code=request_cancelled error="History read cancelled"',
    'app IPC request failed request_id=target method=runtime.tasks.list elapsed_ms=1 code=request_cancelled error="Other operation"',
    'app IPC request failed request_id=target-extra method=runtime.tasks.transcript elapsed_ms=1 code=request_cancelled error="History read cancelled"',
  ].join('\n')
  assert.equal(transcriptRequestState(unrelated, 'target'), 'pending')
  assert.equal(
    transcriptRequestState(
      `${unrelated}\napp IPC request failed request_id=target method=runtime.tasks.transcript elapsed_ms=20 code=request_cancelled error="History read cancelled"`,
      'target'
    ),
    'cancelled'
  )
})

test('distinguishes successful and unrelated failed reads from a cancelled read', () => {
  assert.equal(
    transcriptRequestState(
      'app IPC request finished request_id=target method=runtime.tasks.transcript elapsed_ms=1500 ok=true',
      'target'
    ),
    'completed'
  )
  assert.equal(
    transcriptRequestState(
      'app IPC request failed request_id=target method=runtime.tasks.transcript elapsed_ms=1500 code=request_timeout error="Read timed out"',
      'target'
    ),
    'failed'
  )
})
