// @vitest-environment node

import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'
import { setNativeCatalogOverride } from '../e2e/desktop/modules/model-catalog-recovery.mjs'
import { requestExecutor } from '../e2e/desktop/modules/executor-rpc.mjs'

vi.mock('../e2e/desktop/modules/executor-rpc.mjs', () => ({ requestExecutor: vi.fn() }))
beforeEach(() => vi.resetAllMocks())
afterEach(() => vi.useRealTimers())

test('only changes and restarts the native catalog once for repeated identical prerequisites', async () => {
  const fields = { experimental_supported_tools: ['request_user_input_async'] }
  let effective = { slug: 'fixture', experimental_supported_tools: [] }
  requestExecutor.mockImplementation(async (_control, method, params) => {
    if (method.endsWith('.read')) return { models: [{ slug: 'fixture', effective }] }
    if (method.endsWith('.write')) effective = structuredClone(params.entry)
    if (method.endsWith('.restart')) return { restarted: true }
    return {}
  })
  const control = {}
  await setNativeCatalogOverride(control, 'fixture', fields, 10000)
  await setNativeCatalogOverride(control, 'fixture', structuredClone(fields), 10000)
  assert.equal(
    requestExecutor.mock.calls.filter(([, method]) => method.endsWith('.write')).length,
    1
  )
  const restarts = requestExecutor.mock.calls.filter(([, method]) => method.endsWith('.restart'))
  assert.equal(restarts.length, 1)
  assert.deepEqual(restarts[0][2], { ifIdle: true })
})

test('fails when native admission stays busy without caching the override as loaded', async () => {
  vi.useFakeTimers()
  const control = {}
  let effective = { slug: 'fixture' }
  requestExecutor.mockImplementation(async (_control, method) => {
    if (method.endsWith('.read')) return { models: [{ slug: 'fixture', effective }] }
    if (method.endsWith('.write')) effective = { ...effective, context_window: 12345 }
    if (method.endsWith('.restart')) return { restarted: false, requiresConfirmation: true }
    return {}
  })
  const first = assert.rejects(
    setNativeCatalogOverride(control, 'fixture', { context_window: 12345 }, 10000),
    /requiresConfirmation/
  )
  await vi.advanceTimersByTimeAsync(10000)
  await first
  const firstAttempts = requestExecutor.mock.calls.filter(([, method]) =>
    method.endsWith('.restart')
  ).length
  assert.ok(firstAttempts > 0)
  const second = assert.rejects(
    setNativeCatalogOverride(control, 'fixture', { context_window: 12345 }, 10000),
    /requiresConfirmation/
  )
  await vi.advanceTimersByTimeAsync(10000)
  await second
  assert.equal(
    requestExecutor.mock.calls.filter(([, method]) => method.endsWith('.write')).length,
    1
  )
  const restarts = requestExecutor.mock.calls.filter(([, method]) => method.endsWith('.restart'))
  assert.ok(restarts.length > firstAttempts)
  assert.ok(restarts.every(([, , params]) => params.ifIdle === true && !params.force))
})

test('waits for native idle admission before caching identical catalog prerequisites', async () => {
  vi.useFakeTimers()
  const control = {}
  const fields = { context_window: 12345 }
  let effective = { slug: 'fixture' }
  let attempts = 0
  requestExecutor.mockImplementation(async (_control, method, params) => {
    if (method.endsWith('.read')) return { models: [{ slug: 'fixture', effective }] }
    if (method.endsWith('.write')) effective = structuredClone(params.entry)
    if (method.endsWith('.restart')) {
      attempts++
      return attempts === 1
        ? { restarted: false, requiresConfirmation: true, activeTaskCount: 1 }
        : { restarted: true }
    }
    return {}
  })
  const preparation = setNativeCatalogOverride(control, 'fixture', fields, 10000)
  await vi.advanceTimersByTimeAsync(100)
  await preparation
  await setNativeCatalogOverride(control, 'fixture', fields, 10000)
  assert.equal(attempts, 2)
  assert.equal(
    requestExecutor.mock.calls.filter(([, method]) => method.endsWith('.write')).length,
    1
  )
  assert.ok(
    requestExecutor.mock.calls
      .filter(([, method]) => method.endsWith('.restart'))
      .every(([, , params]) => params.ifIdle === true && !params.force)
  )
})
