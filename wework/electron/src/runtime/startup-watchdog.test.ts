import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { STARTUP_WATCHDOG_SOURCE } from './startup-watchdog.js'
import { temporaryDirectory } from './test-helpers.js'

test('captures a stalled main thread without exposing inspected scope values', async () => {
  const directory = await temporaryDirectory('startup-watchdog-')
  try {
    const path = join(directory.path, 'startup.log')
    await promisify(execFile)(
      process.execPath,
      [
        '-e',
        `
const { Worker } = require('node:worker_threads')
const heartbeat = new BigInt64Array(new SharedArrayBuffer(8))
const worker = new Worker(${JSON.stringify(STARTUP_WATCHDOG_SOURCE)}, {
  eval: true,
  workerData: {
    heartbeat: heartbeat.buffer, path: ${JSON.stringify(path)},
    releaseId: 'test-release', intervalMs: 20, stallMs: 50,
  },
})
function holdMainThread() {
  const privateScope = 'must-not-appear-in-diagnostics'
  const deadline = Date.now() + 1500
  while (Date.now() < deadline) {}
  return privateScope.length
}
worker.once('message', () => {
  Atomics.store(heartbeat, 0, BigInt(Date.now()))
  holdMainThread()
  setTimeout(() => worker.terminate(), 100)
})
`,
      ],
      { timeout: 4000 }
    )
    const output = await readFile(path, 'utf8')
    const events = output
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    const stack = events.find(event => event.event === 'startup-main-thread-stack')
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'startup-main-thread-stalled', releaseId: 'test-release' })
    )
    expect(stack?.frames).toContainEqual(
      expect.objectContaining({ functionName: 'holdMainThread' })
    )
    expect(output).not.toContain('must-not-appear-in-diagnostics')
    expect(output).not.toContain('scopeChain')
  } finally {
    await directory.remove()
  }
})
