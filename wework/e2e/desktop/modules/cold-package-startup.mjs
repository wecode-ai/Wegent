import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const PHASES = [
  'desktop-components-prepare',
  'core-runtime-materialize',
  'core-dsh-prepare',
  'core-dsh-process-start',
  'primary-renderer-load',
]
const TIMED_STARTUP_STEPS = [
  'workbench-mode-initialize',
  'desktop-components-prepare',
  'core-dsh-prepare',
  'core-dsh-process-start',
  'primary-renderer-load',
  'main-window-show',
]

export function parseStartupEvents(log) {
  return [...log.matchAll(/\[startup\]\s*\{([^}]+)\}/g)].flatMap(([, body]) => {
    const step = body.match(/\bstep['"]?\s*:\s*['"]([^'"]+)['"]/)?.[1]
    const status = body.match(/\bstatus['"]?\s*:\s*['"]([^'"]+)['"]/)?.[1]
    const elapsed = body.match(/\belapsedMs['"]?\s*:\s*(\d+(?:\.\d+)?)/)?.[1]
    const phaseElapsed = body.match(/\bphaseElapsedMs['"]?\s*:\s*(\d+(?:\.\d+)?)/)?.[1]
    return step && status && elapsed
      ? [
          {
            step,
            status,
            elapsedMs: Number(elapsed),
            ...(phaseElapsed ? { phaseElapsedMs: Number(phaseElapsed) } : {}),
          },
        ]
      : []
  })
}

export function splitStartupAttempts(events) {
  const attempts = []
  for (const event of events) {
    if (event.step === 'device-id-resolve' && event.status === 'started') attempts.push([])
    attempts.at(-1)?.push(event)
  }
  return attempts.filter(attempt => attempt.length > 0)
}

export function summarizeStartupAttempt(events) {
  const phaseDurationsMs = Object.fromEntries(
    events
      .filter(event => event.status === 'completed' && event.phaseElapsedMs !== undefined)
      .map(event => [event.step, event.phaseElapsedMs])
  )
  for (const step of TIMED_STARTUP_STEPS) {
    const startIndex = events.findIndex(event => event.step === step && event.status === 'started')
    const end = events.find(
      (event, index) => index > startIndex && event.step === step && event.status === 'completed'
    )
    if (startIndex >= 0 && end)
      phaseDurationsMs[step] ??= end.elapsedMs - events[startIndex].elapsedMs
  }
  const mainWindowShow = events.find(
    event => event.step === 'main-window-show' && event.status === 'completed'
  )
  return {
    mainWindowShowElapsedMs: mainWindowShow?.elapsedMs ?? null,
    phaseDurationsMs,
    events,
  }
}

export async function waitForStartupAttempt(
  logPath,
  attemptNumber,
  {
    timeoutMs,
    readLog = () => readStartupLog(logPath),
    now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  }
) {
  assert.ok(Number.isInteger(attemptNumber) && attemptNumber > 0)
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0)
  const deadline = now() + timeoutMs
  do {
    const attempts = splitStartupAttempts(parseStartupEvents(await readLog()))
    const attempt = attempts[attemptNumber - 1]
    if (attempt?.some(event => event.step === 'main-window-show' && event.status === 'completed')) {
      return summarizeStartupAttempt(attempt)
    }
    await sleep(100)
  } while (now() < deadline)
  throw new Error(`Startup attempt ${attemptNumber} did not reach main-window-show`)
}

async function readStartupLog(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

/** Cold extraction and profile preparation each own the existing startup budget. */
export async function waitForColdPackageStartup(
  ready,
  logPath,
  {
    phaseTimeoutMs,
    readLog = () => readStartupLog(logPath),
    now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  }
) {
  assert.ok(Number.isFinite(phaseTimeoutMs) && phaseTimeoutMs > 0)
  let outcome
  void ready.then(
    value => {
      outcome = { value }
    },
    error => {
      outcome = { error }
    }
  )
  let phase = -1
  let phaseStartedAt = now()
  let nativePhaseStartedAt = 0
  let completed = true
  let seen = 0
  for (;;) {
    const steps = parseStartupEvents(await readLog())
    assert.ok(steps.length >= seen, 'Cold packaged startup log regressed')
    for (const event of steps.slice(seen)) {
      assert.notEqual(event.status, 'failed', `Cold packaged startup failed: ${event.step}`)
      const next = PHASES.indexOf(event.step)
      if (next < 0) continue
      const elapsed = event.elapsedMs - nativePhaseStartedAt
      assert.ok(
        elapsed >= 0 && elapsed < phaseTimeoutMs,
        `Cold packaged startup exceeded its phase budget: ${PHASES[phase] ?? 'launch'}, elapsedMs=${elapsed}`
      )
      if (event.status === 'started') {
        assert.equal(next, phase + 1, 'Cold packaged startup phase regressed or skipped')
        assert.ok(completed, 'Cold packaged startup advanced before completing its phase')
        phase = next
        phaseStartedAt = now()
        nativePhaseStartedAt = event.elapsedMs
        completed = false
      } else if (event.status === 'completed') {
        assert.equal(next, phase, 'Cold packaged startup completed an inactive phase')
        completed = true
      }
    }
    seen = steps.length
    if (outcome && 'error' in outcome) throw outcome.error
    assert.ok(
      now() - phaseStartedAt < phaseTimeoutMs,
      `Cold packaged startup stalled: phase=${PHASES[phase] ?? 'launch'}`
    )
    if (outcome) return outcome.value
    await sleep(250)
  }
}
