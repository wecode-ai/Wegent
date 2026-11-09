import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { inspectBeforeStart, inspectRunningApp } from './inspect-before-start.mjs'

test('awaits native asynchronous assertions only after startup and verifies the current host PID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-running-inspector-'))
  const entry = join(directory, 'running.cjs')
  await writeFile(entry, "setInterval(() => {}, 1000); console.log('ready')")
  const child = spawn(process.execPath, ['--inspect-brk=127.0.0.1:0', entry], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit')
  const ready = once(child.stdout, 'data', { signal: AbortSignal.timeout(10_000) })
  try {
    const socketUrl = await inspectBeforeStart(child, 'globalThis.started = true', () => {})
    await ready
    const port = new URL(socketUrl).port
    assert.deepEqual(
      await inspectRunningApp(
        port,
        child.pid,
        'Promise.resolve({started: globalThis.started, authenticated: true})',
        () => {}
      ),
      { started: true, authenticated: true }
    )
    await assert.rejects(
      inspectRunningApp(port, child.pid + 1, 'process.exit(1)', () => {}),
      /another release process/
    )
  } finally {
    child.kill()
    await exited
    await rm(directory, { recursive: true, force: true })
  }
})

for (const moduleType of ['cjs', 'mjs']) {
  test(`initializes and disconnects before returning for ${moduleType} entry`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-inspector-entry-'))
    const entry = join(directory, `entry.${moduleType}`)
    await writeFile(entry, 'console.log(globalThis.testSetup)')
    const child = spawn(process.execPath, ['--inspect-brk=127.0.0.1:0', entry], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk
    })
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(20_000) })
    const diagnostics = []
    try {
      await inspectBeforeStart(
        child,
        'globalThis.testSetup = "installed before entry"',
        (...details) => diagnostics.push(details)
      )
      assert.ok(
        diagnostics.some(details => details[0] === '[desktop-e2e-inspector] disconnected'),
        'Setup must release its inspector connection before returning'
      )
      assert.deepEqual(await exited, [0, null])
      assert.equal(output.trim(), 'installed before entry')
      assert.ok(
        diagnostics.some(
          details =>
            details[0] === '[desktop-e2e-inspector] response' &&
            details[1] === 'Debugger.disable' &&
            details[2] === 'ok'
        ),
        'The application must start with the driver-owned debugger disabled'
      )
    } finally {
      child.kill()
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('reports a child that exits before the inspector is available', async () => {
  const child = spawn(process.execPath, ['--eval', 'process.exit(17)'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(20_000) })
  try {
    await assert.rejects(
      inspectBeforeStart(child, 'globalThis.testSetup = true'),
      /The isolated app exited before its inspector started/
    )
    assert.deepEqual(await exited, [17, null])
  } finally {
    child.kill()
  }
})
