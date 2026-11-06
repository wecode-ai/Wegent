import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

export const RELEASE_PREPARATION_PHASE_TIMEOUT_MS = 300_000
export const RELEASE_PREPARATION_PROGRESS_PREFIX = '[release-preparation-stage] '

const RELEASE_PHASES = [
  'preparing',
  'profile-copy',
  'components',
  'runtimes',
  'profile-prepare',
  'source-layout-recovery',
  'macos-installation',
  'ready',
]

export function prepareReleaseProcess(
  executable,
  args,
  { env, progress, releaseId, version, stop }
) {
  const preparation = promisify(execFile)(executable, args, {
    env,
    detached: process.platform !== 'win32',
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  })
  let output = ''
  if (progress === 'stdout')
    preparation.child.stdout.on('data', chunk => {
      output += chunk
    })
  const monitored = waitForReleasePreparation(
    preparation,
    async () => {
      if (progress === 'stdout')
        return releasePreparationProgress(output, releaseId, version, 'stdout')
      let log
      try {
        log = await readFile(progress.logPath, 'utf8')
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        return { phase: 'preparing' }
      }
      return releasePreparationProgress(log, releaseId, version)
    },
    { stop }
  )
  monitored.child = preparation.child
  return monitored
}

export function releasePreparationProgress(log, releaseId, version, source = 'journal') {
  let phase = 'preparing'
  // Ignore the final partial write, and only observe this release's preparation.
  for (const line of log.split('\n').slice(0, -1)) {
    if (source === 'stdout' && !line.startsWith(RELEASE_PREPARATION_PROGRESS_PREFIX)) continue
    const start =
      source === 'stdout' ? RELEASE_PREPARATION_PROGRESS_PREFIX.length : line.indexOf('{')
    if (start < 0) continue
    const event = JSON.parse(line.slice(start))
    if (
      event.event !== 'release-preparation-stage' ||
      event.releaseId !== releaseId ||
      event.version !== version
    )
      continue
    assert.ok(
      event.stage !== 'ready' &&
        RELEASE_PHASES.indexOf(event.stage) >= RELEASE_PHASES.indexOf(phase),
      'Release preparation phase regressed or is unknown'
    )
    phase = event.stage
  }
  return { phase }
}

export async function waitForReleasePreparation(preparation, readProgress, { stop, ...timing }) {
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
      { ...timing, phases: RELEASE_PHASES, description: 'Release preparation' }
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

export async function waitForPreparationPhases(
  readProgress,
  {
    phaseTimeoutMs = RELEASE_PREPARATION_PHASE_TIMEOUT_MS,
    now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    phases,
    description = 'Update preparation',
  }
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
