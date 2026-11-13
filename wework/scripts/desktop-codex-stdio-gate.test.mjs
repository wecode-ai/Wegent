// @vitest-environment node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'vitest'

test('the Codex relay delivers the entire catalog to a slow reader', async () => {
  const relay = fileURLToPath(
    new URL('../e2e/desktop/modules/codex-stdio-gate-process.mjs', import.meta.url)
  )
  const instructionLength = 600_000
  const catalog = JSON.stringify({
    models: [{ slug: 'test', instructions: 'x'.repeat(instructionLength) }],
  })
  const exportCatalog = `process.stdout.write(JSON.stringify({ models: [{ slug: 'test', instructions: 'x'.repeat(${instructionLength}) }] }))`
  const child = spawn(
    process.execPath,
    [relay, process.execPath, '.', '-e', exportCatalog, 'debug', 'models', '--bundled'],
    { stdio: ['pipe', 'pipe', 'inherit'], signal: AbortSignal.timeout(10_000) }
  )
  const closed = once(child, 'close')
  const chunks = []
  // Keep the consumer behind the writer to exercise pending writes at child exit.
  for await (const chunk of child.stdout) {
    chunks.push(chunk)
    await delay(15)
  }
  assert.deepEqual(await closed, [0, null])
  const received = Buffer.concat(chunks).toString('utf8')
  assert.equal(received.length, catalog.length)
  assert.equal(received, catalog)
})
