// @vitest-environment node

import assert from 'node:assert/strict'
import { beforeEach, test, vi } from 'vitest'
import { setNativeCatalogOverride } from '../e2e/desktop/modules/model-catalog-recovery.mjs'
import { requestExecutor } from '../e2e/desktop/modules/executor-rpc.mjs'

vi.mock('../e2e/desktop/modules/executor-rpc.mjs', () => ({ requestExecutor: vi.fn() }))
beforeEach(() => vi.resetAllMocks())

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

test('keeps a refused restart fatal when the requested fields actually change', async () => {
  const control = {}
  let effective = { slug: 'fixture' }
  requestExecutor.mockImplementation(async (_control, method) => {
    if (method.endsWith('.read')) return { models: [{ slug: 'fixture', effective }] }
    if (method.endsWith('.write')) effective = { ...effective, context_window: 12345 }
    if (method.endsWith('.restart')) return { restarted: false, requiresConfirmation: true }
    return {}
  })
  await assert.rejects(
    setNativeCatalogOverride(control, 'fixture', { context_window: 12345 }, 10000),
    /requiresConfirmation/
  )
  assert.equal(
    requestExecutor.mock.calls.filter(([, method]) => method.endsWith('.restart')).length,
    1
  )
  await assert.rejects(
    setNativeCatalogOverride(control, 'fixture', { context_window: 12345 }, 10000),
    /requiresConfirmation/
  )
  assert.equal(
    requestExecutor.mock.calls.filter(([, method]) => method.endsWith('.write')).length,
    1
  )
  assert.equal(
    requestExecutor.mock.calls.filter(([, method]) => method.endsWith('.restart')).length,
    2
  )
})
