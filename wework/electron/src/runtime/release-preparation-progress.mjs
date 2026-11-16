import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'

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

/** Own the process group that must stop before activation recovery can write data. */
export function spawnReleaseProcess(executable, args, { env, maxBuffer = 1024 * 1024 }) {
  const child = spawn(executable, args, {
    env,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const result = new Promise((resolve, reject) => {
    const output = { stdout: [], stderr: [] }
    for (const name of ['stdout', 'stderr']) {
      let bytes = 0
      child[name].on('data', chunk => {
        bytes += chunk.length
        if (bytes > maxBuffer) {
          reject(new Error('Release preparation output exceeded its buffer limit'))
          return
        }
        output[name].push(chunk)
      })
    }
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code !== 0 || signal) {
        reject(new Error('Release preparation process did not exit successfully'))
        return
      }
      resolve({
        stdout: Buffer.concat(output.stdout).toString('utf8'),
        stderr: Buffer.concat(output.stderr).toString('utf8'),
      })
    })
  })
  return Object.assign(result, { child })
}

export function prepareReleaseProcess(
  executable,
  args,
  { env, progress, releaseId, version, stop }
) {
  const preparation = spawnReleaseProcess(executable, args, {
    env,
    maxBuffer: 1024 * 1024,
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
    if (!outcome || (outcome.error && preparation.child?.pid)) {
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
