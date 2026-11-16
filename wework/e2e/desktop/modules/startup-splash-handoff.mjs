import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const STARTUP_SPLASH_HANDOFF_EVENTS = [
  'created',
  'animation-ready',
  'shown',
  'completion-started',
  'completed',
  'main-prepared',
  'fade-started',
  'fade-completed',
  'closed',
]

function assertCompletedFrame(completion) {
  assert.ok(completion, 'The renderer did not acknowledge a completed frame')
  assert.equal(completion.progressNow, 100, 'The startup progress did not reach 100%')
  assert.ok(Number.isFinite(completion.trackEnd) && completion.trackEnd > 1)
  assert.equal(
    completion.fillEnd,
    completion.trackEnd,
    'The completed progress line did not reach the physical track endpoint'
  )
  assert.equal(completion.wordmarkVisible, false, 'The startup wordmark is still visible')
  assert.ok(completion.viewport.width > 0 && completion.viewport.height > 0)
  assert.deepEqual(
    completion.canvas,
    { x: 0, y: 0, ...completion.viewport },
    'The brand canvas does not cover the full window independently of its footer'
  )
}

export function assertStartupSplashHandoff(snapshot) {
  assert.equal(snapshot.state, 'closed', 'The handoff did not close the startup splash')
  const names = snapshot.events.map(event => event.name)
  const readiness = names.indexOf('animation-ready')
  assert.ok(
    readiness > 0 &&
      readiness < names.indexOf('completion-started') &&
      names.lastIndexOf('animation-ready') === readiness,
    'The startup splash did not record animation readiness before completion'
  )
  // Showing the window does not wait for animation initialization. Either event
  // may arrive first, while every other handoff stage retains its strict order.
  assert.deepEqual(
    names.filter(name => name !== 'animation-ready'),
    STARTUP_SPLASH_HANDOFF_EVENTS.filter(name => name !== 'animation-ready'),
    `The startup splash did not complete its painted-completion and fade lifecycle: ${names.join(
      ','
    )}`
  )
  assert.ok(
    snapshot.events.every(
      (event, index, events) =>
        Number.isFinite(event.timestamp) &&
        (index === 0 || event.timestamp >= events[index - 1].timestamp)
    ),
    'The startup handoff lifecycle timestamps are out of order'
  )
  const handoff = snapshot.handoff
  assert.ok(handoff, 'The startup splash did not retain its real handoff evidence')
  assert.equal(handoff.fadeDurationMs, 600, 'The approved fade duration was not applied')
  assert.equal(typeof handoff.reducedMotion, 'boolean')
  assertCompletedFrame(handoff.completion)
  assert.ok(handoff.bounds?.splash?.width > 0 && handoff.bounds.splash.height > 0)
  assert.deepEqual(
    handoff.bounds.main,
    handoff.bounds.splash,
    'The main window moved or resized during the startup handoff'
  )
  if (!handoff.reducedMotion) {
    const start = snapshot.events.find(event => event.name === 'fade-started')
    const end = snapshot.events.find(event => event.name === 'fade-completed')
    // Date.now truncates the two endpoints independently to whole milliseconds.
    assert.ok(
      end.timestamp - start.timestamp >= handoff.fadeDurationMs - 1,
      `The native startup fade ended before its duration: ${end.timestamp - start.timestamp}ms`
    )
  }
  return handoff
}

export async function verifyStartupSplashHandoff({
  snapshot,
  resultDir,
  name = 'startup-splash-handoff',
}) {
  assertStartupSplashHandoff(snapshot)
  await writeFile(join(resultDir, `${name}.json`), `${JSON.stringify(snapshot, null, 2)}\n`)
}
