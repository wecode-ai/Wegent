import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { stopProcessGroup } from '../process-lifecycle.mjs'
import { waitForPreparationPhases } from './update-preparation-progress.mjs'

const SOURCE_PHASES = [
  'preparing',
  'profile-copy',
  'components',
  'runtimes',
  'profile-prepare',
  'source-layout-recovery',
  'macos-installation',
  'ready',
]

export function prepareSourceRelease(executable, args, { env, logPath, version }) {
  const preparation = promisify(execFile)(executable, args, {
    env,
    detached: process.platform !== 'win32',
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  })
  const monitored = waitForSourcePreparation(preparation, async () => {
    let log
    try {
      log = await readFile(logPath, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return { phase: 'preparing' }
    }
    return sourcePreparationProgress(log, version)
  })
  monitored.child = preparation.child
  return monitored
}

export function sourcePreparationProgress(log, version) {
  let phase = 'preparing'
  // Ignore the final partial write, and only observe this delivered source.
  for (const line of log.split('\n').slice(0, -1)) {
    const start = line.indexOf('{')
    if (start < 0) continue
    const event = JSON.parse(line.slice(start))
    if (
      event.event !== 'release-preparation-stage' ||
      event.releaseId !== 'source-preparation' ||
      event.version !== version
    )
      continue
    assert.ok(
      SOURCE_PHASES.indexOf(event.stage) >= SOURCE_PHASES.indexOf(phase),
      'Source preparation phase regressed or is unknown'
    )
    phase = event.stage
  }
  return { phase }
}

export async function waitForSourcePreparation(
  preparation,
  readProgress,
  { stop = stopProcessGroup, ...timing } = {}
) {
  let outcome
  const settled = preparation.then(
    value => {
      outcome = { value }
    },
    error => {
      outcome = { error }
    }
  )
  try {
    await waitForPreparationPhases(
      async () => {
        if (!outcome) return readProgress()
        if (outcome.error) throw outcome.error
        return { phase: 'ready' }
      },
      { ...timing, phases: SOURCE_PHASES, description: 'Source preparation' }
    )
    return outcome.value
  } catch (error) {
    if (!outcome) {
      try {
        await stop(preparation.child)
        await settled
      } catch (stopError) {
        throw new AggregateError([error, stopError], error.message)
      }
    }
    throw error
  }
}
