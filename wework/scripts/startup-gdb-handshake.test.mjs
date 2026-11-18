// @vitest-environment node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { describe, it, vi } from 'vitest'
import { parseStartupGdbReady } from '../e2e/desktop/modules/startup-gdb-handshake.mjs'
import { processIsAlive } from '../e2e/desktop/process-lifecycle.mjs'

const PROTOCOL_URL = new URL('../e2e/desktop/modules/startup-gdb-handshake.mjs', import.meta.url)
  .href
const CHILD_SOURCE = `
  import { readSync, writeSync } from 'node:fs';
  const { completeStartupGdbHandshake } = await import(process.argv[1]);
  const mode = process.argv[2];
  writeSync(1, '[protocol-identity] ' + JSON.stringify({pid:process.pid,ppid:process.ppid}) + '\\n');
  if (mode === 'before-ack-read') {
    writeSync(1, '[blocked-before-ack-read]\\n');
    readSync(4, Buffer.alloc(1), 0, 1, null);
    throw new Error('The fault-injection barrier was unexpectedly released');
  }
  completeStartupGdbHandshake(mode === 'normal' ? 'normal' : 'interrupt');
  if (mode !== 'normal') setInterval(() => {}, 1000);
`

function startChild(mode) {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', CHILD_SOURCE, '--', PROTOCOL_URL, mode],
    {
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    }
  )
  const lines = []
  const errors = []
  let stderr = ''
  let spawnError
  let exit
  const reader = createInterface({ input: child.stdout })
  reader.on('line', line => lines.push(line))
  child.stderr.on('data', chunk => {
    stderr += chunk
  })
  child.once('error', error => {
    spawnError = error
  })
  child.once('close', (code, signal) => {
    exit = { code, signal }
  })
  for (const descriptor of [3, 4]) {
    child.stdio[descriptor].on('error', error => errors.push({ descriptor, code: error.code }))
    child.stdio[descriptor].resume()
  }
  async function waitFor(predicate) {
    await vi.waitFor(
      () => {
        if (spawnError) throw spawnError
        assert.ok(predicate(), stderr || `Waiting for ${mode}: ${lines.join('\n')}`)
      },
      { timeout: 2_000, interval: 10 }
    )
  }
  return {
    child,
    lines,
    errors,
    waitFor,
    get stderr() {
      return stderr
    },
    get exit() {
      return exit
    },
    async acknowledge(byte = 1) {
      let timeout
      try {
        await Promise.race([
          new Promise((resolve, reject) => {
            child.stdio[3].end(Buffer.from([byte]), error => (error ? reject(error) : resolve()))
          }),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Protocol ACK write timed out')), 2_000)
          }),
        ])
      } finally {
        clearTimeout(timeout)
      }
    },
    async cleanup() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await waitFor(() => exit !== undefined)
      reader.close()
      assert.equal(processIsAlive(child.pid), false, 'Protocol child survived cleanup')
    },
  }
}

async function waitForIdentity(probe) {
  await probe.waitFor(() => probe.lines.some(line => line.startsWith('[protocol-identity] ')))
  const line = probe.lines.find(value => value.startsWith('[protocol-identity] '))
  assert.deepEqual(JSON.parse(line.slice('[protocol-identity] '.length)), {
    pid: probe.child.pid,
    ppid: process.pid,
  })
}

function readyMarkers(probe) {
  return probe.lines.map(parseStartupGdbReady).filter(Boolean)
}

// These real extra-FD/socket-reset cases exercise Unix pipes. GDB and the
// production smoke remain Linux-only; Windows does not share this contract.
describe.skipIf(process.platform === 'win32')('startup GDB acknowledgement protocol', () => {
  it('reproduces teardown with an unread acknowledgement and no ready marker', async () => {
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const probe = startChild('before-ack-read')
      try {
        await waitForIdentity(probe)
        await probe.waitFor(() => probe.lines.includes('[blocked-before-ack-read]'))
        // FD4 is never released, so the real ACK is still unread when killed.
        await probe.acknowledge()
        assert.equal(probe.child.kill('SIGKILL'), true)
        await probe.waitFor(() => probe.exit !== undefined)
        assert.deepEqual(probe.exit, { code: null, signal: 'SIGKILL' })
        assert.deepEqual(readyMarkers(probe), [])
        // Kernels can report EOF or reset for this unread Unix socket. The
        // race is proven by the unreleased FD4 barrier and the missing ready.
        for (const error of probe.errors)
          assert.deepEqual(error, { descriptor: 3, code: 'ECONNRESET' })
      } finally {
        await probe.cleanup()
      }
    }
  })

  it('exits normally only after consuming the acknowledgement and reporting ready', async () => {
    const probe = startChild('normal')
    try {
      await waitForIdentity(probe)
      assert.deepEqual(readyMarkers(probe), [])
      await probe.acknowledge()
      await probe.waitFor(() => probe.exit !== undefined)
      assert.deepEqual(readyMarkers(probe), [{ pid: probe.child.pid, mode: 'normal' }])
      assert.deepEqual(probe.exit, { code: 0, signal: null })
      assert.deepEqual(probe.errors, [])
    } finally {
      await probe.cleanup()
    }
  })

  it('consumes and closes the acknowledgement before interrupt teardown', async () => {
    const probe = startChild('after-ack-read')
    try {
      await waitForIdentity(probe)
      await probe.acknowledge()
      await probe.waitFor(() => readyMarkers(probe).length === 1)
      assert.deepEqual(readyMarkers(probe), [{ pid: probe.child.pid, mode: 'interrupt' }])
      assert.equal(probe.child.kill('SIGKILL'), true)
      await probe.waitFor(() => probe.exit !== undefined)
      assert.deepEqual(probe.errors, [])
    } finally {
      await probe.cleanup()
    }
  })

  it('rejects an invalid acknowledgement without emitting ready', async () => {
    const probe = startChild('normal')
    try {
      await waitForIdentity(probe)
      await probe.acknowledge(2)
      await probe.waitFor(() => probe.exit !== undefined)
      assert.equal(probe.exit.code, 1)
      assert.match(probe.stderr, /Invalid GDB smoke acknowledgement/)
      assert.deepEqual(readyMarkers(probe), [])
      assert.deepEqual(probe.errors, [])
    } finally {
      await probe.cleanup()
    }
  })
})
