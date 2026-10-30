import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import {
  waitForElementTop,
  waitForElementWidth,
} from '../e2e/desktop/modules/conversation-layout.mjs'

afterEach(() => vi.useRealTimers())

async function withPollingClock(run, elapsedMs = 150) {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] })
  const [result] = await Promise.all([run(), vi.advanceTimersByTimeAsync(elapsedMs)])
  return result
}

for (const [property, waitForMetric] of [
  ['width', waitForElementWidth],
  ['top', waitForElementTop],
]) {
  test(`${property} wait observes a remounted surface instead of failing on its empty frame`, async () => {
    const samples = [[], [{ [property]: 100 }], [{ [property]: 200 }]]
    const trace = []
    const control = {
      async command(action, selector) {
        assert.equal(action, 'getElementMetrics')
        assert.equal(selector, '[data-testid="layout-surface"]')
        const sample = samples.shift()
        assert.ok(sample, 'The wait must finish at the matching geometry')
        trace.push(sample)
        return JSON.stringify(sample)
      },
    }
    try {
      const metrics = await withPollingClock(() =>
        waitForMetric(
          control,
          '[data-testid="layout-surface"]',
          value => value === 200,
          'The remounted layout surface',
          500
        )
      )
      assert.equal(metrics[property], 200)
      assert.equal(samples.length, 0)
    } finally {
      console.info(`${property} observations: ${JSON.stringify(trace)}`)
    }
  })

  test(`${property} wait keeps duplicate surfaces as an error`, async () => {
    const control = {
      async command() {
        return JSON.stringify([{ [property]: 200 }, { [property]: 200 }])
      },
    }
    await assert.rejects(
      waitForMetric(control, '[data-testid="layout-surface"]', value => value === 200, 'Layout'),
      /2 matching elements/
    )
  })

  test(`${property} wait uses the shared step budget when no timeout is specified`, async () => {
    const metrics = await withPollingClock(() => {
      const startedAt = Date.now()
      const control = {
        async command() {
          return JSON.stringify([{ [property]: Date.now() - startedAt >= 2000 ? 200 : 100 }])
        },
      }
      return waitForMetric(control, 'section', value => value === 200, 'Layout')
    }, 2100)
    assert.equal(metrics[property], 200)
  })

  test(`${property} wait returns an already matching surface without an extra observation window`, async () => {
    let reads = 0
    const control = {
      async command() {
        reads += 1
        return JSON.stringify([{ [property]: 200 }])
      },
    }
    const metrics = await waitForMetric(control, 'section', value => value === 200, 'Layout')
    assert.equal(metrics[property], 200)
    assert.equal(reads, 1)
  })

  test(`${property} wait fails when the mounted surface never reaches its expected geometry`, async () => {
    let reads = 0
    const control = {
      async command() {
        reads += 1
        return JSON.stringify([{ [property]: 100 }])
      },
    }
    await withPollingClock(() =>
      assert.rejects(
        waitForMetric(control, 'section', value => value === 200, 'Layout', 75),
        error => {
          assert.match(error.message, /Timed out/)
          assert.match(error.message, new RegExp(`"${property}":100`))
          return true
        }
      )
    )
    assert.ok(reads > 1)
  })

  test(`${property} timeout reports the selector and observed empty frames`, async () => {
    let reads = 0
    const control = {
      async command() {
        reads += 1
        return '[]'
      },
    }
    await withPollingClock(() =>
      assert.rejects(
        waitForMetric(control, '[data-testid="layout-surface"]', () => true, 'Layout', 75),
        error => {
          assert.match(error.message, /Timed out/)
          assert.match(error.message, /layout-surface/)
          assert.match(error.message, /observations/)
          assert.match(error.message, /"matches":0/)
          return true
        }
      )
    )
    assert.ok(reads > 1)
    console.info(`${property} missing surface: ${reads} observations, timed out without a match`)
  })
}
