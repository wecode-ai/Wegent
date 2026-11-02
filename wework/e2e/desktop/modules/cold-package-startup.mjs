import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const PHASES = [
  'desktop-components-prepare',
  'core-runtime-materialize',
  'core-dsh-prepare',
  'core-dsh-process-start',
  'primary-renderer-load',
]

function startupSteps(log) {
  return [...log.matchAll(/\[startup\]\s*\{([^}]+)\}/g)].flatMap(([, body]) => {
    const step = body.match(/\bstep['"]?\s*:\s*['"]([^'"]+)['"]/)?.[1]
    const status = body.match(/\bstatus['"]?\s*:\s*['"]([^'"]+)['"]/)?.[1]
    const elapsed = body.match(/\belapsedMs['"]?\s*:\s*(\d+(?:\.\d+)?)/)?.[1]
    return step && status && elapsed ? [{ step, status, elapsedMs: Number(elapsed) }] : []
  })
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
    const steps = startupSteps(await readLog())
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
