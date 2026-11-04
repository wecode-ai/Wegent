import assert from 'node:assert/strict'
import { DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'

async function waitForElementMetric(
  control,
  selector,
  property,
  predicate,
  description,
  timeoutMs
) {
  const startedAt = Date.now()
  const observations = []
  let metrics = []
  while (Date.now() - startedAt < timeoutMs) {
    metrics = JSON.parse(await control.command('getElementMetrics', selector))
    assert.ok(metrics.length <= 1, `${description} rendered ${metrics.length} matching elements`)
    observations.push({
      elapsedMs: Date.now() - startedAt,
      matches: metrics.length,
      [property]: metrics[0]?.[property] ?? null,
    })
    if (observations.length > 20) observations.shift()
    if (metrics[0] && predicate(metrics[0][property])) return metrics[0]
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${description} (${selector}) ${property}; ` +
      `metrics=${JSON.stringify(metrics)}; observations=${JSON.stringify(observations)}`
  )
}

export function waitForElementWidth(
  control,
  selector,
  predicate,
  description,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS
) {
  return waitForElementMetric(control, selector, 'width', predicate, description, timeoutMs)
}

export function waitForElementTop(
  control,
  selector,
  predicate,
  description,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS
) {
  return waitForElementMetric(control, selector, 'top', predicate, description, timeoutMs)
}
