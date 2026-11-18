import assert from 'node:assert/strict'
import { closeSync, readSync, writeSync } from 'node:fs'

const READY_PREFIX = '[startup-gdb-ready] '
const MODES = ['normal', 'trap', 'interrupt']

/** Only the synthetic smoke child uses this descriptor; the app never does. */
export function completeStartupGdbHandshake(mode) {
  assert.ok(MODES.includes(mode), 'Unknown startup GDB smoke mode')
  const acknowledgement = Buffer.alloc(1)
  assert.equal(readSync(3, acknowledgement, 0, 1, null), 1, 'Missing GDB smoke acknowledgement')
  assert.equal(acknowledgement[0], 1, 'Invalid GDB smoke acknowledgement')
  closeSync(3)
  writeSync(1, `${READY_PREFIX}${JSON.stringify({ pid: process.pid, mode })}\n`)
}

export function parseStartupGdbReady(line) {
  if (!line.startsWith(READY_PREFIX)) return null
  const ready = JSON.parse(line.slice(READY_PREFIX.length))
  assert.deepEqual(Object.keys(ready).sort(), ['mode', 'pid'], 'Invalid GDB smoke ready marker')
  assert.ok(Number.isSafeInteger(ready.pid) && ready.pid > 0, 'Invalid GDB smoke ready PID')
  assert.ok(MODES.includes(ready.mode), 'Invalid GDB smoke ready mode')
  return ready
}
