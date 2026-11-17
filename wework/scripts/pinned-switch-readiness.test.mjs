// @vitest-environment node
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { waitForBottom } from '../e2e/desktop/modules/streaming-text-fixture.mjs'
import { verifyConversationSwitchPosition } from '../e2e/desktop/modules/streaming-text-switch-stability.mjs'

const samplerBoundary = new Error('Sampling boundary reached')

function readinessControl(distances) {
  const readings = []
  let samplerStarted = false
  return {
    readings,
    get samplerStarted() {
      return samplerStarted
    },
    async command(action) {
      if (action === 'waitFor') return ''
      if (action === 'getElementMetrics') {
        const distance = distances[Math.min(readings.length, distances.length - 1)]
        readings.push(distance)
        return JSON.stringify([
          { scrollHeight: 1000, clientHeight: 600, scrollTop: 400 - distance },
        ])
      }
      assert.equal(action, 'startScrollStabilitySampling')
      samplerStarted = true
      // Stop at the exact measurement boundary without navigating or writing artifacts.
      throw samplerBoundary
    },
  }
}

const switchOptions = pinned => ({
  address: { taskId: 'contract-task' },
  anchorText: 'contract-anchor',
  name: 'contract-pinned-switch',
  pinned,
  uiTimeoutMs: 500,
})

test('two pixels from bottom cannot enter a pinned sampler', async () => {
  const control = readinessControl([2])
  await assert.rejects(
    verifyConversationSwitchPosition(control, { ...switchOptions(true), uiTimeoutMs: 25 }),
    /remained 2px from the bottom/
  )
  assert.equal(control.samplerStarted, false)
  assert.ok(control.readings.length >= 1)
})

test('one pixel from bottom satisfies the pinned measurement boundary', async () => {
  const control = readinessControl([1])
  await assert.rejects(
    verifyConversationSwitchPosition(control, switchOptions(true)),
    samplerBoundary
  )
  assert.equal(control.samplerStarted, true)
  assert.deepEqual(control.readings, [1])
})

test('the observed two-to-one pixel transition settles before pinned sampling begins', async () => {
  const control = readinessControl([2, 1])
  await assert.rejects(
    verifyConversationSwitchPosition(control, switchOptions(true)),
    samplerBoundary
  )
  assert.equal(control.samplerStarted, true)
  assert.deepEqual(control.readings, [2, 1])
})

test('reading-position sampling does not force the conversation to the bottom', async () => {
  const control = readinessControl([300])
  await assert.rejects(
    verifyConversationSwitchPosition(control, switchOptions(false)),
    samplerBoundary
  )
  assert.equal(control.samplerStarted, true)
  assert.deepEqual(control.readings, [])
})

test('ordinary bottom readiness keeps its existing eight-pixel default', async () => {
  const control = readinessControl([8])
  const metrics = await waitForBottom(control, 'Ordinary bottom readiness', 500)
  assert.equal(metrics.scrollTop, 392)
  assert.deepEqual(control.readings, [8])
})
