import assert from 'node:assert/strict'
import test from 'node:test'
import { stopRecoveryProcess } from '../e2e/desktop/process-lifecycle.mjs'

test('failed Windows activation cleanup terminates the recovery shell and its descendants', async () => {
  let alive = true
  await stopRecoveryProcess(123, {
    platform: 'win32',
    isAlive: () => alive,
    signal: () => assert.fail('Windows must terminate the whole recovery tree'),
    execute: async (command, args) => {
      assert.equal(command, 'taskkill')
      assert.deepEqual(args, ['/PID', '123', '/T', '/F'])
      alive = false
    },
  })
  assert.equal(alive, false)
})

test('cleanup preserves termination errors and never signals a missing recovery shell', async () => {
  const failure = new Error('termination denied')
  await assert.rejects(
    stopRecoveryProcess(123, {
      platform: 'win32',
      isAlive: () => true,
      execute: async () => {
        throw failure
      },
    }),
    error => error === failure
  )
  await stopRecoveryProcess(123, {
    isAlive: () => false,
    signal: () => assert.fail('The recorded recovery shell already exited'),
  })
  await assert.rejects(stopRecoveryProcess(0), /recorded process ID/)
})
