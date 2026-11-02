import assert from 'node:assert/strict'
import { UPGRADE_PREPARATION_PHASE_TIMEOUT_MS } from '../upgrade-suite.mjs'

const PHASES = ['preparing', 'host', 'extracting', 'runtime', 'ready']

export function waitForUpdatePreparation(readProgress, options = {}) {
  return waitForPreparationPhases(readProgress, { ...options, phases: PHASES })
}

export async function waitForPreparationPhases(
  readProgress,
  {
    phaseTimeoutMs = UPGRADE_PREPARATION_PHASE_TIMEOUT_MS,
    now = Date.now,
    sleep = ms => new Promise(r => setTimeout(r, ms)),
    phases,
    description = 'Update preparation',
  } = {}
) {
  let phaseIndex = -1
  let phaseStartedAt = now()
  for (;;) {
    const progress = await readProgress()
    assert.notEqual(progress.phase, 'failed', `${description} failed: ${progress.failure?.message}`)
    assert.ok(
      phaseIndex < 0 || now() - phaseStartedAt < phaseTimeoutMs,
      `${description} stalled: phase=${phases[phaseIndex]}, elapsedMs=${now() - phaseStartedAt}, downloadedBytes=${progress.downloadedBytes}`
    )
    const nextIndex = phases.indexOf(progress.phase)
    assert.ok(nextIndex >= phaseIndex && nextIndex >= 0, `${description} phase regressed`)
    if (nextIndex > phaseIndex) {
      phaseIndex = nextIndex
      phaseStartedAt = now()
    }
    if (progress.phase === 'ready') return progress
    await sleep(250)
  }
}
