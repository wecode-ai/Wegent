import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { cleanupNativeMcpResources } from '../e2e/desktop/modules/native-mcp-cleanup.mjs'

test('executor shutdown failure still closes HTTP services and records evidence', async () => {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const failure = new Error('Timed out waiting for process group to exit')
  const completed = []
  try {
    await assert.rejects(
      cleanupNativeMcpResources([
        async () => {
          throw failure
        },
        async () => {
          await new Promise(resolve => server.close(resolve))
          completed.push('http-closed')
        },
        async () => {
          completed.push('log-written')
        },
        async () => {
          completed.push('model-closed')
        },
      ]),
      error => error === failure
    )
    assert.equal(server.listening, false)
    assert.deepEqual(completed, ['http-closed', 'log-written', 'model-closed'])
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve))
  }
})

test('cleanup failures preserve the original execution error and attempt every cleanup', async () => {
  const original = new Error('MCP execution failed')
  const attempted = []
  await assert.rejects(
    cleanupNativeMcpResources(
      [
        async () => {
          attempted.push('stop')
          throw new Error('stop failed')
        },
        async () => {
          attempted.push('close')
          throw new Error('close failed')
        },
        async () => {
          attempted.push('log')
        },
      ],
      original
    ),
    error => error === original
  )
  assert.deepEqual(attempted, ['stop', 'close', 'log'])
})
