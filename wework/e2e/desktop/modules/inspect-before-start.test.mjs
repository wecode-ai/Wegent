import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { inspectBeforeStart } from './inspect-before-start.mjs'

test('initializes the paused child before any application code runs', async () => {
  const child = spawn(
    process.execPath,
    ['--inspect-brk=127.0.0.1:0', '--eval', 'console.log(globalThis.testSetup)'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let output = ''
  child.stdout.on('data', chunk => {
    output += chunk
  })
  const exited = once(child, 'exit')
  try {
    await inspectBeforeStart(child, 'globalThis.testSetup = "installed before entry"')
    assert.deepEqual(await exited, [0, null])
    assert.equal(output.trim(), 'installed before entry')
  } finally {
    child.kill()
  }
})
