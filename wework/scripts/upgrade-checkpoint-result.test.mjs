import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { upgradeCheckpointPassed } from './lib/upgrade-checkpoint-result.mjs'

test('completed package rejection is an explicit failed candidate, not missing proof', () => {
  for (const code of [0, 1, 2]) {
    const result = spawnSync(process.execPath, ['-e', `process.exit(${code})`])
    assert.equal(
      upgradeCheckpointPassed('upgrade-and-rollback', {
        code: result.status,
        signal: result.signal,
      }),
      code === 0
    )
  }
})

test('interruption and absent exit status cannot become compatibility decisions', () => {
  assert.throws(
    () => upgradeCheckpointPassed('upgrade-and-rollback', { code: null, signal: 'SIGTERM' }),
    /interrupted/
  )
  for (const code of [null, undefined, -1])
    assert.throws(() => upgradeCheckpointPassed('upgrade-and-rollback', { code }), /exit status/)
})

test('focused diagnostics retain their failing exit behavior', () => {
  assert.throws(
    () => upgradeCheckpointPassed('app-rollback-recovery', { code: 1 }, true),
    /Release package checkpoint failed/
  )
  assert.equal(upgradeCheckpointPassed('app-rollback-recovery', { code: 0 }, true), true)
})
