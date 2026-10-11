import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { waitForProcessBoundPort } from '../e2e/desktop/modules/process-bound-port.mjs'
import { reserveListeningPort } from '../e2e/desktop/port-reservation.mjs'

test('keeps the gateway port unavailable until the Python process owns its port', async () => {
  const reservation = await reserveListeningPort()
  const contender = createServer()
  try {
    const failed = once(contender, 'error')
    contender.listen(reservation.port, '127.0.0.1')
    const [error] = await failed
    assert.equal(error.code, 'EADDRINUSE')
    await reservation.release()
    const listening = once(contender, 'listening')
    contender.listen(reservation.port, '127.0.0.1')
    await listening
  } finally {
    await reservation.release()
    await new Promise(resolve => contender.close(resolve))
  }
})

test('uses the port owned by the new process instead of an earlier startup log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-bound-port-'))
  const logPath = join(root, 'backend.log')
  const stale = 'Uvicorn running on http://127.0.0.1:1\n'
  await writeFile(logPath, stale)
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { createServer } from 'node:http'
    const server = createServer((request, response) => response.end('ready'))
    server.listen(0, '127.0.0.1', () => {
      console.log('Uvicorn running on http://127.0.0.1:' + server.address().port)
    })
  `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  child.stdout.on('data', data => {
    void appendFile(logPath, data)
  })
  try {
    const port = await waitForProcessBoundPort(child, logPath, {
      fromOffset: stale.length,
      timeoutMs: 2_000,
    })
    assert.notEqual(port, 1)
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'ready')
  } finally {
    const exited = once(child, 'exit')
    child.kill()
    await exited
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects a process that exited without opening its port', async () => {
  await assert.rejects(
    waitForProcessBoundPort({ exitCode: 1, signalCode: null }, '/unused', { timeoutMs: 100 }),
    /exited before binding/
  )
})

test('rejects an invalid advertised port', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-bound-port-invalid-'))
  const logPath = join(root, 'backend.log')
  try {
    await writeFile(logPath, 'Uvicorn running on http://127.0.0.1:0\n')
    await assert.rejects(
      waitForProcessBoundPort({ exitCode: null, signalCode: null }, logPath, { timeoutMs: 100 }),
      /invalid port/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
