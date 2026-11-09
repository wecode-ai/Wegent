import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  confirmPendingUpdateRetry,
  quitActiveRelease,
  readRollbackHistory,
} from '../e2e/desktop/modules/failed-upgrade-retry.mjs'
import { processIsAlive } from '../e2e/desktop/process-lifecycle.mjs'

test('historical direct downloads do not require a rollback confirmation', async () => {
  const progress = { phase: 'host', downloadedBytes: 10, totalBytes: 100 }
  assert.equal(
    await confirmPendingUpdateRetry(
      {
        async command(name) {
          assert.equal(name, 'getAppUpdateProgress')
          return JSON.stringify(progress)
        },
      },
      '1.1.0'
    ),
    false
  )
})

test('starts a rolled-back target only after confirming its existing retry dialog', async () => {
  const version = '1.1.0'
  let phase
  let confirmationVisible = false
  let confirmations = 0
  assert.equal(
    await confirmPendingUpdateRetry(
      {
        async command(name, selector, options) {
          if (name === 'getAppUpdateProgress')
            return JSON.stringify({ update: { retryConfirmation: { version } } })
          if (name === 'waitFor') {
            assert.equal(selector, '[data-testid="app-update-retry-dialog"]')
            assert.equal(options.text, version)
            confirmationVisible = true
            return
          }
          assert.equal(name, 'clickWhenEnabled')
          assert.equal(selector, '[data-testid="app-update-retry-confirm"]')
          assert.equal(confirmationVisible, true)
          confirmations++
          phase = 'preparing'
        },
      },
      version
    ),
    true
  )
  assert.equal(phase, 'preparing')
  assert.equal(confirmations, 1)
})

test('cannot confirm a retry for another release', async () => {
  await assert.rejects(
    confirmPendingUpdateRetry(
      {
        async command(name) {
          assert.equal(name, 'getAppUpdateProgress')
          return JSON.stringify({ update: { retryConfirmation: { version: '1.2.0' } } })
        },
      },
      '1.1.0'
    ),
    /another target/
  )
})

test('retry restart waits for the current supervised release to exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-retry-quit-'))
  const child = spawn(process.execPath, ['-e', 'process.on("message", () => process.exit(0))'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  const exited = once(child, 'exit')
  try {
    await writeFile(join(root, 'active-pid'), String(child.pid))
    const commands = []
    await quitActiveRelease(
      {
        async command(command) {
          commands.push(command)
          if (command === 'getOwnedProcessSnapshot')
            return JSON.stringify({ applicationPid: child.pid })
          assert.equal(command, 'quitApp')
          child.send('quit')
        },
      },
      root
    )
    assert.equal(processIsAlive(child.pid), false)
    assert.deepEqual(commands, ['getOwnedProcessSnapshot', 'quitApp'])
    assert.deepEqual(await exited, [0, null])
    await assert.rejects(
      quitActiveRelease(
        { command: async () => JSON.stringify({ applicationPid: process.pid }) },
        root
      ),
      /connected to another release/
    )
  } finally {
    if (processIsAlive(child.pid)) child.kill('SIGKILL')
    await exited
    await rm(root, { recursive: true, force: true })
  }
})

test('retry verification requires the real package identity and production failure reason', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-retry-evidence-'))
  const target = { version: '1.1.0', sha256: 'a'.repeat(64) }
  const history = [
    {
      token: 'real-activation-token',
      version: target.version,
      fromVersion: '1.0.0',
      packageSha256: target.sha256,
      reason: 'startup-failed',
      occurredAt: new Date().toISOString(),
    },
  ]
  try {
    await assert.rejects(readRollbackHistory(root, target, 'startup-failed'), /rebuild the source/)
    await writeFile(join(root, 'rolled-back-versions.json'), JSON.stringify([target.version]))
    await assert.rejects(readRollbackHistory(root, target, 'startup-failed'), /rebuild the source/)
    await writeFile(join(root, 'update-rollback-history.json'), JSON.stringify(history))
    assert.deepEqual(await readRollbackHistory(root, target, 'startup-failed'), history)
    await assert.rejects(readRollbackHistory(root, target, 'rolled-back'), /did not record/)
    await assert.rejects(
      readRollbackHistory(root, { ...target, sha256: 'b'.repeat(64) }, 'startup-failed'),
      /another package/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
