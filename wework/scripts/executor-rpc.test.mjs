import assert from 'node:assert/strict'
import { test } from 'node:test'

import { requestExecutor } from '../e2e/desktop/modules/executor-rpc.mjs'

function controlWithResponses(responses) {
  let index = 0
  let runtimeRequests = 0
  return {
    command: async action => {
      if (action === 'getLocationOrigin') return 'http://127.0.0.1:4100'
      assert.equal(action, 'fetchLocalRuntime')
      runtimeRequests += 1
      const value = responses[Math.min(index, responses.length - 1)]
      index += 1
      if (value instanceof Error) throw value
      return value
    },
    runtimeRequests: () => runtimeRequests,
  }
}

test('does not resubmit an executor RPC after its control response is lost', async () => {
  const control = controlWithResponses([new Error('transport failed')])

  await assert.rejects(
    requestExecutor(control, 'runtime.tasks.create', {}, 1_000),
    /runtime\.tasks\.create failed during response-headers/
  )
  assert.equal(control.runtimeRequests(), 1)
})
