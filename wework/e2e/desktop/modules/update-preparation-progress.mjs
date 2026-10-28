import assert from 'node:assert/strict'
import { UPGRADE_PREPARATION_PHASE_TIMEOUT_MS } from '../upgrade-suite.mjs'

const PHASES = ['host', 'extracting', 'runtime', 'ready']

export async function waitForUpdatePreparation(
  readProgress,
  {
    phaseTimeoutMs = UPGRADE_PREPARATION_PHASE_TIMEOUT_MS,
    now = Date.now,
    sleep = ms => new Promise(r => setTimeout(r, ms)),
  } = {}
) {
  let phaseIndex = -1
  let phaseStartedAt = now()
  for (;;) {
    const progress = await readProgress()
    assert.notEqual(
      progress.phase,
      'failed',
      `Update preparation failed: ${progress.failure?.message}`
    )
    assert.ok(
      phaseIndex < 0 || now() - phaseStartedAt < phaseTimeoutMs,
      `Update preparation stalled: phase=${PHASES[phaseIndex]}, elapsedMs=${now() - phaseStartedAt}, downloadedBytes=${progress.downloadedBytes}`
    )
    const nextIndex = PHASES.indexOf(progress.phase)
    assert.ok(nextIndex >= phaseIndex && nextIndex >= 0, 'Update preparation phase regressed')
    if (nextIndex > phaseIndex) {
      phaseIndex = nextIndex
      phaseStartedAt = now()
    }
    if (progress.phase === 'ready') return progress
    await sleep(250)
  }
}
