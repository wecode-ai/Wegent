import assert from 'node:assert/strict'
import { test } from 'vitest'
import { assertStartupPreparation } from '../e2e/desktop/scenarios/startup-preparation.scenario.mjs'
import { parseStartupEvents } from '../e2e/desktop/scenarios/native-window-startup.scenario.mjs'

const ordered = [
  ['desktop-environment', 'started'],
  ['electron-ready', 'started'],
  ['electron-ready', 'completed'],
  ['desktop-environment', 'completed'],
  ['executor-home-preparation', 'started'],
  ['core-dsh-process-start', 'started'],
  ['core-dsh-process-start', 'completed'],
  ['primary-renderer-load', 'started'],
  ['renderer-startup-ready', 'completed'],
  ['startup-splash-close', 'completed'],
].map(([step, status]) => ({ step, status, elapsedMs: 1 }))

test('accepts actual event order even when rounded clocks are equal', () => {
  const log = ordered
    .map(event => `[startup] { step: '${event.step}', status: '${event.status}', elapsedMs: 1 }`)
    .join('\n')
  assertStartupPreparation(parseStartupEvents(log))
})

test('rejects absent preparation instead of treating it as ready', () => {
  assert.throws(() => assertStartupPreparation([]), /exactly one desktop-environment:started/)
})

test('rejects a second preparation in the same application process', () => {
  assert.throws(
    () => assertStartupPreparation([...ordered, ordered[0]]),
    /exactly one desktop-environment:started/
  )
})

test('rejects environment preparation started after Electron ready begins', () => {
  assert.throws(
    () => assertStartupPreparation([ordered[1], ordered[0], ...ordered.slice(2)]),
    /did not start before ready/
  )
})

test('rejects either runtime admitted before preparation completes', () => {
  for (const index of [4, 5]) {
    const events = [...ordered]
    events[3] = ordered[index]
    events[index] = ordered[3]
    assert.throws(() => assertStartupPreparation(events), /preceded|before environment preparation/)
  }
})

test('rejects readiness reported before the actual renderer or Core is ready', () => {
  for (const [left, right] of [
    [6, 7],
    [7, 8],
    [8, 9],
  ]) {
    const events = [...ordered]
    events[left] = ordered[right]
    events[right] = ordered[left]
    assert.throws(() => assertStartupPreparation(events), /before|did not become ready/)
  }
})
