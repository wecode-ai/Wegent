// @vitest-environment node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'vitest'
import { waitForColdPackageStartup } from '../e2e/desktop/modules/cold-package-startup.mjs'

const phases = [
  'desktop-components-prepare',
  'core-runtime-materialize',
  'core-dsh-prepare',
  'core-dsh-process-start',
  'primary-renderer-load',
]
const event = (step, status, elapsedMs) =>
  `[startup] {\n  step: '${step}',\n  status: '${status}',\n  elapsedMs: ${elapsedMs}\n}\n`
const neverReady = () => new Promise(() => {})

test('release-package resource ownership selects cold startup without a second opt-in', async () => {
  const runner = await readFile(
    new URL('../e2e/desktop/modules/task-flow-main.mjs', import.meta.url),
    'utf8'
  )
  assert.ok(
    /const ready\s*=\s*usesReleasePackageRuntimeAssets && !usesDefaultUserData\s*\? await waitForColdPackageStartup/.test(
      runner
    ),
    'Only ordinary packaged cold starts use phase readiness; release-pair diagnostics retain their deadline'
  )
  assert.match(
    runner,
    /const usesDefaultUserData = UPGRADE_DIAGNOSTIC_CHECKPOINTS.includes\(DESKTOP_SEGMENT\)/
  )
  for (const scenario of ['component-update', 'release-package-startup']) {
    const source = await readFile(
      new URL(`../e2e/desktop/scenarios/${scenario}.scenario.mjs`, import.meta.url),
      'utf8'
    )
    assert.match(source, /usesReleasePackageRuntimeAssets: true/)
    assert.doesNotMatch(source, /usesColdPackageStartup/)
  }
})

function clock(readLog) {
  let time = 0
  return {
    phaseTimeoutMs: 100,
    now: () => time,
    sleep: async () => {
      time += 60
    },
    readLog: () => readLog(time),
  }
}

test('accepts serial cold preparation longer than one budget, then returns actual readiness', async () => {
  const ready = Promise.withResolvers()
  const expected = { windowLabel: 'main', location: 'http://127.0.0.1/wework/app' }
  const options = clock(time => {
    if (time >= 300) ready.resolve(expected)
    return phases
      .map(
        (phase, index) =>
          (time >= index * 60 ? event(phase, 'started', index * 60) : '') +
          (time >= index * 60 + 50 ? event(phase, 'completed', index * 60 + 50) : '')
      )
      .join('')
  })
  assert.equal(await waitForColdPackageStartup(ready.promise, '', options), expected)
  assert.ok(options.now() > options.phaseTimeoutMs)
})

test('accepts the observed Windows cold-start timeline without increasing a phase budget', async () => {
  // CI job 125090898982: extraction took 145101ms; the controller arrived at 191935ms.
  const timing = [
    [1140, 14811],
    [14811, 159912],
    [159965, 177073],
    [177074, 183330],
    [183331, 188382],
  ]
  const ready = Promise.withResolvers()
  let time = 0
  const value = { windowLabel: 'main' }
  const options = {
    phaseTimeoutMs: 180_000,
    now: () => time,
    sleep: async () => {
      time += 250
    },
    readLog: () => {
      if (time >= 191935) ready.resolve(value)
      return phases
        .map(
          (phase, index) =>
            (time >= timing[index][0] ? event(phase, 'started', timing[index][0]) : '') +
            (time >= timing[index][1] ? event(phase, 'completed', timing[index][1]) : '')
        )
        .join('')
    },
  }
  assert.equal(await waitForColdPackageStartup(ready.promise, '', options), value)
  assert.ok(time > options.phaseTimeoutMs)
})

test('rejects a launch with no startup events or controller', async () => {
  await assert.rejects(
    waitForColdPackageStartup(
      neverReady(),
      '',
      clock(() => '')
    ),
    /stalled: phase=launch/
  )
})

test('rejects a stalled phase even when unrelated startup messages keep arriving', async () => {
  const options = clock(
    time => event(phases[0], 'started', 0) + event('heartbeat', 'completed', time)
  )
  await assert.rejects(
    waitForColdPackageStartup(neverReady(), '', options),
    /stalled: phase=desktop-components-prepare/
  )
})

test('rejects a phase that exceeded its budget between observations', async () => {
  const options = clock(
    () =>
      event(phases[0], 'started', 0) +
      event(phases[0], 'completed', 101) +
      event(phases[1], 'started', 102)
  )
  await assert.rejects(
    waitForColdPackageStartup(neverReady(), '', options),
    /exceeded its phase budget/
  )
})

test('rejects regressing phases', async () => {
  const options = clock(
    () =>
      event(phases[0], 'started', 0) +
      event(phases[0], 'completed', 10) +
      event(phases[1], 'started', 20) +
      event(phases[1], 'completed', 30) +
      event(phases[0], 'started', 40)
  )
  await assert.rejects(waitForColdPackageStartup(neverReady(), '', options), /regressed or skipped/)
})

test('completed preparation does not substitute for the real renderer connection', async () => {
  const log = phases
    .map(
      (phase, index) =>
        event(phase, 'started', index * 10) + event(phase, 'completed', index * 10 + 5)
    )
    .join('')
  await assert.rejects(
    waitForColdPackageStartup(
      neverReady(),
      '',
      clock(() => log)
    ),
    /stalled: phase=primary-renderer-load/
  )
})

test('propagates controller failures and native startup failures', async () => {
  const error = new Error('controller closed')
  await assert.rejects(
    waitForColdPackageStartup(
      Promise.reject(error),
      '',
      clock(() => '')
    ),
    value => value === error
  )
  await assert.rejects(
    waitForColdPackageStartup(
      neverReady(),
      '',
      clock(() => event('node-runtime-prepare', 'failed', 1))
    ),
    /startup failed: node-runtime-prepare/
  )
})
