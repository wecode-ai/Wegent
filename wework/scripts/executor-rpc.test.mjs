import assert from 'node:assert/strict'
import { test } from 'node:test'

import { requestExecutor } from '../e2e/desktop/modules/executor-rpc.mjs'

function controlWithResponses(responses) {
  let index = 0
  return {
    command: async action => {
      if (action === 'getLocationOrigin') return 'http://127.0.0.1:4100'
      assert.equal(action, 'fetchLocalRuntime')
      const value = responses[Math.min(index, responses.length - 1)]
      index += 1
      if (value instanceof Error) throw value
      return value
    },
  }
}

test('retries an idempotent executor RPC after a transport failure', async () => {
  const control = controlWithResponses([
    new Error('Desktop E2E control result failed with 404'),
    JSON.stringify({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true, result: { saved: true } }),
    }),
  ])

  await assert.doesNotReject(async () => {
    const result = await requestExecutor(
      control,
      'runtime.codex.catalog.overrides.write',
      { slug: 'model-1', entry: { tool_mode: 'code_mode' } },
      1_000,
      { retryOnTransport: true }
    )
    assert.deepEqual(result, { saved: true })
  })
})

test('does not retry an executor RPC without an explicit idempotency opt-in', async () => {
  const control = controlWithResponses([new Error('transport failed')])

  await assert.rejects(
    requestExecutor(control, 'runtime.tasks.create', {}, 1_000),
    /runtime\.tasks\.create failed during response-headers/
  )
})
